import { ImapFlow } from 'imapflow';
import { DestinationProvider, MessageMetadata } from '../../core/types.js';

export interface GmailConfig {
  email: string;
  appPassword: string;
}

const GMAIL_IMAP_HOST = 'imap.gmail.com';
const GMAIL_IMAP_PORT = 993;

export class GmailImapDestination implements DestinationProvider {
  public name = 'gmail-imap';
  private client?: ImapFlow;

  constructor(private config: GmailConfig) {}

  async connect(): Promise<void> {
    // ImapFlow instances are single-use (no reconnect after logout), so build a fresh one each run.
    this.client = new ImapFlow({
      host: GMAIL_IMAP_HOST,
      port: GMAIL_IMAP_PORT,
      secure: true,
      auth: { user: this.config.email, pass: this.config.appPassword },
      logger: false,
    });
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {
      // swallow: remote may have already closed the socket
    }
    this.client = undefined;
  }

  async ensureReady(): Promise<void> {
    if (!this.client) throw new Error('GmailImapDestination: connect() must be called first');
    await this.client.list();
  }

  async storeRawMessage(
    rawMime: Buffer,
    metadata: MessageMetadata,
    options?: { targetMailbox?: string }
  ): Promise<void> {
    if (!this.client) throw new Error('GmailImapDestination: connect() must be called first');
    const mailbox = options?.targetMailbox || 'INBOX';
    await this.client.append(mailbox, rawMime, [], metadata.receivedAt);
  }
}
