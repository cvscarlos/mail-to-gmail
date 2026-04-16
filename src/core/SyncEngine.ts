import crypto from 'crypto';
import pRetry from 'p-retry';
import {
  SourceProvider,
  DestinationProvider,
  StateStore,
  Logger,
  SyncRecord,
  SyncFilter,
} from './types.js';

export interface SyncOptions {
  lookbackDays: number;
  maxMessages: number;
  concurrency: number;
  sourceFolders?: string[];
  targetMailbox?: string;
  dryRun?: boolean;
  filter?: SyncFilter;
}

export class SyncEngine {
  constructor(
    private source: SourceProvider,
    private destination: DestinationProvider,
    private state: StateStore,
    private logger: Logger
  ) {}

  async run(options: SyncOptions): Promise<void> {
    const mode = options.dryRun ? '[DRY RUN] ' : '';
    this.logger.info(`${mode}Starting sync run: ${this.source.name} -> ${this.destination.name}`);

    await this.source.connect();
    if (!options.dryRun) {
      await this.destination.connect();
      await this.destination.ensureReady();
    }

    const accountId = await this.source.getAccountId();
    let checkpoint = await this.state.loadCheckpoint(this.source.name, accountId);

    if (!checkpoint.lastReceivedAt && options.lookbackDays > 0) {
      const lookbackDate = new Date(Date.now() - options.lookbackDays * 24 * 60 * 60 * 1000);
      checkpoint = {
        lastReceivedAt: lookbackDate.toISOString(),
      };
      this.logger.info(
        `${mode}No checkpoint found. Initializing with lookback of ${options.lookbackDays} days (${checkpoint.lastReceivedAt})`
      );
    }

    this.logger.info(`${mode}Loaded checkpoint for ${accountId}: ${JSON.stringify(checkpoint)}`);

    const candidates = await this.source.listCandidateMessages(checkpoint, {
      folders: options.sourceFolders,
      limit: options.maxMessages,
    });
    this.logger.info(`${mode}Found ${candidates.length} candidate messages`);

    let processedCount = 0;
    let successCount = 0;
    let skipCount = 0;
    let filterCount = 0;
    let errorCount = 0;

    const latestCheckpoint = { ...checkpoint };

    for (const msg of candidates) {
      if (processedCount >= options.maxMessages) {
        this.logger.info(`${mode}Reached max messages limit (${options.maxMessages})`);
        break;
      }

      processedCount++;

      try {
        // Filter by subject if specified
        if (options.filter?.subjectContains && msg.subject) {
          const filterTerm = options.filter.subjectContains.toLowerCase();
          if (!msg.subject.toLowerCase().includes(filterTerm)) {
            filterCount++;
            this.logger.debug(`${mode}Message filtered out by subject: ${msg.subject}`);
            continue;
          }
        }

        const alreadySeen = await this.state.hasSeen(this.source.name, accountId, msg.id);
        if (alreadySeen) {
          skipCount++;
          this.logger.debug(`${mode}Skipping already seen message: ${msg.id}`);
          continue;
        }

        await pRetry(
          async () => {
            this.logger.info(
              `${mode}Processing message [${processedCount}/${candidates.length}]: ${msg.id} - ${msg.subject}`
            );

            const rawMime = await this.source.fetchRawMessage({ id: msg.id, accountId });
            const contentHash = crypto.createHash('sha256').update(rawMime).digest('hex');

            const hashSeen = await this.state.hasSeen(
              this.source.name,
              accountId,
              msg.id,
              contentHash
            );
            if (hashSeen) {
              this.logger.info(`${mode}Message content already seen by hash: ${msg.id}`);
              skipCount++;
              return;
            }

            if (options.dryRun) {
              this.logger.info(`[DRY RUN] Would have stored message: ${msg.subject}`);
            } else {
              await this.destination.storeRawMessage(rawMime, msg, {
                targetMailbox: options.targetMailbox,
              });

              const record: SyncRecord = {
                sourceProvider: this.source.name,
                sourceAccount: accountId,
                sourceMessageId: msg.id,
                receivedAt: msg.receivedAt,
                contentHash,
                importTimestamp: new Date(),
                destinationProvider: this.destination.name,
                destinationMailbox: options.targetMailbox || 'INBOX',
              };

              await this.state.markSeen(record);
            }

            successCount++;

            // Update checkpoint trackers
            if (
              !latestCheckpoint.lastReceivedAt ||
              msg.receivedAt.toISOString() > latestCheckpoint.lastReceivedAt
            ) {
              latestCheckpoint.lastReceivedAt = msg.receivedAt.toISOString();
              latestCheckpoint.lastMessageId = msg.id;
            }
          },
          {
            retries: options.dryRun ? 0 : 3,
            onFailedAttempt: (err) => {
              this.logger.warn(
                `${mode}Attempt ${err.attemptNumber} failed for message ${msg.id}: ${err.error.message}`
              );
            },
          }
        );
      } catch (err: any) {
        this.logger.error(`${mode}Failed to sync message ${msg.id}: ${err.message}`);
        errorCount++;
      }
    }

    if (!options.dryRun && latestCheckpoint.lastReceivedAt !== checkpoint.lastReceivedAt) {
      await this.state.saveCheckpoint(this.source.name, accountId, latestCheckpoint);
      this.logger.info(`${mode}Saved new checkpoint: ${JSON.stringify(latestCheckpoint)}`);
    }

    this.logger.info(
      `${mode}Sync completed: ${successCount} success, ${skipCount} skipped, ${filterCount} filtered, ${errorCount} errors`
    );

    await this.source.disconnect();
    if (!options.dryRun) {
      await this.destination.disconnect();
    }
  }
}
