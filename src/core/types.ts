export interface MessageMetadata {
  id: string;
  receivedAt: Date;
  subject?: string;
  from?: string;
  to?: string;
  listId?: string;
  folderId?: string;
  folderName?: string;
  rawSize?: number;
}

export interface MessageRef {
  id: string;
  folderId?: string;
  /**
   * Optional RFC 5322 Message-ID. When present, IMAP source providers can fall
   * back to a Message-ID HEADER search if the encoded UID has gone stale
   * (e.g. after a move-out-and-back round-trip on the source side).
   */
  rfcMessageId?: string;
}

export interface SyncCheckpoint {
  lastReceivedAt?: string;
  lastMessageId?: string;
}

export interface ListOptions {
  folders?: string[];
  excludeFolders?: string[];
  limit?: number;
  fetchListId?: boolean;
}

export interface RestoreRef {
  /** RFC 5322 Message-ID (used by IMAP providers to find the message in source Trash). */
  rfcMessageId?: string;
  /**
   * Original source-side identifier captured at propagation time (used by providers like
   * Zoho whose native IDs remain stable across folder moves).
   */
  sourceMessageId: string;
}

/**
 * Outcome of a source-side restore attempt.
 * - `restored`: the message was successfully moved out of source Trash back to INBOX.
 * - `not-in-trash`: the source no longer has the message in Trash (auto-classified to
 *   Spam/Bulk, expired, or otherwise gone). Tombstone should be dropped — there's
 *   nothing to act on.
 * Genuine errors (network, auth, transient) still throw.
 */
export type RestoreOutcome = 'restored' | 'not-in-trash';

export interface SourceProvider {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listCandidateMessages(
    checkpoint: SyncCheckpoint,
    options?: ListOptions
  ): Promise<MessageMetadata[]>;
  fetchRawMessage(messageRef: MessageRef): Promise<Buffer>;
  getAccountId(): Promise<string>;
  /**
   * Move the referenced message to the source's own Trash folder.
   * Called by delete-sync when a propagated deletion is detected in the destination.
   */
  deleteMessage(messageRef: MessageRef): Promise<void>;
  /**
   * Move a previously-trashed message back to the source's INBOX.
   * Called by delete-sync when a user restores a Gmail tombstone and we want to
   * mirror the restoration on the source side.
   */
  restoreMessage(ref: RestoreRef): Promise<RestoreOutcome>;
}

/**
 * A destination-side hit that should trigger a source-side delete.
 * Produced by DestinationProvider.listPropagatableDeletions().
 */
export interface PropagatableDeletion {
  /** Destination-side folder path where the deleted message was found (e.g. `[Gmail]/Trash`). */
  folder: string;
  /** Destination-side UID of the tombstone. */
  uid: number;
  /** Source name tagged on the destination message (matches config source name). */
  sourceName: string;
  /** Encoded source message id read from the destination message's header. */
  sourceIdEncoded: string;
  /** Gmail's stable X-GM-MSGID (emailId), for tracking across label changes. */
  gmailMsgId: string;
  /** RFC 5322 Message-ID parsed from the destination message's headers. */
  rfcMessageId?: string;
}

/**
 * Current state of a previously-propagated Gmail tombstone.
 * Used by delete-sync's restoration reconciliation pass to decide whether to
 * un-propagate (move source message back to INBOX) or simply forget about it.
 */
export type RestorationState = 'in-trash-or-spam' | 'restored' | 'hard-deleted';

export interface DestinationProvider {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ensureReady(): Promise<void>;
  hasMessage(criteria: { messageId?: string; contentHash: string }): Promise<boolean>;
  storeRawMessage(
    rawMime: Buffer,
    metadata: MessageMetadata,
    options?: { targetMailbox?: string }
  ): Promise<void>;
  /**
   * Return destination-side messages tagged with our markers for this source that
   * have landed in a "deleted" folder (Trash, Spam) and have not yet been propagated.
   */
  listPropagatableDeletions(sourceName: string): Promise<PropagatableDeletion[]>;
  /**
   * Apply the "we've propagated this" marker so future passes skip the message.
   */
  markPropagated(ref: { folder: string; uid: number }): Promise<void>;
  /**
   * Remove the propagated marker after a successful source-side restore. Without
   * this, a second delete on the destination would be silently filtered out by
   * `listPropagatableDeletions` (which excludes already-marked messages), so the
   * round-trip delete → restore → delete cycle would only propagate the first
   * deletion.
   */
  unmarkPropagated(gmailMsgId: string): Promise<void>;
  /**
   * Given a previously-propagated message's stable destination-side ID
   * (Gmail's X-GM-MSGID), determine whether it's still in Trash/Spam, has
   * been restored (moved back into All Mail), or has been permanently deleted
   * from the destination account.
   */
  checkRestoration(gmailMsgId: string): Promise<RestorationState>;
}

export interface PropagatedTombstoneRecord {
  gmailMsgId: string;
  sourceName: string;
  sourceMessageId: string;
  rfcMessageId?: string;
  propagatedAt: string;
}

export type PropagatedTombstone = PropagatedTombstoneRecord;

export interface StateStore {
  loadCheckpoint(sourceName: string): Promise<SyncCheckpoint>;
  saveCheckpoint(sourceName: string, checkpoint: SyncCheckpoint): Promise<void>;
  hasSeen(sourceName: string, messageId: string, contentHash?: string): Promise<boolean>;
  markSeen(record: SyncRecord): Promise<void>;
  resetSource(sourceName: string): Promise<void>;
  pruneSeenMessagesOlderThan(days: number): Promise<number>;
  recordPropagatedTombstone(row: PropagatedTombstoneRecord): Promise<void>;
  listPropagatedTombstones(sourceName: string): Promise<PropagatedTombstone[]>;
  removePropagatedTombstone(gmailMsgId: string): Promise<void>;
}

export interface SyncRecord {
  sourceName: string;
  sourceMessageId: string;
  receivedAt: Date;
  contentHash: string;
  importTimestamp: Date;
  destinationName: string;
  destinationMailbox: string;
}

export interface Logger {
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
  debug(message: string, ...meta: unknown[]): void;
}

export type SourceKind = 'zoho-api' | 'imap';
type ImapPreset = 'yahoo' | 'outlook';

export interface FilterConfig {
  subjectContains?: string[];
  fromContains?: string[];
  toContains?: string[];
  listIdContains?: string[];
}

interface ScheduleConfig {
  intervalMinutes: number;
  lookbackDays: number;
  maxMessagesPerRun: number;
}

interface DeleteSyncConfig {
  enabled: boolean;
  maxPropagationsPerRun: number;
}

interface ZohoSourceConfig {
  name: string;
  enabled: boolean;
  type: 'zoho-api';
  credentialsPrefix: string;
  destination: string;
  folders?: string[];
  excludeFolders?: string[];
  idle: false;
  schedule: ScheduleConfig;
  filter: FilterConfig;
  deleteSync: DeleteSyncConfig;
}

interface ImapSourceConfig {
  name: string;
  enabled: boolean;
  type: 'imap';
  preset?: ImapPreset;
  host?: string;
  port?: number;
  tls?: boolean;
  credentialsPrefix: string;
  destination: string;
  folders?: string[];
  excludeFolders?: string[];
  idle: boolean;
  idleFolder: string;
  schedule: ScheduleConfig;
  filter: FilterConfig;
  deleteSync: DeleteSyncConfig;
}

export type SourceConfig = ZohoSourceConfig | ImapSourceConfig;

export interface DestinationConfig {
  name: string;
  credentialsPrefix: string;
  mailbox: string;
}

export interface AppConfig {
  destinations: DestinationConfig[];
  sources: SourceConfig[];
}
