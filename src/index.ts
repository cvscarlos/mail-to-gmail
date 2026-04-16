import { Command } from 'commander';
import { loadConfig } from './utils/config.js';
import { createLogger } from './utils/logger.js';
import { SqliteStateStore } from './core/StateStore.js';
import { SyncEngine } from './core/SyncEngine.js';
import { ZohoMailApiSource } from './providers/source/ZohoMailApiSource.js';
import { GmailImapDestination } from './providers/destination/GmailImapDestination.js';
import lockfile from 'proper-lockfile';
import fs from 'fs';
import path from 'path';
import { SyncFilter } from './core/types.js';

const program = new Command();

program.name('mail-bridge').description('One-way sync from Zoho to Gmail').version('1.0.0');

const MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 min ceiling on failure backoff

function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

program
  .command('sync')
  .description(
    'Sync messages. Loops every SYNC_INTERVAL_SECONDS (default 300); set to 0 or use --once for a single run.'
  )
  .option('--once', 'Run once and exit (overrides SYNC_INTERVAL_SECONDS)')
  .option('--dry-run', 'Run without storing messages in the destination')
  .action(async (cmdOptions) => {
    const config = loadConfig();
    const logger = createLogger(config.APP_LOG_LEVEL);
    const state = new SqliteStateStore(config.STATE_DB_PATH);

    const dryRun = cmdOptions.dryRun || config.DRY_RUN;
    const runOnce = !!cmdOptions.once || config.SYNC_INTERVAL_SECONDS === 0;
    const intervalMs = config.SYNC_INTERVAL_SECONDS * 1000;

    let filter: SyncFilter | undefined;
    const filterPath = config.FILTER_CONFIG_PATH;
    if (filterPath && fs.existsSync(filterPath)) {
      try {
        filter = JSON.parse(fs.readFileSync(filterPath, 'utf-8'));
        logger.info(`Loaded sync filter from ${filterPath}`);
      } catch (err: any) {
        logger.error(`Failed to load filter from ${filterPath}: ${err.message}`);
        state.close();
        process.exit(1);
      }
    }

    // Lockfile only matters when another single-run invocation could race us.
    // The loop daemon is the single writer by construction, so skip it in loop mode.
    let release: (() => Promise<void>) | undefined;
    if (runOnce) {
      const lockPath = path.resolve(config.STATE_DB_PATH + '.lock');
      if (!fs.existsSync(lockPath)) fs.writeFileSync(lockPath, '');
      try {
        release = await lockfile.lock(lockPath, { retries: 0 });
      } catch {
        logger.error('Another sync process is already running.');
        state.close();
        process.exit(1);
      }
    }

    // Long-lived instances: reuse across iterations so Zoho tokens (~1h) stay warm
    // and prepared statements / config objects aren't rebuilt every run.
    const source = new ZohoMailApiSource({
      dc: config.ZOHO_DC,
      clientId: config.ZOHO_CLIENT_ID,
      clientSecret: config.ZOHO_CLIENT_SECRET,
      refreshToken: config.ZOHO_REFRESH_TOKEN,
      accountId: config.ZOHO_ACCOUNT_ID,
    });
    const destination = new GmailImapDestination({
      email: config.GMAIL_EMAIL,
      appPassword: config.GMAIL_APP_PASSWORD,
    });
    const engine = new SyncEngine(source, destination, state, logger);

    const shutdown = new AbortController();
    const onSignal = (signal: NodeJS.Signals) => {
      if (shutdown.signal.aborted) return;
      logger.info(`Received ${signal}, shutting down after current iteration...`);
      shutdown.abort();
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);

    let consecutiveFailures = 0;
    let exitCode = 0;

    try {
      while (!shutdown.signal.aborted) {
        try {
          await engine.run({
            lookbackDays: config.SYNC_LOOKBACK_DAYS,
            maxMessages: config.MAX_MESSAGES_PER_RUN,
            concurrency: config.CONCURRENCY,
            targetMailbox: config.GMAIL_TARGET_MAILBOX,
            dryRun,
            filter,
          });
          consecutiveFailures = 0;
        } catch (err: any) {
          consecutiveFailures++;
          logger.error(
            `Sync iteration failed (attempt ${consecutiveFailures}): ${err.message}`
          );
          if (runOnce) {
            exitCode = 1;
            break;
          }
        }

        if (runOnce || shutdown.signal.aborted) break;

        const backoff = Math.min(intervalMs * 2 ** Math.min(consecutiveFailures, 6), MAX_BACKOFF_MS);
        const waitMs = consecutiveFailures > 0 ? backoff : intervalMs;
        logger.info(`Next run in ${Math.round(waitMs / 1000)}s`);
        await cancellableSleep(waitMs, shutdown.signal);
      }
    } finally {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      await release?.().catch(() => {});
      state.close();
    }

    if (exitCode) process.exit(exitCode);
  });

program
  .command('reset-checkpoints')
  .description('Clear all saved sync checkpoints (forces next run to start from lookback period)')
  .action(async () => {
    const config = loadConfig();
    const state = new SqliteStateStore(config.STATE_DB_PATH);
    
    try {
      await state.clearCheckpoints();
      console.log('✅ Checkpoints cleared successfully. The next sync run will start based on SYNC_LOOKBACK_DAYS.');
    } catch (err: any) {
      console.error(`❌ Failed to clear checkpoints: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('test-source')
  .description('Test Zoho source connection')
  .action(async () => {
    const config = loadConfig();
    const source = new ZohoMailApiSource({
      dc: config.ZOHO_DC,
      clientId: config.ZOHO_CLIENT_ID,
      clientSecret: config.ZOHO_CLIENT_SECRET,
      refreshToken: config.ZOHO_REFRESH_TOKEN,
      accountId: config.ZOHO_ACCOUNT_ID,
    });

    try {
      console.log('Connecting to Zoho...');
      await source.connect();
      const accountId = await source.getAccountId();
      console.log(`✅ Connected successfully. Account ID: ${accountId}`);
    } catch (err: any) {
      console.error(`❌ Connection failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('test-destination')
  .description('Test Gmail destination connection')
  .action(async () => {
    const config = loadConfig();
    const destination = new GmailImapDestination({
      email: config.GMAIL_EMAIL,
      appPassword: config.GMAIL_APP_PASSWORD,
    });

    try {
      console.log('Connecting to Gmail IMAP...');
      await destination.connect();
      await destination.ensureReady();
      console.log('✅ Connected successfully.');
      await destination.disconnect();
    } catch (err: any) {
      console.error(`❌ Connection failed: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
