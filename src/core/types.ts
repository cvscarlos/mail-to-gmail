export interface MessageMetadata {
  id: string;
  receivedAt: Date;
  subject?: string;
  from?: string;
  to?: string;
  folderId?: string;
  folderName?: string;
  rawSize?: number;
}

export interface MessageRef {
  id: string;
  accountId: string;
  folderId?: string;
}

export interface SyncCheckpoint {
  lastReceivedAt?: string; // ISO String
  lastMessageId?: string;
}

export interface SourceProvider {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listCandidateMessages(
    checkpoint: SyncCheckpoint,
    options?: { folders?: string[]; limit?: number }
  ): Promise<MessageMetadata[]>;
  fetchRawMessage(messageRef: MessageRef): Promise<Buffer>;
  getAccountId(): Promise<string>;
}

export interface DestinationProvider {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ensureReady(): Promise<void>;
  storeRawMessage(
    rawMime: Buffer,
    metadata: MessageMetadata,
    options?: { targetMailbox?: string }
  ): Promise<void>;
}

export interface StateStore {
  loadCheckpoint(provider: string, account: string): Promise<SyncCheckpoint>;
  saveCheckpoint(provider: string, account: string, checkpoint: SyncCheckpoint): Promise<void>;
  hasSeen(
    provider: string,
    account: string,
    messageId: string,
    contentHash?: string
  ): Promise<boolean>;
  markSeen(record: SyncRecord): Promise<void>;
}

export interface SyncFilter {
  subjectContains?: string;
}

export interface SyncRecord {
  sourceProvider: string;
  sourceAccount: string;
  sourceMessageId: string;
  receivedAt: Date;
  contentHash: string;
  importTimestamp: Date;
  destinationProvider: string;
  destinationMailbox: string;
}

export interface Logger {
  info(message: string, ...meta: any[]): void;
  warn(message: string, ...meta: any[]): void;
  error(message: string, ...meta: any[]): void;
  debug(message: string, ...meta: any[]): void;
}
