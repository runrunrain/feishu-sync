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
   * Upsert a document record.
   *
   * v0.2.0 mapping-expansion fields (parent_node_token, space_id,
   * obj_edit_time, cloud_deleted, last_seen_at, local_sort_order) are
   * optional. When omitted the column keeps its previous value on UPDATE
   * (COALESCE pattern) so callers that only know about v0.1.0 fields do
   * not clobber mapping metadata written by change-detector / reorder API.
   *
   * local_sort_order is intentionally never written here — it is a
   * user-owned field updated only via setSortOrder(). upsertDocument uses
   * COALESCE to preserve whatever value the row currently holds.
   */
  upsertDocument(record: DocumentRecord): void {
    const stmt = this.getStatement(`
      INSERT INTO documents (
        obj_token, wiki_node_token, obj_type, title, local_md_path,
        last_synced_modify_time, last_synced_at, status,
        parent_node_token, space_id, obj_edit_time,
        cloud_deleted, last_seen_at, local_sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(obj_token) DO UPDATE SET
        wiki_node_token = COALESCE(excluded.wiki_node_token, documents.wiki_node_token),
        obj_type = COALESCE(excluded.obj_type, documents.obj_type),
        title = excluded.title,
        local_md_path = excluded.local_md_path,
        last_synced_modify_time = excluded.last_synced_modify_time,
        last_synced_at = excluded.last_synced_at,
        status = excluded.status,
        parent_node_token = COALESCE(excluded.parent_node_token, documents.parent_node_token),
        space_id = COALESCE(excluded.space_id, documents.space_id),
        obj_edit_time = COALESCE(excluded.obj_edit_time, documents.obj_edit_time),
        cloud_deleted = COALESCE(excluded.cloud_deleted, documents.cloud_deleted),
        last_seen_at = COALESCE(excluded.last_seen_at, documents.last_seen_at),
        local_sort_order = documents.local_sort_order,
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
      record.status,
      record.parentNodeToken ?? null,
      record.spaceId ?? null,
      record.objEditTime ?? null,
      record.cloudDeleted ?? 0,
      record.lastSeenAt ?? null,
      record.localSortOrder ?? null,
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

  // -------------------------------------------------------------------------
  // v0.2.0 mapping-expansion methods (P1-T4)
  // -------------------------------------------------------------------------

  /**
   * Record that a node was seen during cloud traversal, refreshing its
   * parent / space / edit-time / last_seen_at metadata without disturbing
   * status or local_md_path (which are owned by the sync flow).
   *
   * Used by ChangeDetector.compareWithLocalRecords (see 03 §3.3.1).
   *
   * local_sort_order is never touched here (user-owned).
   */
  upsertDocumentSeen(input: {
    objToken: string;
    wikiNodeToken?: string | null;
    parentNodeToken?: string | null;
    spaceId?: string | null;
    objEditTime?: number | null;
    lastSeenAt: string;
  }): void {
    const stmt = this.getStatement(`
      INSERT INTO documents (
        obj_token, wiki_node_token, obj_type, title, local_md_path,
        last_synced_modify_time, last_synced_at, status,
        parent_node_token, space_id, obj_edit_time, last_seen_at
      ) VALUES (?, ?, 'unknown', '', '', '', ?, 'placeholder', ?, ?, ?, ?)
      ON CONFLICT(obj_token) DO UPDATE SET
        wiki_node_token = COALESCE(excluded.wiki_node_token, documents.wiki_node_token),
        parent_node_token = COALESCE(excluded.parent_node_token, documents.parent_node_token),
        space_id = COALESCE(excluded.space_id, documents.space_id),
        obj_edit_time = COALESCE(excluded.obj_edit_time, documents.obj_edit_time),
        last_seen_at = excluded.last_seen_at,
        updated_at = datetime('now')
    `);

    stmt.run(
      input.objToken,
      input.wikiNodeToken ?? null,
      input.lastSeenAt,
      input.parentNodeToken ?? null,
      input.spaceId ?? null,
      input.objEditTime ?? null,
      input.lastSeenAt,
    );
  }

  /**
   * Mark a document as cloud-deleted (soft delete). The local .md is left
   * in place; the UI surfaces these rows for user confirmation before
   * physical cleanup.
   */
  markCloudDeleted(objToken: string, timestamp: string): void {
    const stmt = this.getStatement(`
      UPDATE documents
      SET cloud_deleted = 1, last_seen_at = ?, updated_at = datetime('now')
      WHERE obj_token = ?
    `);
    stmt.run(timestamp, objToken);
  }

  /**
   * User-driven local sort order update (decision 5: local-only drag reorder).
   * Accepts a parent scope + ordered obj_tokens; assigns 0..N as the
   * local_sort_order of each child. Rows whose parent doesn't match are
   * rejected by the caller (P2 reorder API).
   *
   * Note: parent_node_token may be NULL for top-level nodes; we handle both
   * by binding the same parentToken value (NULL or string) to the WHERE.
   */
  setSortOrder(parentNodeToken: string | null, orderedObjTokens: string[]): number {
    if (orderedObjTokens.length === 0) return 0;
    const update = this.db.transaction((tokens: string[]) => {
      const stmt = this.db.prepare(`
        UPDATE documents
        SET local_sort_order = ?, updated_at = datetime('now')
        WHERE obj_token = ? AND parent_node_token IS ?
      `);
      let updated = 0;
      tokens.forEach((tok, idx) => {
        const r = stmt.run(idx, tok, parentNodeToken);
        updated += r.changes;
      });
      return updated;
    });
    return update(orderedObjTokens);
  }

  /**
   * Upsert a sub-sheet mapping row (sheet_sheets table).
   * PK is (sheet_obj_token, sheet_id).
   */
  upsertSheetSheet(record: {
    sheetObjToken: string;
    sheetId: string;
    sheetTitle: string;
    localCsvPath: string;
    localMdPath?: string | null;
    lastSyncedModifyTime?: string | null;
    status?: 'synced' | 'changed' | 'error' | 'placeholder';
  }): void {
    const stmt = this.getStatement(`
      INSERT INTO sheet_sheets (
        sheet_obj_token, sheet_id, sheet_title, local_csv_path,
        local_md_path, last_synced_modify_time, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sheet_obj_token, sheet_id) DO UPDATE SET
        sheet_title = excluded.sheet_title,
        local_csv_path = excluded.local_csv_path,
        local_md_path = COALESCE(excluded.local_md_path, sheet_sheets.local_md_path),
        last_synced_modify_time = COALESCE(excluded.last_synced_modify_time, sheet_sheets.last_synced_modify_time),
        status = excluded.status,
        updated_at = datetime('now')
    `);

    stmt.run(
      record.sheetObjToken,
      record.sheetId,
      record.sheetTitle,
      record.localCsvPath,
      record.localMdPath ?? null,
      record.lastSyncedModifyTime ?? null,
      record.status ?? 'synced',
    );
  }

  /**
   * List all sub-sheet rows for a given workbook obj_token.
   */
  getSheetSheets(sheetObjToken: string): Array<{
    sheet_obj_token: string;
    sheet_id: string;
    sheet_title: string;
    local_csv_path: string;
    local_md_path: string | null;
    last_synced_modify_time: string | null;
    status: string;
    created_at: string;
    updated_at: string;
  }> {
    const stmt = this.getStatement(`
      SELECT * FROM sheet_sheets WHERE sheet_obj_token = ? ORDER BY sheet_id
    `);
    return stmt.all(sheetObjToken) as any[];
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
   * Map a database row to DocumentRecord.
   * v0.2.0 columns are read defensively; if a migration was rolled back
   * the columns may be absent and the row object won't contain them — we
   * fall back to undefined rather than throwing.
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
      parentNodeToken: row.parent_node_token ?? null,
      spaceId: row.space_id ?? null,
      objEditTime: row.obj_edit_time ?? null,
      cloudDeleted: row.cloud_deleted ?? 0,
      lastSeenAt: row.last_seen_at ?? null,
      localSortOrder: row.local_sort_order ?? null,
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
