import Database from 'libsql';
import { StateStore, SyncCheckpoint, SyncRecord } from './types.js';

type Statement = Database.Statement<unknown[]>;

export class SqliteStateStore implements StateStore {
  private db: Database.Database;
  private stmtLoad: Statement;
  private stmtSave: Statement;
  private stmtHasSeenById: Statement;
  private stmtHasSeenByHash: Statement;
  private stmtMarkSeen: Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
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

    this.stmtLoad = this.db.prepare(
      'SELECT last_received_at, last_message_id FROM checkpoints WHERE provider = ? AND account = ?'
    );
    this.stmtSave = this.db.prepare(`
      INSERT INTO checkpoints (provider, account, last_received_at, last_message_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider, account) DO UPDATE SET
        last_received_at = excluded.last_received_at,
        last_message_id = excluded.last_message_id
    `);
    this.stmtHasSeenById = this.db.prepare(
      'SELECT 1 FROM seen_messages WHERE provider = ? AND account = ? AND message_id = ?'
    );
    this.stmtHasSeenByHash = this.db.prepare(
      'SELECT 1 FROM seen_messages WHERE content_hash = ?'
    );
    this.stmtMarkSeen = this.db.prepare(`
      INSERT OR IGNORE INTO seen_messages (
        provider, account, message_id, content_hash, received_at,
        import_timestamp, dest_provider, dest_mailbox
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  async loadCheckpoint(provider: string, account: string): Promise<SyncCheckpoint> {
    const row = this.stmtLoad.get(provider, account) as
      | { last_received_at: string; last_message_id: string }
      | undefined;
    if (!row) return {};
    return { lastReceivedAt: row.last_received_at, lastMessageId: row.last_message_id };
  }

  async saveCheckpoint(
    provider: string,
    account: string,
    checkpoint: SyncCheckpoint
  ): Promise<void> {
    this.stmtSave.run(provider, account, checkpoint.lastReceivedAt, checkpoint.lastMessageId);
  }

  async clearCheckpoints(): Promise<void> {
    this.db.exec('DELETE FROM checkpoints');
  }

  async hasSeen(
    provider: string,
    account: string,
    messageId: string,
    contentHash?: string
  ): Promise<boolean> {
    if (this.stmtHasSeenById.get(provider, account, messageId)) return true;
    if (contentHash && this.stmtHasSeenByHash.get(contentHash)) return true;
    return false;
  }

  async markSeen(record: SyncRecord): Promise<void> {
    this.stmtMarkSeen.run(
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

  close(): void {
    this.db.close();
  }
}
