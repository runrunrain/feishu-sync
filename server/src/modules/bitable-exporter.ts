/**
 * bitable-exporter — 飞书多维表格（objType=bitable / base）确定性完整导出器。
 *
 * 背景（2026-10）：bitable 此前被 change-detector.normalizeObjType 折叠为
 * 'unknown'，同步时走 docs+fetch 被飞书拒绝（lark-cli code 3380002
 * "Unsupported document type"），产物只有元数据占位。本模块补齐完整导出：
 *
 *   - 数据表清单（table-list 翻页拉全）
 *   - 每表字段 schema（含 single/multi select 选项、date 格式、link 目标表）
 *   - 每表全部记录（record-list 翻页拉全，硬上限防死循环）
 *   - 视图清单（view-list 翻页拉全）
 *   - 附件文件落地（base +record-download-attachment，软失败降级标注）
 *   - dashboard / workflow / form 元数据 JSON 存档（软失败降级标注）
 *
 * 设计决策（已定，勿改）：
 *   - **确定性管线，零 LLM**：数据表格 LLM 重排有丢数据风险，md 由 API
 *     数据直接渲染；LLM 整理在 SyncEngine 对 bitable 跳过。
 *   - **不走 LayoutReconstructor**：那是 sheet CSV→md 的重构器；bitable
 *     的表格语义（字段 schema / 类型化值）比裸 CSV 强，直接渲染。
 *   - **不做子表级增量检测**（范围外）：bitable 整档 obj_edit_time 变更
 *     即整档重导。
 *
 * 错误策略（与既有契约对齐）：
 *   - 硬失败（抛错，同步中止不推进 synced 基线）：table-list / field-list /
 *     record-list 失败——数据不完整时绝不标记 synced（同 sheet 子表契约）。
 *   - 软失败（降级标注，不阻断）：单个附件下载失败、view-list 失败、
 *     dashboard / workflow / form 单类失败——这些是主数据之上的增强层。
 *
 * 响应解析采用 sheet-media.parseSheetFloatImages 的宽容模式：snake/camel
 * key 兼容、{ok,data} 包装层剥解、任意一层形状不符按空页处理；翻页终止
 * 条件三重兜底（has_more===false / 返回数 < limit / items 为空）+ 条数硬
 * 上限。lark-cli base 子命令的响应形状未经逐版本实测固定，宽容解析是
 * 刻意的。
 *
 * 该模块不直接持有 LarkCliClient 依赖，只依赖结构化的最小 client 接口
 * （与 sheet-media 的注入风格一致），便于测试替身。
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types — client face
// ---------------------------------------------------------------------------

/** 导出所需的 client 面（LarkCliClient base 方法的结构子集）。 */
export interface BitableClient {
  listBaseTables(appToken: string, offset: number, limit: number): Promise<any>;
  listBaseFields(options: {
    baseToken: string;
    tableId: string;
    offset: number;
    limit: number;
  }): Promise<any>;
  listBaseViews(options: {
    baseToken: string;
    tableId: string;
    offset: number;
    limit: number;
  }): Promise<any>;
  listBaseRecords(options: {
    baseToken: string;
    tableId: string;
    offset: number;
    limit: number;
  }): Promise<any>;
  downloadBaseAttachment(options: {
    baseToken: string;
    tableId: string;
    recordId: string;
    fileToken: string;
    outputDir: string;
  }): Promise<any>;
  listBaseDashboards(baseToken: string): Promise<any>;
  listBaseWorkflows(baseToken: string): Promise<any>;
  listBaseForms(options: { baseToken: string; tableId: string }): Promise<any>;
}

// ---------------------------------------------------------------------------
// Types — normalized data model
// ---------------------------------------------------------------------------

export interface BitableField {
  fieldId: string;
  fieldName: string;
  /** lark-cli 原始类型值（数字码或字符串），仅用于展示与诊断。 */
  rawType: string;
  /** 归一化后的类型家族（text / single_select / link / ...）。 */
  canonicalType: string;
  /** 字段配置（select 选项 / date 格式 / link 目标表 id 等），未定义为 null。 */
  property: Record<string, any> | null;
  isPrimary: boolean;
}

export interface BitableView {
  viewId: string;
  viewName: string;
  viewType: string;
}

export interface BitableRecord {
  recordId: string;
  /** 以字段名为 key 的原始值（v2/v3 records API 的 fields 对象）。 */
  fields: Record<string, unknown>;
}

export interface BitableTableData {
  tableId: string;
  tableName: string;
  fields: BitableField[];
  views: BitableView[];
  /** view-list 失败时的降级说明；成功为 null。 */
  viewError: string | null;
  records: BitableRecord[];
  /** 记录数达到硬上限被截断。 */
  truncated: boolean;
}

export interface BitableSectionSummary {
  tableId: string;
  tableName: string;
  recordCount: number;
  fieldCount: number;
  viewCount: number;
  truncated: boolean;
  /** 相对 stagingDocDir 的 CSV 路径（POSIX），如 Title.csv-data/表.csv。 */
  csvRelPath: string;
}

export interface BitableAttachmentRef {
  /** 相对 stagingDocDir 的 POSIX 路径，如 attachments/01-xxx.png。 */
  relativePath: string;
  /** staging 内的绝对路径。 */
  absolutePath: string;
  name: string;
  token: string;
}

/** 除 md 正文外需要随文档提交的文件（CSV / base 元数据 JSON；不含附件）。 */
export interface BitableCommitFile {
  /** 相对 stagingDocDir 的 POSIX 路径。 */
  relativePath: string;
  /** staging 内的绝对路径。 */
  absolutePath: string;
}

export interface BitableExportResult {
  markdown: string;
  sections: BitableSectionSummary[];
  attachments: BitableAttachmentRef[];
  commitFiles: BitableCommitFile[];
  /** 非致命降级说明（截断 / 软失败），也会写入 md 正文。 */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Pagination & tolerant response normalization
// ---------------------------------------------------------------------------

const TABLES_PAGE_LIMIT = 100;
const FIELDS_PAGE_LIMIT = 200;
const VIEWS_PAGE_LIMIT = 200;
const RECORDS_PAGE_LIMIT = 200;
const MAX_TABLES = 200;
const MAX_FIELDS_PER_TABLE = 500;
const MAX_VIEWS_PER_TABLE = 500;
/** 每表记录硬上限：防 API 异常翻页死循环；超限截断并在 md 标注。 */
export const MAX_RECORDS_PER_TABLE = 50_000;

interface PageSlice<T> {
  items: T[];
  /** null 表示响应未携带 has_more（容错路径由其他条件兜底）。 */
  hasMore: boolean | null;
}

/**
 * 剥解 {ok:true,data:{...}} / 裸 {items:[...]} 等包装层，返回承载分页
 * 数据的对象。最多剥两层 data；本层已携带 items/has_more 时不再剥。
 */
function unwrapPageRoot(response: unknown): Record<string, any> {
  let current: unknown = response;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) break;
    const record = current as Record<string, unknown>;
    if ('data' in record && !('items' in record) && !('has_more' in record)) {
      current = record.data;
      continue;
    }
    break;
  }
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, any>;
  }
  return {};
}

/** 从宽容归一化后的分页响应中提取 items 数组（多种常见 key 兼容）。 */
function pageItems(root: Record<string, any>): any[] {
  const candidates = [root.items, root.tables, root.records, root.fields, root.views, root.list];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function pageHasMore(root: Record<string, any>): boolean | null {
  const raw = root.has_more ?? root.hasMore ?? root.more;
  return typeof raw === 'boolean' ? raw : null;
}

function extractPage(response: unknown): PageSlice<any> {
  const root = unwrapPageRoot(response);
  return { items: pageItems(root), hasMore: pageHasMore(root) };
}

function readStr(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 翻页拉全一个列表端点。终止条件三重兜底：
 *   ① has_more === false（显式终点）
 *   ② 本页条数 < limit（服务端隐式终点）
 *   ③ 本页为空
 * 外加条数硬上限（maxItems），超限置 truncated 并停止。页面数额外设
 * ceil(maxItems/limit)+2 的保险丝，防止 API 在「整页返回 + has_more 缺失」
 * 时死循环。
 */
async function paginateAll<T>(
  context: string,
  limit: number,
  maxItems: number,
  fetchPage: (offset: number, limit: number) => Promise<PageSlice<T>>,
): Promise<{ items: T[]; truncated: boolean }> {
  const collected: T[] = [];
  const maxPages = Math.ceil(maxItems / limit) + 2;
  let offset = 0;
  let truncated = false;
  let exhaustedByServer = false;

  for (let page = 0; page < maxPages; page += 1) {
    const slice = await fetchPage(offset, limit);
    if (slice.items.length === 0) {
      exhaustedByServer = true;
      break;
    }
    collected.push(...slice.items);
    offset += slice.items.length;
    if (slice.hasMore === false) {
      exhaustedByServer = true;
      break;
    }
    if (slice.items.length < limit) {
      exhaustedByServer = true;
      break;
    }
    if (collected.length >= maxItems) {
      truncated = true;
      break;
    }
  }

  // 页数保险丝触发（未到条数上限也未收到服务端终点信号）：按截断处理。
  if (!exhaustedByServer) truncated = true;
  if (collected.length > maxItems) {
    collected.length = maxItems;
    truncated = true;
  }
  void context;
  return { items: collected, truncated };
}

// ---------------------------------------------------------------------------
// Field type canonicalization
// ---------------------------------------------------------------------------

/**
 * 字符串类型名 → 类型家族。key 为「小写 + 去非字母数字」形式，覆盖
 * v3 ui_type 的 PascalCase（SingleSelect→singleselect）、snake_case
 * （single_select→singleselect）与裸单词。
 */
const FIELD_TYPE_ALIASES: Record<string, string> = {
  text: 'text', textarea: 'textarea', paragraph: 'textarea', richtext: 'text',
  url: 'url', hyperlink: 'url', linkurl: 'url',
  phone: 'phone', telephone: 'phone', mobile: 'phone', phonenumber: 'phone',
  barcode: 'barcode',
  autonumber: 'auto_number', serial: 'auto_number',
  number: 'number', integer: 'number',
  currency: 'currency', progress: 'progress', rating: 'rating',
  singleselect: 'single_select', select: 'single_select', singlechoice: 'single_select',
  multiselect: 'multi_select', multichoice: 'multi_select',
  date: 'date', datetime: 'datetime',
  createtime: 'create_time', createdtime: 'create_time', createdat: 'create_time',
  modifytime: 'modify_time', modifiedtime: 'modify_time', updatetime: 'modify_time', updatedat: 'modify_time',
  checkbox: 'checkbox', check: 'checkbox', bool: 'checkbox',
  user: 'user',
  group: 'group',
  attachment: 'attachment', file: 'attachment', files: 'attachment',
  link: 'link', onewaylink: 'link', duplexlink: 'link', twowaylink: 'link',
  relation: 'link', relationlink: 'link', linkedrecord: 'link',
  lookup: 'lookup', lookups: 'lookup', reference: 'lookup', rollup: 'lookup',
  formula: 'formula',
  location: 'location', geo: 'location', geography: 'location',
  createdby: 'created_by', modifiedby: 'modified_by',
};

/**
 * 数字类型码 → 类型家族（v1/v2 字段枚举）。未列出的码走 unknown 兜底
 * （值形状宽容渲染，不会丢数据）。数字码与字符串名映射以实测 lark-cli
 * 返回为准；若版本差异导致误映射，渲染退化为 loose/JSON 而非报错。
 */
const NUMERIC_FIELD_TYPES: Record<number, string> = {
  1: 'text', 2: 'number', 3: 'single_select', 4: 'multi_select',
  5: 'date', 6: 'checkbox', 7: 'user', 8: 'group', 9: 'phone',
  10: 'attachment', 11: 'url', 13: 'link', 15: 'formula', 17: 'link',
  18: 'lookup', 21: 'create_time', 22: 'modify_time', 23: 'auto_number',
  1001: 'location',
};

function canonicalizeFieldType(rawType: unknown, uiType: unknown): string {
  const fromString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalized) return null;
    return FIELD_TYPE_ALIASES[normalized] ?? null;
  };
  return fromString(uiType) ?? fromString(rawType) ?? 'unknown';
}

function normalizeField(entry: any): BitableField | null {
  if (!entry || typeof entry !== 'object') return null;
  const fieldId = readStr(entry.field_id ?? entry.fieldId ?? entry.id);
  const fieldName = readStr(entry.field_name ?? entry.fieldName ?? entry.name);
  if (!fieldName && !fieldId) return null;
  const rawType = entry.type ?? entry.field_type ?? entry.fieldType;
  const uiType = entry.ui_type ?? entry.uiType;
  const property =
    entry.property && typeof entry.property === 'object'
      ? (entry.property as Record<string, any>)
      : null;
  const numericType = typeof rawType === 'number' && Number.isFinite(rawType)
    ? NUMERIC_FIELD_TYPES[rawType]
    : undefined;
  let canonicalType = canonicalizeFieldType(
    typeof rawType === 'string' ? rawType : undefined,
    uiType,
  );
  if (canonicalType === 'unknown' && numericType) canonicalType = numericType;
  return {
    fieldId: fieldId || fieldName,
    fieldName: fieldName || fieldId,
    rawType: rawType === undefined || rawType === null ? '' : String(rawType),
    canonicalType,
    property,
    isPrimary: entry.is_primary === true || entry.isPrimary === true,
  };
}

function normalizeView(entry: any): BitableView | null {
  if (!entry || typeof entry !== 'object') return null;
  const viewId = readStr(entry.view_id ?? entry.viewId ?? entry.id);
  const viewName = readStr(entry.view_name ?? entry.viewName ?? entry.name);
  if (!viewId && !viewName) return null;
  return {
    viewId: viewId || viewName,
    viewName: viewName || viewId,
    viewType: readStr(entry.view_type ?? entry.viewType ?? entry.type) || 'unknown',
  };
}

function normalizeRecord(entry: any): BitableRecord | null {
  if (!entry || typeof entry !== 'object') return null;
  const recordId = readStr(entry.record_id ?? entry.recordId ?? entry.id);
  if (!recordId) return null;
  const fields =
    entry.fields && typeof entry.fields === 'object' && !Array.isArray(entry.fields)
      ? (entry.fields as Record<string, unknown>)
      : {};
  return { recordId, fields };
}

// ---------------------------------------------------------------------------
// Value rendering
// ---------------------------------------------------------------------------

interface RenderContext {
  /** record_id → 跨表可读标题（两遍渲染的第一遍产物）。 */
  recordTitleById: Map<string, { tableName: string; title: string }>;
  /** file_token → attachments/xxx 本地相对路径（仅下载成功的）。 */
  attachmentLinks: Map<string, string>;
  /** tableId → 表名（link 字段目标表解析）。 */
  tableNamesById: Map<string, string>;
}

/** md 表格单元格转义：`|` 转义 + 换行折叠为 <br>，保持表格结构。 */
function escapeMdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** 紧凑 JSON（兜底渲染，保证未知类型不丢数据）。 */
function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** 文本段（text/mention/url segment 等）→ 纯文本。 */
function segmentText(segment: any): string {
  if (segment == null) return '';
  if (typeof segment === 'string') return segment;
  if (typeof segment !== 'object') return String(segment);
  const record = segment as Record<string, any>;
  if (typeof record.text === 'string') return record.text;
  const link = record.link;
  if (link && typeof link === 'object') {
    return readStr(link.text) || readStr(link.link) || readStr(link.url);
  }
  if (typeof record.link === 'string') return record.link;
  return '';
}

function renderTextLike(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(segmentText).filter((part) => part.length > 0).join('');
  }
  return segmentText(value) || compactJson(value);
}

function renderNumber(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'boolean') return String(value);
  return '';
}

function optionLabel(option: any): string {
  if (option == null) return '';
  if (typeof option === 'string') return option;
  if (typeof option !== 'object') return String(option);
  const record = option as Record<string, any>;
  return readStr(record.text ?? record.name ?? record.label ?? record.id);
}

function renderSingleSelect(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.map(optionLabel).filter(Boolean).join(' / ');
  }
  return optionLabel(value) || compactJson(value);
}

function renderMultiSelect(value: unknown): string {
  return asArray(value).map(optionLabel).filter(Boolean).join(' / ') || renderSingleSelect(value);
}

/** unix 毫秒转 ISO；容错秒级（<1e11 视为秒）。 */
function renderTimestamp(value: unknown): string {
  if (value == null || value === '') return '';
  let numeric: number;
  if (typeof value === 'number') numeric = value;
  else if (typeof value === 'string') numeric = Number(value);
  else return '';
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  const ms = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function personLabel(person: any): string {
  if (person == null) return '';
  if (typeof person === 'string') return person;
  if (typeof person !== 'object') return String(person);
  const record = person as Record<string, any>;
  return readStr(record.name ?? record.en_name ?? record.display_name ?? record.id ?? record.open_id ?? record.user_id);
}

function renderPeople(value: unknown): string {
  const items = Array.isArray(value) ? value : [value];
  return items.map(personLabel).filter(Boolean).join(' / ');
}

function attachmentTokens(value: unknown): Array<{ token: string; name: string }> {
  return asArray(value)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, any>;
      const token = readStr(record.file_token ?? record.fileToken ?? record.token);
      const name = readStr(record.name ?? record.title ?? record.file_name ?? record.filename);
      if (!token && !name) return null;
      return { token, name };
    })
    .filter((item): item is { token: string; name: string } => item !== null);
}

function renderAttachments(value: unknown, ctx: RenderContext): string {
  const tokens = attachmentTokens(value);
  if (tokens.length === 0) return '';
  return tokens
    .map(({ token, name }) => {
      const label = name || token;
      const localRel = token ? ctx.attachmentLinks.get(token) : undefined;
      if (localRel) return `[${label}](${localRel})`;
      return `[${label}](下载失败 token:${token || 'unknown'})`;
    })
    .join('<br>');
}

/** link 字段值（v2: record_id 字符串数组；v3: {record_id,...} 对象数组）→ record_id 列表。 */
function extractRecordIds(value: unknown): string[] {
  const ids: string[] = [];
  for (const item of asArray(value)) {
    if (typeof item === 'string') {
      if (item.trim().length > 0) ids.push(item.trim());
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, any>;
      const id = readStr(record.record_id ?? record.recordId ?? record.link_record_id ?? record.id);
      if (id) ids.push(id);
    }
  }
  return ids;
}

function linkTargetTableName(field: BitableField, ctx: RenderContext): string | null {
  const property = field.property;
  if (!property) return null;
  const tableId = readStr(
    property.table_id ?? property.tableId ?? property.link_table_id ?? property.linkTableId,
  );
  if (!tableId) return null;
  return ctx.tableNamesById.get(tableId) ?? tableId;
}

function renderLink(field: BitableField, value: unknown, ctx: RenderContext): string {
  const ids = extractRecordIds(value);
  if (ids.length === 0) return '';
  const fallbackTable = linkTargetTableName(field, ctx) ?? '关联记录';
  return ids
    .map((recordId) => {
      const resolved = ctx.recordTitleById.get(recordId);
      if (resolved) return `${resolved.tableName}: ${resolved.title}`;
      return `${fallbackTable}: ${recordId}`;
    })
    .join('<br>');
}

/** 宽容标量渲染（lookup / formula / 形状未知值）：不依赖字段类型也能读。 */
function renderLoose(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(renderLoose).filter((part) => part.length > 0).join(' / ');
  }
  const record = value as Record<string, any>;
  const text = segmentText(record);
  if (text) return text;
  const label = readStr(record.name ?? record.title);
  if (label && Object.keys(record).length <= 3) return label;
  const token = readStr(record.file_token ?? record.fileToken);
  if (token && Object.keys(record).length <= 4) return token;
  return compactJson(value);
}

function renderLookup(value: unknown): string {
  return renderLoose(value);
}

function renderLocation(value: unknown): string {
  if (value == null) return '';
  const target =
    value && typeof value === 'object' && (value as any).location
      ? (value as any).location
      : value;
  if (!target || typeof target !== 'object') return renderLoose(value);
  const record = target as Record<string, any>;
  const parts = [
    readStr(record.province),
    readStr(record.city),
    readStr(record.district),
    readStr(record.adname),
    readStr(record.address),
    readStr(record.full_address),
    readStr(record.name),
  ].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(' ') : compactJson(value);
}

/** 按字段家族渲染一个单元格值（未转义；转义在单元格拼装时统一做）。 */
function renderFieldValue(field: BitableField, value: unknown, ctx: RenderContext): string {
  if (value == null) return '';
  switch (field.canonicalType) {
    case 'text':
    case 'textarea':
    case 'url':
    case 'phone':
    case 'barcode':
    case 'auto_number':
      return renderTextLike(value);
    case 'number':
    case 'currency':
    case 'progress':
    case 'rating':
      return renderNumber(value);
    case 'single_select':
      return renderSingleSelect(value);
    case 'multi_select':
      return renderMultiSelect(value);
    case 'date':
    case 'datetime':
    case 'create_time':
    case 'modify_time':
      return renderTimestamp(value);
    case 'checkbox':
      return value === true ? '✅' : '';
    case 'user':
    case 'created_by':
    case 'modified_by':
      return renderPeople(value);
    case 'group':
      return renderPeople(value);
    case 'attachment':
      return renderAttachments(value, ctx);
    case 'link':
      return renderLink(field, value, ctx);
    case 'lookup':
      return renderLookup(value);
    case 'formula':
      return renderLoose(value);
    case 'location':
      return renderLocation(value);
    default:
      return renderLoose(value) || compactJson(value);
  }
}

// ---------------------------------------------------------------------------
// CSV raw-value rendering
// ---------------------------------------------------------------------------

function csvRawScalar(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(csvRawScalar).filter((part) => part.length > 0).join(';');
  }
  const record = value as Record<string, any>;
  const text = segmentText(record);
  if (text && Object.keys(record).length <= 2) return text;
  return compactJson(value);
}

/** CSV 单元格：字段原始值；附件列写 file_token 列表（';' 连接）。 */
function csvCell(field: BitableField, value: unknown): string {
  if (value == null) return '';
  if (field.canonicalType === 'attachment') {
    return attachmentTokens(value)
      .map(({ token }) => token)
      .filter(Boolean)
      .join(';');
  }
  return csvRawScalar(value);
}

function serializeCsvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---------------------------------------------------------------------------
// File name safety
// ---------------------------------------------------------------------------

/** 与 exportSheetsToStaging 的子表名清洗同规则：仅去文件系统非法字符。 */
function safeTableFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'table';
}

/** 文件名片段净化（附件名）：去非法字符与空白，截断 40 字符（对齐 sheet-media）。 */
function sanitizeFileStem(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F\s]+/g, '_')
    .replace(/^_+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : 'file';
}

/**
 * 字段 schema「配置」列摘要：select 选项全量列出、date 格式、link 目标
 * 表名；无命中的非空 property 退化为 compact JSON（保证配置不丢）。
 */
function describeFieldProperty(field: BitableField, ctx: RenderContext): string {
  const property = field.property;
  if (!property) return '';
  const parts: string[] = [];

  if (field.canonicalType === 'single_select' || field.canonicalType === 'multi_select') {
    const options = asArray(property.options ?? property.choices)
      .map(optionLabel)
      .filter(Boolean);
    if (options.length > 0) parts.push(`选项: ${options.join(' / ')}`);
  } else if (
    field.canonicalType === 'date'
    || field.canonicalType === 'datetime'
    || field.canonicalType === 'create_time'
    || field.canonicalType === 'modify_time'
  ) {
    const format = readStr(property.date_formatter ?? property.dateFormat ?? property.format);
    if (format) parts.push(`格式: ${format}`);
  } else if (field.canonicalType === 'link') {
    const target = linkTargetTableName(field, ctx);
    if (target) parts.push(`关联表: ${target}`);
  } else if (
    field.canonicalType === 'number'
    || field.canonicalType === 'currency'
    || field.canonicalType === 'progress'
    || field.canonicalType === 'rating'
  ) {
    const format = readStr(property.formatter ?? property.format);
    if (format) parts.push(`格式: ${format}`);
  }

  if (parts.length === 0) {
    const json = compactJson(property);
    if (json && json !== '{}') parts.push(json);
  }
  return parts.join('；');
}

// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------

interface AttachmentDownloadPlan {
  tableId: string;
  recordId: string;
  fileToken: string;
  name: string;
}

export class BitableExporter {
  constructor(private client: BitableClient) {}

  /**
   * 导出一个 base 的完整 Markdown + 附属文件。
   *
   * 落盘约定（与 sheet 的 csv-data / docx 的 attachments 保持一致）：
   *   stagingDocDir/
   *     <docname>.csv-data/<safe表名>.csv   每表原始记录 CSV
   *     <docname>.base-meta/*.json          dashboard/workflow/form 存档
   *     attachments/<NN>-<名><ext>          附件（软失败跳过并标注）
   *
   * 返回的 commitFiles 是相对 stagingDocDir 的 POSIX 路径；SyncEngine 负责
   * 加上文档目录前缀后走 atomic-commit 的 extraFiles 通道。
   */
  async exportBitable(options: {
    baseToken: string;
    title: string;
    stagingDocDir: string;
    docname: string;
  }): Promise<BitableExportResult> {
    const { baseToken, title, stagingDocDir, docname } = options;
    const warnings: string[] = [];

    // ---- a) 数据表清单（翻页拉全；失败为硬失败） ----
    let tableEntries: any[];
    let tablesTruncated = false;
    try {
      const page = await paginateAll(
        `table-list ${baseToken}`,
        TABLES_PAGE_LIMIT,
        MAX_TABLES,
        (offset, limit) =>
          this.client
            .listBaseTables(baseToken, offset, limit)
            .then((response) => extractPage(response)),
      );
      tableEntries = page.items;
      tablesTruncated = page.truncated;
    } catch (error) {
      throw new Error(
        `bitable 数据表清单读取失败 (${baseToken}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (tablesTruncated) {
      warnings.push(`数据表数量达到上限 ${MAX_TABLES}，已截断`);
    }

    const tables: Array<{ tableId: string; tableName: string }> = tableEntries
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const tableId = readStr(entry.table_id ?? entry.tableId ?? entry.id);
        const tableName = readStr(entry.name ?? entry.table_name ?? entry.tableName ?? entry.title);
        if (!tableId && !tableName) return null;
        return { tableId: tableId || tableName, tableName: tableName || tableId };
      })
      .filter((entry): entry is { tableId: string; tableName: string } => entry !== null);

    // ---- b) 每表 fields + views + records ----
    const tableData: BitableTableData[] = [];
    for (const table of tables) {
      const { tableId, tableName } = table;

      let fields: BitableField[];
      try {
        const page = await paginateAll(
          `field-list ${tableId}`,
          FIELDS_PAGE_LIMIT,
          MAX_FIELDS_PER_TABLE,
          (offset, limit) =>
            this.client
              .listBaseFields({ baseToken, tableId, offset, limit })
              .then((response) => extractPage(response)),
        );
        fields = page.items
          .map(normalizeField)
          .filter((field): field is BitableField => field !== null);
        if (page.truncated) warnings.push(`表 "${tableName}" 字段数达到上限，已截断`);
      } catch (error) {
        // 字段 schema 是记录渲染的必要输入，缺失即数据不完整 → 硬失败。
        throw new Error(
          `bitable 字段读取失败: 表 "${tableName}" (${tableId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      let views: BitableView[] = [];
      let viewError: string | null = null;
      try {
        const page = await paginateAll(
          `view-list ${tableId}`,
          VIEWS_PAGE_LIMIT,
          MAX_VIEWS_PER_TABLE,
          (offset, limit) =>
            this.client
              .listBaseViews({ baseToken, tableId, offset, limit })
              .then((response) => extractPage(response)),
        );
        views = page.items
          .map(normalizeView)
          .filter((view): view is BitableView => view !== null);
      } catch (error) {
        // 视图是增强层 → 软失败。
        viewError = error instanceof Error ? error.message : String(error);
      }

      let records: BitableRecord[];
      let truncated = false;
      try {
        const page = await paginateAll(
          `record-list ${tableId}`,
          RECORDS_PAGE_LIMIT,
          MAX_RECORDS_PER_TABLE,
          (offset, limit) =>
            this.client
              .listBaseRecords({ baseToken, tableId, offset, limit })
              .then((response) => extractPage(response)),
        );
        records = page.items
          .map(normalizeRecord)
          .filter((record): record is BitableRecord => record !== null);
        truncated = page.truncated;
      } catch (error) {
        // 记录不完整绝不推进 synced 基线 → 硬失败。
        throw new Error(
          `bitable 记录读取失败: 表 "${tableName}" (${tableId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (truncated) {
        warnings.push(
          `表 "${tableName}" 记录数达到上限 ${MAX_RECORDS_PER_TABLE}，已截断`,
        );
      }

      tableData.push({ tableId, tableName, fields, views, viewError, records, truncated });
    }

    // ---- c) 附件下载（软失败降级） ----
    const attachmentPlans: AttachmentDownloadPlan[] = [];
    for (const table of tableData) {
      const attachmentFields = table.fields.filter((f) => f.canonicalType === 'attachment');
      if (attachmentFields.length === 0) continue;
      for (const record of table.records) {
        for (const field of attachmentFields) {
          const value = record.fields[field.fieldName];
          for (const { token, name } of attachmentTokens(value)) {
            if (!token) continue;
            attachmentPlans.push({
              tableId: table.tableId,
              recordId: record.recordId,
              fileToken: token,
              name,
            });
          }
        }
      }
    }
    const attachments = await this.downloadAttachments(
      baseToken,
      stagingDocDir,
      attachmentPlans,
      warnings,
    );

    // ---- d) 两遍渲染：先建 record_id → 可读标题索引，再渲染 md ----
    const ctx = this.buildRenderContext(tableData, attachments);

    const csvDataDir = path.join(stagingDocDir, `${docname}.csv-data`);
    fs.mkdirSync(csvDataDir, { recursive: true });

    const sections: BitableSectionSummary[] = [];
    const commitFiles: BitableCommitFile[] = [];
    const usedFileNames = new Map<string, number>();

    const markdownSections: string[] = [`# ${title}`];
    markdownSections.push(this.renderOverview(tableData, warnings));

    for (const table of tableData) {
      const safeBase = safeTableFileName(table.tableName);
      const used = usedFileNames.get(safeBase) ?? 0;
      usedFileNames.set(safeBase, used + 1);
      const safeName = used === 0 ? safeBase : `${safeBase}_${used + 1}`;

      const csvRelPath = `${docname}.csv-data/${safeName}.csv`;
      const csvAbsPath = path.join(csvDataDir, `${safeName}.csv`);
      fs.writeFileSync(csvAbsPath, this.renderCsv(table), 'utf-8');
      commitFiles.push({ relativePath: csvRelPath, absolutePath: csvAbsPath });

      markdownSections.push(this.renderTableSection(table, ctx, csvRelPath));
      sections.push({
        tableId: table.tableId,
        tableName: table.tableName,
        recordCount: table.records.length,
        fieldCount: table.fields.length,
        viewCount: table.views.length,
        truncated: table.truncated,
        csvRelPath,
      });
    }

    // ---- e) base 级元数据存档（软失败） ----
    const baseMeta = await this.exportBaseMeta(baseToken, stagingDocDir, docname, tableData);
    commitFiles.push(...baseMeta.commitFiles);
    markdownSections.push(baseMeta.markdown);

    // 非空块以 `---` 分隔（H1/概览 → 各表章节 → Base 元数据存档）。
    const markdown =
      markdownSections
        .map((section) => section.trimEnd())
        .filter((section) => section.length > 0)
        .join('\n\n---\n\n') + '\n';
    return { markdown, sections, attachments, commitFiles, warnings };
  }

  /** 下载附件到 staging 的 attachments/ 目录；单文件失败软降级。 */
  private async downloadAttachments(
    baseToken: string,
    stagingDocDir: string,
    plans: AttachmentDownloadPlan[],
    warnings: string[],
  ): Promise<BitableAttachmentRef[]> {
    const results: BitableAttachmentRef[] = [];
    if (plans.length === 0) return results;

    const attachmentsDir = path.join(stagingDocDir, 'attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });

    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      const seq = String(index + 1).padStart(2, '0');
      // fileToken 清洗（diting 2026-10 Minor-3）：理论上含 ../ 等路径段
      // 的 token 会把临时下载目录拼出 staging 之外，清洗后再 join。
      const safeToken = plan.fileToken.replace(/[^A-Za-z0-9_-]/g, '_');
      const downloadDir = path.join(attachmentsDir, `.dl-${seq}-${safeToken}`);
      try {
        fs.mkdirSync(downloadDir, { recursive: true });
        const response = await this.client.downloadBaseAttachment({
          baseToken,
          tableId: plan.tableId,
          recordId: plan.recordId,
          fileToken: plan.fileToken,
          outputDir: downloadDir,
        });
        const downloaded = resolveDownloadedFile(downloadDir, response);
        if (fs.statSync(downloaded).size <= 0) {
          throw new Error('下载内容为空');
        }
        // 纵深防御（diting 2026-10 Minor-3）：ext 优先取已下载文件的真实
        // 扩展名；plan.name 来自云端记录，split('.') 派生的 ext 可携带路径
        // 段（如 "a.b/../../x"），白名单不过则退化 .bin，杜绝穿透。
        const derivedExt = path.extname(downloaded)
          || (plan.name.includes('.') ? `.${plan.name.split('.').pop()}` : '')
          || '';
        const ext = /^\.[A-Za-z0-9]{1,8}$/.test(derivedExt) ? derivedExt : '.bin';
        // stem 去掉尾部扩展名（扩展名统一由 downloaded/plan.name 推导，
        // 避免「图.png」+ .png → 01-图.png.png 的双后缀）。
        const sanitizedBase = sanitizeFileStem(plan.name || plan.fileToken);
        const stem = sanitizedBase.replace(/\.[^.]+$/, '') || sanitizedBase;
        const finalName = `${seq}-${stem}${ext}`;
        const finalPath = path.join(attachmentsDir, finalName);
        fs.renameSync(downloaded, finalPath);
        results.push({
          relativePath: `attachments/${finalName}`,
          absolutePath: finalPath,
          name: plan.name || plan.fileToken,
          token: plan.fileToken,
        });
      } catch (error) {
        warnings.push(
          `附件下载失败（软降级，已在 md 标注）: ${plan.name || plan.fileToken}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        console.warn(
          `[bitable-exporter] attachment download failed: ${plan.name || plan.fileToken}:`,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        try {
          fs.rmSync(downloadDir, { recursive: true, force: true });
        } catch {
          /* best effort cleanup */
        }
      }
    }
    return results;
  }

  /** 第一遍渲染：record_id → 「表名: 首字段值」索引 + 渲染上下文。 */
  private buildRenderContext(
    tableData: BitableTableData[],
    attachments: BitableAttachmentRef[],
  ): RenderContext {
    const recordTitleById = new Map<string, { tableName: string; title: string }>();
    const tableNamesById = new Map<string, string>();
    const attachmentLinks = new Map<string, string>();

    for (const att of attachments) {
      attachmentLinks.set(att.token, att.relativePath);
    }
    for (const table of tableData) {
      tableNamesById.set(table.tableId, table.tableName);
    }

    const ctx: RenderContext = { recordTitleById, attachmentLinks, tableNamesById };
    for (const table of tableData) {
      const titleField =
        table.fields.find((field) => field.isPrimary) ?? table.fields[0] ?? null;
      if (!titleField) continue;
      for (const record of table.records) {
        if (recordTitleById.has(record.recordId)) continue;
        const value = record.fields[titleField.fieldName];
        const rendered = renderTextLike(value).trim();
        recordTitleById.set(record.recordId, {
          tableName: table.tableName,
          title: rendered || record.recordId,
        });
      }
    }
    return ctx;
  }

  private renderOverview(tableData: BitableTableData[], warnings: string[]): string {
    const lines: string[] = [];
    lines.push(`> 云端类型 \`bitable\`（多维表格），共 ${tableData.length} 张数据表。`);
    if (warnings.length > 0) {
      lines.push('>');
      for (const warning of warnings) lines.push(`> ⚠️ ${warning}`);
    }
    return lines.join('\n');
  }

  private renderTableSection(
    table: BitableTableData,
    ctx: RenderContext,
    csvRelPath: string,
  ): string {
    const lines: string[] = [];
    lines.push(`## 数据表: ${table.tableName}`);
    lines.push('');
    lines.push(`- 表 ID: \`${table.tableId}\``);
    lines.push(`- 记录数: ${table.records.length}`);
    if (table.viewError) {
      lines.push(`- 视图: 获取失败（${table.viewError}）`);
    } else if (table.views.length === 0) {
      lines.push('- 视图: 无');
    } else {
      const viewParts = table.views.map(
        (view) => `**${view.viewName}**（\`${view.viewId}\`，类型 \`${view.viewType}\`）`,
      );
      lines.push(`- 视图: ${viewParts.join('；')}`);
    }
    lines.push(`- [CSV 原始数据](${csvRelPath})`);
    if (table.truncated) {
      lines.push(`- ⚠️ 记录数达到上限 ${MAX_RECORDS_PER_TABLE}，以下仅含截断后的前 ${table.records.length} 条`);
    }
    lines.push('');

    // 字段 schema 小节
    lines.push('### 字段');
    lines.push('');
    if (table.fields.length === 0) {
      lines.push('（未获取到字段定义）');
    } else {
      lines.push('| 字段名 | field_id | 类型 | 配置 |');
      lines.push('| --- | --- | --- | --- |');
      for (const field of table.fields) {
        const typeLabel =
          field.canonicalType === 'unknown'
            ? field.rawType || 'unknown'
            : field.canonicalType === field.rawType || !field.rawType
              ? field.canonicalType
              : `${field.canonicalType} (${field.rawType})`;
        lines.push(
          `| ${escapeMdCell(field.fieldName)} | \`${field.fieldId}\` | ${escapeMdCell(typeLabel)} | ${escapeMdCell(describeFieldProperty(field, ctx))} |`,
        );
      }
    }
    lines.push('');

    // 记录小节
    lines.push('### 记录');
    lines.push('');
    if (table.records.length === 0) {
      lines.push('（无记录）');
    } else {
      const header = ['record_id', ...table.fields.map((field) => field.fieldName)];
      lines.push(`| ${header.map(escapeMdCell).join(' | ')} |`);
      lines.push(`| ${header.map(() => '---').join(' | ')} |`);
      for (const record of table.records) {
        const cells = [
          record.recordId,
          ...table.fields.map((field) =>
            renderFieldValue(field, record.fields[field.fieldName], ctx),
          ),
        ];
        lines.push(`| ${cells.map(escapeMdCell).join(' | ')} |`);
      }
    }
    lines.push('');
    return lines.join('\n');
  }

  private renderCsv(table: BitableTableData): string {
    const header = ['record_id', ...table.fields.map((field) => field.fieldName)];
    const rows: string[] = [header.map(serializeCsvCell).join(',')];
    for (const record of table.records) {
      const cells = [
        record.recordId,
        ...table.fields.map((field) => csvCell(field, record.fields[field.fieldName])),
      ];
      rows.push(cells.map(serializeCsvCell).join(','));
    }
    return rows.join('\n') + '\n';
  }

  /**
   * base 级附录：dashboard / workflow / 每 table 的 form。
   * 成功落 <docname>.base-meta/<类别>.json 并在 md 中列链接与条数；
   * 单类失败软降级标注，不阻断。
   */
  private async exportBaseMeta(
    baseToken: string,
    stagingDocDir: string,
    docname: string,
    tableData: BitableTableData[],
  ): Promise<{ markdown: string; commitFiles: BitableCommitFile[] }> {
    const baseMetaDir = path.join(stagingDocDir, `${docname}.base-meta`);
    fs.mkdirSync(baseMetaDir, { recursive: true });
    const commitFiles: BitableCommitFile[] = [];
    const lines: string[] = ['## Base 元数据存档', ''];

    const writeMeta = (category: string, payload: unknown): string => {
      const rel = `${docname}.base-meta/${category}.json`;
      const abs = path.join(baseMetaDir, `${category}.json`);
      fs.writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
      commitFiles.push({ relativePath: rel, absolutePath: abs });
      return rel;
    };

    // dashboards
    try {
      const response = await this.client.listBaseDashboards(baseToken);
      const items = extractPage(response).items;
      const rel = writeMeta('dashboards', { generatedAt: new Date().toISOString(), response });
      lines.push(`- [仪表盘](${rel})（${items.length} 条）`);
    } catch (error) {
      lines.push(`- 仪表盘：获取失败（${error instanceof Error ? error.message : String(error)}）`);
    }

    // workflows
    try {
      const response = await this.client.listBaseWorkflows(baseToken);
      const items = extractPage(response).items;
      const rel = writeMeta('workflows', { generatedAt: new Date().toISOString(), response });
      lines.push(`- [自动化流程](${rel})（${items.length} 条）`);
    } catch (error) {
      lines.push(`- 自动化流程：获取失败（${error instanceof Error ? error.message : String(error)}）`);
    }

    // forms（每表）
    const formTables: Array<Record<string, unknown>> = [];
    let formTotal = 0;
    for (const table of tableData) {
      try {
        const response = await this.client.listBaseForms({ baseToken, tableId: table.tableId });
        const items = extractPage(response).items;
        formTotal += items.length;
        formTables.push({
          tableId: table.tableId,
          tableName: table.tableName,
          ok: true,
          itemCount: items.length,
          response,
        });
      } catch (error) {
        formTables.push({
          tableId: table.tableId,
          tableName: table.tableName,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (tableData.length > 0) {
      const rel = writeMeta('forms', {
        generatedAt: new Date().toISOString(),
        tables: formTables,
      });
      const okCount = formTables.filter((entry) => entry.ok === true).length;
      if (okCount === tableData.length) {
        lines.push(`- [表单](${rel})（${tableData.length} 张表 / ${formTotal} 条）`);
      } else {
        lines.push(
          `- [表单](${rel})（${okCount}/${tableData.length} 张表成功，共 ${formTotal} 条；失败明细见 JSON）`,
        );
      }
    }

    lines.push('');
    return { markdown: lines.join('\n'), commitFiles };
  }
}

// ---------------------------------------------------------------------------
// Attachment download resolution
// ---------------------------------------------------------------------------

/**
 * 解析 +record-download-attachment 的落盘结果。--output 收的是目录，实际
 * 文件名由 lark-cli 决定；按优先级解析：
 *   ① 响应 data.saved_path（或同义 key）→ 必须位于 downloadDir 内
 *   ② downloadDir 里的唯一文件
 *   ③ downloadDir 中与附件名精确匹配的文件
 * 全部失败抛错（调用方软降级）。
 */
function resolveDownloadedFile(downloadDir: string, response: unknown): string {
  const root = unwrapPageRoot(response);
  const reported = readStr(
    root.saved_path ?? root.savedPath ?? root.path ?? root.file_path ?? root.filePath,
  );
  if (reported) {
    const resolved = path.resolve(reported);
    if (isInsideDirectory(downloadDir, resolved) && isNonEmptyFile(resolved)) {
      return resolved;
    }
  }

  const files = listFilesRecursive(downloadDir);
  if (files.length === 1 && isNonEmptyFile(files[0])) return files[0];
  if (reported) {
    const base = path.basename(reported);
    const match = files.find((file) => path.basename(file) === base);
    if (match && isNonEmptyFile(match)) return match;
  }
  throw new Error(`无法定位附件下载产物（目录内文件数: ${files.length}）`);
}

function listFilesRecursive(directory: string): string[] {
  const collected: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) collected.push(full);
    }
  };
  walk(directory);
  return collected.sort();
}

function isNonEmptyFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile() && fs.statSync(candidate).size > 0;
  } catch {
    return false;
  }
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  const canonical = (value: string): string => {
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const relative = path.relative(canonical(directory), canonical(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
