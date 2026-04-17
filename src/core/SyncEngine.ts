import crypto from 'crypto';
import pRetry from 'p-retry';
import {
  type DestinationConfig,
  type DestinationProvider,
  type FilterConfig,
  type Logger,
  type MessageMetadata,
  type SourceConfig,
  type SourceProvider,
  type StateStore,
  type SyncCheckpoint,
  type SyncRecord,
} from './types.js';
import { injectHeader, parseListId, parseMessageId } from './mimeUtils.js';
import { CONTENT_HASH_HEADER } from './constants.js';

export interface SyncEngineArgs {
  sourceConfig: SourceConfig;
  source: SourceProvider;
  destinationConfig: DestinationConfig;
  destination: DestinationProvider;
  state: StateStore;
  logger: Logger;
}

export interface SyncRunOptions {
  dryRun?: boolean;
  abort?: AbortSignal;
}

function matchesMetadataFilter(
  filter: FilterConfig,
  msg: MessageMetadata,
  includeListId: boolean
): boolean {
  const check = (needles: string[] | undefined, hay: string | undefined): boolean => {
    if (!needles || needles.length === 0) return true;
    if (!hay) return false;
    const lower = hay.toLowerCase();
    return needles.some((n) => lower.includes(n.toLowerCase()));
  };
  if (!check(filter.subjectContains, msg.subject)) return false;
  if (!check(filter.fromContains, msg.from)) return false;
  if (!check(filter.toContains, msg.to)) return false;
  if (includeListId && !check(filter.listIdContains, msg.listId)) return false;
  return true;
}

function filterRequiresListId(filter: FilterConfig): boolean {
  return !!filter.listIdContains && filter.listIdContains.length > 0;
}

export class SyncEngine {
  private readonly sourceConfig: SourceConfig;
  private readonly source: SourceProvider;
  private readonly destinationConfig: DestinationConfig;
  private readonly destination: DestinationProvider;
  private readonly state: StateStore;
  private readonly logger: Logger;

  constructor(args: SyncEngineArgs) {
    this.sourceConfig = args.sourceConfig;
    this.source = args.source;
    this.destinationConfig = args.destinationConfig;
    this.destination = args.destination;
    this.state = args.state;
    this.logger = args.logger;
  }

  public async run(options: SyncRunOptions = {}): Promise<void> {
    const { abort, dryRun = false } = options;
    const tag = dryRun ? '[DRY RUN] ' : '';
    const sourceName = this.sourceConfig.name;
    const { schedule, filter } = this.sourceConfig;

    this.logger.info(
      `${tag}Starting sync: ${sourceName} → ${this.destinationConfig.name} (${this.destinationConfig.mailbox})`
    );

    await this.source.connect();
    await this.destination.connect();
    await this.destination.ensureReady();

    let checkpoint = await this.state.loadCheckpoint(sourceName);
    if (!checkpoint.lastReceivedAt && schedule.lookbackDays > 0) {
      const lookbackStart = new Date(Date.now() - schedule.lookbackDays * 86_400_000);
      checkpoint = { lastReceivedAt: lookbackStart.toISOString() };
      this.logger.info(
        `${tag}No checkpoint for "${sourceName}". Using lookback of ${schedule.lookbackDays} day(s) → ${checkpoint.lastReceivedAt}`
      );
    }

    const wantsListId = filterRequiresListId(filter);
    const candidates = await this.source.listCandidateMessages(checkpoint, {
      folders: this.sourceConfig.folders,
      excludeFolders: this.sourceConfig.excludeFolders,
      fetchListId: wantsListId,
    });
    this.logger.info(`${tag}${sourceName}: ${candidates.length} candidate(s)`);

    const latestCheckpoint: SyncCheckpoint = { ...checkpoint };
    let processed = 0;
    let imported = 0;
    let skipped = 0;
    let filtered = 0;
    let errors = 0;
    let dedupedViaGmail = 0;

    for (const msg of candidates) {
      if (abort?.aborted) {
        this.logger.info(`${tag}Abort signal received — stopping mid-run`);
        break;
      }
      if (processed >= schedule.maxMessagesPerRun) {
        this.logger.info(`${tag}Hit maxMessagesPerRun=${schedule.maxMessagesPerRun}; stopping`);
        break;
      }
      processed++;

      try {
        if (!matchesMetadataFilter(filter, msg, false)) {
          filtered++;
          this.logger.debug(`${tag}Filtered out by metadata: ${msg.id} (${msg.subject ?? ''})`);
          continue;
        }

        if (await this.state.hasSeen(sourceName, msg.id)) {
          skipped++;
          this.logger.debug(`${tag}Already seen locally: ${msg.id}`);
          continue;
        }

        await pRetry(
          async () => {
            this.logger.info(
              `${tag}${sourceName} [${processed}/${candidates.length}]: ${msg.id} — ${msg.subject ?? ''}`
            );

            const rawMime = await this.source.fetchRawMessage({
              id: msg.id,
              folderId: msg.folderId,
            });

            if (wantsListId && !msg.listId) {
              msg.listId = parseListId(rawMime);
            }

            if (!matchesMetadataFilter(filter, msg, true)) {
              filtered++;
              this.logger.debug(`${tag}Filtered out by list-id (post-fetch): ${msg.id}`);
              return;
            }

            const contentHash = crypto.createHash('sha256').update(rawMime).digest('hex');

            if (await this.state.hasSeen(sourceName, msg.id, contentHash)) {
              skipped++;
              this.logger.info(`${tag}Duplicate content-hash skipped: ${msg.id}`);
              return;
            }

            const rfcMessageId = parseMessageId(rawMime);

            const existsInDest = await this.destination.hasMessage({
              messageId: rfcMessageId,
              contentHash,
            });
            if (existsInDest) {
              dedupedViaGmail++;
              this.logger.info(
                `${tag}Already in destination (Gmail-side dedup): ${msg.id} msgId=${rfcMessageId ?? 'none'}`
              );
              if (!dryRun) await this.recordSeen(msg, contentHash);
              return;
            }

            if (dryRun) {
              this.logger.info(`${tag}Would APPEND: ${msg.id} — ${msg.subject ?? ''}`);
            } else {
              const withHashHeader = injectHeader(rawMime, CONTENT_HASH_HEADER, contentHash);
              await this.destination.storeRawMessage(withHashHeader, msg, {
                targetMailbox: this.destinationConfig.mailbox,
              });
              await this.recordSeen(msg, contentHash);
            }

            imported++;
            if (
              !latestCheckpoint.lastReceivedAt ||
              msg.receivedAt.toISOString() > latestCheckpoint.lastReceivedAt
            ) {
              latestCheckpoint.lastReceivedAt = msg.receivedAt.toISOString();
              latestCheckpoint.lastMessageId = msg.id;
            }
          },
          {
            retries: dryRun ? 0 : 3,
            onFailedAttempt: (err) => {
              this.logger.warn(
                `${tag}Attempt ${err.attemptNumber} failed for ${msg.id}: ${err.error.message}`
              );
            },
          }
        );
      } catch (err) {
        errors++;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`${tag}Failed to sync ${msg.id}: ${message}`);
      }
    }

    if (!dryRun && latestCheckpoint.lastReceivedAt !== checkpoint.lastReceivedAt) {
      await this.state.saveCheckpoint(sourceName, latestCheckpoint);
      this.logger.info(`${tag}Checkpoint → ${JSON.stringify(latestCheckpoint)}`);
    }

    this.logger.info(
      `${tag}${sourceName} done: imported=${imported} skipped=${skipped} filtered=${filtered} gmail-dedup=${dedupedViaGmail} errors=${errors}`
    );
  }

  private async recordSeen(msg: MessageMetadata, contentHash: string): Promise<void> {
    const record: SyncRecord = {
      sourceName: this.sourceConfig.name,
      sourceMessageId: msg.id,
      receivedAt: msg.receivedAt,
      contentHash,
      importTimestamp: new Date(),
      destinationName: this.destinationConfig.name,
      destinationMailbox: this.destinationConfig.mailbox,
    };
    await this.state.markSeen(record);
  }
}
