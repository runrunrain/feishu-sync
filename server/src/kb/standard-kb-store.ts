/**
 * StandardKbStore — 已发布标准库的读取（设计 §6.5 / §9.2 / §10）
 *
 * 发布真相 = CURRENT.json 指针 + release manifest。本模块每次请求读取
 * 指针（按 mtime 缓存），读取 release 内文件前用 realpath 校验在
 * releases/<releaseId> 内。不依赖 SQLite（MCP 复用同一实现）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  isPathInside,
  PathGuardError,
  resolveInside,
} from '../agent/path-guard.js';
import type { SearchHit } from './kb-search.js';
import { getKbQueryService, type KbQueryService } from './search/kb-query-service.js';
export { stripStdHeader } from './search/header.js';
import { stripStdHeader } from './search/header.js';
import { loadReleaseKnowledge } from './search/release-reader.js';
import { assembleKnowledgeIndex, KNOWLEDGE_INDEX_SCHEMA_VERSION, type KbKnowledgeIndex } from './search/knowledge-index.js';
export type { KbKnowledgeIndex } from './search/knowledge-index.js';
import type {
  KbCurrentPointer,
  KbManifest,
  KbManifestDoc,
  KbTreeNode,
} from '../types/agent-knowledge.js';

export class KbNotPublishedError extends Error {
  constructor() {
    super('标准知识库尚未发布');
    this.name = 'KbNotPublishedError';
  }
}

// 知识索引视图（KbKnowledgeIndex）与装配实现移至 ./search/knowledge-index.ts
// （A案 §8：StandardKbStore 与 KbQueryService 共用同一视图，不各写一套）；
// 本文件按原路径 re-export 该类型，T4a 导出面不变。


/** 解析标准文档文件头（feishu_sync_kb YAML-in-comment）。 */
export function parseStdHeader(
  markdown: string,
): { docId: string; sources: string[]; buildId: string } | null {
  const match = /^<!--\s*\nfeishu_sync_kb:\n([\s\S]*?)\n-->/.exec(markdown);
  if (!match) return null;
  const body = match[1];
  const docId = /^\s{2}doc_id:\s*(\S+)\s*$/m.exec(body)?.[1];
  const buildId = /^\s{2}build_id:\s*(\S+)\s*$/m.exec(body)?.[1];
  const sources: string[] = [];
  const sourcesMatch = /^\s{2}sources:\s*$/m.exec(body);
  if (sourcesMatch) {
    const after = body.slice(sourcesMatch.index + sourcesMatch[0].length);
    for (const line of after.split('\n')) {
      const item = /^\s{4}-\s*(\S+)\s*$/.exec(line);
      if (item) sources.push(item[1]);
      else if (/^\S/.test(line)) break; // 下一个键
    }
  }
  if (!docId || !buildId) return null;
  return { docId, sources, buildId };
}

export interface LoadedDoc {
  doc: KbManifestDoc;
  markdown: string;
}

export class StandardKbStore {
  private readonly outputRoot: string;
  readonly queryService: KbQueryService;
  private cachedPointer: { mtimeMs: number; pointer: KbCurrentPointer | null } | null = null;


  constructor(outputRoot: string) {
    this.outputRoot = outputRoot;
    this.queryService = getKbQueryService(outputRoot);
  }

  get outputRootPath(): string {
    return this.outputRoot;
  }

  private pointerPath(): string {
    return path.join(this.outputRoot, 'CURRENT.json');
  }

  /** 读取 CURRENT 指针（mtime 缓存）。无发布时返回 null。 */
  readCurrent(): KbCurrentPointer | null {
    const pointerPath = this.pointerPath();
    const stat = fs.statSync(pointerPath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) {
      this.cachedPointer = null;
      return null;
    }
    if (this.cachedPointer && this.cachedPointer.mtimeMs === stat.mtimeMs) {
      return this.cachedPointer.pointer;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(pointerPath, 'utf-8')) as KbCurrentPointer;
      if (typeof parsed.releaseId !== 'string' || typeof parsed.publishedAt !== 'string') {
        throw new Error('CURRENT.json 结构不完整');
      }
      this.cachedPointer = { mtimeMs: stat.mtimeMs, pointer: parsed };
      return parsed;
    } catch {
      this.cachedPointer = { mtimeMs: stat.mtimeMs, pointer: null };
      return null;
    }
  }

  releaseDir(releaseId: string): string {
    return path.join(this.outputRoot, 'releases', releaseId);
  }

  private knowledgeCache = new Map<string, KbKnowledgeIndex>();

  /** 知识索引读取（A案 §8 双读）：v1/未组织化 release 返回 null；v2 按组织
   * 段哈希加载并缓存（缓存键含索引结构版本，A案 §8.2）。sidecar 损坏 →
   * 抛 QueryError（组织查询失败不降级）。 */
  readKnowledgeIndex(releaseId?: string): KbKnowledgeIndex | null {
    const release = this.queryService.resolveRelease(releaseId);
    if (!release.organization) return null;
    const cacheKey = `${release.releaseId}:${release.organization.hash}:${KNOWLEDGE_INDEX_SCHEMA_VERSION}`;
    const cached = this.knowledgeCache.get(cacheKey);
    if (cached) return cached;
    const { knowledge } = loadReleaseKnowledge(release);
    const index = assembleKnowledgeIndex(release.releaseId, knowledge);
    // 缓存同 release 仅保一份（旧哈希让位）
    for (const key of this.knowledgeCache.keys()) {
      if (key.startsWith(`${release.releaseId}:`)) this.knowledgeCache.delete(key);
    }
    this.knowledgeCache.set(cacheKey, index);
    return index;
  }

  /** Resolve before reading metadata too; a cached pointer must not bypass release realpath fences. */
  readManifest(releaseId?: string): KbManifest | null {
    try {
      return this.queryService.resolveRelease(releaseId).manifest;
    } catch {
      return null;
    }
  }

  /** 读取 release 内文档文件（realpath 围栏校验；文件位于 docs/ 下）。 */
  readReleaseDoc(releaseId: string, doc: KbManifestDoc): LoadedDoc {
    const release = this.queryService.resolveRelease(releaseId);
    const rootReal = resolveInside(release.releaseDir, 'docs', 'read');
    const target = path.join(rootReal, doc.path);
    const targetReal = fs.realpathSync.native(target);
    if (!isPathInside(rootReal, targetReal)) {
      throw new PathGuardError('path_escape', `文档越出 release 目录: ${doc.path}`);
    }
    const markdown = fs.readFileSync(targetReal, 'utf-8');
    return { doc, markdown: stripStdHeader(markdown) };
  }

  findDoc(manifest: KbManifest, ref: { docId?: string; path?: string }): KbManifestDoc | null {
    if (ref.docId) {
      const found = manifest.docs.find((doc) => doc.docId === ref.docId);
      if (found) return found;
    }
    if (ref.path) {
      const normalized = ref.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
      return manifest.docs.find((doc) => doc.path === normalized) ?? null;
    }
    return null;
  }

  /** 目录树（§9.2 KbTreeNode）。 */
  buildTree(manifest: KbManifest): KbTreeNode[] {
    const root: KbTreeNode = { name: '', path: '', type: 'dir', children: [] };
    const dirNodes = new Map<string, KbTreeNode>([['', root]]);
    const ensureDir = (dirPath: string): KbTreeNode => {
      const existing = dirNodes.get(dirPath);
      if (existing) return existing;
      const parentPath = dirPath.includes('/') ? dirPath.slice(0, dirPath.lastIndexOf('/')) : '';
      const parent = ensureDir(parentPath);
      const node: KbTreeNode = {
        name: dirPath.slice(dirPath.lastIndexOf('/') + 1),
        path: dirPath,
        type: 'dir',
        children: [],
      };
      parent.children!.push(node);
      dirNodes.set(dirPath, node);
      return node;
    };
    for (const doc of manifest.docs) {
      const dirPath = doc.path.includes('/') ? doc.path.slice(0, doc.path.lastIndexOf('/')) : '';
      const parent = ensureDir(dirPath);
      parent.children!.push({
        name: doc.path.slice(doc.path.lastIndexOf('/') + 1),
        path: doc.path,
        type: 'doc',
        docId: doc.docId,
        title: doc.title,
      });
    }
    const sortNodes = (nodes: KbTreeNode[]): KbTreeNode[] => {
      nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh');
      });
      for (const node of nodes) {
        if (node.children) sortNodes(node.children);
      }
      return nodes;
    };
    return sortNodes(root.children!);
  }

  /** Legacy UI top-k contract: drain shared budget pages instead of silently losing hits. */
  async search(manifest: KbManifest, query: string, limit = 20): Promise<SearchHit[]> {
    const results: SearchHit[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.queryService.search({ releaseId: manifest.releaseId, query, limit, cursor });
      results.push(...page.results);
      cursor = page.next ?? undefined;
    } while (cursor && results.length < limit);
    return results.slice(0, limit);
  }
}

/** 计算 release 目录内全部文档的内容哈希（构建校验用）。 */
export function hashFile(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}
