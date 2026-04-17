import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import inquirer from 'inquirer';
import lockfile from 'proper-lockfile';
import { getDestination, loadAppConfig } from './config/appConfig.js';
import { SqliteStateStore } from './core/StateStore.js';
import { SyncScheduler } from './core/SyncScheduler.js';
import { type AppConfig, type SourceConfig } from './core/types.js';
import { createDestination, createSource } from './providers/factories.js';
import { loadAppEnv } from './utils/config.js';
import { createLogger } from './utils/logger.js';

const program = new Command();
program
  .name('mail-to-gmail')
  .description('Self-hosted sync from Zoho / Yahoo / Outlook mailboxes into Gmail accounts')
  .version('2.0.0');

async function ensureLockFile(lockPath: string): Promise<void> {
  try {
    await fs.promises.writeFile(lockPath, '', { flag: 'a' });
  } catch {
    // File already exists or we lack permission; lockfile.lock() will surface the real error.
  }
}

async function acquireLock(dbPath: string): Promise<() => Promise<void>> {
  const lockPath = path.resolve(`${dbPath}.lock`);
  await ensureLockFile(lockPath);
  const release = await lockfile.lock(lockPath, { retries: 0 });
  return async (): Promise<void> => {
    try {
      await release();
    } catch {
      // Another process may have released first; safe to ignore on shutdown.
    }
  };
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 360) / 10}h`;
}

function printTable(rows: Array<Record<string, string>>, columns: string[]): void {
  if (rows.length === 0) return;
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => (r[c] ?? '').length)));
  const pad = (value: string, width: number): string => value.padEnd(width);
  const header = columns.map((c, i) => pad(c, widths[i])).join('  ');
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  console.warn(header);
  console.warn(sep);
  for (const row of rows) {
    console.warn(columns.map((c, i) => pad(row[c] ?? '', widths[i])).join('  '));
  }
}

function formatSourceRow(source: SourceConfig): Record<string, string> {
  return {
    name: source.name,
    type: source.type,
    credentialsRef: source.credentialsRef,
    destination: source.destination,
    enabled: source.enabled ? 'yes' : 'no',
    idle: source.type === 'imap' && source.idle ? 'yes' : 'no',
    interval: formatInterval(source.schedule.intervalSeconds),
    lookback: `${source.schedule.lookbackDays}d`,
  };
}

function printList(appConfig: AppConfig): void {
  const destinationRows = appConfig.destinations.map((d) => ({
    name: d.name,
    type: d.type,
    credentialsRef: d.credentialsRef,
    mailbox: d.mailbox,
  }));
  console.warn('\nDestinations');
  printTable(destinationRows, ['name', 'type', 'credentialsRef', 'mailbox']);

  const sourceRows = appConfig.sources.map(formatSourceRow);
  console.warn('\nSources');
  printTable(sourceRows, [
    'name',
    'type',
    'credentialsRef',
    'destination',
    'enabled',
    'idle',
    'interval',
    'lookback',
  ]);
  console.warn('');
}

program
  .command('sync')
  .description(
    'Run all enabled sources (daemon). Use --source <name> to run one source; --once to exit after one pass.'
  )
  .option('--source <name>', 'Run only the named source')
  .option('--once', 'Run a single pass then exit')
  .option('--dry-run', 'Skip APPEND and state writes; log intended actions')
  .action(async (opts: { source?: string; once?: boolean; dryRun?: boolean }) => {
    const env = loadAppEnv();
    const logger = createLogger(env.APP_LOG_LEVEL);
    const appConfig = loadAppConfig(env.CONFIG_PATH);
    const state = new SqliteStateStore(env.STATE_DB_PATH);

    const release = await acquireLock(env.STATE_DB_PATH).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `Cannot acquire lock on ${env.STATE_DB_PATH}: ${message}. Is another sync process running?`
      );
      state.close();
      process.exit(1);
    });

    const scheduler = new SyncScheduler({
      appConfig,
      state,
      logger,
      dryRun: !!opts.dryRun || env.DRY_RUN,
    });

    const shutdown = new AbortController();
    const onSignal = (signal: NodeJS.Signals): void => {
      if (shutdown.signal.aborted) return;
      logger.info(`Received ${signal}. Shutting down after current iteration…`);
      shutdown.abort();
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);

    try {
      await scheduler.run({
        abort: shutdown.signal,
        runOnce: !!opts.once,
        onlySource: opts.source,
      });
    } finally {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      await release();
      state.close();
    }
  });

program
  .command('test-source <name>')
  .description('Connect the named source + its declared destination without writing')
  .action(async (name: string) => {
    const env = loadAppEnv();
    const logger = createLogger(env.APP_LOG_LEVEL);
    const appConfig = loadAppConfig(env.CONFIG_PATH);

    const source = appConfig.sources.find((s) => s.name === name);
    if (!source) {
      logger.error(`Unknown source: "${name}"`);
      process.exit(1);
    }

    const destinationConfig = getDestination(appConfig, source.destination);
    const sourceProvider = createSource(source);
    const destinationProvider = createDestination(destinationConfig);

    try {
      logger.info(`Connecting source "${source.name}"…`);
      await sourceProvider.connect();
      logger.info('✓ source connected');

      logger.info(`Connecting destination "${destinationConfig.name}"…`);
      await destinationProvider.connect();
      await destinationProvider.ensureReady();
      logger.info('✓ destination ready');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Connection failed: ${message}`);
      process.exitCode = 1;
    } finally {
      await sourceProvider.disconnect().catch(() => {});
      await destinationProvider.disconnect().catch(() => {});
    }
  });

program
  .command('reset <source-name>')
  .description('Clear checkpoint + seen_messages for one source (forces next run to re-walk)')
  .option('--yes', 'Skip confirmation prompt')
  .action(async (sourceName: string, opts: { yes?: boolean }) => {
    const env = loadAppEnv();
    const logger = createLogger(env.APP_LOG_LEVEL);
    const appConfig = loadAppConfig(env.CONFIG_PATH);

    if (!appConfig.sources.some((s) => s.name === sourceName)) {
      logger.error(`Unknown source: "${sourceName}"`);
      process.exit(1);
    }

    if (!opts.yes) {
      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Reset checkpoint + seen_messages for "${sourceName}"? This cannot be undone.`,
          default: false,
        },
      ]);
      if (!confirmed) {
        logger.info('Aborted');
        return;
      }
    }

    const state = new SqliteStateStore(env.STATE_DB_PATH);
    const release = await acquireLock(env.STATE_DB_PATH).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Cannot acquire lock: ${message}. Stop the daemon first.`);
      state.close();
      process.exit(1);
    });

    try {
      await state.resetSource(sourceName);
      logger.info(`✓ Reset "${sourceName}"`);
    } finally {
      await release();
      state.close();
    }
  });

program
  .command('list')
  .description('Print configured sources and destinations')
  .action(() => {
    const env = loadAppEnv();
    const appConfig = loadAppConfig(env.CONFIG_PATH);
    printList(appConfig);
  });

program
  .command('reset-checkpoints')
  .description('Deprecated. Use "reset <source-name>" instead.')
  .action(() => {
    console.error('reset-checkpoints is deprecated. Use: mail-to-gmail reset <source-name>');
    process.exit(2);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
