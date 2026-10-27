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
} from '../agent/path-guard.js';
import { searchDocs, type SearchHit } from './kb-search.js';
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

interface CachedManifest {
  releaseId: string;
  mtimeMs: number;
  manifest: KbManifest;
}

/** 从标准文档 Markdown 中剥去 server 生成的文件头。 */
export function stripStdHeader(markdown: string): string {
  const match = /^<!--\s*\nfeishu_sync_kb:[\s\S]*?\n-->\s*\n?/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}

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
  private cachedPointer: { mtimeMs: number; pointer: KbCurrentPointer | null } | null = null;
  private cachedManifest: CachedManifest | null = null;

  constructor(outputRoot: string) {
    this.outputRoot = outputRoot;
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

  private manifestPath(releaseId: string): string {
    return path.join(this.releaseDir(releaseId), 'manifest.json');
  }

  /** 读取发布 manifest（按 releaseId 缓存）。 */
  readManifest(releaseId?: string): KbManifest | null {
    const current = releaseId ? { releaseId } : this.readCurrent();
    if (!current) return null;
    const manifestFile = this.manifestPath(current.releaseId);
    const stat = fs.statSync(manifestFile, { throwIfNoEntry: false });
    if (!stat) return null;
    if (this.cachedManifest && this.cachedManifest.releaseId === current.releaseId && this.cachedManifest.mtimeMs === stat.mtimeMs) {
      return this.cachedManifest.manifest;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as KbManifest;
      if (manifest.releaseId !== current.releaseId) {
        throw new Error('manifest releaseId 与目录不一致');
      }
      this.cachedManifest = { releaseId: current.releaseId, mtimeMs: stat.mtimeMs, manifest };
      return manifest;
    } catch {
      return null;
    }
  }

  /** 读取 release 内文档文件（realpath 围栏校验；文件位于 docs/ 下）。 */
  readReleaseDoc(releaseId: string, doc: KbManifestDoc): LoadedDoc {
    const rootReal = fs.realpathSync.native(path.join(this.releaseDir(releaseId), 'docs'));
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

  /** 搜索已发布文档（含正文片段）。 */
  search(manifest: KbManifest, query: string, limit = 20): SearchHit[] {
    const releaseId = manifest.releaseId;
    const bodyCache = new Map<string, string | null>();
    return searchDocs(
      manifest.docs.map((doc) => ({
        docId: doc.docId,
        path: doc.path,
        title: doc.title,
        summary: doc.summary,
        headings: doc.headings,
      })),
      query,
      limit,
      (entry) => {
        if (bodyCache.has(entry.docId)) return bodyCache.get(entry.docId) ?? null;
        let body: string | null = null;
        try {
          const doc = manifest.docs.find((candidate) => candidate.docId === entry.docId);
          if (doc) body = this.readReleaseDoc(releaseId, doc).markdown;
        } catch {
          body = null;
        }
        bodyCache.set(entry.docId, body);
        return body;
      },
    );
  }
}

/** 计算 release 目录内全部文档的内容哈希（构建校验用）。 */
export function hashFile(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}
