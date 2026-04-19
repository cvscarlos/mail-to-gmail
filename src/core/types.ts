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
}

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
}

export interface StateStore {
  loadCheckpoint(sourceName: string): Promise<SyncCheckpoint>;
  saveCheckpoint(sourceName: string, checkpoint: SyncCheckpoint): Promise<void>;
  hasSeen(sourceName: string, messageId: string, contentHash?: string): Promise<boolean>;
  markSeen(record: SyncRecord): Promise<void>;
  resetSource(sourceName: string): Promise<void>;
  pruneSeenMessagesOlderThan(days: number): Promise<number>;
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
export type ImapPreset = 'yahoo' | 'outlook';

export interface FilterConfig {
  subjectContains?: string[];
  fromContains?: string[];
  toContains?: string[];
  listIdContains?: string[];
}

export interface ScheduleConfig {
  intervalMinutes: number;
  lookbackDays: number;
  maxMessagesPerRun: number;
}

export interface ZohoSourceConfig {
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
}

export interface ImapSourceConfig {
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
