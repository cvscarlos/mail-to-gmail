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
import { CONTENT_HASH_HEADER, SOURCE_MESSAGE_ID_HEADER, SOURCE_NAME_HEADER } from './constants.js';

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
    const sourceName = this.sourceConfig.name;
    const { schedule, filter } = this.sourceConfig;
    // Every log line produced by this run is prefixed with `[source-name] ` so
    // operators can grep a single source's activity across multiplexed output.
    // Dry-run modality lives inside the message body, not the prefix, to keep
    // the grep pattern stable across real and dry runs.
    const prefix = `[${sourceName}] `;
    const dryTag = dryRun ? '[DRY RUN] ' : '';

    this.logger.info(
      `${prefix}${dryTag}Starting sync → ${this.destinationConfig.name} (${this.destinationConfig.mailbox})`
    );

    await this.source.connect();
    await this.destination.connect();
    await this.destination.ensureReady();

    let checkpoint = await this.state.loadCheckpoint(sourceName);
    if (!checkpoint.lastReceivedAt && schedule.lookbackDays > 0) {
      const lookbackStart = new Date(Date.now() - schedule.lookbackDays * 86_400_000);
      checkpoint = { lastReceivedAt: lookbackStart.toISOString() };
      this.logger.info(
        `${prefix}No checkpoint. Using lookback of ${schedule.lookbackDays} day(s) → ${checkpoint.lastReceivedAt}`
      );
    }

    const wantsListId = filterRequiresListId(filter);
    const candidates = await this.source.listCandidateMessages(checkpoint, {
      folders: this.sourceConfig.folders,
      excludeFolders: this.sourceConfig.excludeFolders,
      fetchListId: wantsListId,
    });
    this.logger.info(`${prefix}${candidates.length} candidate(s)`);

    const latestCheckpoint: SyncCheckpoint = { ...checkpoint };
    let processed = 0;
    let imported = 0;
    let skipped = 0;
    let filtered = 0;
    let errors = 0;
    let dedupedViaGmail = 0;

    for (const msg of candidates) {
      if (abort?.aborted) {
        this.logger.info(`${prefix}Abort signal received — stopping mid-run`);
        break;
      }
      if (processed >= schedule.maxMessagesPerRun) {
        this.logger.info(`${prefix}Hit maxMessagesPerRun=${schedule.maxMessagesPerRun}; stopping`);
        break;
      }
      processed++;

      try {
        if (!matchesMetadataFilter(filter, msg, false)) {
          filtered++;
          this.logger.debug(`${prefix}Filtered out by metadata: ${msg.id} (${msg.subject ?? ''})`);
          continue;
        }

        if (await this.state.hasSeen(sourceName, msg.id)) {
          skipped++;
          this.logger.debug(`${prefix}Already seen locally: ${msg.id}`);
          continue;
        }

        await pRetry(
          async () => {
            this.logger.info(
              `${prefix}[${processed}/${candidates.length}] ${msg.id} — ${msg.subject ?? ''}`
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
              this.logger.debug(`${prefix}Filtered out by list-id (post-fetch): ${msg.id}`);
              return;
            }

            const contentHash = crypto.createHash('sha256').update(rawMime).digest('hex');

            if (await this.state.hasSeen(sourceName, msg.id, contentHash)) {
              skipped++;
              this.logger.info(`${prefix}Duplicate content-hash skipped: ${msg.id}`);
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
                `${prefix}Already in destination (Gmail-side dedup): ${msg.id} msgId=${rfcMessageId ?? 'none'}`
              );
              if (!dryRun) await this.recordSeen(msg, contentHash);
              return;
            }

            if (dryRun) {
              this.logger.info(`${prefix}${dryTag}Would APPEND: ${msg.id} — ${msg.subject ?? ''}`);
            } else {
              const withHash = injectHeader(rawMime, CONTENT_HASH_HEADER, contentHash);
              const withSource = injectHeader(withHash, SOURCE_NAME_HEADER, sourceName);
              const tagged = injectHeader(
                withSource,
                SOURCE_MESSAGE_ID_HEADER,
                encodeURIComponent(msg.id)
              );
              await this.destination.storeRawMessage(tagged, msg, {
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
                `${prefix}Attempt ${err.attemptNumber} failed for ${msg.id}: ${err.error.message}`
              );
            },
          }
        );
      } catch (err) {
        errors++;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`${prefix}Failed to sync ${msg.id}: ${message}`);
      }
    }

    if (!dryRun && latestCheckpoint.lastReceivedAt !== checkpoint.lastReceivedAt) {
      await this.state.saveCheckpoint(sourceName, latestCheckpoint);
      this.logger.info(`${prefix}Checkpoint → ${JSON.stringify(latestCheckpoint)}`);
    }

    this.logger.info(
      `${prefix}done: imported=${imported} skipped=${skipped} filtered=${filtered} gmail-dedup=${dedupedViaGmail} errors=${errors}`
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

  /**
   * Detect destination-side deletions (messages in Gmail Trash/Spam that we previously
   * imported) and propagate them to the source by moving the source copy to its Trash.
   * Runs only when `sourceConfig.deleteSync.enabled` is true. Safe to call every sync
   * iteration — no work when the destination has no tagged tombstones.
   */
  public async reconcileDeletions(options: SyncRunOptions = {}): Promise<void> {
    const { abort, dryRun = false } = options;
    const sourceName = this.sourceConfig.name;
    const cfg = this.sourceConfig.deleteSync;

    if (!cfg.enabled) {
      this.logger.debug(`[${sourceName}] delete-sync: disabled; skipping`);
      return;
    }

    const tag = `[${sourceName}] delete-sync:${dryRun ? ' [DRY RUN]' : ''} `;

    await this.destination.connect();
    const candidates = await this.destination.listPropagatableDeletions(sourceName);

    if (candidates.length === 0) {
      this.logger.debug(`${tag}no pending deletions`);
      return;
    }

    this.logger.info(`${tag}found ${candidates.length} pending deletion(s)`);

    const capped = candidates.slice(0, cfg.maxPropagationsPerRun);
    if (candidates.length > cfg.maxPropagationsPerRun) {
      this.logger.warn(
        `${tag}capping to maxPropagationsPerRun=${cfg.maxPropagationsPerRun} (${candidates.length - cfg.maxPropagationsPerRun} deferred to next run)`
      );
    }

    await this.source.connect();

    let propagated = 0;
    let errors = 0;
    for (const c of capped) {
      if (abort?.aborted) {
        this.logger.info(`${tag}abort signal received — stopping`);
        break;
      }
      const sourceMessageId = decodeURIComponent(c.sourceIdEncoded);
      try {
        if (dryRun) {
          this.logger.info(
            `${tag}would move source message to Trash: ${sourceMessageId} (Gmail ${c.folder} UID ${c.uid})`
          );
        } else {
          await this.source.deleteMessage({ id: sourceMessageId });
          await this.destination.markPropagated({ folder: c.folder, uid: c.uid });
          await this.state.recordPropagatedTombstone({
            gmailMsgId: c.gmailMsgId,
            sourceName,
            sourceMessageId,
            rfcMessageId: c.rfcMessageId,
            propagatedAt: new Date().toISOString(),
          });
          this.logger.info(
            `${tag}propagated delete: ${sourceMessageId} (Gmail ${c.folder} UID ${c.uid})`
          );
        }
        propagated++;
      } catch (err) {
        errors++;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`${tag}failed to propagate ${sourceMessageId}: ${message}`);
      }
    }

    this.logger.info(`${tag}done: propagated=${propagated} errors=${errors}`);
  }

  /**
   * Mirror Gmail-side restorations: for each tombstone we previously propagated,
   * check whether the Gmail copy is still in Trash/Spam. If the user has moved it
   * back into All Mail, restore the source copy from the source's Trash to INBOX.
   * If the Gmail copy is gone entirely (hard-deleted / Trash expired), forget it.
   */
  public async reconcileRestorations(options: SyncRunOptions = {}): Promise<void> {
    const { abort, dryRun = false } = options;
    const sourceName = this.sourceConfig.name;
    const cfg = this.sourceConfig.deleteSync;

    if (!cfg.enabled) return;

    const tag = `[${sourceName}] delete-sync (restore):${dryRun ? ' [DRY RUN]' : ''} `;

    const tombstones = await this.state.listPropagatedTombstones(sourceName);
    if (tombstones.length === 0) {
      this.logger.debug(`${tag}no tombstones to check`);
      return;
    }

    this.logger.debug(`${tag}checking ${tombstones.length} tombstone(s) for restoration`);

    await this.destination.connect();
    await this.source.connect();

    const maxAgeMs = RESTORATION_TRACKING_DAYS * 24 * 60 * 60 * 1000;
    const ageCutoff = Date.now() - maxAgeMs;
    let restored = 0;
    let hardDeleted = 0;
    let pending = 0;
    let expired = 0;
    let errors = 0;

    for (const t of tombstones) {
      if (abort?.aborted) {
        this.logger.info(`${tag}abort signal received — stopping`);
        break;
      }

      const propagatedAt = Date.parse(t.propagatedAt);
      if (Number.isFinite(propagatedAt) && propagatedAt < ageCutoff) {
        expired++;
        await this.state.removePropagatedTombstone(t.gmailMsgId);
        continue;
      }

      if (!t.rfcMessageId) {
        // Can't check restoration without a stable header-level identifier.
        // Leave the row; it'll age out via the ageCutoff path.
        pending++;
        continue;
      }

      try {
        const state = await this.destination.checkRestoration(t.rfcMessageId);
        if (state === 'in-trash-or-spam') {
          pending++;
          continue;
        }
        if (state === 'hard-deleted') {
          hardDeleted++;
          await this.state.removePropagatedTombstone(t.gmailMsgId);
          continue;
        }
        // state === 'restored'
        if (dryRun) {
          this.logger.info(
            `${tag}would restore source message: sourceId=${t.sourceMessageId} rfcId=${t.rfcMessageId}`
          );
        } else {
          await this.source.restoreMessage({
            rfcMessageId: t.rfcMessageId,
            sourceMessageId: t.sourceMessageId,
          });
          await this.state.removePropagatedTombstone(t.gmailMsgId);
          this.logger.info(
            `${tag}restored source message to INBOX: sourceId=${t.sourceMessageId} rfcId=${t.rfcMessageId}`
          );
        }
        restored++;
      } catch (err) {
        errors++;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `${tag}failed to check/restore rfcId=${t.rfcMessageId ?? '(none)'}: ${message}`
        );
      }
    }

    if (restored > 0 || hardDeleted > 0 || expired > 0 || errors > 0) {
      this.logger.info(
        `${tag}done: restored=${restored} hard-deleted=${hardDeleted} pending=${pending} expired=${expired} errors=${errors}`
      );
    }
  }
}

// How long we keep tracking a propagated tombstone. Gmail Trash auto-expires in
// 30 days; after ~35 we can safely forget — a restoration after that window is
// effectively impossible anyway.
const RESTORATION_TRACKING_DAYS = 35;
