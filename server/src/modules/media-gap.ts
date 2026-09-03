/**
 * media-gap — 媒体完整性核对模块
 *
 * 用于检测历史欠账的表格浮动图片与 docx 白板/媒体占位标签，
 * 让由于 synced 基线对齐而不再报变更的历史文档能被重新送入同步管线。
 *
 * 核心功能：
 *   - stripFeishuSyncHeader()    剥离正文首部的 feishu_sync YAML 注释块
 *   - scanRawMediaTags()          识别正文残留的未本地化原始媒体标签
 *   - collectLocalImageRefs()     收集文档目录及 *.csv-data/*.csv 下本地图片引用（去重）
 *   - detectMediaGaps()           对 synced 记录核对媒体完整性并输出差距清单
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DocumentRecord } from '../types/index.js';

// ---------------------------------------------------------------------------
// workbook-info 结果缓存（限流防护）
// ---------------------------------------------------------------------------

/**
 * 同一 spreadsheet 的图片清单在短时间内不会变化；5 分钟缓存把重复核对
 * （如用户连续点击两次「立即检测」）的云端调用收敛为一次，避免与主检测
 * 叠加触发飞书账号级 99991400 限流。
 */
const WORKBOOK_INFO_CACHE_TTL_MS = 5 * 60_000;

const workbookInfoCache = new Map<string, { count: number; expiresAt: number }>();

/** @visibleForTesting 清空缓存。 */
export function __resetWorkbookInfoCacheForTest(): void {
  workbookInfoCache.clear();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaGapReason = 'local_placeholder_tags' | 'sheet_cloud_images_missing';

/**
 * 媒体核对 API 作用域：
 * - local-only：零云端调用（仅本地文件扫描），供轮询等高频路径安全使用；
 * - full：对 sheet 文档追加 workbook-info 云端图片清单核对，仅供用户主动
 *   触发的检测（「立即检测」）使用。实测背靠背两次全量核对会触发飞书
 *   账号级 99991400 限流，导致核对结果时有时无并干扰主检测，因此云端
 *   核对必须与轮询隔离。
 */
export type MediaGapApiScope = 'local-only' | 'full';

export interface MediaGap {
  objToken: string;
  reason: MediaGapReason;
  detail?: string | number;
}

export interface DetectMediaGapsOptions {
  records: DocumentRecord[];
  knowledgeBaseRoot: string;
  larkCliClient: {
    getWorkbookInfo(spreadsheetToken: string): Promise<any>;
  };
  /** 默认 'local-only'：跳过全部 workbook-info 调用，仅做本地扫描。 */
  apiScope?: MediaGapApiScope;
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 剥离文件首部 `<!-- feishu_sync: ... -->` YAML 注释块。
 * 只用于扫描正文残留标签，不改动原文件语义。
 */
export function stripFeishuSyncHeader(md: string): string {
  if (!md) return '';
  const match = md.match(/^\s*<!--[\s\S]*?feishu_sync:[\s\S]*?-->\r?\n?/);
  if (match) {
    return md.slice(match[0].length);
  }
  return md;
}

/**
 * 识别正文中未本地化的原始媒体标签，返回 token 列表。
 *
 * 标签形态：
 *   `<whiteboard token="X">`
 *   `<image token="X">`
 *   `<file token="X">`
 *   `<source token="X">`
 *   `<img src="X">`
 *
 * 规则：
 *   - token 属性值不以 `images/` 或 `attachments/`（含反斜杠）开头才算残留；
 *   - 属性顺序不保证；自闭合与包裹式都要匹配；
 *   - 即使被 `<synced-source>` 等外层标签包裹也能正确提取。
 */
export function scanRawMediaTags(body: string): string[] {
  if (!body) return [];
  const tokens: string[] = [];
  const TAG_PATTERN = /<(whiteboard|image|file|source|img)\b([^>]*)>/gi;

  for (const tagMatch of body.matchAll(TAG_PATTERN)) {
    const tagName = tagMatch[1].toLowerCase();
    const attributes = tagMatch[2];

    const attrPattern =
      tagName === 'img'
        ? /(?:^|\s)(?:src|token)\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i
        : tagName === 'image'
          ? /(?:^|\s)(?:token|src)\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i
          : /(?:^|\s)token\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i;

    const attrMatch = attrPattern.exec(attributes);
    if (!attrMatch) continue;

    let token = (attrMatch[2] ?? attrMatch[3] ?? '').trim();
    if (token.endsWith('/')) {
      token = token.slice(0, -1).trim();
    }
    if (!token) continue;

    if (
      token.startsWith('images/') ||
      token.startsWith('images\\') ||
      token.startsWith('attachments/') ||
      token.startsWith('attachments\\')
    ) {
      continue;
    }

    tokens.push(token);
  }

  return tokens;
}

/**
 * 收集文档目录下 md 与 `*.csv-data/*.csv` 中所有 `](images/...)` 引用的文件名集合。
 *
 * 去重原因：sheet 图片在 md 附录与 CSV 注入中会出现两次，必须按文件名去重。
 */
export function collectLocalImageRefs(docDir: string): Set<string> {
  const refs = new Set<string>();
  if (!docDir) return refs;

  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(docDir)) return refs;
    entries = fs.readdirSync(docDir, { withFileTypes: true });
  } catch {
    return refs;
  }

  const IMAGE_REF_PATTERN = /\]\(\s*images[/\\]([^)\s"']+)\s*\)/g;

  const scanContent = (content: string) => {
    for (const match of content.matchAll(IMAGE_REF_PATTERN)) {
      const raw = match[1];
      const filename = raw.split(/[/\\]/).pop() || '';
      if (filename) {
        refs.add(filename);
      }
    }
  };

  const scanFile = (filePath: string) => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      scanContent(content);
    } catch {
      // 容错（读失败跳过）
    }
  };

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      scanFile(path.join(docDir, entry.name));
    } else if (entry.isDirectory() && entry.name.endsWith('.csv-data')) {
      const csvDir = path.join(docDir, entry.name);
      try {
        const csvEntries = fs.readdirSync(csvDir, { withFileTypes: true });
        for (const csvEntry of csvEntries) {
          if (csvEntry.isFile() && csvEntry.name.endsWith('.csv')) {
            scanFile(path.join(csvDir, csvEntry.name));
          }
        }
      } catch {
        // 容错（读失败跳过）
      }
    }
  }

  return refs;
}

/**
 * 核心媒体完整性核对
 *
 * 对每条 synced 记录：
 *   - 读 localMdPath（不存在则跳过）；
 *   - 任意 objType：扫描正文残留标签，非空 → gap `{ reason: 'local_placeholder_tags' }`（零 API，任意 scope 都执行）；
 *   - objType==='sheet' 且 apiScope==='full'：调 `getWorkbookInfo(objToken)`
 *     汇总各子表 `float_image_count`（5 分钟结果缓存 + 异常软失败）；
 *     若云端总数 > 本地图片引用集合大小 → gap `{ reason: 'sheet_cloud_images_missing' }`。
 */
export async function detectMediaGaps(options: DetectMediaGapsOptions): Promise<MediaGap[]> {
  const { records, knowledgeBaseRoot, larkCliClient } = options;
  const apiScope: MediaGapApiScope = options.apiScope ?? 'local-only';
  const gaps: MediaGap[] = [];

  for (const record of records) {
    if (!record.objToken) continue;
    // 仅针对 synced 状态记录进行完整性核对
    if (record.status && record.status !== 'synced' && record.syncState !== 'synced') {
      continue;
    }
    if (!record.localMdPath) continue;

    const resolvedMdPath = path.isAbsolute(record.localMdPath)
      ? record.localMdPath
      : path.resolve(knowledgeBaseRoot, record.localMdPath);

    if (!fs.existsSync(resolvedMdPath)) {
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(resolvedMdPath, 'utf-8');
    } catch {
      continue;
    }

    // 1. 任意 objType：扫描正文残留标签
    const body = stripFeishuSyncHeader(content);
    const rawTokens = scanRawMediaTags(body);
    if (rawTokens.length > 0) {
      gaps.push({
        objToken: record.objToken,
        reason: 'local_placeholder_tags',
        detail: rawTokens.length,
      });
    }

    // 2. objType==='sheet'：核对浮动图片云端与本地总数。
    //    仅 apiScope==='full'（用户主动触发）才发起云端调用；轮询路径
    //    local-only 下 sheet 缺口不产出，避免高频 API 消耗与限流。
    if (record.objType === 'sheet' && apiScope === 'full') {
      let workbookInfo: any;
      const cached = workbookInfoCache.get(record.objToken);
      const now = Date.now();
      let totalCloudImages: number | null = null;
      if (cached && cached.expiresAt > now) {
        totalCloudImages = cached.count;
      } else {
        try {
          workbookInfo = await larkCliClient.getWorkbookInfo(record.objToken);
        } catch (err) {
          console.warn(
            `[media-gap] getWorkbookInfo failed for ${record.objToken}:`,
            err instanceof Error ? err.message : String(err),
          );
          continue;
        }

        const root =
          workbookInfo?.data && typeof workbookInfo.data === 'object'
            ? workbookInfo.data
            : workbookInfo;
        const sheetsList = Array.isArray(root?.sheets) ? root.sheets : [];
        totalCloudImages = 0;
        for (const sheet of sheetsList) {
          if (!sheet || typeof sheet !== 'object') continue;
          const count = Number(sheet.float_image_count ?? sheet.floatImageCount ?? 0) || 0;
          totalCloudImages += count;
        }
        workbookInfoCache.set(record.objToken, {
          count: totalCloudImages,
          expiresAt: now + WORKBOOK_INFO_CACHE_TTL_MS,
        });
      }

      const docDir = path.dirname(resolvedMdPath);
      const localRefs = collectLocalImageRefs(docDir);

      if ((totalCloudImages ?? 0) > localRefs.size) {
        gaps.push({
          objToken: record.objToken,
          reason: 'sheet_cloud_images_missing',
          detail: `云端 ${totalCloudImages} 张 / 本地 ${localRefs.size} 张`,
        });
      }
    }
  }

  return gaps;
}
