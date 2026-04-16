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

program
  .command('sync')
  .description('Sync messages once')
  .option('--dry-run', 'Run without storing messages in the destination')
  .action(async (cmdOptions) => {
    const config = loadConfig();
    const logger = createLogger(config.APP_LOG_LEVEL);
    const state = new SqliteStateStore(config.STATE_DB_PATH);

    const dryRun = cmdOptions.dryRun || config.DRY_RUN;

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

    // Load filter if path is provided
    let filter: SyncFilter | undefined;
    const filterPath = config.FILTER_CONFIG_PATH;
    if (filterPath && fs.existsSync(filterPath)) {
      try {
        const filterData = JSON.parse(fs.readFileSync(filterPath, 'utf-8'));
        filter = filterData;
        logger.info(`Loaded sync filter from ${filterPath}`);
      } catch (err: any) {
        logger.error(`Failed to load filter from ${filterPath}: ${err.message}`);
        process.exit(1);
      }
    }

    const lockPath = path.resolve(config.STATE_DB_PATH + '.lock');
    if (!fs.existsSync(lockPath)) {
      fs.writeFileSync(lockPath, '');
    }

    let release;
    try {
      release = await lockfile.lock(lockPath, { retries: 0 });
    } catch (_err) {
      logger.error('Another sync process is already running.');
      process.exit(1);
    }

    try {
      await engine.run({
        lookbackDays: config.SYNC_LOOKBACK_DAYS,
        maxMessages: config.MAX_MESSAGES_PER_RUN,
        concurrency: config.CONCURRENCY,
        targetMailbox: config.GMAIL_TARGET_MAILBOX,
        dryRun,
        filter,
      });
    } catch (err: any) {
      logger.error(`Sync failed: ${err.message}`);
      process.exit(1);
    } finally {
      await release();
    }
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
