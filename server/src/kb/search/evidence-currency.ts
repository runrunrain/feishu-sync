/**
 * evidence-currency — 证据当前源并列比对（A案 §8.3）
 *
 * 查询侧只读模块：对象证据读取时，接受可选的当前源根路径上下文，对每条
 * 证据尝试解析 sourceRef 指向的当前源资源并按 evidence-locator 的同一
 * hash 公式（contentResourceHash）计算哈希比对：
 * - 匹配 → currency 'current'；
 * - 不匹配 → 'stale'，并列「发布依据版本」（release 保留的 source+locator）
 *   与「当前源版本」（currentRef：当前源路径 + 当前哈希）；
 * - 当前源缺失 → 'source_missing'：发布依据不抹除，提示后续维护风险；
 * - 资源形态无法从文件系统推导（工作簿/图片旁路资源）→ 'unsupported'，
 *   如实标注不可比对，不冒充任何一侧。
 *
 * 资源解析复用 kb/evidence-locator.ts 的 selector/hash 语义（只读，不依赖
 * staging）：resourceId 形态 主文档=objToken、CSV=<objToken>#csv:<basename>
 * （与 raw_read 回执资源表同公式）；CSV 落盘位置为 md 同目录子树，按有界
 * 目录行走查找。发布时 relPath 来自 release manifest.sourceSnapshot。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../../agent/path-guard.js';
import { contentResourceHash } from '../evidence-locator.js';
import type { Evidence } from '../knowledge-schema.js';

export type EvidenceCurrencyState = 'current' | 'stale' | 'source_missing' | 'unsupported';

export interface EvidenceCurrencyInput {
  /** 当前原始库根（调用方注入：routes 从 config.knowledgeBaseRoot 解析） */
  sourceRoot: string;
  evidence: Evidence;
  /** release manifest.sourceSnapshot 中该源的 relPath；源不在快照 → undefined */
  publishedRelPath: string | undefined;
}

export interface EvidenceCurrencyResult {
  currency: EvidenceCurrencyState;
  /** 当前源版本定位（A案 §8.3 双版本并列的当前侧；missing/unsupported 为 null） */
  currentRef: { path: string; resourceHash: string } | null;
  note?: string;
}

/** 单文件读取上限：与 raw 读取同量级（8 MiB），超限按不可比对处理。 */
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
/** CSV 附件有界查找：md 同目录起深度 ≤2、扫描条目 ≤200。 */
const CSV_WALK_MAX_ENTRIES = 200;

function readResource(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_RESOURCE_BYTES) return null;
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/** 有界查找 md 同目录子树内的指定 basename（CSV 附件落盘契约：同目录或其子目录）。 */
function findCsvSibling(sourceRoot: string, dirRel: string, basename: string): string | null {
  const scanned: string[] = [];
  const walk = (rel: string, depth: number): string | null => {
    if (depth > 2 || scanned.length >= CSV_WALK_MAX_ENTRIES) return null;
    let dir: string;
    try {
      dir = resolveInside(sourceRoot, rel, 'read');
      if (!fs.statSync(dir).isDirectory()) return null;
    } catch {
      return null;
    }
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    for (const name of names) {
      scanned.push(name);
      if (name === basename) {
        try {
          if (fs.statSync(path.join(dir, name)).isFile()) return rel ? `${rel}/${name}` : name;
        } catch { /* 不可读条目跳过 */ }
      }
    }
    for (const name of names) {
      if (scanned.length >= CSV_WALK_MAX_ENTRIES) break;
      try {
        if (fs.statSync(path.join(dir, name)).isDirectory()) {
          const found = walk(rel ? `${rel}/${name}` : name, depth + 1);
          if (found) return found;
        }
      } catch { /* 不可读条目跳过 */ }
    }
    return null;
  };
  return walk(dirRel, 0);
}

/** A案 §8.3：单条证据的当前源比对（结构化结果，不抛异常）。 */
export function resolveEvidenceCurrency(input: EvidenceCurrencyInput): EvidenceCurrencyResult {
  const { sourceRoot, evidence } = input;
  const sourceId = evidence.sourceRef.sourceId;
  if (input.publishedRelPath === undefined) {
    return {
      currency: 'source_missing',
      currentRef: null,
      note: `源 ${sourceId} 不在发布快照中，无法定位当前源（发布依据仍在 release 内保留）`,
    };
  }
  const mainRel = input.publishedRelPath;
  const dirRel = path.posix.dirname(mainRel.replace(/\\/g, '/'));
  let candidateRel: string | null;
  if (evidence.sourceRef.resourceId === sourceId) {
    candidateRel = mainRel;
  } else if (evidence.sourceRef.resourceId.startsWith(`${sourceId}#csv:`)) {
    const basename = evidence.sourceRef.resourceId.slice(sourceId.length + '#csv:'.length);
    if (!basename || basename.includes('/') || basename.includes('\\') || basename.includes('..')) {
      return { currency: 'unsupported', currentRef: null, note: 'CSV 附件名非法，不可比对' };
    }
    candidateRel = findCsvSibling(sourceRoot, dirRel, basename);
    if (candidateRel === null) {
      return { currency: 'source_missing', currentRef: null, note: `CSV 附件 ${basename} 不在当前源 ${dirRel || '.'} 子树内` };
    }
  } else {
    // 工作簿/图片旁路资源：无文件系统推导契约，如实标注不可比对
    return { currency: 'unsupported', currentRef: null, note: `资源形态 ${evidence.sourceRef.resourceId} 暂不支持当前源比对` };
  }
  let content: string | null;
  try {
    content = readResource(resolveInside(sourceRoot, candidateRel, 'read'));
  } catch {
    content = null;
  }
  if (content === null) {
    return { currency: 'source_missing', currentRef: null, note: `当前源文件缺失或不可读：${candidateRel}` };
  }
  const currentHash = contentResourceHash(content);
  if (currentHash === evidence.sourceRef.resourceHash) {
    return { currency: 'current', currentRef: { path: candidateRel, resourceHash: currentHash } };
  }
  return { currency: 'stale', currentRef: { path: candidateRel, resourceHash: currentHash } };
}

/** 供测试与调用方核对公式：sha256(content) 与 evidence-locator 同式。 */
export function textResourceHash(content: string): string {
  return `sha256:${crypto.createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}
