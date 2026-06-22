/**
 * SnapshotService - Read-only _index.json cache generator (P2-T6).
 *
 * Implements 03 §2.4.1 + §3.6.4:
 * - Builds a MappingNode[] projection from the documents table
 * - Scans knowledge_base_root for orphan .md files (no obj_token header)
 * - Aggregates top_level_dirs counts
 * - Writes the result to <knowledge_base_root>/_index.json atomically
 *
 * Design intent (03 §2.4 last paragraph): SQLite is the WRITE source of
 * truth; _index.json is a READ-ONLY cache consumed by the frontend node
 * tree and by external tooling. Reordering / sync never edits _index.json
 * inline — they update SQLite, then trigger this service to refresh the
 * snapshot.
 *
 * Trigger points (per 03 §2.4.1 "生成时机"):
 *   - sync completion (sync-engine hook)
 *   - first index completion (index-scanner hook)
 *   - manual trigger (mapping/refresh-index API)
 *   - reorder API (refresh sortOrder only; cheap path)
 *
 * The orphan-file scan reuses IndexScanner's parseMetadata so the
 * "what counts as mapped" definition stays identical between first-index
 * and orphan-detection (P1 upgrade pays off here).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { LocalMapStore } from './local-map-store.js';
import type { ConfigManager } from './config-manager.js';
import { IndexScanner } from './index-scanner.js';
import type {
  IndexSnapshot,
  MappingNode,
  WatchedRoot,
} from '../types/index.js';

const SNAPSHOT_VERSION = '1.0';
const SNAPSHOT_FILENAME = '_index.json';

export class SnapshotService {
  /**
   * Reuse a single IndexScanner instance for orphan detection so the
   * header-parsing logic (3 formats) is shared with first-index.
   * LarkCliClient is only invoked on demand for files that have an
   * original_link but no obj_token — orphan detection skips that path
   * (orphans are by definition files we couldn't map).
   */
  private indexScanner: IndexScanner;

  constructor(
    private localMapStore: LocalMapStore,
    private configManager: ConfigManager,
    indexScannerDeps: { larkCliClient: any; config: any } | IndexScanner,
  ) {
    this.watchedRootsVersion = 0;
    if (indexScannerDeps instanceof IndexScanner) {
      this.indexScanner = indexScannerDeps;
    } else {
      this.indexScanner = new IndexScanner({
        localMapStore,
        larkCliClient: indexScannerDeps.larkCliClient,
        config: indexScannerDeps.config,
      });
    }
  }

  /**
   * Build a derived watched_roots array for the current snapshot.
   *
   * v0.2.0 structure-align Phase B: combines the configured watchedRootUrls
   * with SQLite state to produce one entry per watchedRoot. Each entry
   * carries display_name + status + child_count so the frontend can
   * render the top-level groupings without a second round-trip.
   */
  private buildWatchedRoots(): WatchedRoot[] {
    const config = this.configManager.getConfig();
    const urls = config?.watchedRootUrls ?? [];
    if (urls.length === 0) return [];
    if (typeof (this.localMapStore as any).getWatchedRoots !== 'function') {
      return [];
    }
    return (this.localMapStore as any).getWatchedRoots(urls) as WatchedRoot[];
  }

  /**
   * Scan kbRoot for directories that exist on disk but are NOT bound
   * to any configured watchedRoot. These are surfaced as mounted_dirs
   * in _index.json so the local view can show them distinctly from
   * tracked watchedRoots.
   *
   * A directory is "mounted" when:
   *   - it exists directly under kbRoot
   *   - its name does not match any watchedRoot.localDir
   *
   * Examples: _reports/, attachments/, .trash-bin/ (dot-dirs skipped).
   */
  private scanMountedDirs(
    kbRoot: string,
    watchedRoots: WatchedRoot[],
  ): Array<{ local_dir: string; reason: string }> {
    const tracked = new Set(
      watchedRoots.map((wr) => wr.localDir).filter((d) => d.length > 0),
    );
    const mounted: Array<{ local_dir: string; reason: string }> = [];
    if (!fs.existsSync(kbRoot)) return mounted;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(kbRoot, { withFileTypes: true });
    } catch {
      return mounted;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (tracked.has(entry.name)) continue;
      mounted.push({
        local_dir: entry.name,
        reason: 'local_only_no_feishu_node',
      });
    }
    return mounted.sort((a, b) => a.local_dir.localeCompare(b.local_dir));
  }

  /**
   * Cache for the watched_roots value so we don't re-query SQLite on
   * every snapshot refresh. Bumped by SnapshotService.generate() so
   * the cache is per-snapshot-fresh.
   */
  private watchedRootsVersion: number;

  /**
   * Generate (or regenerate) the _index.json snapshot under the
   * configured knowledge_base_root. Writes atomically via a temp file
   * + rename so a partial write never leaves a corrupt snapshot.
   *
   * Returns the in-memory snapshot so callers (API handlers, tests)
   * can use it without re-reading the file.
   */
  generate(): IndexSnapshot {
    const config = this.configManager.getConfig();
    if (!config) {
      throw new Error(
        '[SnapshotService] config not loaded yet; call configManager.load() before generating snapshot',
      );
    }
    const kbRoot = config.knowledgeBaseRoot;
    const watchedRootUrls = config.watchedRootUrls ?? [];

    if (!kbRoot) {
      throw new Error(
        '[SnapshotService] knowledgeBaseRoot is not configured; cannot generate _index.json',
      );
    }

    const documents = this.localMapStore.getAllDocuments();
    const nodes = documents.map((d) => this.projectDocument(d));
    const orphanFiles = this.scanOrphanFiles(kbRoot, new Set(documents.map((d) => d.localMdPath)));
    const topLevelDirs = this.aggregateTopLevelDirs(nodes, kbRoot);
    const watchedRoots = this.buildWatchedRoots();
    const mountedDirs = this.scanMountedDirs(kbRoot, watchedRoots);
    this.watchedRootsVersion += 1;

    const snapshot: IndexSnapshot = {
      version: SNAPSHOT_VERSION,
      generated_at: new Date().toISOString(),
      knowledge_base_root: kbRoot,
      watched_root_urls: watchedRootUrls,
      watched_roots: watchedRoots,
      mounted_dirs: mountedDirs,
      top_level_dirs: topLevelDirs,
      nodes,
      orphan_files: orphanFiles,
    };

    this.writeAtomically(kbRoot, snapshot);
    return snapshot;
  }

  /**
   * Refresh only the sortOrder field of each node, leaving the rest
   * of the snapshot intact. Used by the reorder API (cheap path: no
   * orphan rescan, no top_level_dirs recompute).
   *
   * Implementation note: we re-generate the snapshot from SQLite
   * (which is the source of truth and has the new local_sort_order
   * values already applied) — this is cheaper than parsing+patching
   * the JSON file in place and avoids drift. The orphan_files list
   * is preserved from the previous snapshot to avoid re-scanning the
   * filesystem on every drag.
   */
  refreshSortOrder(): IndexSnapshot {
    const config = this.configManager.getConfig();
    if (!config) {
      throw new Error(
        '[SnapshotService] config not loaded yet; call configManager.load() before refreshing sortOrder',
      );
    }
    const kbRoot = config.knowledgeBaseRoot;
    if (!kbRoot) {
      throw new Error(
        '[SnapshotService] knowledgeBaseRoot is not configured; cannot refresh _index.json',
      );
    }

    const previous = this.readExisting(kbRoot);
    const documents = this.localMapStore.getAllDocuments();
    const nodes = documents.map((d) => this.projectDocument(d));
    const watchedRoots = this.buildWatchedRoots();
    const mountedDirs = previous?.mounted_dirs ?? this.scanMountedDirs(kbRoot, watchedRoots);
    this.watchedRootsVersion += 1;

    const snapshot: IndexSnapshot = {
      version: SNAPSHOT_VERSION,
      generated_at: new Date().toISOString(),
      knowledge_base_root: kbRoot,
      watched_root_urls: previous?.watched_root_urls ?? config.watchedRootUrls ?? [],
      watched_roots: watchedRoots,
      mounted_dirs: mountedDirs,
      top_level_dirs: previous?.top_level_dirs ?? this.aggregateTopLevelDirs(nodes, kbRoot),
      nodes,
      // Preserve orphan list from prior snapshot to skip the FS scan.
      orphan_files: previous?.orphan_files ?? [],
    };

    this.writeAtomically(kbRoot, snapshot);
    return snapshot;
  }

  /**
   * Load the snapshot from disk without regenerating. Returns null
   * when the snapshot does not exist yet (first run).
   */
  readExisting(kbRoot: string): IndexSnapshot | null {
    const snapshotPath = path.join(kbRoot, SNAPSHOT_FILENAME);
    if (!fs.existsSync(snapshotPath)) return null;
    try {
      const raw = fs.readFileSync(snapshotPath, 'utf-8');
      return JSON.parse(raw) as IndexSnapshot;
    } catch (error) {
      console.warn(
        `[SnapshotService] Failed to read existing snapshot at ${snapshotPath}; treating as missing:`,
        error,
      );
      return null;
    }
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Project a DocumentRecord (SQLite row) into the MappingNode shape
   * consumed by the frontend / external tools.
   *
   * has_child is computed from the documents table itself (any other
   * row whose parent_node_token equals this node's wiki_node_token)
   * rather than persisted, per 03 §3.1 ("has_child 不持久化").
   */
  private projectDocument(d: any): MappingNode {
    const wikiNodeToken = d.wikiNodeToken ?? null;
    const hasChild = wikiNodeToken
      ? this.localMapStoreHasChildOf(wikiNodeToken)
      : false;

    return {
      obj_token: d.objToken,
      wiki_node_token: wikiNodeToken,
      space_id: d.spaceId ?? null,
      obj_type: d.objType ?? 'unknown',
      title: d.title,
      local_path: d.localMdPath,
      parent_node_token: d.parentNodeToken ?? null,
      has_child: hasChild,
      obj_edit_time: d.objEditTime ?? null,
      last_synced_modify_time: d.lastSyncedModifyTime,
      last_synced_at: d.lastSyncedAt,
      last_seen_at: d.lastSeenAt ?? null,
      status: d.status,
      cloud_deleted: d.cloudDeleted ?? 0,
      sortOrder: d.localSortOrder ?? null,
      // v0.2.0 cloud-link-coverage: surface feishu link + cloud_match so the
      // UI can render "飞书原文" link or "权限受限/无对应" badge.
      original_link: d.originalLink ?? null,
      cloud_match: (d.cloudMatch ?? 'unknown') as
        | 'synced'
        | 'restricted'
        | 'unknown',
      // v0.2.0 structure-align Phase B: surface the watchedRoot that owns
      // this node so the frontend can group top-level entries.
      watched_root_url: d.watchedRootUrl ?? null,
    };
  }

  /**
   * Returns true if any document row has parent_node_token equal to
   * the given wikiNodeToken. Used to compute has_child on the fly.
   *
   * Performance note: this iterates all documents once per node, so
   * snapshot generation is O(N^2) in document count. For the current
   * scale (single-digit hundreds of docs) this is negligible; if the
   * knowledge base grows past ~10k docs we should precompute a
   * parent->child map. Marked for future optimization.
   */
  private localMapStoreHasChildOf(parentWikiNodeToken: string): boolean {
    const all = this.localMapStore.getAllDocuments();
    return all.some((d: any) => (d.parentNodeToken ?? null) === parentWikiNodeToken);
  }

  /**
   * Scan the filesystem for .md files that have no resolvable header
   * (no obj_token AND no original_link). These are surfaced to the UI
   * as orphan_files so the user can decide whether to delete them or
   * manually attach a header.
   *
   * The "known local paths" set lets us skip files that are already
   * mapped in SQLite even if their header parsing is currently broken
   * (defensive: avoids double-listing a file as both mapped and orphan).
   */
  private scanOrphanFiles(
    kbRoot: string,
    knownLocalPaths: Set<string>,
  ): Array<{ path: string; reason: string; cloud_match: 'local_only' }> {
    const orphans: Array<{ path: string; reason: string; cloud_match: 'local_only' }> = [];

    if (!fs.existsSync(kbRoot)) {
      console.warn(
        `[SnapshotService] knowledge_base_root does not exist: ${kbRoot}; skipping orphan scan`,
      );
      return orphans;
    }

    const mdFiles = this.collectMarkdownFiles(kbRoot);
    for (const mdPath of mdFiles) {
      // Skip the generated README.md (it has no header by design).
      const base = path.basename(mdPath);
      if (base === 'README.md') continue;

      // Skip if already mapped.
      if (knownLocalPaths.has(mdPath)) continue;

      // Parse header; orphan = no obj_token AND no original_link.
      let content: string;
      try {
        content = fs.readFileSync(mdPath, 'utf-8');
      } catch {
        continue; // unreadable file; skip silently
      }

      const parsed = this.indexScanner.parseMetadata(content);
      const hasObjToken = !!parsed?.obj_token;
      const hasOriginalLink = !!parsed?.original_link;

      if (!hasObjToken && !hasOriginalLink) {
        orphans.push({
          path: path.relative(kbRoot, mdPath).split(path.sep).join('/'),
          reason: 'no_obj_token_in_header',
          // v0.2.0 cloud-link-coverage: explicit marker — this file has
          // no feishu correspondence, it is local-only (curated/added by
          // the user). The UI surfaces this distinctly from synced/restricted.
          cloud_match: 'local_only',
        });
      }
    }

    return orphans;
  }

  /**
   * Aggregate node counts per top-level directory under kbRoot.
   * top_level_dirs reflects the local filesystem layout (NOT Feishu
   * L1 structure) per Q5: the local library is a curated subset of
   * the Feishu space, so directories like "000-研发规范" are local
   * groupings whose counts the UI surfaces for orientation.
   */
  private aggregateTopLevelDirs(
    nodes: MappingNode[],
    kbRoot: string,
  ): Array<{ dir: string; node_count: number }> {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      if (!node.local_path) continue;
      const abs = path.isAbsolute(node.local_path)
        ? node.local_path
        : path.join(kbRoot, node.local_path);
      const rel = path.relative(kbRoot, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // outside kbRoot
      const topSegment = rel.split(path.sep)[0];
      if (!topSegment) continue;
      counts.set(topSegment, (counts.get(topSegment) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, node_count]) => ({ dir, node_count }));
  }

  /**
   * Recursive .md file enumeration. Skips the snapshot file itself
   * and known generated artifacts.
   */
  private collectMarkdownFiles(dir: string): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }

    for (const entry of entries) {
      // Skip dot-dirs (.trash-bin, .assets handled separately as they
      // don't typically contain docs; .git etc).
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...this.collectMarkdownFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== SNAPSHOT_FILENAME) {
        out.push(full);
      }
    }
    return out;
  }

  /**
   * Atomic snapshot write: serialize to a temp file in the same
   * directory, then rename over the destination. rename() is atomic
   * on POSIX + NTFS for same-directory moves, so readers never observe
   * a half-written file.
   */
  private writeAtomically(kbRoot: string, snapshot: IndexSnapshot): void {
    const target = path.join(kbRoot, SNAPSHOT_FILENAME);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(kbRoot, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
    fs.renameSync(tmp, target);
    console.info(`[SnapshotService] _index.json refreshed at ${target} (${snapshot.nodes.length} nodes, ${snapshot.orphan_files.length} orphans)`);
  }
}
