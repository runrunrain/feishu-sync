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
import type {
  CloudNodeObservation,
  DocumentRecord,
  FeishuPendingItem,
  SyncResult,
  SyncFailureReasonCode,
  SyncRepairAction,
  SyncState,
  WatchedRootConfig,
} from '../types/index.js';

const V5_RUNTIME_SCHEMA_VERSION = 'v5_runtime_state';

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
   *   - v5 runtime state: observed/synced timestamps, state-machine fields,
   *     watched-root identity and traversal-missing counter
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
      // v5 runtime state. `status` and `obj_edit_time` remain for legacy
      // compatibility; these fields are now the authoritative sync model.
      { name: 'observed_obj_edit_time', dml: 'ALTER TABLE documents ADD COLUMN observed_obj_edit_time INTEGER' },
      { name: 'synced_obj_edit_time', dml: 'ALTER TABLE documents ADD COLUMN synced_obj_edit_time INTEGER' },
      { name: 'sync_state', dml: "ALTER TABLE documents ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'pending_added'" },
      { name: 'watched_root_id', dml: 'ALTER TABLE documents ADD COLUMN watched_root_id TEXT' },
      { name: 'local_rel_path', dml: 'ALTER TABLE documents ADD COLUMN local_rel_path TEXT' },
      { name: 'missing_complete_count', dml: 'ALTER TABLE documents ADD COLUMN missing_complete_count INTEGER NOT NULL DEFAULT 0' },
      { name: 'last_sync_error_code', dml: 'ALTER TABLE documents ADD COLUMN last_sync_error_code TEXT' },
      { name: 'has_child', dml: 'ALTER TABLE documents ADD COLUMN has_child INTEGER NOT NULL DEFAULT 0' },
      // custom-folder archive (quick-add): links a document to custom_folders.id
      { name: 'custom_folder_id', dml: 'ALTER TABLE documents ADD COLUMN custom_folder_id TEXT' },
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
      CREATE INDEX IF NOT EXISTS idx_documents_sync_state ON documents(sync_state);
      CREATE INDEX IF NOT EXISTS idx_documents_watched_root_id ON documents(watched_root_id);
      CREATE INDEX IF NOT EXISTS idx_documents_missing_complete ON documents(missing_complete_count);
      CREATE INDEX IF NOT EXISTS idx_documents_custom_folder ON documents(custom_folder_id);
    `);

    this.applyV5RuntimeStateBackfill();

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
   * One-time v5 data migration. The schema changes above are additive, but
   * existing rows still need a conservative state interpretation. We only
   * trust a legacy `synced` row when its local file exists at migration time;
   * otherwise it becomes pending so a later dry-run can review it instead of
   * silently acknowledging an unverifiable baseline.
   *
   * Historic `cloud_deleted=1` is deliberately demoted to
   * `missing_candidate` and unhidden. Older detectors could mark deletion
   * after partial traversal, so there is no reliable proof that such a row
   * was manually confirmed. This migration chooses recoverability over an
   * irreversible hidden/deleted interpretation.
   */
  private applyV5RuntimeStateBackfill(): void {
    const existing = this.db
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(V5_RUNTIME_SCHEMA_VERSION) as { version?: string } | undefined;
    if (existing?.version) return;

    const rows = this.db.prepare(`
      SELECT
        obj_token,
        status,
        cloud_match,
        cloud_deleted,
        local_md_path,
        obj_edit_time,
        observed_obj_edit_time,
        watched_root_url,
        watched_root_id
      FROM documents
    `).all() as Array<{
      obj_token: string;
      status: string;
      cloud_match: string | null;
      cloud_deleted: number | null;
      local_md_path: string | null;
      obj_edit_time: number | null;
      observed_obj_edit_time: number | null;
      watched_root_url: string | null;
      watched_root_id: string | null;
    }>;

    const update = this.db.prepare(`
      UPDATE documents
      SET
        observed_obj_edit_time = ?,
        synced_obj_edit_time = ?,
        sync_state = ?,
        watched_root_id = ?,
        missing_complete_count = ?,
        cloud_deleted = ?,
        updated_at = datetime('now')
      WHERE obj_token = ?
    `);
    const recordMigration = this.db.prepare(
      'INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)',
    );

    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const observed = row.observed_obj_edit_time ?? row.obj_edit_time ?? null;
        const localPath = row.local_md_path?.trim() ?? '';
        // `local_md_path` in the legacy schema was an absolute-path field.
        // A relative value has no trustworthy base after a database is moved,
        // so never let the process working directory accidentally prove a
        // synced baseline during migration.
        const localFileExists = path.isAbsolute(localPath) && fs.existsSync(localPath);
        const wasLegacyDelete = (row.cloud_deleted ?? 0) === 1;

        let state: SyncState;
        let synced: number | null = null;
        let missingCount = 0;
        let cloudDeleted = 0;

        if (wasLegacyDelete) {
          state = 'missing_candidate';
          missingCount = 2;
        } else if (row.status === 'error') {
          state = 'error';
        } else if (row.status === 'placeholder' && row.cloud_match === 'restricted') {
          state = 'restricted';
        } else if (row.status === 'synced' && localFileExists) {
          state = 'synced';
          synced = observed;
        } else if (row.status === 'changed' || (row.status === 'synced' && localPath.length > 0)) {
          state = 'pending_modified';
        } else {
          state = 'pending_added';
        }

        update.run(
          observed,
          synced,
          state,
          row.watched_root_id ?? row.watched_root_url ?? null,
          missingCount,
          cloudDeleted,
          row.obj_token,
        );
      }
      recordMigration.run(V5_RUNTIME_SCHEMA_VERSION);
    });
    tx();
    console.info(`[LocalMapStore] v5 runtime-state migration complete (${rows.length} rows evaluated)`);
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
        original_link, cloud_match, watched_root_url,
        observed_obj_edit_time, watched_root_id, local_rel_path, has_child
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0))
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
        observed_obj_edit_time = COALESCE(excluded.observed_obj_edit_time, documents.observed_obj_edit_time),
        cloud_deleted = documents.cloud_deleted,
        last_seen_at = COALESCE(excluded.last_seen_at, documents.last_seen_at),
        local_sort_order = documents.local_sort_order,
        original_link = COALESCE(excluded.original_link, documents.original_link),
        cloud_match = COALESCE(excluded.cloud_match, documents.cloud_match),
        watched_root_url = COALESCE(excluded.watched_root_url, documents.watched_root_url),
        watched_root_id = COALESCE(excluded.watched_root_id, documents.watched_root_id),
        local_rel_path = COALESCE(excluded.local_rel_path, documents.local_rel_path),
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
      record.observedObjEditTime ?? record.objEditTime ?? null,
      record.watchedRootId ?? null,
      record.localRelPath ?? null,
      record.hasChild == null ? null : record.hasChild ? 1 : 0,
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
   * Persist one traversal observation without advancing the synced baseline.
   *
   * This is the v5 replacement for `upsertDocumentSeen`. It writes the full
   * cloud identity (including title/type/root/parent/hasChild) and only ever
   * changes `observed_obj_edit_time`. The transition function preserves an
   * existing pending/error state across polls, so ten identical detections
   * cannot make a pending change disappear.
   */
  recordCloudObservation(observation: CloudNodeObservation & { lastSeenAt: string }): DocumentRecord {
    const current = this.getDocumentByObjToken(observation.objToken);
    const pending = this.getFeishuPendingByObjToken(observation.objToken);
    // A Feishu-side repair is opt-in: routine polls keep the queue entry and
    // its suppression state intact.  After the user clicks “处理后重新检测”,
    // only a readable observation releases it; permission/unavailable states
    // stay queued and do not become a fresh pending change again.
    const keepFeishuPending = !!pending && !(
      pending.recheckRequestedAt != null && observation.observationStatus === 'available'
    );
    if (pending && !keepFeishuPending) this.removeFeishuPending(observation.objToken);
    const nextState: SyncState = keepFeishuPending
      ? 'feishu_pending'
      : this.nextStateForObservation(current, observation);
    const legacyStatus = this.legacyStatusForSyncState(nextState);

    const stmt = this.getStatement(`
      INSERT INTO documents (
        obj_token, wiki_node_token, obj_type, title, local_md_path,
        last_synced_modify_time, last_synced_at, status,
        parent_node_token, space_id, obj_edit_time,
        cloud_deleted, last_seen_at, observed_obj_edit_time,
        sync_state, watched_root_id, watched_root_url,
        missing_complete_count, last_sync_error_code, has_child
      ) VALUES (?, ?, ?, ?, '', '', '', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, NULL, ?)
      ON CONFLICT(obj_token) DO UPDATE SET
        wiki_node_token = COALESCE(excluded.wiki_node_token, documents.wiki_node_token),
        obj_type = COALESCE(excluded.obj_type, documents.obj_type),
        title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE documents.title END,
        parent_node_token = COALESCE(excluded.parent_node_token, documents.parent_node_token),
        space_id = COALESCE(excluded.space_id, documents.space_id),
        obj_edit_time = COALESCE(excluded.obj_edit_time, documents.obj_edit_time),
        observed_obj_edit_time = COALESCE(excluded.observed_obj_edit_time, documents.observed_obj_edit_time),
        sync_state = excluded.sync_state,
        status = excluded.status,
        watched_root_id = COALESCE(excluded.watched_root_id, documents.watched_root_id),
        watched_root_url = COALESCE(excluded.watched_root_url, documents.watched_root_url),
        has_child = excluded.has_child,
        last_seen_at = excluded.last_seen_at,
        missing_complete_count = 0,
        cloud_deleted = 0,
        last_sync_error_code = CASE
          WHEN excluded.sync_state IN ('error', 'feishu_pending') THEN documents.last_sync_error_code
          ELSE NULL
        END,
        updated_at = datetime('now')
    `);

    const observed = observation.observedObjEditTime ?? null;
    stmt.run(
      observation.objToken,
      observation.wikiNodeToken || null,
      observation.objType,
      observation.title ?? '',
      legacyStatus,
      observation.parentNodeToken ?? null,
      observation.spaceId ?? null,
      observed,
      observation.lastSeenAt,
      observed,
      nextState,
      observation.watchedRootId || null,
      observation.watchedRootUrl ?? null,
      observation.hasChild ? 1 : 0,
    );

    // The row was inserted/updated in the same synchronous connection, so a
    // follow-up lookup is stable and gives callers the exact resulting state.
    return this.getDocumentByObjToken(observation.objToken)!;
  }

  /**
   * Compatibility shim for v2-v4 callers. New code must call
   * recordCloudObservation so it cannot lose title/type/root metadata.
   */
  upsertDocumentSeen(input: {
    objToken: string;
    wikiNodeToken?: string | null;
    parentNodeToken?: string | null;
    spaceId?: string | null;
    objEditTime?: number | null;
    lastSeenAt: string;
  }): void {
    this.recordCloudObservation({
      objToken: input.objToken,
      wikiNodeToken: input.wikiNodeToken ?? '',
      objType: 'unknown',
      title: '',
      spaceId: input.spaceId ?? null,
      parentNodeToken: input.parentNodeToken ?? null,
      watchedRootId: '',
      watchedRootUrl: null,
      observedObjEditTime: input.objEditTime ?? null,
      hasChild: false,
      observationStatus: 'unavailable',
      lastSeenAt: input.lastSeenAt,
    });
  }

  /**
   * Commit the local sync baseline after the file transaction has succeeded.
   * P3's atomic coordinator owns the call site; keeping this operation
   * separate is what prevents detection from acknowledging unsaved content.
   */
  markDocumentSynced(input: {
    objToken: string;
    syncedObjEditTime: number | null;
    localMdPath?: string | null;
    localRelPath?: string | null;
    lastSyncedModifyTime?: string | null;
    lastSyncedAt?: string;
  }): void {
    const stmt = this.getStatement(`
      UPDATE documents
      SET
        synced_obj_edit_time = ?,
        sync_state = 'synced',
        status = 'synced',
        local_md_path = COALESCE(?, local_md_path),
        local_rel_path = COALESCE(?, local_rel_path),
        last_synced_modify_time = COALESCE(?, last_synced_modify_time),
        last_synced_at = COALESCE(?, last_synced_at),
        missing_complete_count = 0,
        cloud_deleted = 0,
        last_sync_error_code = NULL,
        updated_at = datetime('now')
      WHERE obj_token = ?
    `);
    stmt.run(
      input.syncedObjEditTime,
      input.localMdPath ?? null,
      input.localRelPath ?? null,
      input.lastSyncedModifyTime ?? null,
      input.lastSyncedAt ?? new Date().toISOString(),
      input.objToken,
    );
  }

  /** Mark a failed write while preserving the last known synced baseline. */
  markDocumentSyncError(objToken: string, errorCode: string): void {
    const stmt = this.getStatement(`
      UPDATE documents
      SET sync_state = 'error', status = 'error', last_sync_error_code = ?,
          updated_at = datetime('now')
      WHERE obj_token = ?
    `);
    stmt.run(errorCode, objToken);
  }

  /**
   * Move a non-retryable cloud-side issue into the durable Feishu queue.
   * This is intentionally a local state transition only: the application
   * never attempts to grant itself access, revive a deleted cloud page, or
   * change a cloud object's type.
   */
  recordFeishuPending(input: {
    objToken: string;
    title: string;
    watchedRootId?: string | null;
    reasonCode: SyncFailureReasonCode;
    error: string;
    suggestedResolution: string;
    repairAction: SyncRepairAction;
  }): void {
    const now = new Date().toISOString();
    const insertPending = this.getStatement(`
      INSERT INTO feishu_pending_items (
        obj_token, title, watched_root_id, reason_code, error,
        suggested_resolution, repair_action, created_at, updated_at,
        recheck_requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(obj_token) DO UPDATE SET
        title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE feishu_pending_items.title END,
        watched_root_id = COALESCE(excluded.watched_root_id, feishu_pending_items.watched_root_id),
        reason_code = excluded.reason_code,
        error = excluded.error,
        suggested_resolution = excluded.suggested_resolution,
        repair_action = excluded.repair_action,
        updated_at = excluded.updated_at,
        recheck_requested_at = NULL
    `);
    const markDocument = this.getStatement(`
      UPDATE documents
      SET sync_state = 'feishu_pending', status = 'error',
          last_sync_error_code = ?, updated_at = datetime('now')
      WHERE obj_token = ?
    `);
    const tx = this.db.transaction(() => {
      insertPending.run(
        input.objToken,
        input.title,
        input.watchedRootId ?? null,
        input.reasonCode,
        input.error,
        input.suggestedResolution,
        input.repairAction,
        now,
        now,
      );
      markDocument.run(input.reasonCode, input.objToken);
    });
    tx();
  }

  /** Read the queue used by the Sync view's “飞书侧待处理” panel. */
  listFeishuPending(watchedRootIds?: string[]): FeishuPendingItem[] {
    const ids = (watchedRootIds ?? []).filter((id) => typeof id === 'string' && id.trim());
    const where = ids.length > 0
      ? `WHERE watched_root_id IN (${ids.map(() => '?').join(', ')})`
      : '';
    const rows = this.db.prepare(`
      SELECT * FROM feishu_pending_items
      ${where}
      ORDER BY updated_at DESC, title COLLATE NOCASE ASC
    `).all(...ids) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRowToFeishuPendingItem(row));
  }

  /**
   * Explicitly permit one recovery traversal.  The rows remain queued until
   * a later observation is actually readable; a still-restricted/deleted
   * document therefore does not fall back into the recurring change list.
   */
  requestFeishuPendingRecheck(watchedRootIds?: string[]): number {
    const ids = (watchedRootIds ?? []).filter((id) => typeof id === 'string' && id.trim());
    const now = new Date().toISOString();
    const where = ids.length > 0
      ? `WHERE watched_root_id IN (${ids.map(() => '?').join(', ')})`
      : '';
    const result = this.db.prepare(`
      UPDATE feishu_pending_items
      SET recheck_requested_at = ?, updated_at = ?
      ${where}
    `).run(now, now, ...ids);
    return result.changes;
  }

  private getFeishuPendingByObjToken(objToken: string): FeishuPendingItem | null {
    const row = this.getStatement(`
      SELECT * FROM feishu_pending_items WHERE obj_token = ?
    `).get(objToken) as Record<string, unknown> | undefined;
    return row ? this.mapRowToFeishuPendingItem(row) : null;
  }

  private removeFeishuPending(objToken: string): void {
    this.getStatement('DELETE FROM feishu_pending_items WHERE obj_token = ?').run(objToken);
  }

  /**
   * Record a single absence after a COMPLETE traversal. The first complete
   * miss is intentionally observational; only the second becomes a deletion
   * candidate. Nothing here performs a delete or hides the local document.
   */
  recordCompleteTraversalMiss(objToken: string, timestamp: string): DocumentRecord | null {
    const current = this.getDocumentByObjToken(objToken);
    if (!current) return null;
    const state = current.syncState ?? this.legacyStateFromRecord(current);
    if (
      state === 'pending_added' ||
      state === 'restricted' ||
      state === 'feishu_pending' ||
      state === 'deleted_confirmed'
    ) {
      return current;
    }

    const nextCount = (current.missingCompleteCount ?? 0) + 1;
    const nextState: SyncState = nextCount >= 2 ? 'missing_candidate' : state;
    const stmt = this.getStatement(`
      UPDATE documents
      SET missing_complete_count = ?, sync_state = ?, status = ?,
          last_seen_at = ?, updated_at = datetime('now')
      WHERE obj_token = ?
    `);
    stmt.run(nextCount, nextState, this.legacyStatusForSyncState(nextState), timestamp, objToken);
    return this.getDocumentByObjToken(objToken);
  }

  listMissingCandidates(): DocumentRecord[] {
    const rows = this.getStatement(`
      SELECT * FROM documents
      WHERE sync_state = 'missing_candidate'
      ORDER BY last_seen_at ASC, title ASC
    `).all() as any[];
    return rows.map((row) => this.mapRowToDocumentRecord(row));
  }

  /**
   * Finalize a deletion candidate only after an explicit user/API confirmation.
   * Returns false when the record is not currently a candidate, making the
   * transition idempotent and preventing a stale UI from deleting a revived
   * document.
   */
  confirmMissingCandidateDeletion(objToken: string, timestamp: string): boolean {
    const result = this.getStatement(`
      UPDATE documents
      SET sync_state = 'deleted_confirmed', cloud_deleted = 1,
          last_seen_at = ?, updated_at = datetime('now')
      WHERE obj_token = ? AND sync_state = 'missing_candidate'
    `).run(timestamp, objToken);
    return result.changes === 1;
  }

  /**
   * Legacy/manual soft-delete helper. Traversal code must use
   * recordCompleteTraversalMiss + confirmMissingCandidateDeletion instead.
   */
  markCloudDeleted(objToken: string, timestamp: string): void {
    const stmt = this.getStatement(`
      UPDATE documents
      SET cloud_deleted = 1, sync_state = 'deleted_confirmed',
          status = 'changed', last_seen_at = ?, updated_at = datetime('now')
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
      SET cloud_deleted = 0,
          sync_state = CASE
            WHEN sync_state = 'deleted_confirmed' THEN 'missing_candidate'
            ELSE sync_state
          END,
          updated_at = datetime('now')
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
      DELETE FROM documents
      WHERE obj_token = ? AND sync_state = 'deleted_confirmed'
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
   * Run a group of writes in one SQLite transaction.
   * Used by SyncEngine so sheet_sheets + markDocumentSynced either both
   * commit or both roll back (Gate 3 file/DB linkage).
   */
  withTransaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
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

  /** Map v5 state to the legacy constrained status column. */
  private legacyStatusForSyncState(state: SyncState): DocumentRecord['status'] {
    switch (state) {
      case 'synced':
        return 'synced';
      case 'restricted':
        return 'placeholder';
      case 'feishu_pending':
        return 'error';
      case 'error':
        return 'error';
      case 'pending_added':
      case 'pending_modified':
      case 'missing_candidate':
      case 'deleted_confirmed':
        return 'changed';
    }
  }

  /** Conservative interpretation used only when reading a pre-v5-like row. */
  private legacyStateFromRecord(record: DocumentRecord): SyncState {
    if (record.cloudDeleted === 1) return 'missing_candidate';
    if (record.status === 'error') return 'error';
    if (record.status === 'placeholder') {
      return record.cloudMatch === 'restricted' ? 'restricted' : 'pending_added';
    }
    if (record.status === 'changed') return 'pending_modified';
    return 'synced';
  }

  /**
   * State transition for an observation. It deliberately never changes
   * syncedObjEditTime; that field belongs to markDocumentSynced only.
   */
  private nextStateForObservation(
    current: DocumentRecord | null,
    observation: CloudNodeObservation,
  ): SyncState {
    if (!current) {
      return observation.observationStatus === 'restricted'
        ? 'restricted'
        : 'pending_added';
    }

    const currentState = current.syncState ?? this.legacyStateFromRecord(current);
    if (observation.observationStatus === 'restricted') {
      return 'restricted';
    }

    // A transient detail failure still refreshes visible hierarchy metadata,
    // but it must not acknowledge, downgrade or fabricate a sync result.
    if (observation.observationStatus === 'unavailable') {
      return currentState;
    }

    if (currentState === 'pending_added' || currentState === 'pending_modified' || currentState === 'error') {
      return currentState;
    }

    const observed = observation.observedObjEditTime;
    const synced = current.syncedObjEditTime ?? null;
    const hasLocalContent = current.localMdPath.trim().length > 0;

    // A queue row is normally handled before this method. This fallback
    // covers an interrupted migration/manual database repair: once no queue
    // row remains, the next readable observation safely derives a normal
    // pending/synced state from the unchanged baseline.
    if (currentState === 'feishu_pending') {
      if (!hasLocalContent) return 'pending_added';
      if (observed == null || synced == null || observed > synced) return 'pending_modified';
      return 'synced';
    }

    // A historical writer stored the local wall-clock timestamp in
    // synced_obj_edit_time for at least one failed Slides export, while the
    // upstream wiki API supplies Unix seconds.  That makes the local baseline
    // roughly 1000x newer than the cloud observation and can permanently hide
    // an old metadata placeholder as "synced".  A baseline may never be that
    // far ahead of the exact cloud version it acknowledges, so fail closed and
    // require a new atomic export instead of normalizing it in place.
    if (this.hasLegacyTimestampUnitMismatch(observed, synced)) {
      return hasLocalContent ? 'pending_modified' : 'pending_added';
    }

    if (currentState === 'restricted') {
      if (!hasLocalContent) return 'pending_added';
      if (observed == null || synced == null || observed > synced) return 'pending_modified';
      return 'synced';
    }

    if (currentState === 'missing_candidate' || currentState === 'deleted_confirmed') {
      if (!hasLocalContent) return 'pending_added';
      if (observed == null || synced == null || observed > synced) return 'pending_modified';
      return 'synced';
    }

    // synced state: a null baseline is intentionally not treated as equal.
    // The legacy migration only assigns a baseline when it verified the file,
    // so a missing baseline needs a conservative pending review.
    if (synced == null || (observed != null && observed > synced)) {
      return hasLocalContent ? 'pending_modified' : 'pending_added';
    }
    return 'synced';
  }

  /** Detect the known seconds-vs-milliseconds legacy baseline corruption. */
  private hasLegacyTimestampUnitMismatch(
    observed: number | null,
    synced: number | null,
  ): boolean {
    return (
      observed != null &&
      synced != null &&
      Number.isFinite(observed) &&
      Number.isFinite(synced) &&
      observed > 0 &&
      synced > observed * 100
    );
  }

  private mapRowToFeishuPendingItem(row: Record<string, unknown>): FeishuPendingItem {
    return {
      objToken: String(row.obj_token ?? ''),
      title: String(row.title ?? ''),
      watchedRootId: typeof row.watched_root_id === 'string' && row.watched_root_id
        ? row.watched_root_id
        : null,
      reasonCode: String(row.reason_code ?? 'unknown') as SyncFailureReasonCode,
      error: String(row.error ?? ''),
      suggestedResolution: String(row.suggested_resolution ?? ''),
      repairAction: String(row.repair_action ?? 'manual_review') as SyncRepairAction,
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      recheckRequestedAt: typeof row.recheck_requested_at === 'string' && row.recheck_requested_at
        ? row.recheck_requested_at
        : null,
    };
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
      objEditTime: row.observed_obj_edit_time ?? row.obj_edit_time ?? null,
      cloudDeleted: row.cloud_deleted ?? 0,
      lastSeenAt: row.last_seen_at ?? null,
      localSortOrder: row.local_sort_order ?? null,
      originalLink: row.original_link ?? null,
      cloudMatch: row.cloud_match ?? 'unknown',
      watchedRootUrl: row.watched_root_url ?? null,
      observedObjEditTime: row.observed_obj_edit_time ?? row.obj_edit_time ?? null,
      syncedObjEditTime: row.synced_obj_edit_time ?? null,
      syncState: row.sync_state ?? this.legacyStateFromRecord({
        objToken: row.obj_token,
        wikiNodeToken: row.wiki_node_token ?? null,
        objType: row.obj_type,
        title: row.title,
        localMdPath: row.local_md_path,
        lastSyncedModifyTime: row.last_synced_modify_time,
        lastSyncedAt: row.last_synced_at,
        status: row.status,
        cloudDeleted: row.cloud_deleted ?? 0,
        cloudMatch: row.cloud_match ?? 'unknown',
      }),
      watchedRootId: row.watched_root_id ?? null,
      localRelPath: row.local_rel_path ?? null,
      missingCompleteCount: row.missing_complete_count ?? 0,
      lastSyncErrorCode: row.last_sync_error_code ?? null,
      hasChild: (row.has_child ?? 0) === 1,
      customFolderId: row.custom_folder_id ?? null,
    };
  }

  /**
   * Generate a unique sync ID
   */
  private generateSyncId(): string {
    return `sync-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  // -------------------------------------------------------------------------
  // Custom-folder archive (quick-add flow)
  // -------------------------------------------------------------------------

  /** Return all custom folders ordered by name. */
  listCustomFolders(): Array<{
    id: string;
    name: string;
    localRelPath: string;
    createdAt: string;
  }> {
    const rows = this.getStatement(`
      SELECT id, name, local_rel_path, created_at
      FROM custom_folders
      ORDER BY name COLLATE NOCASE ASC, created_at ASC
    `).all() as Array<{
      id: string;
      name: string;
      local_rel_path: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      localRelPath: row.local_rel_path,
      createdAt: row.created_at,
    }));
  }

  /** Get a single folder by id, or null when it does not exist. */
  getCustomFolder(id: string): {
    id: string;
    name: string;
    localRelPath: string;
    createdAt: string;
  } | null {
    const row = this.getStatement(`
      SELECT id, name, local_rel_path, created_at
      FROM custom_folders WHERE id = ?
    `).get(id) as
      | {
          id: string;
          name: string;
          local_rel_path: string;
          created_at: string;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          name: row.name,
          localRelPath: row.local_rel_path,
          createdAt: row.created_at,
        }
      : null;
  }

  /** Find a folder by display name (case-sensitive, exact match). */
  getCustomFolderByName(name: string): {
    id: string;
    name: string;
    local_rel_path: string;
  } | null {
    const row = this.getStatement(`
      SELECT id, name, local_rel_path FROM custom_folders WHERE name = ?
    `).get(name) as
      | { id: string; name: string; local_rel_path: string }
      | undefined;
    return row ?? null;
  }

  /** Find a folder whose local_rel_path matches exactly. */
  getCustomFolderByLocalRelPath(localRelPath: string): { id: string } | null {
    const row = this.getStatement(`
      SELECT id FROM custom_folders WHERE local_rel_path = ?
    `).get(localRelPath) as { id: string } | undefined;
    return row ?? null;
  }

  /** Insert a new custom folder. localRelPath must be unique (caller checks). */
  createCustomFolder(input: {
    id: string;
    name: string;
    localRelPath: string;
  }): { id: string; name: string; localRelPath: string; createdAt: string } {
    this.getStatement(`
      INSERT INTO custom_folders (id, name, local_rel_path)
      VALUES (?, ?, ?)
    `).run(input.id, input.name, input.localRelPath);
    return this.getCustomFolder(input.id)!;
  }

  /** Rename a folder. Only the display label changes; localRelPath is fixed. */
  renameCustomFolder(id: string, name: string): void {
    this.getStatement(`
      UPDATE custom_folders SET name = ? WHERE id = ?
    `).run(name, id);
  }

  /** Delete a folder row. Associated documents are unlinked by the caller. */
  deleteCustomFolder(id: string): void {
    this.getStatement(`DELETE FROM custom_folders WHERE id = ?`).run(id);
  }

  /** Set documents.custom_folder_id = NULL for every doc in this folder. */
  clearDocumentsCustomFolder(folderId: string): number {
    const result = this.getStatement(`
      UPDATE documents SET custom_folder_id = NULL WHERE custom_folder_id = ?
    `).run(folderId);
    return result.changes;
  }

  /** Set documents.custom_folder_id = NULL for one doc currently in the folder
   *  （从归档移出单篇；本地文件与同步基线保留）。Returns affected row count. */
  clearDocumentCustomFolder(objToken: string, folderId: string): number {
    const result = this.getStatement(`
      UPDATE documents SET custom_folder_id = NULL
      WHERE obj_token = ? AND custom_folder_id = ?
    `).run(objToken, folderId);
    return result.changes;
  }

  /**
   * List documents belonging to a custom folder, ordered by title.
   * Used by GET /api/custom-folders to compose the docs array per folder.
   */
  listCustomFolderDocs(folderId: string): Array<{
    objToken: string;
    title: string;
    objType: string;
    originalLink: string | null;
    localRelPath: string | null;
  }> {
    const rows = this.getStatement(`
      SELECT obj_token, title, obj_type, original_link, local_rel_path
      FROM documents
      WHERE custom_folder_id = ?
      ORDER BY title COLLATE NOCASE ASC
    `).all(folderId) as Array<{
      obj_token: string;
      title: string;
      obj_type: string;
      original_link: string | null;
      local_rel_path: string | null;
    }>;
    return rows.map((row) => ({
      objToken: row.obj_token,
      title: row.title,
      objType: row.obj_type,
      originalLink: row.original_link,
      localRelPath: row.local_rel_path,
    }));
  }

  /**
   * Link a document row to a custom folder and stamp the archive-specific
   * fields. This is the write performed after a successful file commit for a
   * quick-added docx. Returns { applied: false } (a no-op) when a row for the
   * obj_token already exists as a structure-tree member (watched_root_id or
   * wiki_node_token set) — a race the route's earlier already_exists dup-check
   * cannot cover — so the caller can roll back its files and report
   * already_exists instead of clobbering the structure fields.
   */
  setDocumentCustomFolder(input: {
    objToken: string;
    folderId: string;
    wikiNodeToken: string | null;
    objType: 'docx' | 'sheet' | 'slides' | 'unknown';
    title: string;
    localMdPath: string;
    localRelPath: string;
    originalLink: string | null;
    objEditTime: number | null;
    spaceId: string | null;
    lastSyncedAt?: string;
  }): { applied: boolean } {
    const nowIso = input.lastSyncedAt ?? new Date().toISOString();
    // INSERT the documents row with the archive contract: watched_root_* NULL,
    // custom_folder_id set, sync_state='synced', cloud_match='synced'.
    //
    // Ownership guard: the conflict update only applies to rows that are NOT
    // structure-tree members (watched_root_id AND wiki_node_token both NULL).
    // If the structure-sync engine inserted this obj_token between the route's
    // already_exists dup-check and this write, the WHERE is false → the row is
    // left untouched → changes=0 → the caller sees applied=false and rolls
    // back its files. This prevents an unconditional upsert from nulling the
    // structure fields and silently archiving a doc the user still wants in
    // the tree.
    const stmt = this.getStatement(`
      INSERT INTO documents (
        obj_token, wiki_node_token, obj_type, title, local_md_path,
        last_synced_modify_time, last_synced_at, status,
        original_link, cloud_match, watched_root_url,
        observed_obj_edit_time, synced_obj_edit_time, sync_state,
        watched_root_id, local_rel_path, space_id,
        missing_complete_count, has_child, custom_folder_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'synced', ?, 'synced', NULL, ?, ?, 'synced', NULL, ?, ?, 0, 0, ?)
      ON CONFLICT(obj_token) DO UPDATE SET
        obj_type = excluded.obj_type,
        title = excluded.title,
        local_md_path = excluded.local_md_path,
        last_synced_at = excluded.last_synced_at,
        status = 'synced',
        original_link = COALESCE(excluded.original_link, documents.original_link),
        cloud_match = 'synced',
        observed_obj_edit_time = COALESCE(excluded.observed_obj_edit_time, documents.observed_obj_edit_time),
        synced_obj_edit_time = COALESCE(excluded.synced_obj_edit_time, documents.synced_obj_edit_time),
        sync_state = 'synced',
        wiki_node_token = excluded.wiki_node_token,
        watched_root_url = NULL,
        watched_root_id = NULL,
        local_rel_path = excluded.local_rel_path,
        space_id = COALESCE(excluded.space_id, documents.space_id),
        custom_folder_id = excluded.custom_folder_id,
        cloud_deleted = 0,
        missing_complete_count = 0,
        last_sync_error_code = NULL,
        updated_at = datetime('now')
      WHERE documents.watched_root_id IS NULL
        AND documents.wiki_node_token IS NULL
    `);
    const info = stmt.run(
      input.objToken,
      input.wikiNodeToken,
      input.objType,
      input.title,
      input.localMdPath,
      input.objEditTime != null ? String(input.objEditTime) : '',
      nowIso,
      input.originalLink,
      input.objEditTime,
      input.objEditTime,
      input.localRelPath,
      input.spaceId,
      input.folderId,
    );
    return { applied: info.changes > 0 };
  }

  /**
   * List ALL documents that belong to ANY custom folder (custom_folder_id
   * IS NOT NULL AND watched_root_url IS NULL). Used by ChangeDetector's
   * detectCustomFolderChanges to check cloud edits for quick-added archive
   * docs that live outside the synced structure tree.
   *
   * Note: listCustomFolderDocs(folderId) returns display fields for a single
   * folder; this method returns full DocumentRecord rows for ALL folders.
   */
  listAllCustomFolderDocs(): DocumentRecord[] {
    const rows = this.getStatement(`
      SELECT * FROM documents
      WHERE custom_folder_id IS NOT NULL
        AND watched_root_url IS NULL
        AND cloud_deleted = 0
      ORDER BY title COLLATE NOCASE ASC
    `).all() as any[];
    return rows.map((row) => this.mapRowToDocumentRecord(row));
  }

  /** All custom-folder local_rel_path prefixes, for orphan-exclusion guards. */
  getCustomFolderRelPaths(): string[] {
    const rows = this.getStatement(`
      SELECT local_rel_path FROM custom_folders
    `).all() as Array<{ local_rel_path: string }>;
    return rows.map((row) => row.local_rel_path).filter((p) => p && p.length > 0);
  }

  /**
   * Look up the owner obj_token of a documents row by its local_rel_path.
   * Used by the custom-folder archive flow to detect title collisions so two
   * same-title docs never share one file (each DB row maps to a unique file).
   */
  getDocumentByLocalRelPath(localRelPath: string): { obj_token: string } | null {
    const row = this.getStatement(`
      SELECT obj_token FROM documents WHERE local_rel_path = ? LIMIT 1
    `).get(localRelPath) as { obj_token: string } | undefined;
    return row ?? null;
  }

  /**
   * Backfill documents.custom_folder_id for rows that live under a
   * registered custom folder's local_rel_path but carry no archive binding
   * (e.g. the user hand-dropped a feishu-sync .md into _custom/<name>/ and a
   * rebuild upserted the row with custom_folder_id NULL, watched_root_url
   * NULL). Symmetric to backfillWatchedRoots(), but driven by longest-prefix
   * matching against registered folder paths instead of config.
   *
   * Candidates: custom_folder_id NULL + watched_root_url NULL +
   * cloud_deleted = 0 + non-empty local_rel_path. watchedRoot-owned rows are
   * excluded because structure-tree ownership wins over archive ownership.
   *
   * Matching: longest prefix on folder localRelPath — the row must live
   * strictly INSIDE the folder (relPath === folderRelPath + '/' + rest);
   * when both `_custom/a` and `_custom/a/b` are registered, a file at
   * `_custom/a/b/x.md` binds to `_custom/a/b`, never to `_custom/a`.
   *
   * Design decision — only custom_folder_id is written; wiki_node_token is
   * deliberately NOT cleared:
   *   a) upsertDocument's ON CONFLICT uses COALESCE(excluded, existing) for
   *      wiki_node_token, so the next reindex writes the header-parsed token
   *      right back — clearing it is wasted work;
   *   b) custom_folder_id is the single source of truth for archive identity:
   *      both the frontend tree filter (MappingService feishu view) and
   *      detectCustomFolderChanges() (custom_folder_id IS NOT NULL) branch
   *      on it alone;
   *   c) keeping the wiki identity benefits detectCustomFolderChanges, whose
   *      skip conditions treat an empty wikiNodeToken as a skip signal.
   *
   * Idempotent and concurrency-safe: the UPDATE guards on
   * `AND custom_folder_id IS NULL` so a concurrent setDocumentCustomFolder()
   * write is never clobbered.
   *
   * Returns { bound } — the number of rows newly linked to a folder.
   */
  backfillCustomFolders(): { bound: number } {
    const folders = (
      this.getStatement(`SELECT id, local_rel_path FROM custom_folders`).all() as Array<{
        id: string;
        local_rel_path: string;
      }>
    ).filter((folder) => folder.local_rel_path && folder.local_rel_path.length > 0);

    const tx = this.db.transaction((): { bound: number } => {
      const candidates = this.db
        .prepare(
          `SELECT obj_token, local_rel_path FROM documents
           WHERE custom_folder_id IS NULL
             AND watched_root_url IS NULL
             AND cloud_deleted = 0
             AND local_rel_path IS NOT NULL
             AND local_rel_path != ''`,
        )
        .all() as Array<{ obj_token: string; local_rel_path: string }>;

      const bind = this.db.prepare(`
        UPDATE documents
        SET custom_folder_id = ?, updated_at = datetime('now')
        WHERE obj_token = ? AND custom_folder_id IS NULL
      `);

      let bound = 0;
      for (const row of candidates) {
        // Longest-prefix match over folder localRelPath. The trailing '/'
        // forces a strict containment test (exact equality is not a match —
        // a file path is never a folder path).
        let best: { id: string; local_rel_path: string } | null = null;
        for (const folder of folders) {
          const prefix = folder.local_rel_path.endsWith('/')
            ? folder.local_rel_path
            : folder.local_rel_path + '/';
          if (
            row.local_rel_path.startsWith(prefix) &&
            (!best || folder.local_rel_path.length > best.local_rel_path.length)
          ) {
            best = folder;
          }
        }
        if (best) {
          bound += bind.run(best.id, row.obj_token).changes;
        }
      }
      return { bound };
    });
    return tx();
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
   * Classify local rows from the configured watched-root authority. Both the
   * stable token id and the URL are recorded; state-machine ownership uses
   * the former so a tenant host change cannot orphan existing rows.
   */
  backfillWatchedRoots(
    roots: Array<Pick<WatchedRootConfig, 'id' | 'url' | 'localDir'>>,
    kbRoot: string,
  ): { scanned: number; tagged: number; untagged: number } {
    const configuredRoots = roots.filter((root) => root.id && root.url && root.localDir);
    if (configuredRoots.length === 0) {
      return { scanned: 0, tagged: 0, untagged: 0 };
    }

    const tx = this.db.transaction((): {
      scanned: number;
      tagged: number;
      untagged: number;
    } => {
      // Reset only local-path URL tags. Do not clear watched_root_id: P1 may
      // have observed a pending cloud node before it has a verified local
      // file, and that identity remains authoritative for deletion safety.
      this.db.exec(`
        UPDATE documents
        SET watched_root_url = NULL
        WHERE COALESCE(local_md_path, '') <> ''
      `);

      let tagged = 0;
      for (const root of configuredRoots) {
        const dirName = root.localDir;
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
             SET watched_root_url = ?, watched_root_id = ?, updated_at = datetime('now')
             WHERE LOWER(local_md_path) LIKE ? ESCAPE '\\'
                OR LOWER(local_md_path) LIKE ? ESCAPE '\\'
                OR LOWER(local_md_path) LIKE ? ESCAPE '\\'`,
          )
          .run(
            root.url,
            root.id,
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

  /** @deprecated P2 callers should pass structured roots to backfillWatchedRoots(). */
  backfillWatchedRootUrls(
    dirToUrl: Map<string, string>,
    kbRoot: string,
  ): { scanned: number; tagged: number; untagged: number } {
    return this.backfillWatchedRoots(
      Array.from(dirToUrl.entries()).map(([localDir, url]) => ({
        id: parseNodeTokenFromUrl(url),
        url,
        localDir,
      })),
      kbRoot,
    );
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
   * Build the watched_roots projection from structured configuration. Root
   * token ids are the primary join key; URL is retained for legacy snapshots
   * and display, so a tenant-host change does not sever state ownership.
   */
  getWatchedRoots(configuredRoots: WatchedRootConfig[]): import('../types/index.js').WatchedRoot[] {
    if (configuredRoots.length === 0) return [];

    const statsById = this.db
      .prepare(
        `SELECT
           watched_root_id AS id,
           COUNT(*) AS child_count,
           MAX(last_seen_at) AS last_seen
         FROM documents
         WHERE watched_root_id IS NOT NULL AND cloud_deleted = 0
         GROUP BY watched_root_id`,
      )
      .all() as Array<{ id: string; child_count: number; last_seen: string | null }>;
    const statsByUrl = this.db
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
    const statsByIdMap = new Map(statsById.map((stat) => [stat.id, stat]));
    const statsByUrlMap = new Map(statsByUrl.map((stat) => [stat.url, stat]));

    return configuredRoots.map((root) => {
      const stat = statsByIdMap.get(root.id) ?? statsByUrlMap.get(root.url);
      const childCount = stat?.child_count ?? 0;
      const lastSeen = stat?.last_seen ?? null;
      return {
        url: root.url,
        nodeToken: root.id,
        title: root.localDir,
        displayName: root.enabled ? root.localDir : `[已停用] ${root.localDir}`,
        localDir: root.localDir,
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
        watched_root_url TEXT,
        -- v5 runtime state. The legacy status/obj_edit_time fields above
        -- remain readable during the staged migration, but new detection
        -- logic treats these columns as authoritative.
        observed_obj_edit_time INTEGER,
        synced_obj_edit_time INTEGER,
        sync_state TEXT NOT NULL DEFAULT 'pending_added',
        watched_root_id TEXT,
        local_rel_path TEXT,
        missing_complete_count INTEGER NOT NULL DEFAULT 0,
        last_sync_error_code TEXT,
        has_child INTEGER NOT NULL DEFAULT 0,
        custom_folder_id TEXT
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

      -- Operator-owned Feishu-side repair queue. These rows deliberately do
      -- not participate in the normal added/modified diff until the user has
      -- finished the cloud-side action and explicitly asks for a recheck.
      CREATE TABLE IF NOT EXISTS feishu_pending_items (
        obj_token TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        watched_root_id TEXT,
        reason_code TEXT NOT NULL,
        error TEXT NOT NULL,
        suggested_resolution TEXT NOT NULL DEFAULT '',
        repair_action TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        recheck_requested_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_feishu_pending_root ON feishu_pending_items(watched_root_id);
      CREATE INDEX IF NOT EXISTS idx_feishu_pending_recheck ON feishu_pending_items(recheck_requested_at);

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

      -- Custom-folder archive (quick-add flow). Each row is a user-created
      -- folder that collects scattered cloud docs under a local directory
      -- (_custom/<sanitized-name>). Documents link back via custom_folder_id.
      CREATE TABLE IF NOT EXISTS custom_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        local_rel_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_custom_folders_local_rel_path ON custom_folders(local_rel_path);

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
