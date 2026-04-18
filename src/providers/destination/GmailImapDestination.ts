import { ImapFlow } from 'imapflow';
import { LRUCache } from 'lru-cache';
import { type DestinationProvider, type Logger, type MessageMetadata } from '../../core/types.js';
import { CONTENT_HASH_HEADER } from '../../core/constants.js';
import { getHeader, parseMessageId } from '../../core/mimeUtils.js';

export interface GmailConfig {
  email: string;
  appPassword: string;
  logger: Logger;
}

interface MailboxListEntry {
  path?: string;
  specialUse?: string;
}

interface CurrentMailbox {
  path?: string;
}

const GMAIL_IMAP_HOST = 'imap.gmail.com';
const GMAIL_IMAP_PORT = 993;
const LRU_MAX = 5_000;
const ALL_MAIL_FALLBACK = '[Gmail]/All Mail';

export class GmailImapDestination implements DestinationProvider {
  public readonly name = 'gmail-imap';
  private readonly config: GmailConfig;
  private readonly logger: Logger;
  private readonly lru: LRUCache<string, true>;
  private client?: ImapFlow;
  private allMailPath?: string;

  constructor(config: GmailConfig) {
    this.config = config;
    this.logger = config.logger;
    this.lru = new LRUCache<string, true>({ max: LRU_MAX });
  }

  public async connect(): Promise<void> {
    if (this.client) return;
    const client = new ImapFlow({
      host: GMAIL_IMAP_HOST,
      port: GMAIL_IMAP_PORT,
      secure: true,
      auth: { user: this.config.email, pass: this.config.appPassword },
      logger: false,
    });
    await client.connect();
    this.client = client;
    this.allMailPath = undefined;
  }

  public async disconnect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.debug(`Gmail logout threw (socket likely already closed): ${message}`);
    }
    this.client = undefined;
    this.allMailPath = undefined;
  }

  public async ensureReady(): Promise<void> {
    await this.connect();
    await this.findAllMail();
  }

  public async hasMessage(criteria: { messageId?: string; contentHash: string }): Promise<boolean> {
    const { messageId, contentHash } = criteria;
    const messageIdKey = messageId ? `m:${messageId}` : undefined;
    const hashKey = `h:${contentHash}`;
    if (messageIdKey && this.lru.has(messageIdKey)) return true;
    if (this.lru.has(hashKey)) return true;

    await this.connect();
    await this.selectAllMailReadOnly();

    if (messageId) {
      const uids = await this.gmailRawSearch(`rfc822msgid:${messageId}`);
      if (uids.length > 0) {
        if (messageIdKey) this.lru.set(messageIdKey, true);
        this.lru.set(hashKey, true);
        return true;
      }
    }

    const fallbackUids = await this.gmailRawSearch(`"${CONTENT_HASH_HEADER}:${contentHash}"`);
    if (fallbackUids.length > 0) {
      this.lru.set(hashKey, true);
      if (messageIdKey) this.lru.set(messageIdKey, true);
      return true;
    }

    return false;
  }

  public async storeRawMessage(
    rawMime: Buffer,
    metadata: MessageMetadata,
    options?: { targetMailbox?: string }
  ): Promise<void> {
    await this.connect();
    const mailbox = options?.targetMailbox ?? 'INBOX';
    await this.client!.append(mailbox, rawMime, [], metadata.receivedAt);

    const rfcMessageId = parseMessageId(rawMime);
    const contentHash = getHeader(rawMime, CONTENT_HASH_HEADER);
    if (rfcMessageId) this.lru.set(`m:${rfcMessageId}`, true);
    if (contentHash) this.lru.set(`h:${contentHash}`, true);
  }

  private async gmailRawSearch(rawQuery: string): Promise<number[]> {
    if (!this.client) throw new Error('GmailImapDestination: not connected');
    const searchArg = { gmailRaw: rawQuery } as Parameters<ImapFlow['search']>[0];
    const result = await this.client.search(searchArg, { uid: true });
    if (!result) return [];
    return result;
  }

  private async findAllMail(): Promise<string> {
    if (this.allMailPath) return this.allMailPath;
    if (!this.client) throw new Error('GmailImapDestination: not connected');
    const boxes = (await this.client.list()) as MailboxListEntry[];
    for (const box of boxes) {
      if (box.specialUse === '\\All' && typeof box.path === 'string') {
        this.allMailPath = box.path;
        return box.path;
      }
    }
    this.allMailPath = ALL_MAIL_FALLBACK;
    return this.allMailPath;
  }

  private async selectAllMailReadOnly(): Promise<void> {
    if (!this.client) throw new Error('GmailImapDestination: not connected');
    const path = await this.findAllMail();
    const current = this.client.mailbox as CurrentMailbox | false;
    if (!current || current.path !== path) {
      await this.client.mailboxOpen(path, { readOnly: true });
    }
  }
}
