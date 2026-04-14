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

const program = new Command();

program
  .name('mail-bridge')
  .description('One-way sync from Zoho to Gmail')
  .version('1.0.0');

program.command('sync')
  .description('Sync messages once')
  .action(async () => {
    const config = loadConfig();
    const logger = createLogger(config.APP_LOG_LEVEL);
    const state = new SqliteStateStore(config.STATE_DB_PATH);

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

    const lockPath = path.resolve(config.STATE_DB_PATH + '.lock');
    if (!fs.existsSync(lockPath)) {
      fs.writeFileSync(lockPath, '');
    }

    let release;
    try {
      release = await lockfile.lock(lockPath, { retries: 0 });
    } catch (err) {
      logger.error('Another sync process is already running.');
      process.exit(1);
    }

    try {
      await engine.run({
        lookbackMinutes: config.SYNC_LOOKBACK_MINUTES,
        maxMessages: config.MAX_MESSAGES_PER_RUN,
        concurrency: config.CONCURRENCY,
        sourceFolders: config.ZOHO_FOLDER_NAMES.split(','),
        targetMailbox: config.GMAIL_TARGET_MAILBOX,
      });
    } catch (err: any) {
      logger.error(`Sync failed: ${err.message}`);
      process.exit(1);
    } finally {
      await release();
    }
  });

program.command('test-source')
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

program.command('test-destination')
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
