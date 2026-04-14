import { ImapFlow } from 'imapflow';
import { DestinationProvider, MessageMetadata } from '../../core/types.js';

export interface GmailConfig {
  host: string;
  port: number;
  email: string;
  appPassword: string;
}

export class GmailImapDestination implements DestinationProvider {
  public name = 'gmail-imap';
  private client: ImapFlow;

  constructor(private config: GmailConfig) {
    this.client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: true,
      auth: {
        user: config.email,
        pass: config.appPassword,
      },
      logger: false,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client.logout();
  }

  async ensureReady(): Promise<void> {
    // Check connection by listing mailboxes
    await this.client.list();
  }

  async storeRawMessage(rawMime: Buffer, metadata: MessageMetadata, options?: { targetMailbox?: string }): Promise<void> {
    const mailbox = options?.targetMailbox || 'INBOX';
    
    await this.client.append(mailbox, rawMime, [], metadata.receivedAt);
  }
}
