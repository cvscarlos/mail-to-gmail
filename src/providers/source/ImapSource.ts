import { ImapFlow, type FetchMessageObject, type SearchObject } from 'imapflow';
import {
  type ListOptions,
  type Logger,
  type MessageMetadata,
  type MessageRef,
  type SourceProvider,
  type SyncCheckpoint,
} from '../../core/types.js';

export interface ImapSourceOptions {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  email: string;
  appPassword: string;
  logger: Logger;
}

interface FolderEntry {
  path: string;
  name: string;
  specialUse?: string;
}

interface RawListEntry {
  path?: string;
  name?: string;
  specialUse?: string;
  flags?: Set<string> | string[];
}

type IdleHandler = (sourceName: string) => void;

const DEFAULT_EXCLUDES = new Set(['Spam', 'Trash']);
const LIST_ID_BODY_PART = 'HEADER.FIELDS (LIST-ID)';
const MESSAGE_ID_DELIMITER = '\u0000';

function encodeMessageId(folderPath: string, uid: number): string {
  return `${folderPath}${MESSAGE_ID_DELIMITER}${uid}`;
}

function decodeMessageId(id: string): { folderPath: string; uid: number } {
  const delimIdx = id.indexOf(MESSAGE_ID_DELIMITER);
  if (delimIdx < 0) throw new Error(`Malformed IMAP message id: ${id}`);
  const folderPath = id.slice(0, delimIdx);
  const uid = Number(id.slice(delimIdx + 1));
  if (!Number.isFinite(uid)) throw new Error(`Malformed IMAP message id (uid): ${id}`);
  return { folderPath, uid };
}

function extractListIdFromHeaderBlock(
  headerSource: Buffer | string | undefined
): string | undefined {
  if (!headerSource) return undefined;
  const text = typeof headerSource === 'string' ? headerSource : headerSource.toString('latin1');
  const match = text.match(/^List-Id:\s*(.+)$/im);
  if (!match) return undefined;
  const value = match[1].trim();
  const angled = value.match(/<([^>]+)>/);
  return angled ? angled[1] : value;
}

function hasNoSelectFlag(flags: Set<string> | string[] | undefined): boolean {
  if (!flags) return false;
  if (flags instanceof Set) return flags.has('\\Noselect');
  return flags.includes('\\Noselect');
}

function isSpecialUseExcluded(specialUse: string | undefined): boolean {
  return specialUse === '\\Junk' || specialUse === '\\Trash';
}

function firstAddress(list: Array<{ address?: string }> | undefined): string | undefined {
  return list && list.length > 0 ? list[0].address : undefined;
}

function coerceDate(value: Date | string | undefined): Date {
  if (!value) return new Date();
  return value instanceof Date ? value : new Date(value);
}

export class ImapSource implements SourceProvider {
  public readonly name: string;
  private readonly options: ImapSourceOptions;
  private readonly logger: Logger;
  private client?: ImapFlow;
  private currentFolder?: string;
  private idleHandler?: IdleHandler;
  private idleFolder = 'INBOX';
  private onExistsListener?: () => void;
  private watching = false;

  constructor(options: ImapSourceOptions) {
    this.options = options;
    this.logger = options.logger;
    this.name = options.name;
  }

  public setIdleHandler(idleFolder: string, handler: IdleHandler): void {
    this.idleFolder = idleFolder;
    this.idleHandler = handler;
  }

  public async startIdleWatch(): Promise<void> {
    if (this.watching || !this.idleHandler) return;
    await this.connect();
    await this.selectFolder(this.idleFolder);
    this.onExistsListener = (): void => {
      if (this.idleHandler) this.idleHandler(this.name);
    };
    this.client!.on('exists', this.onExistsListener);
    this.watching = true;
  }

  public stopIdleWatch(): void {
    if (!this.watching) return;
    if (this.client && this.onExistsListener) {
      this.client.off('exists', this.onExistsListener);
    }
    this.onExistsListener = undefined;
    this.watching = false;
  }

  public async connect(): Promise<void> {
    if (this.client?.usable) return;

    if (this.client) {
      this.logger.info(`IMAP "${this.name}" connection is stale — discarding and reconnecting`);
      try {
        await this.client.logout();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.info(
          `IMAP "${this.name}" stale-client logout failed (socket likely already closed): ${message}`
        );
      }
      this.client = undefined;
      this.currentFolder = undefined;
    }

    const client = new ImapFlow({
      host: this.options.host,
      port: this.options.port,
      secure: this.options.tls,
      auth: { user: this.options.email, pass: this.options.appPassword },
      logger: false,
    });
    await client.connect();
    this.client = client;
    this.currentFolder = undefined;
  }

  public async disconnect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.info(
        `IMAP "${this.name}" logout failed (socket likely already closed): ${message}`
      );
    }
    this.client = undefined;
    this.currentFolder = undefined;
  }

  public async getAccountId(): Promise<string> {
    return this.options.email;
  }

  public async listCandidateMessages(
    checkpoint: SyncCheckpoint,
    options?: ListOptions
  ): Promise<MessageMetadata[]> {
    await this.connect();
    const folders = await this.listFolders();
    const targetFolders = this.selectTargetFolders(folders, options);

    const sinceDate = checkpoint.lastReceivedAt ? new Date(checkpoint.lastReceivedAt) : undefined;
    const limit = options?.limit;
    const wantsListId = !!options?.fetchListId;

    const all: MessageMetadata[] = [];

    for (const folder of targetFolders) {
      await this.selectFolder(folder.path);
      const uids = await this.searchFolder(sinceDate);
      if (uids.length === 0) continue;

      const sortedUids = [...uids].sort((a, b) => a - b);
      for await (const msg of this.fetchEnvelopes(sortedUids, wantsListId)) {
        const internalDate = coerceDate(msg.internalDate);
        if (sinceDate && internalDate < sinceDate) continue;

        all.push({
          id: encodeMessageId(folder.path, Number(msg.uid)),
          receivedAt: internalDate,
          subject: msg.envelope?.subject,
          from: firstAddress(msg.envelope?.from),
          to: firstAddress(msg.envelope?.to),
          listId: wantsListId ? readListIdFromBodyParts(msg.bodyParts) : undefined,
          folderId: folder.path,
          folderName: folder.name,
          rawSize: msg.size,
        });

        if (limit !== undefined && all.length >= limit) break;
      }
      if (limit !== undefined && all.length >= limit) break;
    }

    return all.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  }

  public async fetchRawMessage(ref: MessageRef): Promise<Buffer> {
    await this.connect();
    const { folderPath, uid } = decodeMessageId(ref.id);
    await this.selectFolder(folderPath);
    const msg = (await this.client!.fetchOne(String(uid), { source: true }, { uid: true })) as
      | FetchMessageObject
      | undefined;
    if (!msg || !msg.source) {
      throw new Error(`Message UID ${uid} not found in ${folderPath}`);
    }
    return Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source);
  }

  private selectTargetFolders(
    folders: FolderEntry[],
    options: ListOptions | undefined
  ): FolderEntry[] {
    const includeSet =
      options?.folders && !options.folders.includes('*') ? new Set(options.folders) : undefined;
    const excludeSet = new Set(options?.excludeFolders ?? [...DEFAULT_EXCLUDES]);

    return folders.filter((f) => {
      if (isSpecialUseExcluded(f.specialUse)) return false;
      if (includeSet && !includeSet.has(f.name) && !includeSet.has(f.path)) return false;
      if (excludeSet.has(f.name) || excludeSet.has(f.path)) return false;
      return true;
    });
  }

  private async searchFolder(sinceDate: Date | undefined): Promise<number[]> {
    const query: SearchObject = sinceDate ? { since: sinceDate } : { all: true };
    const result = await this.client!.search(query, { uid: true });
    return result ? result : [];
  }

  private fetchEnvelopes(
    uids: number[],
    includeListId: boolean
  ): AsyncIterable<FetchMessageObject> {
    const query: Record<string, unknown> = {
      envelope: true,
      internalDate: true,
      size: true,
      uid: true,
    };
    if (includeListId) query.bodyParts = [LIST_ID_BODY_PART];
    return this.client!.fetch(uids, query as Parameters<ImapFlow['fetch']>[1], { uid: true });
  }

  private async listFolders(): Promise<FolderEntry[]> {
    const boxes = (await this.client!.list()) as RawListEntry[];
    return boxes
      .filter((b): b is RawListEntry & { path: string; name: string } => {
        return (
          typeof b.path === 'string' && typeof b.name === 'string' && !hasNoSelectFlag(b.flags)
        );
      })
      .map((b) => ({ path: b.path, name: b.name, specialUse: b.specialUse }));
  }

  private async selectFolder(path: string): Promise<void> {
    if (this.currentFolder === path) return;
    await this.client!.mailboxOpen(path, { readOnly: true });
    this.currentFolder = path;
  }
}

function readListIdFromBodyParts(bodyParts: Map<string, Buffer> | undefined): string | undefined {
  if (!bodyParts) return undefined;
  for (const value of bodyParts.values()) {
    const headerListId = extractListIdFromHeaderBlock(value);
    if (headerListId) return headerListId;
  }
  return undefined;
}
