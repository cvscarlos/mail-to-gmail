import crypto from 'crypto';
import pRetry from 'p-retry';
import { SourceProvider, DestinationProvider, StateStore, Logger, SyncRecord } from './types.js';

export interface SyncOptions {
  lookbackMinutes: number;
  maxMessages: number;
  concurrency: number;
  sourceFolders?: string[];
  targetMailbox?: string;
}

export class SyncEngine {
  constructor(
    private source: SourceProvider,
    private destination: DestinationProvider,
    private state: StateStore,
    private logger: Logger
  ) {}

  async run(options: SyncOptions): Promise<void> {
    this.logger.info(`Starting sync run: ${this.source.name} -> ${this.destination.name}`);

    await this.source.connect();
    await this.destination.connect();
    await this.destination.ensureReady();

    const accountId = await this.source.getAccountId();
    const checkpoint = await this.state.loadCheckpoint(this.source.name, accountId);

    this.logger.info(`Loaded checkpoint for ${accountId}: ${JSON.stringify(checkpoint)}`);

    const candidates = await this.source.listCandidateMessages(checkpoint, {
      folders: options.sourceFolders,
    });
    this.logger.info(`Found ${candidates.length} candidate messages`);

    let processedCount = 0;
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    let latestCheckpoint = { ...checkpoint };

    for (const msg of candidates) {
      if (processedCount >= options.maxMessages) {
        this.logger.info(`Reached max messages limit (${options.maxMessages})`);
        break;
      }

      processedCount++;

      try {
        const alreadySeen = await this.state.hasSeen(this.source.name, accountId, msg.id);
        if (alreadySeen) {
          skipCount++;
          this.logger.debug(`Skipping already seen message: ${msg.id}`);
          continue;
        }

        await pRetry(
          async () => {
            this.logger.info(
              `Processing message [${processedCount}/${candidates.length}]: ${msg.id} - ${msg.subject}`
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
              this.logger.info(`Message content already seen by hash: ${msg.id}`);
              skipCount++;
              return;
            }

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
            retries: 3,
            onFailedAttempt: (err) => {
              this.logger.warn(
                `Attempt ${err.attemptNumber} failed for message ${msg.id}: ${err.error.message}`
              );
            },
          }
        );
      } catch (err: any) {
        this.logger.error(`Failed to sync message ${msg.id}: ${err.message}`);
        errorCount++;
      }
    }

    if (latestCheckpoint.lastReceivedAt !== checkpoint.lastReceivedAt) {
      await this.state.saveCheckpoint(this.source.name, accountId, latestCheckpoint);
      this.logger.info(`Saved new checkpoint: ${JSON.stringify(latestCheckpoint)}`);
    }

    this.logger.info(
      `Sync completed: ${successCount} success, ${skipCount} skipped, ${errorCount} errors`
    );

    await this.source.disconnect();
    await this.destination.disconnect();
  }
}
