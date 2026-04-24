import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { LRUCache } from 'lru-cache';

import {
  type DestinationProvider,
  type Logger,
  type MessageMetadata,
  type PropagatableDeletion,
  type RestorationState,
} from '../../core/types.js';
import {
  CONTENT_HASH_HEADER,
  PROPAGATED_LABEL,
  SOURCE_MESSAGE_ID_HEADER,
  SOURCE_NAME_HEADER,
} from '../../core/constants.js';
import { getHeader, parseMessageId } from '../../core/mimeUtils.js';

export interface GmailConfig {
  /** Destination name from config.yaml (e.g. `gmail-main`). Used in log lines. */
  name: string;
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
const TRASH_FOLDER = '[Gmail]/Trash';
const SPAM_FOLDER = '[Gmail]/Spam';
const DELETION_SCAN_FOLDERS = [TRASH_FOLDER, SPAM_FOLDER] as const;

export class GmailImapDestination implements DestinationProvider {
  public readonly name: string;
  private readonly config: GmailConfig;
  private readonly logger: Logger;
  private readonly lru: LRUCache<string, true>;
  private client?: ImapFlow;
  private allMailPath?: string;

  constructor(config: GmailConfig) {
    this.config = config;
    this.name = config.name;
    this.logger = config.logger;
    this.lru = new LRUCache<string, true>({ max: LRU_MAX });
  }

  public async connect(): Promise<void> {
    if (this.client?.usable) return;

    if (this.client) {
      this.logger.info(`[${this.name}] connection is stale — discarding and reconnecting`);
      try {
        await this.client.logout();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.info(
          `[${this.name}] stale-client logout failed (socket likely already closed): ${message}`
        );
      }
      this.client = undefined;
      this.allMailPath = undefined;
    }

    const client = new ImapFlow({
      host: GMAIL_IMAP_HOST,
      port: GMAIL_IMAP_PORT,
      secure: true,
      auth: { user: this.config.email, pass: this.config.appPassword },
      logger: false,
    });
    // Register an error listener so async socket-level failures (TLS idle timeout,
    // remote RST, etc.) don't surface as Node's uncaught 'error' event and crash
    // the daemon between sync ticks. We drop our reference to the dead client so
    // the next connect() call rebuilds a fresh one.
    client.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[${this.name}] async error: ${message} (will reconnect on next use)`);
      if (this.client === client) {
        this.client = undefined;
        this.allMailPath = undefined;
      }
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
      this.logger.info(`[${this.name}] logout failed (socket likely already closed): ${message}`);
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

  public async listPropagatableDeletions(sourceName: string): Promise<PropagatableDeletion[]> {
    await this.connect();
    const results: PropagatableDeletion[] = [];

    for (const folder of DELETION_SCAN_FOLDERS) {
      try {
        await this.client!.mailboxOpen(folder);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.info(`[${this.name}] delete-sync: cannot open ${folder}: ${message}`);
        continue;
      }

      // Two distinct header-shaped tokens ANDed — Gmail's X-GM-RAW is full-text so a
      // user-forwarded message quoting one of these strings in the body could match,
      // but crafting a body that contains both as valid-looking headers is infeasible.
      // The post-fetch getHeader() check below enforces they are *actual* headers.
      const query = `"${SOURCE_NAME_HEADER}:${sourceName}" "${CONTENT_HASH_HEADER}:" -label:${PROPAGATED_LABEL}`;
      const uids = await this.gmailRawSearch(query);
      if (uids.length === 0) continue;

      const fetchQuery = {
        uid: true,
        emailId: true,
        headers: [SOURCE_NAME_HEADER, SOURCE_MESSAGE_ID_HEADER, CONTENT_HASH_HEADER, 'Message-ID'],
      } as Parameters<ImapFlow['fetch']>[1];

      for await (const msg of this.client!.fetch(uids, fetchQuery, {
        uid: true,
      }) as AsyncIterable<FetchMessageObject>) {
        const headers = msg.headers;
        if (!headers) continue;
        const buf = Buffer.isBuffer(headers) ? headers : Buffer.from(String(headers), 'latin1');
        const srcName = getHeader(buf, SOURCE_NAME_HEADER);
        const srcIdEncoded = getHeader(buf, SOURCE_MESSAGE_ID_HEADER);
        const contentHash = getHeader(buf, CONTENT_HASH_HEADER);
        // All three markers must be present as real headers for this to be one of ours.
        if (!srcName || !srcIdEncoded || !contentHash) continue;
        if (srcName !== sourceName) continue;
        const uid = typeof msg.uid === 'number' ? msg.uid : Number(msg.uid);
        if (!Number.isFinite(uid)) continue;
        const gmailMsgId = typeof msg.emailId === 'string' ? msg.emailId : undefined;
        if (!gmailMsgId) {
          // Without a stable Gmail ID we can't track restoration; skip.
          this.logger.debug(
            `[${this.name}] delete-sync: skipping UID ${uid} in ${folder} (no emailId/X-GM-MSGID)`
          );
          continue;
        }
        const rfcMessageId = parseMessageId(buf);
        results.push({
          folder,
          uid,
          sourceName: srcName,
          sourceIdEncoded: srcIdEncoded,
          gmailMsgId,
          rfcMessageId,
        });
      }
    }

    return results;
  }

  public async markPropagated(ref: { folder: string; uid: number }): Promise<void> {
    await this.connect();
    await this.client!.mailboxOpen(ref.folder);
    await this.client!.messageFlagsAdd({ uid: String(ref.uid) }, [PROPAGATED_LABEL], { uid: true });
  }

  public async checkRestoration(rfcMessageId: string): Promise<RestorationState> {
    await this.connect();
    await this.selectAllMailReadOnly();

    // Two Gmail searches, both scoped via X-GM-RAW:
    //  1. anywhere-count = message present *anywhere* in the account (incl. Trash/Spam)
    //  2. normal-count   = message present *outside* Trash/Spam (default X-GM-RAW scope)
    // Decision table:
    //   anywhere == 0          → hard-deleted
    //   normal   > 0           → restored (user moved it out of Trash)
    //   else                   → still in-trash-or-spam
    const quoted = rfcMessageId.replace(/"/g, '\\"');
    const anywhere = await this.gmailRawSearch(`rfc822msgid:${quoted} in:anywhere`);
    if (anywhere.length === 0) return 'hard-deleted';
    const normal = await this.gmailRawSearch(`rfc822msgid:${quoted}`);
    if (normal.length > 0) return 'restored';
    return 'in-trash-or-spam';
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
