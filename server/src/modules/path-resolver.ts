/**
 * PathResolver — profile-aware local path planning for Feishu sync.
 *
 * Responsibility:
 *   1. Prefer an existing, verified relative mapping when it still matches.
 *   2. Otherwise derive a target from watchedRoot + parent chain + title +
 *      hasChild + layoutProfile.
 *   3. Sanitize path segments, reject escapes, and surface conflicts instead
 *      of auto-overwriting or inventing random suffixes.
 *
 * This module never writes files. Callers (dry-run planner, reconciliation,
 * future apply coordinator) consume ResolvedLocalTarget / PathPlanResult.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { LayoutProfile, WatchedRootConfig } from '../types/index.js';

/** Portable, POSIX-style knowledge-base-relative path pieces. */
export interface ResolvedLocalTarget {
  watchedRootId: string;
  /** e.g. `技术 - Dev/2.数据层/README.md` */
  relativeMarkdownPath: string;
  /** Directory that holds images/ for this document. */
  relativeAssetDir: string;
  /** Directory that holds CSV raw data, or null when not a sheet layout. */
  relativeCsvDataDir: string | null;
  source: 'existing-mapping' | 'layout-profile';
  /** When an existing mapping must move to the profile path. */
  plannedMoveFrom?: string;
}

export type PathConflictKind =
  | 'empty-title'
  | 'escape-root'
  | 'reserved-name'
  | 'case-collision'
  | 'existing-file'
  | 'duplicate-target'
  | 'invalid-segment'
  | 'missing-root';

export interface PathConflict {
  kind: PathConflictKind;
  message: string;
  relativePath?: string;
  conflictingPath?: string;
}

export interface PathPlanResult {
  ok: boolean;
  target: ResolvedLocalTarget | null;
  conflicts: PathConflict[];
}

export interface PathResolveInput {
  knowledgeBaseRoot: string;
  watchedRoot: WatchedRootConfig;
  /** Document display title from Feishu. */
  title: string;
  /**
   * Whether this wiki node has children. Branch vs leaf only affects
   * `mirror-title-file`.
   */
  hasChild: boolean;
  /**
   * Titles of ancestors from the watched root (exclusive) down to the
   * immediate parent (inclusive). Empty means this node IS the root body.
   */
  parentChainTitles?: string[];
  /**
   * True when this node is the watched root itself. When omitted, an empty
   * parent chain is treated as the root node.
   */
  isWatchedRootNode?: boolean;
  /** Portable relative path already stored in the database, if any. */
  existingLocalRelPath?: string | null;
  /**
   * Absolute or relative local path already on the document. Used only to
   * recover a relative path when `existingLocalRelPath` is empty.
   */
  existingLocalMdPath?: string | null;
  /**
   * When true, an existing mapping that differs from the profile-derived
   * path becomes a planned move rather than an immediate keep.
   * Default false: keep verified existing mappings (preferred identity).
   */
  preferProfilePath?: boolean;
  /**
   * Other documents' planned or occupied relative markdown paths
   * (POSIX). Used for duplicate-target and case-collision detection.
   */
  occupiedRelPaths?: Iterable<string>;
  /**
   * When true, reject a profile-derived path if a different file already
   * exists at that location. Existing-mapping reuse is exempt.
   * Default true.
   */
  rejectExistingFiles?: boolean;
  /**
   * Object type affects the companion `.csv-data` directory for sheets.
   * Defaults to treating non-sheet as null csv dir.
   */
  objType?: 'docx' | 'sheet' | 'slides' | 'unknown';
}

/** Windows + POSIX reserved basenames (case-insensitive). */
const RESERVED_BASENAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_SEGMENT_LENGTH = 120;
const MAX_RELATIVE_PATH_LENGTH = 240;

/**
 * Sanitize one path segment for cross-platform safety.
 * Returns empty string when the segment cannot be used.
 */
export function sanitizePathSegment(value: string): string {
  const cleaned = value
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[.\s]+$/g, '')
    .trim();

  if (!cleaned) return '';
  if (cleaned === '.' || cleaned === '..') return '';
  if (RESERVED_BASENAMES.has(cleaned.toUpperCase())) return '';
  if (cleaned.length > MAX_SEGMENT_LENGTH) {
    return cleaned.slice(0, MAX_SEGMENT_LENGTH).replace(/[.\s]+$/g, '');
  }
  return cleaned;
}

/** Join POSIX relative segments under a watched root localDir. */
export function joinRelative(...parts: string[]): string {
  return parts
    .filter((part) => part && part !== '.')
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/^\//, '')
    .replace(/\/$/, '');
}

/** Convert an absolute path under root into a POSIX relative path. */
export function toPortableRelative(
  knowledgeBaseRoot: string,
  absoluteOrRelative: string,
): string | null {
  const root = path.resolve(knowledgeBaseRoot);
  const absolute = path.isAbsolute(absoluteOrRelative)
    ? path.resolve(absoluteOrRelative)
    : path.resolve(root, absoluteOrRelative);
  const relative = path.relative(root, absolute);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

/** Resolve a portable relative path to an absolute filesystem path. */
export function resolveAbsolute(
  knowledgeBaseRoot: string,
  relativePath: string,
): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return path.resolve(knowledgeBaseRoot, ...segments);
}

export function isPathInsideRoot(
  knowledgeBaseRoot: string,
  candidateAbsolute: string,
): boolean {
  const root = path.resolve(knowledgeBaseRoot);
  const candidate = path.resolve(candidateAbsolute);
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Derive the profile-based relative markdown path for one document.
 * Does not consult existing mappings or the filesystem.
 */
export function deriveProfileRelativePath(input: {
  localDir: string;
  layoutProfile: LayoutProfile;
  title: string;
  hasChild: boolean;
  parentChainTitles?: string[];
  isWatchedRootNode?: boolean;
}): { relativePath: string | null; conflicts: PathConflict[] } {
  const conflicts: PathConflict[] = [];
  const localDir = sanitizePathSegment(input.localDir) || input.localDir.trim();
  if (!localDir || localDir.includes('/') || localDir.includes('\\')) {
    // localDir may legitimately contain nested segments (unusual) — re-sanitize per segment.
  }

  const localDirSegments = input.localDir
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => sanitizePathSegment(segment));

  if (localDirSegments.some((segment) => !segment)) {
    conflicts.push({
      kind: 'invalid-segment',
      message: `watchedRoot.localDir 含有无法安全使用的路径段: ${input.localDir}`,
    });
    return { relativePath: null, conflicts };
  }

  const isRoot =
    input.isWatchedRootNode === true ||
    (input.isWatchedRootNode !== false &&
      (!input.parentChainTitles || input.parentChainTitles.length === 0));

  if (isRoot) {
    return {
      relativePath: joinRelative(...localDirSegments, 'README.md'),
      conflicts,
    };
  }

  const parentSegments: string[] = [];
  for (const raw of input.parentChainTitles ?? []) {
    const safe = sanitizePathSegment(raw);
    if (!safe) {
      conflicts.push({
        kind: 'invalid-segment',
        message: `父链标题无法安全作为路径段: ${JSON.stringify(raw)}`,
      });
      return { relativePath: null, conflicts };
    }
    parentSegments.push(safe);
  }

  const titleSegment = sanitizePathSegment(input.title);
  if (!titleSegment) {
    conflicts.push({
      kind: 'empty-title',
      message: `文档标题无法安全作为路径段: ${JSON.stringify(input.title)}`,
    });
    return { relativePath: null, conflicts };
  }

  if (RESERVED_BASENAMES.has(titleSegment.toUpperCase())) {
    conflicts.push({
      kind: 'reserved-name',
      message: `标题是系统保留名: ${titleSegment}`,
      relativePath: titleSegment,
    });
    return { relativePath: null, conflicts };
  }

  let relativePath: string;
  if (input.layoutProfile === 'directory-readme') {
    // <localDir>/<parent...>/<title>/README.md
    relativePath = joinRelative(
      ...localDirSegments,
      ...parentSegments,
      titleSegment,
      'README.md',
    );
  } else if (input.hasChild) {
    // mirror-title-file branch: <localDir>/<parent...>/<title>/<title>.md
    relativePath = joinRelative(
      ...localDirSegments,
      ...parentSegments,
      titleSegment,
      `${titleSegment}.md`,
    );
  } else {
    // mirror-title-file leaf: <localDir>/<parent...>/<title>.md
    relativePath = joinRelative(
      ...localDirSegments,
      ...parentSegments,
      `${titleSegment}.md`,
    );
  }

  if (relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
    conflicts.push({
      kind: 'invalid-segment',
      message: `推导路径过长 (${relativePath.length} > ${MAX_RELATIVE_PATH_LENGTH}): ${relativePath}`,
      relativePath,
    });
    return { relativePath: null, conflicts };
  }

  return { relativePath, conflicts };
}

function companionDirs(
  relativeMarkdownPath: string,
  objType?: string,
): { relativeAssetDir: string; relativeCsvDataDir: string | null } {
  const dirname = relativeMarkdownPath.includes('/')
    ? relativeMarkdownPath.slice(0, relativeMarkdownPath.lastIndexOf('/'))
    : '';
  const basename = relativeMarkdownPath.includes('/')
    ? relativeMarkdownPath.slice(relativeMarkdownPath.lastIndexOf('/') + 1)
    : relativeMarkdownPath;
  const stem = basename.replace(/\.md$/i, '');

  // Assets live next to the markdown body.
  // - directory-readme: .../Title/README.md → .../Title/images
  // - mirror leaf: .../Title.md → .../images (shared at parent) or .../Title.assets
  // Corpus contract uses `images/` under the document directory for
  // directory-readme and attachments/images near mirror docs. We pick:
  //   relativeAssetDir = dirname of md (body's directory) + '/images'
  const relativeAssetDir = joinRelative(dirname, 'images');

  let relativeCsvDataDir: string | null = null;
  if (objType === 'sheet') {
    // Convention: `<stem>.csv-data` beside the markdown file.
    relativeCsvDataDir = joinRelative(dirname, `${stem}.csv-data`);
  }

  return { relativeAssetDir, relativeCsvDataDir };
}

function findCaseCollision(
  candidate: string,
  occupied: Set<string>,
): string | null {
  const lower = candidate.toLowerCase();
  for (const existing of occupied) {
    if (existing !== candidate && existing.toLowerCase() === lower) {
      return existing;
    }
  }
  return null;
}

/**
 * Resolve the local target for one cloud document under a watched root.
 */
export function resolveLocalTarget(input: PathResolveInput): PathPlanResult {
  const conflicts: PathConflict[] = [];
  const root = path.resolve(input.knowledgeBaseRoot);
  const occupied = new Set(
    Array.from(input.occupiedRelPaths ?? []).map((p) =>
      p.replace(/\\/g, '/'),
    ),
  );
  const rejectExisting = input.rejectExistingFiles !== false;

  if (!input.watchedRoot?.id) {
    conflicts.push({
      kind: 'missing-root',
      message: '缺少 watchedRoot.id',
    });
    return { ok: false, target: null, conflicts };
  }

  // --- 1. Existing mapping (preferred identity) ---
  let existingRel =
    input.existingLocalRelPath?.replace(/\\/g, '/') ??
    null;

  if (!existingRel && input.existingLocalMdPath) {
    existingRel = toPortableRelative(root, input.existingLocalMdPath);
  }

  if (existingRel) {
    const absolute = resolveAbsolute(root, existingRel);
    if (!isPathInsideRoot(root, absolute)) {
      conflicts.push({
        kind: 'escape-root',
        message: `已有映射路径逃逸知识库根: ${existingRel}`,
        relativePath: existingRel,
      });
      // Fall through to profile derivation.
      existingRel = null;
    } else if (!input.preferProfilePath) {
      // Keep verified existing mapping when file exists OR path is still
      // inside the watched root localDir (even if missing — pending write).
      const underRootDir = isUnderLocalDir(
        existingRel,
        input.watchedRoot.localDir,
      );
      if (!underRootDir) {
        conflicts.push({
          kind: 'escape-root',
          message: `已有映射不在 watchedRoot.localDir 内: ${existingRel}`,
          relativePath: existingRel,
        });
        existingRel = null;
      } else {
        const caseHit = findCaseCollision(existingRel, occupied);
        if (caseHit) {
          conflicts.push({
            kind: 'case-collision',
            message: `已有映射与已占用路径仅大小写不同: ${existingRel} ↔ ${caseHit}`,
            relativePath: existingRel,
            conflictingPath: caseHit,
          });
          return { ok: false, target: null, conflicts };
        }
        if (occupied.has(existingRel)) {
          conflicts.push({
            kind: 'duplicate-target',
            message: `已有映射与另一文档目标冲突: ${existingRel}`,
            relativePath: existingRel,
          });
          return { ok: false, target: null, conflicts };
        }

        const companions = companionDirs(existingRel, input.objType);
        return {
          ok: true,
          target: {
            watchedRootId: input.watchedRoot.id,
            relativeMarkdownPath: existingRel,
            relativeAssetDir: companions.relativeAssetDir,
            relativeCsvDataDir: companions.relativeCsvDataDir,
            source: 'existing-mapping',
          },
          conflicts: [],
        };
      }
    }
  }

  // --- 2. Profile derivation ---
  const derived = deriveProfileRelativePath({
    localDir: input.watchedRoot.localDir,
    layoutProfile: input.watchedRoot.layoutProfile,
    title: input.title,
    hasChild: input.hasChild,
    parentChainTitles: input.parentChainTitles,
    isWatchedRootNode: input.isWatchedRootNode,
  });
  conflicts.push(...derived.conflicts);

  if (!derived.relativePath) {
    return { ok: false, target: null, conflicts };
  }

  const relativePath = derived.relativePath;
  const absolute = resolveAbsolute(root, relativePath);

  if (!isPathInsideRoot(root, absolute)) {
    conflicts.push({
      kind: 'escape-root',
      message: `推导路径逃逸知识库根: ${relativePath}`,
      relativePath,
    });
    return { ok: false, target: null, conflicts };
  }

  const caseHit = findCaseCollision(relativePath, occupied);
  if (caseHit) {
    conflicts.push({
      kind: 'case-collision',
      message: `推导路径与已占用路径仅大小写不同: ${relativePath} ↔ ${caseHit}`,
      relativePath,
      conflictingPath: caseHit,
    });
    return { ok: false, target: null, conflicts };
  }

  if (occupied.has(relativePath)) {
    conflicts.push({
      kind: 'duplicate-target',
      message: `多个云端文档解析到同一目标路径: ${relativePath}`,
      relativePath,
    });
    return { ok: false, target: null, conflicts };
  }

  if (rejectExisting && fs.existsSync(absolute)) {
    const existingPortable =
      existingRel && existingRel === relativePath ? existingRel : null;
    // If we deliberately moved away from a different existing mapping, or
    // another file already occupies the profile path, block.
    if (!existingPortable) {
      // Allow when the file is the same path we already decided to keep
      // via preferProfilePath + matching existing.
      const sameAsExisting =
        input.existingLocalRelPath?.replace(/\\/g, '/') === relativePath ||
        (input.existingLocalMdPath &&
          toPortableRelative(root, input.existingLocalMdPath) === relativePath);

      if (!sameAsExisting) {
        conflicts.push({
          kind: 'existing-file',
          message: `目标路径已有文件，拒绝自动覆盖: ${relativePath}`,
          relativePath,
        });
        return { ok: false, target: null, conflicts };
      }
    }
  }

  const companions = companionDirs(relativePath, input.objType);
  const plannedMoveFrom =
    existingRel && existingRel !== relativePath ? existingRel : undefined;

  return {
    ok: true,
    target: {
      watchedRootId: input.watchedRoot.id,
      relativeMarkdownPath: relativePath,
      relativeAssetDir: companions.relativeAssetDir,
      relativeCsvDataDir: companions.relativeCsvDataDir,
      source: 'layout-profile',
      plannedMoveFrom,
    },
    conflicts: [],
  };
}

function isUnderLocalDir(relativePath: string, localDir: string): boolean {
  const normalizedDir = localDir.replace(/\\/g, '/').replace(/\/$/, '');
  const normalizedPath = relativePath.replace(/\\/g, '/');
  return (
    normalizedPath === normalizedDir ||
    normalizedPath.startsWith(`${normalizedDir}/`)
  );
}

/**
 * Batch-plan paths for many documents, accumulating occupied targets so
 * later documents cannot collide with earlier successful plans.
 */
export function planDocumentPaths(
  documents: PathResolveInput[],
): Array<PathPlanResult & { index: number }> {
  const occupied = new Set<string>();
  const results: Array<PathPlanResult & { index: number }> = [];

  for (let index = 0; index < documents.length; index += 1) {
    const input = documents[index];
    const mergedOccupied = new Set([
      ...occupied,
      ...Array.from(input.occupiedRelPaths ?? []).map((p) =>
        p.replace(/\\/g, '/'),
      ),
    ]);
    const result = resolveLocalTarget({
      ...input,
      occupiedRelPaths: mergedOccupied,
    });
    if (result.ok && result.target) {
      occupied.add(result.target.relativeMarkdownPath);
    }
    results.push({ ...result, index });
  }

  return results;
}
