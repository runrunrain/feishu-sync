/**
 * Reconciliation dry-run planner (P2-06).
 *
 * Scans a knowledge base (or fixture copy), classifies every Markdown file
 * against watched-root layout profiles and optional SQLite mappings, and
 * emits a machine-readable + Markdown report. Never writes the corpus.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  IndexScanner,
  resolveDocumentTitle,
  type ParsedMetadata,
} from './index-scanner.js';
import { ScanPolicy } from './scan-policy.js';
import {
  deriveProfileRelativePath,
  toPortableRelative,
} from './path-resolver.js';
import type {
  LayoutProfile,
  OrphanClassification,
  WatchedRootConfig,
} from '../types/index.js';

export type ReconciliationClass =
  | 'indexed_unique'
  | 'indexed_readme_title_fixed'
  | 'missing_metadata'
  | 'cloud_match_ambiguous'
  | 'local_only'
  | 'ignored_artifact'
  | 'pre_migrate'
  | 'outside_watched_roots'
  | 'profile_path_mismatch';

export interface ReconciliationItem {
  relativePath: string;
  classification: ReconciliationClass;
  title: string | null;
  objToken: string | null;
  wikiNodeToken: string | null;
  watchedRootId: string | null;
  layoutProfile: LayoutProfile | null;
  /** Profile-derived path when different from current relativePath. */
  expectedRelativePath: string | null;
  notes: string[];
}

export interface ReconciliationReport {
  schemaVersion: 1;
  createdAt: string;
  knowledgeBaseRoot: string;
  mode: 'dry-run';
  summary: {
    markdownTotal: number;
    byClass: Record<string, number>;
    readmeWithLiteralTitle: number;
    profileMismatches: number;
    uniqueTokens: number;
  };
  items: ReconciliationItem[];
}

export interface ReconciliationOptions {
  knowledgeBaseRoot: string;
  watchedRoots: WatchedRootConfig[];
  /** Optional existing token → relative path map from SQLite. */
  tokenToRelPath?: Map<string, string>;
}

/**
 * Collect markdown bodies plus explicitly classified operational artifacts
 * (`.pre-migrate`). Ordinary ScanPolicy skips still apply to directories and
 * `.bak` so staging/recovery noise never enters the report.
 */
function collectReconciliationFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ScanPolicy.shouldSkipDirectory(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        const name = entry.name;
        const isMarkdown = name.toLowerCase().endsWith('.md');
        const isPreMigrate = name.endsWith('.pre-migrate');
        const isBak = name.endsWith('.bak');
        if (isBak) continue;
        if (isMarkdown || isPreMigrate) {
          out.push(full);
        }
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

function matchWatchedRoot(
  relativePath: string,
  roots: WatchedRootConfig[],
): WatchedRootConfig | null {
  const normalized = relativePath.replace(/\\/g, '/');
  const enabled = roots.filter((root) => root.enabled);
  const candidates = enabled
    .filter((root) => {
      const dir = root.localDir.replace(/\\/g, '/').replace(/\/$/, '');
      return normalized === dir || normalized.startsWith(`${dir}/`);
    })
    .sort((a, b) => b.localDir.length - a.localDir.length);
  return candidates[0] ?? null;
}

function inferHasChildAndChain(
  relativePath: string,
  root: WatchedRootConfig,
): {
  isRoot: boolean;
  hasChild: boolean;
  parentChainTitles: string[];
  titleFromPath: string;
} {
  const dir = root.localDir.replace(/\\/g, '/').replace(/\/$/, '');
  const rest = relativePath === dir
    ? ''
    : relativePath.slice(dir.length).replace(/^\//, '');
  const segments = rest.split('/').filter(Boolean);
  const base = segments[segments.length - 1] ?? '';

  if (relativePath === `${dir}/README.md` || relativePath === `${dir}/readme.md`) {
    return {
      isRoot: true,
      hasChild: true,
      parentChainTitles: [],
      titleFromPath: path.basename(dir),
    };
  }

  if (root.layoutProfile === 'directory-readme') {
    // .../Title/README.md
    if (base.toLowerCase() === 'readme.md') {
      const titleSeg = segments[segments.length - 2] ?? path.basename(dir);
      const parentChain = segments.slice(0, -2);
      return {
        isRoot: false,
        hasChild: false,
        parentChainTitles: parentChain,
        titleFromPath: titleSeg,
      };
    }
  } else {
    // mirror-title-file: branch Title/Title.md or leaf parent/Title.md
    if (base.toLowerCase().endsWith('.md')) {
      const stem = base.replace(/\.md$/i, '');
      if (segments.length >= 2 && segments[segments.length - 2] === stem) {
        return {
          isRoot: false,
          hasChild: true,
          parentChainTitles: segments.slice(0, -2),
          titleFromPath: stem,
        };
      }
      return {
        isRoot: false,
        hasChild: false,
        parentChainTitles: segments.slice(0, -1),
        titleFromPath: stem,
      };
    }
  }

  return {
    isRoot: false,
    hasChild: false,
    parentChainTitles: segments.slice(0, -1),
    titleFromPath: base.replace(/\.md$/i, '') || 'untitled',
  };
}

/**
 * Build a dry-run reconciliation report for one knowledge base root.
 */
export function buildReconciliationReport(
  options: ReconciliationOptions,
): ReconciliationReport {
  const root = path.resolve(options.knowledgeBaseRoot);
  const scanner = new IndexScanner({
    localMapStore: { upsertDocument() {} },
    larkCliClient: {},
    config: { knowledgeBaseRoot: root },
  });

  const files = collectReconciliationFiles(root);
  const items: ReconciliationItem[] = [];
  const tokenCounts = new Map<string, number>();

  // First pass: count tokens for ambiguity detection.
  const parsedByPath = new Map<
    string,
    { content: string; meta: ParsedMetadata | null; relative: string }
  >();

  for (const absolute of files) {
    const relative = toPortableRelative(root, absolute);
    if (!relative) continue;
    let content = '';
    try {
      content = fs.readFileSync(absolute, 'utf-8');
    } catch {
      continue;
    }
    const meta = scanner.parseMetadata(content);
    parsedByPath.set(absolute, { content, meta, relative });
    // .pre-migrate copies intentionally retain the same token as the live
    // body; they must not make the live document look ambiguous.
    const isPreMigrate =
      absolute.endsWith('.pre-migrate') ||
      path.basename(absolute).includes('.md.pre-migrate');
    if (meta?.obj_token && !isPreMigrate) {
      tokenCounts.set(meta.obj_token, (tokenCounts.get(meta.obj_token) ?? 0) + 1);
    }
  }

  for (const [absolute, { content, meta, relative }] of parsedByPath) {
    const notes: string[] = [];
    const base = path.basename(absolute);

    if (base.endsWith('.pre-migrate') || absolute.endsWith('.md.pre-migrate')) {
      items.push({
        relativePath: relative,
        classification: 'pre_migrate',
        title: null,
        objToken: null,
        wikiNodeToken: null,
        watchedRootId: null,
        layoutProfile: null,
        expectedRelativePath: null,
        notes: ['迁移留档，保持原状并忽略'],
      });
      continue;
    }

    if (base === 'INDEX.md') {
      items.push({
        relativePath: relative,
        classification: 'ignored_artifact',
        title: resolveDocumentTitle(absolute, content),
        objToken: null,
        wikiNodeToken: null,
        watchedRootId: null,
        layoutProfile: null,
        expectedRelativePath: null,
        notes: ['本地导航索引'],
      });
      continue;
    }

    const watched = matchWatchedRoot(relative, options.watchedRoots);
    if (!watched) {
      items.push({
        relativePath: relative,
        classification: 'outside_watched_roots',
        title: resolveDocumentTitle(absolute, content),
        objToken: meta?.obj_token ?? null,
        wikiNodeToken: meta?.wiki_node_token ?? null,
        watchedRootId: null,
        layoutProfile: null,
        expectedRelativePath: null,
        notes: ['不在任何启用的 watchedRoot.localDir 下'],
      });
      continue;
    }

    const title = resolveDocumentTitle(absolute, content);
    const objToken = meta?.obj_token ?? null;
    const tokenHits = objToken ? tokenCounts.get(objToken) ?? 0 : 0;

    if (!objToken && !meta?.original_link) {
      const classification: ReconciliationClass =
        base.toLowerCase() === 'readme.md'
          ? 'missing_metadata'
          : /飞书电子表格|feishu\s*sheet/i.test(content.slice(0, 500))
            ? 'cloud_match_ambiguous'
            : 'local_only';
      items.push({
        relativePath: relative,
        classification,
        title,
        objToken: null,
        wikiNodeToken: null,
        watchedRootId: watched.id,
        layoutProfile: watched.layoutProfile,
        expectedRelativePath: null,
        notes: [
          classification === 'missing_metadata'
            ? 'README 缺少飞书元数据'
            : classification === 'cloud_match_ambiguous'
              ? '疑似飞书导出但无 token'
              : '本地文件，无云端身份',
        ],
      });
      continue;
    }

    if (tokenHits > 1) {
      items.push({
        relativePath: relative,
        classification: 'cloud_match_ambiguous',
        title,
        objToken,
        wikiNodeToken: meta?.wiki_node_token ?? null,
        watchedRootId: watched.id,
        layoutProfile: watched.layoutProfile,
        expectedRelativePath: null,
        notes: [`obj_token ${objToken} 出现 ${tokenHits} 次，禁止自动回填`],
      });
      continue;
    }

    const pathInfo = inferHasChildAndChain(relative, watched);
    const derived = deriveProfileRelativePath({
      localDir: watched.localDir,
      layoutProfile: watched.layoutProfile,
      title: title || pathInfo.titleFromPath,
      hasChild: pathInfo.hasChild,
      parentChainTitles: pathInfo.parentChainTitles,
      isWatchedRootNode: pathInfo.isRoot,
    });

    const expected = derived.relativePath;
    const profileMismatch = expected != null && expected !== relative;
    if (profileMismatch) {
      notes.push(`当前路径与 profile 推导不一致，期望 ${expected}`);
    }

    const literalReadmeTitle =
      base.toLowerCase() === 'readme.md' && title === 'README';
    if (literalReadmeTitle) {
      notes.push('README 标题退化为字面量 README，应使用 H1 或父目录名');
    }

    let classification: ReconciliationClass = 'indexed_unique';
    if (literalReadmeTitle) {
      classification = 'indexed_readme_title_fixed';
    } else if (profileMismatch) {
      classification = 'profile_path_mismatch';
    }

    // Cross-check optional SQLite map.
    if (objToken && options.tokenToRelPath?.has(objToken)) {
      const mapped = options.tokenToRelPath.get(objToken)!;
      if (mapped !== relative) {
        notes.push(`SQLite local_rel_path=${mapped}`);
      }
    }

    items.push({
      relativePath: relative,
      classification,
      title,
      objToken,
      wikiNodeToken: meta?.wiki_node_token ?? null,
      watchedRootId: watched.id,
      layoutProfile: watched.layoutProfile,
      expectedRelativePath: profileMismatch ? expected : null,
      notes,
    });
  }

  const byClass: Record<string, number> = {};
  for (const item of items) {
    byClass[item.classification] = (byClass[item.classification] ?? 0) + 1;
  }

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    knowledgeBaseRoot: root,
    mode: 'dry-run',
    summary: {
      markdownTotal: items.length,
      byClass,
      readmeWithLiteralTitle: byClass.indexed_readme_title_fixed ?? 0,
      profileMismatches: byClass.profile_path_mismatch ?? 0,
      uniqueTokens: [...tokenCounts.values()].filter((n) => n === 1).length,
    },
    items,
  };
}

/** Render a human-readable Markdown summary of a reconciliation report. */
export function formatReconciliationMarkdown(report: ReconciliationReport): string {
  const lines: string[] = [
    '# 知识库对账报告（dry-run）',
    '',
    `- 生成时间：${report.createdAt}`,
    `- 知识库根：\`${report.knowledgeBaseRoot}\``,
    `- Markdown 总数：${report.summary.markdownTotal}`,
    `- 唯一 token：${report.summary.uniqueTokens}`,
    `- 字面量 README 标题：${report.summary.readmeWithLiteralTitle}`,
    `- profile 路径不一致：${report.summary.profileMismatches}`,
    '',
    '## 分类汇总',
    '',
    '| 分类 | 数量 |',
    '|---|---:|',
  ];

  for (const [klass, count] of Object.entries(report.summary.byClass).sort()) {
    lines.push(`| \`${klass}\` | ${count} |`);
  }

  lines.push('', '## 明细（节选：非 indexed_unique）', '');
  const notable = report.items.filter(
    (item) => item.classification !== 'indexed_unique',
  );
  if (notable.length === 0) {
    lines.push('_全部 Markdown 均为 indexed_unique。_');
  } else {
    for (const item of notable.slice(0, 200)) {
      lines.push(
        `- **${item.relativePath}** → \`${item.classification}\`` +
          (item.title ? ` · 标题「${item.title}」` : '') +
          (item.expectedRelativePath
            ? ` · 期望 \`${item.expectedRelativePath}\``
            : '') +
          (item.notes.length ? ` · ${item.notes.join('；')}` : ''),
      );
    }
    if (notable.length > 200) {
      lines.push(`- … 另有 ${notable.length - 200} 条，见 JSON 报告`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

export type { OrphanClassification };
