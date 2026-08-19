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
import { ScanPolicy } from './scan-policy.js';
import { toPortableRelative } from './path-resolver.js';
import { getEnabledWatchedRootUrls } from '../types/index.js';
import type {
  IndexSnapshot,
  MappingNode,
  OrphanFileEntry,
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
   * v0.2.0 structure-align Phase B: combines the configured watchedRoots
   * with SQLite state to produce one entry per watchedRoot. Each entry
   * carries display_name + status + child_count so the frontend can
   * render the top-level groupings without a second round-trip.
   */
  private buildWatchedRoots(): WatchedRoot[] {
    const config = this.configManager.getConfig();
    const roots = config?.watchedRoots ?? [];
    if (roots.length === 0) return [];
    if (typeof (this.localMapStore as any).getWatchedRoots !== 'function') {
      return [];
    }
    return (this.localMapStore as any).getWatchedRoots(roots) as WatchedRoot[];
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
    const watchedRootUrls = getEnabledWatchedRootUrls(config);

    if (!kbRoot) {
      throw new Error(
        '[SnapshotService] knowledgeBaseRoot is not configured; cannot generate _index.json',
      );
    }

    const documents = this.localMapStore.getAllDocuments();
    const nodes = documents.map((d) => this.projectDocument(d));
    const customFolderPrefixes = this.collectCustomFolderPrefixes();
    const orphanFiles = this.scanOrphanFiles(
      kbRoot,
      new Set(documents.map((d) => d.localMdPath)),
      customFolderPrefixes,
    );
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
      watched_root_urls: getEnabledWatchedRootUrls(config),
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
    const hasChild =
      typeof d.hasChild === 'boolean'
        ? d.hasChild
        : wikiNodeToken
          ? this.localMapStoreHasChildOf(wikiNodeToken)
          : false;

    const config = this.configManager.getConfig();
    const kbRoot = config?.knowledgeBaseRoot ?? '';
    const portablePath =
      (typeof d.localRelPath === 'string' && d.localRelPath.length > 0
        ? d.localRelPath.replace(/\\/g, '/')
        : null) ??
      (kbRoot && d.localMdPath
        ? toPortableRelative(kbRoot, d.localMdPath)
        : null) ??
      // Last resort: if already relative-looking, keep; never emit Windows drive paths.
      (typeof d.localMdPath === 'string' &&
      !path.isAbsolute(d.localMdPath) &&
      !/^[A-Za-z]:[\\/]/.test(d.localMdPath)
        ? d.localMdPath.replace(/\\/g, '/')
        : '');

    return {
      obj_token: d.objToken,
      wiki_node_token: wikiNodeToken,
      space_id: d.spaceId ?? null,
      obj_type: d.objType ?? 'unknown',
      title: d.title,
      local_path: portablePath,
      parent_node_token: d.parentNodeToken ?? null,
      has_child: hasChild,
      obj_edit_time: d.objEditTime ?? d.observedObjEditTime ?? null,
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
  /**
   * Collect custom-folder local_rel_path prefixes from SQLite so orphan
   * detection can exclude files that have a cloud identity but live outside
   * the watched-root structure tree.
   */
  private collectCustomFolderPrefixes(): string[] {
    try {
      if (typeof this.localMapStore.getCustomFolderRelPaths !== 'function') return [];
      return this.localMapStore.getCustomFolderRelPaths();
    } catch {
      return [];
    }
  }

  private scanOrphanFiles(
    kbRoot: string,
    knownLocalPaths: Set<string>,
    customFolderPrefixes: string[] = [],
  ): OrphanFileEntry[] {
    const orphans: OrphanFileEntry[] = [];

    if (!fs.existsSync(kbRoot)) {
      console.warn(
        `[SnapshotService] knowledge_base_root does not exist: ${kbRoot}; skipping orphan scan`,
      );
      return orphans;
    }

    // Normalize known paths to absolute + portable relative for membership checks.
    const knownAbsolute = new Set<string>();
    const knownRelative = new Set<string>();
    for (const known of knownLocalPaths) {
      if (!known) continue;
      const absolute = path.isAbsolute(known)
        ? path.resolve(known)
        : path.resolve(kbRoot, known);
      knownAbsolute.add(absolute);
      const rel = toPortableRelative(kbRoot, absolute);
      if (rel) knownRelative.add(rel);
    }

    const mdFiles = this.collectMarkdownFiles(kbRoot);
    for (const mdPath of mdFiles) {
      const base = path.basename(mdPath);
      const relative = path.relative(kbRoot, mdPath).split(path.sep).join('/');

      // Already mapped in SQLite — not an orphan.
      if (knownAbsolute.has(path.resolve(mdPath)) || knownRelative.has(relative)) {
        continue;
      }

      // Custom-folder archive files carry a cloud identity (obj_token) but
      // live outside every watched-root structure tree. They must never be
      // reported as orphans just because their directory is untracked.
      if (isUnderAnyPrefix(relative, customFolderPrefixes)) {
        continue;
      }

      // Navigation / operational artefacts — classified, not hidden.
      if (base === 'INDEX.md') {
        orphans.push({
          path: relative,
          reason: 'navigation_index',
          classification: 'ignored_artifact',
          cloud_match: 'local_only',
        });
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(mdPath, 'utf-8');
      } catch {
        continue;
      }

      const parsed = this.indexScanner.parseMetadata(content);
      const hasObjToken = !!parsed?.obj_token;
      const hasOriginalLink = !!parsed?.original_link;

      // README without identity is a diagnostic (missing_metadata), not skipped.
      if (base === 'README.md' && !hasObjToken && !hasOriginalLink) {
        orphans.push({
          path: relative,
          reason: 'readme_missing_feishu_metadata',
          classification: 'missing_metadata',
          cloud_match: 'unknown',
        });
        continue;
      }

      if (!hasObjToken && !hasOriginalLink) {
        // Sheet-style source markers without tokens are ambiguous, not local-only.
        const looksLikeSheetExport =
          /飞书电子表格|feishu\s*sheet|lark\s*sheet/i.test(content.slice(0, 500));
        orphans.push({
          path: relative,
          reason: looksLikeSheetExport
            ? 'sheet_export_without_token'
            : 'no_obj_token_in_header',
          classification: looksLikeSheetExport
            ? 'cloud_match_ambiguous'
            : 'local_only_confirmed',
          cloud_match: looksLikeSheetExport ? 'unknown' : 'local_only',
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
      // local_path is portable relative after P2-05; still tolerate legacy abs.
      let rel = node.local_path.replace(/\\/g, '/');
      if (path.isAbsolute(node.local_path) || /^[A-Za-z]:[\\/]/.test(node.local_path)) {
        const portable = toPortableRelative(kbRoot, node.local_path);
        if (!portable) continue;
        rel = portable;
      }
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const topSegment = rel.split('/')[0];
      // Only count real top-level directories, not root-level loose files.
      if (!topSegment || !rel.includes('/')) continue;
      counts.set(topSegment, (counts.get(topSegment) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, node_count]) => ({ dir, node_count }));
  }

  /**
   * Recursive .md file enumeration. Skips the snapshot file itself and
   * operational artifacts according to the shared ScanPolicy.
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
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Preserve the existing broad hidden-directory guard for snapshot
        // generation, then apply the shared named-artifact exclusions used
        // by every knowledge-base scanner.
        if (
          ScanPolicy.shouldSkipDirectory(entry.name) ||
          entry.name.startsWith('.')
        ) {
          continue;
        }
        out.push(...this.collectMarkdownFiles(full));
      } else if (
        entry.isFile() &&
        !ScanPolicy.shouldSkipFile(entry.name) &&
        entry.name.endsWith('.md') &&
        entry.name !== SNAPSHOT_FILENAME
      ) {
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

/**
 * Return true when a POSIX relative path equals or sits under one of the
 * given prefixes (each prefix normalized to POSIX without a trailing slash).
 */
function isUnderAnyPrefix(relativePath: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return false;
  const normalized = relativePath.replace(/\\/g, '/');
  for (const raw of prefixes) {
    const prefix = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!prefix) continue;
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true;
  }
  return false;
}
