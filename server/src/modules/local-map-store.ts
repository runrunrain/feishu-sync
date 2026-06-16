/**
 * LocalMapStore - SQLite-based mapping and log store
 *
 * Implements the schema from 技术实现文档 §十二:
 * - documents table: obj_token, wiki_node_token, obj_type, title, local_md_path,
 *                    last_synced_modify_time, last_synced_at, status
 * - sync_log table: sync_id, started_at, completed_at, success_count, error_count, duration
 * - run_log table: log_id, timestamp, level, message, context
 *
 * Uses better-sqlite3 synchronous API with prepared statements for performance.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import type { DocumentRecord, SyncResult } from '../types/index.js';

export class LocalMapStore {
  private db: Database.Database;
  private statements: Map<string, Database.Statement> = new Map();

  constructor(dbPath: string) {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    console.info(`[LocalMapStore] Database initialized at ${dbPath}`);
  }

  /**
   * Initialize database schema (create tables and indexes)
   */
  initialize(): void {
    this.db.exec(this.getCreateTablesDDL());
    console.info('[LocalMapStore] Database schema initialized');
  }

  /**
   * Upsert a document record
   */
  upsertDocument(record: DocumentRecord): void {
    const stmt = this.getStatement(`
      INSERT INTO documents (
        obj_token, wiki_node_token, obj_type, title, local_md_path,
        last_synced_modify_time, last_synced_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(obj_token) DO UPDATE SET
        wiki_node_token = excluded.wiki_node_token,
        obj_type = excluded.obj_type,
        title = excluded.title,
        local_md_path = excluded.local_md_path,
        last_synced_modify_time = excluded.last_synced_modify_time,
        last_synced_at = excluded.last_synced_at,
        status = excluded.status,
        updated_at = datetime('now')
    `);

    stmt.run(
      record.objToken,
      record.wikiNodeToken,
      record.objType,
      record.title,
      record.localMdPath,
      record.lastSyncedModifyTime,
      record.lastSyncedAt,
      record.status
    );
  }

  /**
   * Get document by obj_token
   */
  getDocumentByObjToken(objToken: string): DocumentRecord | null {
    const stmt = this.getStatement(`
      SELECT * FROM documents WHERE obj_token = ?
    `);

    const row = stmt.get(objToken) as any;
    return row ? this.mapRowToDocumentRecord(row) : null;
  }

  /**
   * Get document by wiki_node_token
   */
  getDocumentByWikiNodeToken(wikiNodeToken: string): DocumentRecord | null {
    const stmt = this.getStatement(`
      SELECT * FROM documents WHERE wiki_node_token = ?
    `);

    const row = stmt.get(wikiNodeToken) as any;
    return row ? this.mapRowToDocumentRecord(row) : null;
  }

  /**
   * Get all documents
   */
  getAllDocuments(): DocumentRecord[] {
    const stmt = this.getStatement(`
      SELECT * FROM documents ORDER BY title
    `);

    const rows = stmt.all() as any[];
    return rows.map((row) => this.mapRowToDocumentRecord(row));
  }

  /**
   * Update document status
   */
  updateDocumentStatus(objToken: string, status: DocumentRecord['status']): void {
    const stmt = this.getStatement(`
      UPDATE documents SET status = ?, updated_at = datetime('now') WHERE obj_token = ?
    `);

    stmt.run(status, objToken);
  }

  /**
   * Log a sync operation
   */
  logSync(result: SyncResult): void {
    const stmt = this.getStatement(`
      INSERT INTO sync_log (
        sync_id, started_at, completed_at, success_count, error_count, duration
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      this.generateSyncId(),
      result.startedAt,
      result.completedAt,
      result.syncedDocuments.length,
      result.failedDocuments.length,
      result.duration
    );
  }

  /**
   * Close database connection
   */
  close(): void {
    // Clear statement cache
    this.statements.clear();
    this.db.close();
    console.info('[LocalMapStore] Database connection closed');
  }

  /**
   * Get or prepare a statement (cached for performance)
   */
  private getStatement(sql: string): Database.Statement {
    if (!this.statements.has(sql)) {
      this.statements.set(sql, this.db.prepare(sql));
    }
    return this.statements.get(sql)!;
  }

  /**
   * Map a database row to DocumentRecord
   */
  private mapRowToDocumentRecord(row: any): DocumentRecord {
    return {
      objToken: row.obj_token,
      wikiNodeToken: row.wiki_node_token,
      objType: row.obj_type,
      title: row.title,
      localMdPath: row.local_md_path,
      lastSyncedModifyTime: row.last_synced_modify_time,
      lastSyncedAt: row.last_synced_at,
      status: row.status,
    };
  }

  /**
   * Generate a unique sync ID
   */
  private generateSyncId(): string {
    return `sync-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Get the CREATE TABLE DDL
   */
  private getCreateTablesDDL(): string {
    return `
      -- Documents mapping table
      CREATE TABLE IF NOT EXISTS documents (
        obj_token TEXT PRIMARY KEY,
        wiki_node_token TEXT,
        obj_type TEXT NOT NULL CHECK(obj_type IN ('docx', 'sheet', 'slides', 'unknown')),
        title TEXT NOT NULL,
        local_md_path TEXT NOT NULL,
        last_synced_modify_time TEXT NOT NULL,
        last_synced_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'synced' CHECK(status IN ('synced', 'changed', 'error', 'placeholder')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_documents_wiki_node_token ON documents(wiki_node_token);
      CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
      CREATE INDEX IF NOT EXISTS idx_documents_local_md_path ON documents(local_md_path);

      -- Sync log table
      CREATE TABLE IF NOT EXISTS sync_log (
        sync_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        success_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        duration INTEGER,
        context TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Run log table
      CREATE TABLE IF NOT EXISTS run_log (
        log_id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warn', 'error')),
        message TEXT NOT NULL,
        context TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_run_log_timestamp ON run_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_run_log_level ON run_log(level);
    `;
  }
}
