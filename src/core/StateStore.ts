import Database from 'libsql';
import { type StateStore, type SyncCheckpoint, type SyncRecord } from './types.js';

type Statement = Database.Statement<unknown[]>;

const SCHEMA_VERSION = 2;

export interface StateStoreOptions {
  legacySourceName?: string;
}

export class SqliteStateStore implements StateStore {
  private db: Database.Database;
  private stmtLoad!: Statement;
  private stmtSave!: Statement;
  private stmtHasSeenById!: Statement;
  private stmtHasSeenByHash!: Statement;
  private stmtMarkSeen!: Statement;
  private stmtResetSeen!: Statement;
  private stmtResetCheckpoint!: Statement;

  constructor(dbPath: string, options: StateStoreOptions = {}) {
    this.db = new Database(dbPath);
    this.migrate(options.legacySourceName ?? 'zoho-main');
    this.prepareStatements();
  }

  private migrate(legacySourceName: string): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const applied = this.db
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(SCHEMA_VERSION);

    if (applied) return;

    const legacyExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoints'")
      .get() as { name: string } | undefined;

    if (!legacyExists) {
      this.createV2Schema();
      this.db
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(SCHEMA_VERSION, new Date().toISOString());
      return;
    }

    const cols = this.db.prepare('PRAGMA table_info(checkpoints)').all() as { name: string }[];
    const hasSourceName = cols.some((c) => c.name === 'source_name');

    if (hasSourceName) {
      this.db
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(SCHEMA_VERSION, new Date().toISOString());
      return;
    }

    this.migrateV1ToV2(legacySourceName);
  }

  private createV2Schema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        source_name TEXT PRIMARY KEY,
        last_received_at TEXT,
        last_message_id TEXT
      );

      CREATE TABLE IF NOT EXISTS seen_messages (
        source_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content_hash TEXT,
        received_at TEXT,
        import_timestamp TEXT,
        dest_name TEXT,
        dest_mailbox TEXT,
        PRIMARY KEY (source_name, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_seen_messages_hash ON seen_messages (content_hash);
    `);
  }

  private migrateV1ToV2(legacySourceName: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec(`
        CREATE TABLE checkpoints_v2 (
          source_name TEXT PRIMARY KEY,
          last_received_at TEXT,
          last_message_id TEXT
        );
      `);
      this.db
        .prepare(
          `INSERT INTO checkpoints_v2 (source_name, last_received_at, last_message_id)
           SELECT ?, last_received_at, last_message_id FROM checkpoints LIMIT 1`
        )
        .run(legacySourceName);
      this.db.exec('DROP TABLE checkpoints');
      this.db.exec('ALTER TABLE checkpoints_v2 RENAME TO checkpoints');

      this.db.exec(`
        CREATE TABLE seen_messages_v2 (
          source_name TEXT NOT NULL,
          message_id TEXT NOT NULL,
          content_hash TEXT,
          received_at TEXT,
          import_timestamp TEXT,
          dest_name TEXT,
          dest_mailbox TEXT,
          PRIMARY KEY (source_name, message_id)
        );
      `);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO seen_messages_v2
           (source_name, message_id, content_hash, received_at, import_timestamp, dest_name, dest_mailbox)
           SELECT ?, message_id, content_hash, received_at, import_timestamp, dest_provider, dest_mailbox
           FROM seen_messages`
        )
        .run(legacySourceName);
      this.db.exec('DROP TABLE seen_messages');
      this.db.exec('ALTER TABLE seen_messages_v2 RENAME TO seen_messages');
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_seen_messages_hash ON seen_messages (content_hash)'
      );

      this.db
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(SCHEMA_VERSION, new Date().toISOString());

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private prepareStatements(): void {
    this.stmtLoad = this.db.prepare(
      'SELECT last_received_at, last_message_id FROM checkpoints WHERE source_name = ?'
    );
    this.stmtSave = this.db.prepare(`
      INSERT INTO checkpoints (source_name, last_received_at, last_message_id)
      VALUES (?, ?, ?)
      ON CONFLICT(source_name) DO UPDATE SET
        last_received_at = excluded.last_received_at,
        last_message_id = excluded.last_message_id
    `);
    this.stmtHasSeenById = this.db.prepare(
      'SELECT 1 FROM seen_messages WHERE source_name = ? AND message_id = ?'
    );
    this.stmtHasSeenByHash = this.db.prepare(
      'SELECT 1 FROM seen_messages WHERE source_name = ? AND content_hash = ?'
    );
    this.stmtMarkSeen = this.db.prepare(`
      INSERT OR IGNORE INTO seen_messages (
        source_name, message_id, content_hash, received_at,
        import_timestamp, dest_name, dest_mailbox
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtResetSeen = this.db.prepare('DELETE FROM seen_messages WHERE source_name = ?');
    this.stmtResetCheckpoint = this.db.prepare('DELETE FROM checkpoints WHERE source_name = ?');
  }

  public async loadCheckpoint(sourceName: string): Promise<SyncCheckpoint> {
    const row = this.stmtLoad.get(sourceName) as
      | { last_received_at: string | null; last_message_id: string | null }
      | undefined;
    if (!row) return {};
    return {
      lastReceivedAt: row.last_received_at ?? undefined,
      lastMessageId: row.last_message_id ?? undefined,
    };
  }

  public async saveCheckpoint(sourceName: string, checkpoint: SyncCheckpoint): Promise<void> {
    this.stmtSave.run(sourceName, checkpoint.lastReceivedAt, checkpoint.lastMessageId);
  }

  public async hasSeen(
    sourceName: string,
    messageId: string,
    contentHash?: string
  ): Promise<boolean> {
    if (this.stmtHasSeenById.get(sourceName, messageId)) return true;
    if (contentHash && this.stmtHasSeenByHash.get(sourceName, contentHash)) return true;
    return false;
  }

  public async markSeen(record: SyncRecord): Promise<void> {
    this.stmtMarkSeen.run(
      record.sourceName,
      record.sourceMessageId,
      record.contentHash,
      record.receivedAt.toISOString(),
      record.importTimestamp.toISOString(),
      record.destinationName,
      record.destinationMailbox
    );
  }

  public async resetSource(sourceName: string): Promise<void> {
    this.db.exec('BEGIN');
    try {
      this.stmtResetCheckpoint.run(sourceName);
      this.stmtResetSeen.run(sourceName);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public close(): void {
    this.db.close();
  }
}
