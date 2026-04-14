import Database from 'better-sqlite3';
import { StateStore, SyncCheckpoint, SyncRecord } from './types.js';

export class SqliteStateStore implements StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        provider TEXT,
        account TEXT,
        last_received_at TEXT,
        last_message_id TEXT,
        PRIMARY KEY (provider, account)
      );

      CREATE TABLE IF NOT EXISTS seen_messages (
        provider TEXT,
        account TEXT,
        message_id TEXT,
        content_hash TEXT,
        received_at TEXT,
        import_timestamp TEXT,
        dest_provider TEXT,
        dest_mailbox TEXT,
        PRIMARY KEY (provider, account, message_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_seen_messages_hash ON seen_messages (content_hash);
    `);
  }

  async loadCheckpoint(provider: string, account: string): Promise<SyncCheckpoint> {
    const row = this.db
      .prepare(
        'SELECT last_received_at, last_message_id FROM checkpoints WHERE provider = ? AND account = ?'
      )
      .get(provider, account) as any;

    if (!row) return {};

    return {
      lastReceivedAt: row.last_received_at,
      lastMessageId: row.last_message_id,
    };
  }

  async saveCheckpoint(
    provider: string,
    account: string,
    checkpoint: SyncCheckpoint
  ): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO checkpoints (provider, account, last_received_at, last_message_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider, account) DO UPDATE SET
        last_received_at = excluded.last_received_at,
        last_message_id = excluded.last_message_id
    `
      )
      .run(provider, account, checkpoint.lastReceivedAt, checkpoint.lastMessageId);
  }

  async hasSeen(
    provider: string,
    account: string,
    messageId: string,
    contentHash?: string
  ): Promise<boolean> {
    const byId = this.db
      .prepare('SELECT 1 FROM seen_messages WHERE provider = ? AND account = ? AND message_id = ?')
      .get(provider, account, messageId);

    if (byId) return true;

    if (contentHash) {
      const byHash = this.db
        .prepare('SELECT 1 FROM seen_messages WHERE content_hash = ?')
        .get(contentHash);
      if (byHash) return true;
    }

    return false;
  }

  async markSeen(record: SyncRecord): Promise<void> {
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO seen_messages (
        provider, account, message_id, content_hash, received_at,
        import_timestamp, dest_provider, dest_mailbox
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        record.sourceProvider,
        record.sourceAccount,
        record.sourceMessageId,
        record.contentHash,
        record.receivedAt.toISOString(),
        record.importTimestamp.toISOString(),
        record.destinationProvider,
        record.destinationMailbox
      );
  }
}
