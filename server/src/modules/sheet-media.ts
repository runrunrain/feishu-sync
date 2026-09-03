/**
 * sheet-media — 飞书电子表格（objType=sheet）浮动图片的发现、下载与注入。
 *
 * 背景：sheet 同步主链路只导出纯文本 CSV（csv-get），表格里的浮动图片
 * （float image，含装饰大图 / 单元格锚定图片）在重构后的 Markdown 中
 * 完全丢失。本模块补齐该能力，供 SyncEngine（结构树主链路）与
 * custom-doc-sync（自定义归档表格）双链路复用：
 *
 *   probeSheetFloatImages()  探测一个子表的浮动图片元数据（软失败，见下）
 *   parseSheetFloatImages()  容错解析 lark-cli +float-image-list 响应
 *   downloadSheetMedia()     三层降级安全下载到 staging 的 images/ 目录
 *   annotateCsvWithImages()  把本地图片引用写入 CSV 对应单元格
 *   renderSheetMediaAppendix()  生成子表尾部的「子表图片资源」大图展示区
 *
 * 错误策略（与既有媒体契约对齐）：
 *   - 探测（元数据读取）失败 → 软失败：console.warn 后按「该子表无图」
 *     继续。图片是 CSV 主数据之上的增强层；lark-cli 版本差异 / 单子表
 *     接口抖动不应让原本可用的 CSV 同步整体失败。
 *   - 下载失败（已列出但三层全部拿不到字节）→ 硬失败：与 docx 图片下载
 *     同一契约——资源缺失时不推进 synced 基线，绝不静默丢图。
 *
 * 该模块不直接持有 LarkCliClient 依赖，只依赖结构化的最小 client 接口
 * （与 custom-doc-sync 的注入风格一致），便于测试替身。
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 一个子表内单张浮动图片的云端元数据（+float-image-list 归一化后）。 */
export interface SheetFloatImage {
  /** 浮动图片对象 id（feishu float_image_id），同一子表内唯一。 */
  floatImageId: string;
  /** 可下载的媒体 token（drive media），缺失则该条目无法下载、解析时丢弃。 */
  imageToken: string;
  /** 锚定单元格地址，如 "A7"；无法确定时为 ''。 */
  address: string;
  /** 0-based 列索引；云端未返回时为 null。 */
  col: number | null;
  /** 0-based 行索引；云端未返回时为 null。 */
  row: number | null;
  width: number | null;
  height: number | null;
  /** 云端可能附带的直链下载 URL；可为 null。 */
  url: string | null;
}

/** 已下载落地的表格图片（staging 内的绝对路径 + 文档内相对路径）。 */
export interface SheetMediaItem {
  token: string;
  floatImageId: string;
  address: string;
  /** 绝对路径（staging / 临时目录内）。 */
  localPath: string;
  /** 相对 Markdown 文档目录的 POSIX 路径，如 images/主表_A7_fip123.png。 */
  localRelPath: string;
  subSheetTitle: string;
  width: number | null;
  height: number | null;
}

/** 下载所需的 client 面（LarkCliClient 公共方法的结构子集）。 */
export interface SheetMediaDownloadClient {
  downloadMedia(token: string, outputPath: string, type?: 'media' | 'whiteboard'): Promise<string>;
  previewMedia(token: string, outputPath: string): Promise<string>;
}

/** 探测所需的 client 面；getSheetFloatImages 可选以兼容旧注入。 */
export interface SheetFloatImageProbeClient {
  getSheetFloatImages?(options: {
    spreadsheetToken: string;
    sheetId: string;
  }): Promise<any>;
}

// ---------------------------------------------------------------------------
// 元数据解析
// ---------------------------------------------------------------------------

/**
 * 容错解析 `sheets +float-image-list --format json` 的响应。
 *
 * 期望形状（v2 float_images API 经 lark-cli 归一化）：
 *   { ok: true, data: { sheets: [ { sheet_id, float_images: [ ... ] } ] } }
 *
 * 容错点：
 *   - 接受 ok 包裹与裸 data 两种外层（normalizeJsonResult 两种都会出现）；
 *   - 字段同时接受 snake_case（float_image_id）与 camelCase（floatImageId）；
 *   - 无 imageToken 的条目直接丢弃（无法下载，注入也无意义）；
 *   - 任意一层形状不符返回 []，绝不抛错（探测语义，见模块头）。
 */
export function parseSheetFloatImages(apiResponse: any): SheetFloatImage[] {
  if (!apiResponse || typeof apiResponse !== 'object') return [];
  const root = apiResponse.data && typeof apiResponse.data === 'object'
    ? apiResponse.data
    : apiResponse;

  const collected: SheetFloatImage[] = [];
  const sheets = Array.isArray(root.sheets) ? root.sheets : [];
  for (const sheet of sheets) {
    if (!sheet || typeof sheet !== 'object') continue;
    const floatImages = Array.isArray(sheet.float_images)
      ? sheet.float_images
      : Array.isArray(sheet.floatImages)
        ? sheet.floatImages
        : [];
    for (const entry of floatImages) {
      const item = normalizeFloatImage(entry);
      if (item) collected.push(item);
    }
  }

  // 部分部署直接返回顶层 float_images（无 per-sheet 包裹），兜底接受。
  if (collected.length === 0 && Array.isArray(root.float_images)) {
    for (const entry of root.float_images) {
      const item = normalizeFloatImage(entry);
      if (item) collected.push(item);
    }
  }
  return collected;
}

function normalizeFloatImage(entry: any): SheetFloatImage | null {
  if (!entry || typeof entry !== 'object') return null;
  const imageToken = readString(entry.image_token ?? entry.imageToken);
  if (!imageToken) return null;
  const floatImageId = readString(entry.float_image_id ?? entry.floatImageId) || imageToken;

  const rawPos = (entry.position && typeof entry.position === 'object') ? entry.position : {};
  const rawSize = (entry.size && typeof entry.size === 'object') ? entry.size : {};
  const colLetter = typeof rawPos.col === 'string' ? rawPos.col : null;
  const colVal = readInt(entry.col ?? (colLetter ? columnLettersToIndex(colLetter) : null));
  const rowVal = readInt(entry.row ?? (typeof rawPos.row === 'number' ? rawPos.row : null));
  const widthVal = readInt(entry.width ?? rawSize.width);
  const heightVal = readInt(entry.height ?? rawSize.height);

  return {
    floatImageId,
    imageToken,
    address: normalizeAddress({
      address: readString(entry.address),
      col: colVal,
      row: rowVal,
    }),
    col: colVal,
    row: rowVal,
    width: widthVal,
    height: heightVal,
    url: readString(entry.url) || null,
  };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 探测一个子表的浮动图片元数据（软失败策略，见模块头注释）。
 * client 未实现 getSheetFloatImages（旧注入 / 测试替身）时按无图处理。
 */
export async function probeSheetFloatImages(
  client: SheetFloatImageProbeClient,
  options: {
    spreadsheetToken: string;
    sheetId: string;
    sheetTitle: string;
  },
): Promise<SheetFloatImage[]> {
  if (typeof client.getSheetFloatImages !== 'function') {
    return [];
  }
  try {
    const response = await client.getSheetFloatImages({
      spreadsheetToken: options.spreadsheetToken,
      sheetId: options.sheetId,
    });
    return parseSheetFloatImages(response);
  } catch (error) {
    console.warn(
      `[sheet-media] float-image 探测失败，子表 "${options.sheetTitle}" ` +
        `(${options.sheetId}) 本次不注入表格图片:`,
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// 下载（三层降级）
// ---------------------------------------------------------------------------

export interface DownloadSheetMediaOptions {
  client: SheetMediaDownloadClient;
  floatImages: SheetFloatImage[];
  /** 图片落地目录（调用方负责指向 staging/临时目录，绝不指向知识库）。 */
  imagesDir: string;
  /** 子表标题（用于文件命名与 SheetMediaItem.subSheetTitle）。 */
  subSheetTitle: string;
}

/**
 * 三层降级安全下载一批浮动图片：
 *   ① float image 自带的直链 url（fetch，无 shell）；
 *   ② docs +media-download（权威通道，扩展名由 Content-Type 推导）；
 *   ③ docs +media-preview（部分 token media-download 403 时的已知回退）。
 *
 * 全部三层失败 → 抛错（硬失败，调用方不得推进 synced 基线）。
 * 文件命名：`${safeSubSheetTitle}_${address}_${floatImageId}`（扩展名由
 * 传输层追加；① 由 Content-Type 推导）。title 截断到 40 字符防超长路径。
 */
export async function downloadSheetMedia(
  options: DownloadSheetMediaOptions,
): Promise<SheetMediaItem[]> {
  const items: SheetMediaItem[] = [];
  if (options.floatImages.length === 0) return items;

  fs.mkdirSync(options.imagesDir, { recursive: true });
  const safeTitle = sanitizeFileStem(options.subSheetTitle);

  for (const floatImage of options.floatImages) {
    const address = floatImage.address || 'anchor';
    const stem = path.join(
      options.imagesDir,
      `${safeTitle}_${sanitizeFileStem(address)}_${sanitizeFileStem(floatImage.floatImageId)}`,
    );
    const absolutePath = await downloadFloatImage(options.client, floatImage, stem);
    assertDownloadedSheetMedia(
      absolutePath,
      `子表 "${options.subSheetTitle}" 单元格 ${address} (${floatImage.floatImageId})`,
    );
    items.push({
      token: floatImage.imageToken,
      floatImageId: floatImage.floatImageId,
      address,
      localPath: absolutePath,
      localRelPath: `images/${path.basename(absolutePath)}`,
      subSheetTitle: options.subSheetTitle,
      width: floatImage.width,
      height: floatImage.height,
    });
  }
  return items;
}

async function downloadFloatImage(
  client: SheetMediaDownloadClient,
  floatImage: SheetFloatImage,
  stem: string,
): Promise<string> {
  const context = `float_image ${floatImage.floatImageId} (${floatImage.imageToken})`;
  let lastError: unknown = null;

  // ① 直链 url（可选元数据，不作为主要传输）。
  if (floatImage.url) {
    try {
      return await downloadUrlToFile(stem, floatImage.url);
    } catch (error) {
      lastError = error;
    }
  }

  // ② docs +media-download。
  try {
    return await client.downloadMedia(floatImage.imageToken, stem, 'media');
  } catch (error) {
    lastError = error;
  }

  // ③ docs +media-preview。
  try {
    return await client.previewMedia(floatImage.imageToken, stem);
  } catch (error) {
    lastError = error;
  }

  throw new Error(
    `表格浮动图片三层下载全部失败: ${context}: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** fetch 直链下载到 `${stem}${ext}`；无 shell、无字符串拼接命令。 */
async function downloadUrlToFile(stem: string, url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`URL 下载失败 HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error('URL 下载内容为空');
  }
  const contentType = response.headers.get('content-type')
    ?.split(';', 1)[0]
    ?.toLowerCase() ?? '';
  const target = `${stem}${mediaExtensionForContentType(contentType)}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return target;
}

function mediaExtensionForContentType(contentType: string): string {
  const extensions: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
  };
  return extensions[contentType] ?? '.bin';
}

function assertDownloadedSheetMedia(absolutePath: string, context: string): void {
  if (
    !absolutePath ||
    !fs.existsSync(absolutePath) ||
    !fs.statSync(absolutePath).isFile() ||
    fs.statSync(absolutePath).size <= 0
  ) {
    throw new Error(`表格图片下载失败或为空: ${context}`);
  }
}

// ---------------------------------------------------------------------------
// CSV 注入
// ---------------------------------------------------------------------------

/**
 * 把已下载图片的本地引用写入 CSV 对应单元格。
 *
 * 行定位（二选一，逐行自适应）：
 *   - `[row=N] ` 前缀行（csv-get --include-row-prefix 默认格式）：N 即
 *     1-based 行号，编辑时剥离前缀、输出时还原；
 *   - 标准 CSV 行：物理记录序号 + 1 即行号。
 *
 * 列定位：解析图片 address（如 "A7"）为 0-based 列索引；行不足长时右侧
 * 补空单元格。单元格写入规则：
 *   - 原单元格为空 → 直接写入 `![图片: ${address}](${localRelPath})`；
 *   - 已有文本 → 文本后追加换行 + 图片标记（含换行/逗号/引号的单元格按
 *     RFC 4180 重新加引号转义）。
 *
 * 解析器是引号感知的（引用单元格内可含逗号与换行）；只有被修改的记录
 * 会被重新序列化，未触及的记录保持原字节。目标行超出 CSV 行数或地址
 * 不可解析的图片跳过（附录区仍会展示，见 renderSheetMediaAppendix）。
 */
export function annotateCsvWithImages(
  csvText: string,
  images: SheetMediaItem[],
): string {
  if (!csvText || images.length === 0) return csvText;

  const records = splitCsvRecords(csvText);

  // 记录索引 → 注入该行的图片。超界行直接跳过（防御：浮动图可锚定在
  // 数据区之外的空行上，此时仅由附录展示，不伪造空 CSV 行）。
  const imagesByRecord = new Map<number, SheetMediaItem[]>();
  for (const image of images) {
    const rowNumber = imageRowNumber(image);
    if (rowNumber == null || rowNumber < 1) continue;
    const recordIndex = rowNumber - 1;
    if (recordIndex >= records.length) continue;
    const bucket = imagesByRecord.get(recordIndex);
    if (bucket) bucket.push(image);
    else imagesByRecord.set(recordIndex, [image]);
  }
  if (imagesByRecord.size === 0) return csvText;

  return records
    .map((record, index) => {
      const targets = imagesByRecord.get(index);
      if (!targets) return record.body + record.terminator;
      return annotateCsvRecord(record.body, targets) + record.terminator;
    })
    .join('');
}

function annotateCsvRecord(recordBody: string, images: SheetMediaItem[]): string {
  const prefixMatch = /^\[row=(\d+)\]\s*/.exec(recordBody);
  const prefix = prefixMatch ? prefixMatch[0] : '';
  const cells = splitCsvLine(prefix ? recordBody.slice(prefix.length) : recordBody);

  for (const image of images) {
    const colIndex = imageColumnIndex(image);
    if (colIndex == null || colIndex < 0) continue;
    while (cells.length <= colIndex) cells.push('');
    const label = image.address || '浮动图片';
    const marker = `![图片: ${label}](${image.localRelPath})`;
    cells[colIndex] = cells[colIndex].trim().length === 0
      ? marker
      : `${cells[colIndex]}\n${marker}`;
  }
  return prefix + cells.map(serializeCsvCell).join(',');
}

interface CsvRecord {
  /** 不含行终止符的记录原文。 */
  body: string;
  /** '\n' | '\r\n' | ''（末条无终止符）。 */
  terminator: string;
}

/** 引号感知的 CSV 记录切分（引用单元格内的换行不切行）。 */
function splitCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let body = '';
  let inQuotes = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          body += '""';
          index += 2;
          continue;
        }
        inQuotes = false;
      }
      body += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      body += char;
      index += 1;
      continue;
    }
    if (char === '\n') {
      const terminator = body.endsWith('\r') ? '\r\n' : '\n';
      if (terminator === '\r\n') body = body.slice(0, -1);
      records.push({ body, terminator });
      body = '';
      index += 1;
      continue;
    }
    body += char;
    index += 1;
  }
  if (body.length > 0 || records.length === 0) {
    records.push({ body, terminator: '' });
  }
  return records;
}

/** 引号感知的单行切分为单元格（返回未转义内容）。 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function serializeCsvCell(value: string): string {
  const needsQuoting = /[",\n\r]/.test(value);
  return needsQuoting ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---------------------------------------------------------------------------
// 地址解析
// ---------------------------------------------------------------------------

/** 由 address（优先）或 0-based col/row 推导规范 "A1" 地址；失败返回 ''。 */
function normalizeAddress(floatImage: {
  address: string;
  col: number | null;
  row: number | null;
}): string {
  if (parseCellAddress(floatImage.address)) {
    return floatImage.address.toUpperCase();
  }
  if (floatImage.col != null && floatImage.row != null) {
    return `${columnIndexToLetters(floatImage.col)}${floatImage.row + 1}`;
  }
  return '';
}

function imageRowNumber(image: SheetMediaItem): number | null {
  const parsed = parseCellAddress(image.address);
  return parsed ? parsed.rowNumber : null;
}

function imageColumnIndex(image: SheetMediaItem): number | null {
  const parsed = parseCellAddress(image.address);
  return parsed ? parsed.colIndex : null;
}

/** "A7" → { colIndex: 0, rowNumber: 7 }；不合法返回 null。 */
function parseCellAddress(address: string): { colIndex: number; rowNumber: number } | null {
  const match = /^[ \t]*([A-Za-z]+)([0-9]+)[ \t]*$/.exec(address);
  if (!match) return null;
  const rowNumber = Number.parseInt(match[2], 10);
  if (!Number.isFinite(rowNumber) || rowNumber < 1) return null;
  return { colIndex: columnLettersToIndex(match[1]), rowNumber };
}

/** 列字母（A/AA/AZ…）→ 0-based 索引。 */
function columnLettersToIndex(letters: string): number {
  let index = 0;
  for (const char of letters.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

/** 0-based 列索引 → 列字母（与 SyncEngine.colToLetter 的 1-based 互逆）。 */
function columnIndexToLetters(index: number): string {
  let letters = '';
  let x = index + 1;
  while (x > 0) {
    const mod = (x - 1) % 26;
    letters = String.fromCharCode(65 + mod) + letters;
    x = Math.floor((x - mod) / 26);
  }
  return letters;
}

// ---------------------------------------------------------------------------
// Markdown 附录
// ---------------------------------------------------------------------------

/**
 * 为单个子表生成「子表图片资源」大图展示区（追加在重构后的子表
 * Markdown 尾部）。CSV 单元格内的引用服务于数据关联，此处的大图区块
 * 保证图片在阅读器中以完整尺寸可见、且不依赖 CSV 渲染。
 */
export function renderSheetMediaAppendix(
  sheetTitle: string,
  images: SheetMediaItem[],
): string {
  if (images.length === 0) return '';
  const lines: string[] = [`### 子表图片资源 (${sheetTitle})`, ''];
  for (const image of images) {
    const size = image.width != null && image.height != null
      ? ` (${image.width}×${image.height})`
      : '';
    lines.push(`- **单元格 ${image.address} 浮动图片**${size}：`);
    lines.push(`  ![${sheetTitle} ${image.address} 浮动图片](${image.localRelPath})`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 文件名安全
// ---------------------------------------------------------------------------

/** 文件名片段净化：去文件系统非法字符与空白，截断到 40 字符。 */
function sanitizeFileStem(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F\s]+/g, '_')
    .replace(/^_+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : 'sheet';
}
