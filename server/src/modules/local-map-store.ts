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
   * Initialize database schema (create tables and indexes).
   *
   * Also runs additive column migrations on existing databases so the
   * desktop runtime stays forward-compatible without requiring users to
   * invoke a separate migration script. Each ALTER is guarded by a
   * PRAGMA table_info check so it is a no-op on databases that already
   * have the column.
   *
   * Currently auto-migrated:
   *   - v0.2.0 mapping-expansion (migration_v2): parent_node_token,
   *     space_id, obj_edit_time, cloud_deleted, last_seen_at,
   *     local_sort_order
   *   - v0.2.0 cloud-link-coverage (migration_v3): original_link,
   *     cloud_match
   *   - v0.2.0 structure-align Phase B (migration_v4): watched_root_url
   *     + local_dirs table
   *
   * New fresh databases get all these columns via getCreateTablesDDL();
   * this method only matters for databases created by an older version.
   */
  initialize(): void {
    this.db.exec(this.getCreateTablesDDL());
    this.applyAdditiveMigrations();
    console.info('[LocalMapStore] Database schema initialized');
  }

  /**
   * Apply additive ALTER TABLE migrations guarded by PRAGMA table_info.
   * Each entry lists the column to add; if the column is missing we run
   * the ALTER inside a SAVEPOINT so a mid-migration failure rolls back
   * cleanly without corrupting the existing schema.
   *
   * Also creates v0.2.0+ indexes (idempotent — CREATE INDEX IF NOT EXISTS).
   * These must run AFTER the columns exist, so they cannot live in
   * getCreateTablesDDL() (which executes against a table that may not
   * have the columns yet on legacy databases).
   *
   * The cloud_match column is followed by an immediate backfill UPDATE
   * that classifies existing rows so legacy databases immediately have
   * a sensible distribution (synced / restricted / unknown) instead of
   * everything sitting at the 'unknown' default.
   */
  private applyAdditiveMigrations(): void {
    const currentCols = this.db.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>;
    const colNames = new Set(currentCols.map((c) => c.name));

    const additive: Array<{ name: string; dml: string }> = [
      // v0.2.0 mapping-expansion (migration_v2)
      { name: 'parent_node_token', dml: 'ALTER TABLE documents ADD COLUMN parent_node_token TEXT' },
      { name: 'space_id', dml: 'ALTER TABLE documents ADD COLUMN space_id TEXT' },
      { name: 'obj_edit_time', dml: 'ALTER TABLE documents ADD COLUMN obj_edit_time INTEGER' },
      { name: 'cloud_deleted', dml: "ALTER TABLE documents ADD COLUMN cloud_deleted INTEGER NOT NULL DEFAULT 0" },
      { name: 'last_seen_at', dml: 'ALTER TABLE documents ADD COLUMN last_seen_at TEXT' },
      { name: 'local_sort_order', dml: 'ALTER TABLE documents ADD COLUMN local_sort_order INTEGER' },
      // v0.2.0 cloud-link-coverage (migration_v3)
      { name: 'original_link', dml: 'ALTER TABLE documents ADD COLUMN original_link TEXT' },
      { name: 'cloud_match', dml: "ALTER TABLE documents ADD COLUMN cloud_match TEXT NOT NULL DEFAULT 'unknown'" },
      // v0.2.0 structure-align Phase B (migration_v4)
      { name: 'watched_root_url', dml: 'ALTER TABLE documents ADD COLUMN watched_root_url TEXT' },
    ];

    const pending = additive.filter((c) => !colNames.has(c.name));

    // ALTERs must happen in a transaction so a mid-migration failure
    // rolls back. Indexes (CREATE INDEX IF NOT EXISTS) are idempotent
    // and safe to run after the transaction commits.
    if (pending.length > 0) {
      const tx = this.db.transaction(() => {
        for (const col of pending) {
          this.db.exec(col.dml);
          console.info(`[LocalMapStore] Auto-migration: + documents.${col.name}`);
        }
        // If cloud_match was freshly added, backfill it immediately so the
        // UI doesn't show every legacy row as "未分类" until the next rebuild.
        const addedCloudMatch = pending.some((c) => c.name === 'cloud_match');
        if (addedCloudMatch) {
          this.db.exec(`
            UPDATE documents
            SET cloud_match = CASE
              WHEN title IS NOT NULL AND title <> '' THEN 'synced'
              WHEN obj_token IS NOT NULL AND obj_token <> '' THEN 'restricted'
              ELSE 'unknown'
            END
          `);
          // Backfill original_link for placeholder/restricted rows so the
          // UI has something to render before the next full rebuild.
          this.db.exec(`
            UPDATE documents
            SET original_link = 'https://qcnbafdrjx7n.feishu.cn/wiki/' || wiki_node_token
            WHERE (original_link IS NULL OR original_link = '')
              AND wiki_node_token IS NOT NULL
              AND wiki_node_token <> ''
          `);
        }
      });
      tx();
      console.info(`[LocalMapStore] Auto-migration complete (${pending.length} columns added)`);
    }

    // v0.2.0+ indexes. Run unconditionally (CREATE INDEX IF NOT EXISTS is
    // idempotent). On fresh DBs the columns already exist; on legacy DBs
    // the ALTER above just added them. Either way the indexes can now be
    // created safely.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_node_token);
      CREATE INDEX IF NOT EXISTS idx_documents_space ON documents(space_id);
      CREATE INDEX IF NOT EXISTS idx_documents_cloud_deleted ON documents(cloud_deleted);
      CREATE INDEX IF NOT EXISTS idx_documents_obj_edit_time ON documents(obj_edit_time);
      CREATE INDEX IF NOT EXISTS idx_documents_parent_sort ON documents(parent_node_token, local_sort_order);
      CREATE INDEX IF NOT EXISTS idx_documents_cloud_match ON documents(cloud_match);
      CREATE INDEX IF NOT EXISTS idx_documents_original_link ON documents(original_link);
      CREATE INDEX IF NOT EXISTS idx_documents_watched_root ON documents(watched_root_url);
    `);

    // v0.2.0 structure-align Phase B: local_dirs table.
    // CREATE TABLE IF NOT EXISTS is idempotent, safe to run on every boot.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS localDirs (
        local_path TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        parent_path TEXT,
        watched_root_url TEXT,
        mapped_wiki_node_token TEXT,
        mapped_obj_token TEXT,
        cloud_match TEXT NOT NULL DEFAULT 'unknown'
                      CHECK(cloud_match IN ('synced','restricted','unknown','local_only')),
        auto_detected INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_local_dirs_watched_root ON localDirs(watched_root_url);
      CREATE INDEX IF NOT EXISTS idx_local_dirs_wiki_node    ON localDirs(mapped_wiki_node_token);
      CREATE INDEX IF NOT EXISTS idx_local_dirs_cloud_match  ON localDirs(cloud_match);
      CREATE INDEX IF NOT EXISTS idx_local_dirs_parent       ON localDirs(parent_path);
    `);
    console.info('[LocalMapStore] localDirs table ready (v4 structure-align)');
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
   * v0.2.0 cloud-link-coverage fields (original_link, cloud_match) are
   * likewise preserved on UPDATE when the caller does not supply them,
   * so change-detector upserts (which don't read the .md header) do not
   * wipe a link that IndexScanner previously extracted.
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
        cloud_deleted, last_seen_at, local_sort_order,
        original_link, cloud_match, watched_root_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        original_link = COALESCE(excluded.original_link, documents.original_link),
        cloud_match = COALESCE(excluded.cloud_match, documents.cloud_match),
        watched_root_url = COALESCE(excluded.watched_root_url, documents.watched_root_url),
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
      record.originalLink ?? null,
      // cloud_match is NOT NULL DEFAULT 'unknown' in SQLite; an explicit
      // NULL would violate the constraint. When the caller omits it, fall
      // back to 'unknown' so legacy callers (pre-cloud-link-coverage) do
      // not need to be updated. The recompute pass later promotes the
      // value to synced/restricted based on the row's title/obj_token.
      record.cloudMatch ?? 'unknown',
      record.watchedRootUrl ?? null,
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
    // v0.2.0 detect-traverse-fix: when a node reappears in cloud traversal
    // after a previous soft-delete (cloud_deleted=1), the row must be
    // restored to cloud_deleted=0 so the UI stops surfacing it as trash.
    // The previous ON CONFLICT clause omitted cloud_deleted from the
    // UPDATE set, which prevented automatic revival — detect on
    // watchedRoot A then detect on watchedRoot B would leave B's nodes
    // permanently flagged as deleted even after they reappear.
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
        cloud_deleted = 0,
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
   * Restore a previously cloud-deleted document: clear the soft-delete
   * flag so the row is treated as live again. Used by the trash-bin UI
   * when the user chooses to keep a doc locally (e.g. the cloud delete
   * was a mistake).
   */
  restoreCloudDeleted(objToken: string): void {
    const stmt = this.getStatement(`
      UPDATE documents
      SET cloud_deleted = 0, updated_at = datetime('now')
      WHERE obj_token = ?
    `);
    stmt.run(objToken);
  }

  /**
   * Hard-delete a document row from SQLite. Used by the trash-bin UI
   * when the user chooses permanent cleanup; the caller is responsible
   * for fs.unlink'ing the local .md (and optionally moving it to
   * .trash-bin/ first). Cascade deletes associated sheet_sheets rows
   * via the FK constraint declared in migration_v2.sql.
   */
  purgeCloudDeleted(objToken: string): void {
    const stmt = this.getStatement(`
      DELETE FROM documents WHERE obj_token = ?
    `);
    stmt.run(objToken);
  }

  /**
   * List all cloud-deleted documents (for the trash-bin UI panel).
   * Ordered by last_seen_at desc so the most-recently-flagged items
   * surface first.
   */
  listCloudDeleted(): DocumentRecord[] {
    const stmt = this.getStatement(`
      SELECT * FROM documents
      WHERE cloud_deleted = 1
      ORDER BY last_seen_at DESC, updated_at DESC
    `);
    const rows = stmt.all() as any[];
    return rows.map((row) => this.mapRowToDocumentRecord(row));
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
      originalLink: row.original_link ?? null,
      cloudMatch: row.cloud_match ?? 'unknown',
      watchedRootUrl: row.watched_root_url ?? null,
    };
  }

  /**
   * Generate a unique sync ID
   */
  private generateSyncId(): string {
    return `sync-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Recompute cloud_match for all rows based on current column values.
   *
   * Classification rule (single source of truth — matches run-migration-v3):
   *   - title non-empty            → 'synced'     (feishu cloud reachable + readable)
   *   - title empty + obj_token    → 'restricted' (feishu permission-denied, 131006)
   *   - otherwise                  → 'unknown'
   *
   * Also backfills original_link from wiki_node_token for rows that lost it
   * (e.g. change-detector upserts that predated the cloud-link-coverage
   * schema). The link is a best-effort guess; restricted rows always carry
   * cloud_match='restricted' so the UI can flag uncertainty.
   *
   * Called by IndexScanner.scanKnowledgeBase after a full reindex so the
   * cloud_match column reflects the latest .md header scan results.
   *
   * Returns the distribution so callers (API responses, logs) can surface
   * a quick coverage summary to the user.
   */
  recomputeCloudMatch(): {
    synced: number;
    restricted: number;
    unknown: number;
    link_backfilled: number;
  } {
    const tx = this.db.transaction((): {
      synced: number;
      restricted: number;
      unknown: number;
      link_backfilled: number;
    } => {
      // Step 1: classify by title / obj_token presence.
      const classify = this.db.prepare(`
        UPDATE documents
        SET cloud_match = CASE
          WHEN title IS NOT NULL AND title <> '' THEN 'synced'
          WHEN obj_token IS NOT NULL AND obj_token <> '' THEN 'restricted'
          ELSE 'unknown'
        END
      `);
      classify.run();

      // Step 2: backfill original_link from wiki_node_token where missing.
      const backfill = this.db.prepare(`
        UPDATE documents
        SET original_link = 'https://qcnbafdrjx7n.feishu.cn/wiki/' || wiki_node_token
        WHERE (original_link IS NULL OR original_link = '')
          AND wiki_node_token IS NOT NULL
          AND wiki_node_token <> ''
      `);
      const backfillInfo = backfill.run();

      // Step 3: tally distribution for the return value.
      const distRows = this.db
        .prepare(`SELECT cloud_match, COUNT(*) AS n FROM documents GROUP BY cloud_match`)
        .all() as Array<{ cloud_match: string; n: number }>;
      const dist = { synced: 0, restricted: 0, unknown: 0, link_backfilled: backfillInfo.changes };
      for (const r of distRows) {
        if (r.cloud_match === 'synced') dist.synced = r.n;
        else if (r.cloud_match === 'restricted') dist.restricted = r.n;
        else dist.unknown = r.n;
      }
      return dist;
    });
    return tx();
  }

  // -------------------------------------------------------------------------
  // v0.2.0 structure-align Phase B: watched_root_url + localDirs
  // -------------------------------------------------------------------------

  /**
   * Update a single document's watched_root_url. Used by IndexScanner
   * during a rebuild when the directory containing the .md file maps
   * to a configured watchedRoot.
   *
   * Idempotent: re-running with the same value is a no-op.
   */
  setWatchedRootUrl(objToken: string, watchedRootUrl: string | null): void {
    const stmt = this.getStatement(`
      UPDATE documents
      SET watched_root_url = ?, updated_at = datetime('now')
      WHERE obj_token = ?
    `);
    stmt.run(watchedRootUrl, objToken);
  }

  /**
   * Bulk classify watched_root_url for existing rows based on a
   * directory-prefix map. Called by IndexScanner after a rebuild.
   *
   * The map is keyed by the POSIX-style top-level directory name (e.g.
   * "策划 - Designer") and the value is the watchedRoot URL. Rows whose
   * local_md_path lives under one of these directories get tagged;
   * rows under any other top-level directory get watched_root_url=NULL.
   *
   * Returns the number of rows updated (touched) for diagnostics.
   *
   * Implementation note: we deliberately do a full UPDATE pass keyed
   * on `local_md_path LIKE ?||'/%'` rather than parsing paths in JS —
   * SQLite LIKE with a trailing / is SARGable for the directory prefix
   * and avoids N+1 round-trips.
   */
  backfillWatchedRootUrls(
    dirToUrl: Map<string, string>,
    kbRoot: string,
  ): { scanned: number; tagged: number; untagged: number } {
    if (dirToUrl.size === 0) {
      return { scanned: 0, tagged: 0, untagged: 0 };
    }

    const tx = this.db.transaction((): {
      scanned: number;
      tagged: number;
      untagged: number;
    } => {
      // Reset all rows to NULL first so stale tags from a previous config
      // (e.g. a watchedRoot that was removed) don't linger. The fresh
      // pass below re-tags the ones still owned by a tracked root.
      this.db.exec(`UPDATE documents SET watched_root_url = NULL`);

      let tagged = 0;
      for (const [dirName, url] of dirToUrl.entries()) {
        // Match both absolute (kbRoot/dirName/...) and relative
        // (dirName/...) paths. Windows uses \ but SQLite LIKE needs /
        // — we use a permissive pattern that matches both separators
        // via ESCAPE on the literal segments. The simplest portable
        // form is to compute the normalized prefix once.
        const segs = this.normalizePathForLike(`${kbRoot}/${dirName}/`);
        const relSegs = this.normalizePathForLike(`${dirName}/`);
        const winRoot = kbRoot.replace(/\//g, '\\');
        const winSegs = this.normalizePathForLike(`${winRoot}\\${dirName}\\`);

        // LIKE patterns. Use LOWER() comparison for case-insensitive
        // matching (Windows filesystem is case-insensitive; harmless on
        // case-sensitive filesystems where users always use the exact
        // casing anyway).
        const res = this.db
          .prepare(
            `UPDATE documents
             SET watched_root_url = ?
             WHERE LOWER(local_md_path) LIKE ? ESCAPE '\\'
                OR LOWER(local_md_path) LIKE ? ESCAPE '\\'
                OR LOWER(local_md_path) LIKE ? ESCAPE '\\'`,
          )
          .run(
            url,
            `%${segs}%`,
            `%${relSegs}%`,
            `%${winSegs}%`,
          );
        tagged += res.changes;
      }

      const total = (
        this.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as {
          n: number;
        }
      ).n;
      return {
        scanned: total,
        tagged,
        untagged: total - tagged,
      };
    });
    return tx();
  }

  /**
   * Escape LIKE special characters (%, _, \) in a path so the literal
   * string can be used inside LIKE. Also normalizes separator chars
   * so we don't double-escape them.
   */
  private normalizePathForLike(p: string): string {
    return p.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  }

  /**
   * Build the watched_roots projection consumed by the tree API +
   * _index.json. For each configured watchedRoot URL, derive:
   *   - nodeToken (parsed from URL)
   *   - title (best-effort: derived from local directory mapping)
   *   - displayName (business-prefix UI label)
   *   - localDir (the local directory that backs this watchedRoot)
   *   - trackMode ('tracked' — all configured URLs are tracked)
   *   - status (synced when >=1 row references it; missing_in_db otherwise)
   *   - lastDetectedAt (max last_seen_at among children)
   *   - childCount (number of cloud_deleted=0 rows with this watched_root_url)
   *
   * The mapping is derived from the URL's nodeToken → directory name,
   * using a small static map that mirrors the local knowledge base
   * layout. This avoids a runtime round-trip to lark-cli getNode
   * (which is async and may fail) — the desktop runtime refreshes
   * this via SnapshotService.generate() once detection completes.
   */
  getWatchedRoots(configuredUrls: string[]): import('../types/index.js').WatchedRoot[] {
    if (configuredUrls.length === 0) return [];

    // Aggregate current state from SQLite in one query per URL.
    const statsByChild = this.db
      .prepare(
        `SELECT
           watched_root_url AS url,
           COUNT(*) AS child_count,
           MAX(last_seen_at) AS last_seen
         FROM documents
         WHERE watched_root_url IS NOT NULL AND cloud_deleted = 0
         GROUP BY watched_root_url`,
      )
      .all() as Array<{ url: string; child_count: number; last_seen: string | null }>;
    const statsMap = new Map(statsByChild.map((s) => [s.url, s]));

    return configuredUrls.map((url) => {
      const nodeToken = parseNodeTokenFromUrl(url);
      const meta = inferWatchedRootMeta(nodeToken);
      const stat = statsMap.get(url);
      const childCount = stat?.child_count ?? 0;
      const lastSeen = stat?.last_seen ?? null;
      return {
        url,
        nodeToken,
        title: meta.title,
        displayName: meta.displayName,
        localDir: meta.localDir,
        trackMode: 'tracked' as const,
        status: (childCount > 0 ? 'synced' : 'missing_in_db') as
          | 'synced'
          | 'missing_in_db',
        lastDetectedAt: lastSeen,
        childCount,
      };
    });
  }

  // -------------------------------------------------------------------------
  // localDirs table (v0.2.0 structure-align Phase B)
  // -------------------------------------------------------------------------

  /**
   * Upsert a localDirs row. PK is local_path (relative to kbRoot).
   *
   * On UPDATE we preserve created_at, auto_detected (unless explicitly
   * toggled), and sort_order. COALESCE keeps the previous value when
   * the caller omits a field — same pattern as upsertDocument.
   */
  upsertLocalDir(record: {
    localPath: string;
    title?: string;
    parentPath?: string | null;
    watchedRootUrl?: string | null;
    mappedWikiNodeToken?: string | null;
    mappedObjToken?: string | null;
    cloudMatch?: 'synced' | 'restricted' | 'unknown' | 'local_only';
    autoDetected?: number;
    sortOrder?: number | null;
  }): void {
    const stmt = this.getStatement(`
      INSERT INTO localDirs (
        local_path, title, parent_path, watched_root_url,
        mapped_wiki_node_token, mapped_obj_token, cloud_match,
        auto_detected, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_path) DO UPDATE SET
        title = COALESCE(excluded.title, localDirs.title),
        parent_path = COALESCE(excluded.parent_path, localDirs.parent_path),
        watched_root_url = COALESCE(excluded.watched_root_url, localDirs.watched_root_url),
        mapped_wiki_node_token = COALESCE(excluded.mapped_wiki_node_token, localDirs.mapped_wiki_node_token),
        mapped_obj_token = COALESCE(excluded.mapped_obj_token, localDirs.mapped_obj_token),
        cloud_match = COALESCE(excluded.cloud_match, localDirs.cloud_match),
        auto_detected = COALESCE(excluded.auto_detected, localDirs.auto_detected),
        sort_order = COALESCE(excluded.sort_order, localDirs.sort_order),
        updated_at = datetime('now')
    `);
    stmt.run(
      record.localPath,
      record.title ?? '',
      record.parentPath ?? null,
      record.watchedRootUrl ?? null,
      record.mappedWikiNodeToken ?? null,
      record.mappedObjToken ?? null,
      record.cloudMatch ?? 'unknown',
      record.autoDetected ?? 1,
      record.sortOrder ?? null,
    );
  }

  /**
   * Return all localDirs rows, ordered for UI consumption:
   *   1. parent_path IS NULL (top-level) first
   *   2. then sort_order asc, then title
   *   3. then deeper paths after their parent (lexicographic on local_path)
   */
  getAllLocalDirs(): import('../types/index.js').LocalDirRecord[] {
    const stmt = this.getStatement(`
      SELECT * FROM localDirs
      ORDER BY
        CASE WHEN parent_path IS NULL THEN 0 ELSE 1 END,
        sort_order ASC NULLS LAST,
        local_path ASC
    `);
    const rows = stmt.all() as any[];
    return rows.map((row) => ({
      localPath: row.local_path,
      title: row.title,
      parentPath: row.parent_path ?? null,
      watchedRootUrl: row.watched_root_url ?? null,
      mappedWikiNodeToken: row.mapped_wiki_node_token ?? null,
      mappedObjToken: row.mapped_obj_token ?? null,
      cloudMatch: row.cloud_match ?? 'unknown',
      autoDetected: row.auto_detected ?? 0,
      sortOrder: row.sort_order ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Get the CREATE TABLE DDL.
   *
   * IMPORTANT: indexes that reference v0.2.0+ columns (parent_node_token,
   * space_id, obj_edit_time, cloud_deleted, local_sort_order, original_link,
   * cloud_match) are intentionally NOT in this DDL — they live in
   * applyAdditiveMigrations() so they are only created AFTER the columns
   * exist. Putting them here would break startup on legacy databases
   * (CREATE TABLE IF NOT EXISTS is a no-op on existing tables, so the
   * columns wouldn't be added, but CREATE INDEX IF NOT EXISTS would still
   * try to run and fail with "no such column").
   *
   * Only v0.1.0 columns + their indexes are here. Everything added from
   * v0.2.0 onward goes through the additive-migration path so it works
   * uniformly on fresh databases (where the columns exist via CREATE TABLE)
   * and on legacy databases (where they were added via ALTER).
   */
  private getCreateTablesDDL(): string {
    return `
      -- Documents mapping table (v0.1.0 columns only; v0.2.0+ columns are
      -- added by applyAdditiveMigrations on existing databases, and included
      -- in the table definition for fresh databases so new installs match)
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
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        -- v0.2.0 mapping-expansion (only present on fresh DBs; legacy DBs
        -- get these via ALTER in applyAdditiveMigrations)
        parent_node_token TEXT,
        space_id TEXT,
        obj_edit_time INTEGER,
        cloud_deleted INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        local_sort_order INTEGER,
        -- v0.2.0 cloud-link-coverage (same pattern)
        original_link TEXT,
        cloud_match TEXT NOT NULL DEFAULT 'unknown',
        -- v0.2.0 structure-align Phase B (same pattern)
        watched_root_url TEXT
      );

      -- v0.1.0 indexes (columns always exist)
      CREATE INDEX IF NOT EXISTS idx_documents_wiki_node_token ON documents(wiki_node_token);
      CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
      CREATE INDEX IF NOT EXISTS idx_documents_local_md_path ON documents(local_md_path);

      -- v0.2.0 structure-align Phase B: local_dirs table (local directory ↔ feishu node mapping)
      CREATE TABLE IF NOT EXISTS localDirs (
        local_path TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        parent_path TEXT,
        watched_root_url TEXT,
        mapped_wiki_node_token TEXT,
        mapped_obj_token TEXT,
        cloud_match TEXT NOT NULL DEFAULT 'unknown'
                      CHECK(cloud_match IN ('synced','restricted','unknown','local_only')),
        auto_detected INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_local_dirs_watched_root ON localDirs(watched_root_url);
      CREATE INDEX IF NOT EXISTS idx_local_dirs_wiki_node    ON localDirs(mapped_wiki_node_token);
      CREATE INDEX IF NOT EXISTS idx_local_dirs_cloud_match  ON localDirs(cloud_match);
      CREATE INDEX IF NOT EXISTS idx_local_dirs_parent       ON localDirs(parent_path);

      -- Sub-sheet mapping is a runtime dependency of SyncEngine, not an
      -- optional migration-script add-on. New installs must be able to sync
      -- a workbook before any manual migration has ever been run.
      CREATE TABLE IF NOT EXISTS sheet_sheets (
        sheet_obj_token TEXT NOT NULL,
        sheet_id TEXT NOT NULL,
        sheet_title TEXT NOT NULL,
        local_csv_path TEXT NOT NULL,
        local_md_path TEXT,
        last_synced_modify_time TEXT,
        status TEXT NOT NULL DEFAULT 'synced'
               CHECK(status IN ('synced', 'changed', 'error', 'placeholder')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (sheet_obj_token, sheet_id),
        FOREIGN KEY (sheet_obj_token) REFERENCES documents(obj_token) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sheet_sheets_sheet_obj ON sheet_sheets(sheet_obj_token);
      CREATE INDEX IF NOT EXISTS idx_sheet_sheets_status ON sheet_sheets(status);

      -- Keep the runtime schema self-describing. Historic migration scripts
      -- may record their own version rows; table creation itself is
      -- idempotent and intentionally does not pretend those scripts ran.
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

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

// ===========================================================================
// Module-level helpers (no class state, safe to share across instances)
// ===========================================================================

/**
 * Extract the feishu wiki node token from a wiki URL.
 *
 *   https://qcnbafdrjx7n.feishu.cn/wiki/<token>
 *
 * Returns the empty string when the URL does not match the expected
 * shape. Callers should treat empty as "unknown".
 */
function parseNodeTokenFromUrl(url: string): string {
  const m = url.match(/\/wiki\/([A-Za-z0-9]+)/);
  return m ? m[1] : '';
}

/**
 * Static metadata map for the four configured watchedRoots.
 *
 * Mirrors the project's local knowledge base layout (see 白泽 structure-align
 * survey §3.1). Each entry maps a feishu nodeToken → display-friendly
 * metadata (title / displayName / localDir) used by the UI to render
 * top-level groupings.
 *
 * The map is intentionally a static literal: the local directory names
 * are stable and do not change with the user's config. If a watchedRoot
 * is added that is not in this map, we fall back to a generic shape
 * derived from the URL itself.
 */
function inferWatchedRootMeta(nodeToken: string): {
  title: string;
  displayName: string;
  localDir: string;
} {
  const KNOWN: Record<
    string,
    { title: string; displayName: string; localDir: string }
  > = {
    // 策划
    Wramw1XxRihIgnkCrhqcdEbRnHb: {
      title: '策划-Designer',
      displayName: '[策划] 策划设计',
      localDir: '策划 - Designer',
    },
    // 技术
    QdZpwOmgBi25JVkAUmYcBiMinIf: {
      title: '技术-Dev',
      displayName: '[技术] 技术开发',
      localDir: '技术 - Dev',
    },
    // [必读]研发规范
    NudewPkE9inlGhkEDA1c9FSsnkb: {
      title: '[必读]研发规范',
      displayName: '[规范] 研发规范',
      localDir: '[必读] 研发规范',
    },
    // 开发环境指引
    FEaww3vUHieIumk6FdIc92WHnyh: {
      title: '开发环境指引',
      displayName: '[指引] 开发环境指引',
      localDir: '开发环境指引',
    },
  };

  if (nodeToken && KNOWN[nodeToken]) {
    return KNOWN[nodeToken];
  }
  // Fallback: use the node token as the title; displayName mirrors it.
  return {
    title: nodeToken || '(unknown)',
    displayName: nodeToken ? `[根] ${nodeToken.slice(0, 8)}` : '(unknown)',
    localDir: '',
  };
}
