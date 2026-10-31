/**
 * knowledge-compiler — 知识组织编译器（A 案 §3.2 呈现方式 / §6.2 发布布局）
 *
 * 纯函数、无 IO（正文与声明由调用方传入；发布落盘在 kb-build-service）：
 * 1. exact 片段展开（A 案 §3.2）：`{{kb-include:objectId:fragmentKey}}` 独占块
 *    从目标 canonical 主定义展开为完整文本；目标缺失/递归/跨范围错用/目标
 *    修订不匹配/声明与占位不符 → blocking issue（A 案 §7.4 join 编译门禁）；
 *    代码块中的示例语法不展开；片段内链接重定位为宿主文档相对路径；展开后
 *    体量受既有总量限制。
 * 2. 锚点注入（A 案 §2.4）：canonical 章节注入服务端生成的受限
 *    `<a id="ko_…"></a>` 锚点（仅放行该形态）；正文其余 HTML ID 一律剥离
 *    （模型不能注入任意 ID/脚本/替换其他对象锚点）。bodyRange 重算为发布
 *    后坐标（A 案 §7.1：模型提供的行号不直接作为发布位置）。
 * 3. 声明→发布投影（A 案 §6.2）：knowledge-draft.json（staging 形态）→
 *    knowledge.json（KnowledgeManifest：对象/呈现/关系/证据/覆盖/迁移映射）。
 *    canonical 呈现与 restates 关系由登记自动生成（A 案 §6.1「由登记生成」）。
 * 4. 证据资源区段索引投影（evidence-resources.json，A 案 §5.4：正文/CSV 精确
 *    区段 + 资源 hash，不凭 `--- CSV n ---` 位置猜附件身份）。
 *
 * 有名片段约定：canonical 正文内以 HTML 注释标记
 *   `<!-- kb-fragment:key -->` … `<!-- /kb-fragment:key -->`
 * 标记随发布正文保留（渲染不可见；增量构建可再次解析定位同一片段）。
 *
 * hash/revision 语义：payloadHash / reviewSubjectHash / revision 由声明期
 * （T3 kb_write_doc，草稿坐标）计算并原样携带入发布投影——规范化正文剥离
 * 服务端锚点、内部链接归一为目标 ID，草稿与发布正文规范化后一致；exact
 * 宿主对象的展开文本属派生呈现，不回写宿主 payloadHash（A 案 §3.3 由影响
 * 传播处理）。
 */

import { Buffer } from 'node:buffer';
import type {
  BodyRange,
  CoverageItem,
  Evidence,
  KnowledgeManifest,
  KnowledgeManifestDocumentEntry,
  KnowledgeObject,
  KnowledgeRelation,
  ObjectMigration,
  Presentation,
  ValidationIssue,
} from './knowledge-schema.js';
import type { EvidenceResource } from './evidence-locator.js';

// ============================================================================
// 输入/输出契约
// ============================================================================

/** staging 文档（含 feishu_sync_kb 头；头部字节原样保留进发布正文）。 */
export interface CompilerDocInput {
  path: string;
  content: string;
}

/** 知识声明集合（与 agent-tool-service 的 KnowledgeDraftFile 结构兼容；
 * 此处按结构声明，避免 kb 层反向依赖 agent 工具层）。
 * docs[path] 的坐标基准（diting F02）：
 * - basis='draft'（缺省）：声明坐标以 kb_write_doc 的 markdown 参数为基准；
 *   bodyLineOffset = 去头后正文行号 − markdown 参数行号（工具生成 `# title`
 *   并剥离首部空行后由工具侧计算），编译时按该偏移重映射；缺省 0 = 旧式
 *   坐标已与去头正文对齐（T4a 手写 fixture 语义，行为不变）。
 * - basis='published'：从基线 release 复制未改写的托管文档（diting F06）；
 *   声明坐标已是发布坐标，编译直通（不注入锚点/不剥离 HTML/不展开）。 */
export interface KnowledgeDeclarationSet {
  schemaVersion: number;
  buildId: string;
  docs: Record<string, { docId: string; revision: number; bodyLineOffset?: number; basis?: 'draft' | 'published'; carriedHash?: string }>;
  objects: KnowledgeObject[];
  presentations: Presentation[];
  relations: KnowledgeRelation[];
  evidence: Evidence[];
  coverage: CoverageItem[];
}

/** 证据资源 + source-contents 组合串内字节区段（调用方按
 * captureSourceContents 组合式计算；A 案 §5.4）。 */
export interface CompilerEvidenceResource {
  resource: EvidenceResource;
  /** text/csv 资源在 source-contents.json[sourceId] 内的 UTF-8 字节区段 */
  span?: { byteOffset: number; byteLength: number };
}

export interface CompileKnowledgeReleaseInput {
  docs: CompilerDocInput[];
  knowledgeDraft: KnowledgeDeclarationSet;
  /** 证据资源表（正文/CSV；来自快照 readVerified） */
  evidenceResources?: CompilerEvidenceResource[];
  /** 组织计划迁移映射（A 案 §2.4；缺省无迁移） */
  migrations?: ObjectMigration[];
  /** 上一 release 对象 ID 集合（提供时启用「未解释丢失」检查；A 案 §2.4） */
  previousObjectIds?: string[];
  /** 展开后总量上限（字节；与 validateStagingDocs 同式，A 案 §3.2） */
  maxTotalBytes?: number;
  releaseId?: string;
}

export interface CompiledDoc {
  path: string;
  content: string;
}

/** evidence-resources.json（A 案 §5.4/§6.2）：源资源区段索引及必要证据
 * 资源目录。区段归一化规则：source-contents 的 UTF-8 字节偏移，读者先按
 * 区段还原资源再应用 selector。 */
export interface EvidenceResourceIndexEntry {
  resourceId: string;
  sourceId: string;
  sourceSnapshotHash: string;
  kind: 'text' | 'csv' | 'workbook' | 'image';
  resourceHash: string;
  /** text/csv：source-contents.json[sourceId] 内字节区段 */
  byteOffset?: number;
  byteLength?: number;
  /** csv 附件路径标注 */
  path?: string;
}

export interface EvidenceResourcesFile {
  schemaVersion: 1;
  normalization: 'utf8-bytes-in-source-contents';
  resources: EvidenceResourceIndexEntry[];
  /** evidence/ 子目录登记（被引用的工作簿/图片最小充分内容；本阶段声明
   * 面仅正文/CSV，通常为空——管线保留给后续证据类型） */
  evidenceFiles: Array<{ resourceId: string; path: string; hash: string; bytes: number }>;
}

/** governance.json 最小骨架（A 案 §4.2/§6.2）：审查凭据集合引用；人工
 * 业务决定服务（decisions）属后续迭代，本阶段恒为空数组、不阻塞发布。 */
export interface GovernanceFile {
  schemaVersion: 1;
  releaseId: string;
  reviewCredentials: {
    acceptanceId?: string;
    validReportIds: string[];
    candidateHash?: string;
  };
  decisions: [];
}

export interface KnowledgeCompileResult {
  knowledge: KnowledgeManifest;
  compiledDocs: CompiledDoc[];
  issues: ValidationIssue[];
  /** v2 发布的 sidecar 投影（knowledge.json 之外的证据索引） */
  evidenceResources: EvidenceResourcesFile;
}

// ============================================================================
// 解析常量
// ============================================================================

const HEADER_RE = /^<!--\s*\nfeishu_sync_kb:[\s\S]*?\n-->\s*\n?/;
const FRAGMENT_OPEN_RE = /^<!--\s*kb-fragment:([A-Za-z0-9_.-]+)\s*-->$/;
const FRAGMENT_CLOSE_RE = /^<!--\s*\/kb-fragment:([A-Za-z0-9_.-]+)\s*-->$/;
const INCLUDE_RE = /^\{\{kb-include:(ko_[A-Za-z0-9-]+):([A-Za-z0-9_.-]+)\}\}$/;
const INCLUDE_ANY_RE = /\{\{kb-include:[^}\s]*\}\}/;
const HTML_ID_ATTR_RE = /\s+id\s*=\s*(?:"[^"]*"|'[^']*')/g;
const DOC_ID_RE = /^ {2}doc_id:\s*(\S+)\s*$/m;
const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

function issue(
  code: string,
  field: string,
  message: string,
  severity: ValidationIssue['severity'],
  refs?: { objectId?: string; edgeId?: string },
): ValidationIssue {
  return { code, field, message, severity, ...refs };
}

function splitHeader(content: string): { header: string; body: string } {
  const match = HEADER_RE.exec(content);
  return match ? { header: match[0], body: content.slice(match[0].length) } : { header: '', body: content };
}

function docIdOf(content: string): string | null {
  const match = DOC_ID_RE.exec(content);
  return match ? match[1]! : null;
}

/** 代码围栏状态机（diting F07）：记录开栏字符与长度，闭栏须同字符、
 * 不短于开栏且行尾仅空白——四反引号块内的三反引号是内容，不关栏。
 * （与 CommonMark 围栏规则一致；``` 与 ~~~ 独立。） */
export class FenceTracker {
  private open: { marker: string; length: number } | null = null;

  static fenceRunOf(line: string): { run: string; rest: string } | null {
    const match = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    return match ? { run: match[1]!, rest: match[2] ?? '' } : null;
  }

  visit(line: string): void {
    const fence = FenceTracker.fenceRunOf(line);
    if (!fence) return;
    const marker = fence.run[0]!;
    if (this.open) {
      if (marker === this.open.marker && fence.run.length >= this.open.length && /^[ \t]*$/.test(fence.rest)) {
        this.open = null;
      }
      return;
    }
    this.open = { marker, length: fence.run.length };
  }

  get inside(): boolean {
    return this.open !== null;
  }
}

// ============================================================================
// 有名片段解析（canonical 范围内；A 案 §3.2）
// ============================================================================

interface FragmentParse {
  fragments: Map<string, string>;
  issues: ValidationIssue[];
}

function parseFragments(objectId: string, bodyLines: string[], range: BodyRange): FragmentParse {
  const fragments = new Map<string, string>();
  const issues: ValidationIssue[] = [];
  let openKey: string | null = null;
  let openLine = 0;
  let buffer: string[] = [];
  for (let line = range.startLine; line <= range.endLine; line += 1) {
    const text = bodyLines[line - 1] ?? '';
    const closeMatch = FRAGMENT_CLOSE_RE.exec(text);
    if (openKey !== null && closeMatch) {
      if (closeMatch[1] !== openKey) {
        issues.push(issue('kb_include_invalid', 'fragment',
          `片段关闭标记与打开标记不符：期望 /kb-fragment:${openKey}，实际 /kb-fragment:${closeMatch[1]}（对象 ${objectId} 第 ${line} 行）`,
          'blocking', { objectId }));
        openKey = null; buffer = [];
        continue;
      }
      if (fragments.has(openKey)) {
        issues.push(issue('kb_include_invalid', 'fragmentKey',
          `片段键重复定义：${objectId}/${openKey}`, 'blocking', { objectId }));
      } else {
        fragments.set(openKey, buffer.join('\n'));
      }
      openKey = null; buffer = [];
      continue;
    }
    const openMatch = FRAGMENT_OPEN_RE.exec(text);
    if (openMatch) {
      if (openKey !== null) {
        issues.push(issue('kb_include_invalid', 'fragment',
          `片段嵌套定义不被支持（第一阶段）：${objectId} 第 ${openLine} 行未关闭又打开 ${openMatch[1]}`,
          'blocking', { objectId }));
      }
      openKey = openMatch[1]!;
      openLine = line;
      buffer = [];
      continue;
    }
    if (openKey !== null) buffer.push(text);
  }
  if (openKey !== null) {
    issues.push(issue('kb_include_invalid', 'fragment',
      `片段标记未关闭：${objectId}/kb-fragment:${openKey}（第 ${openLine} 行打开，canonical 范围 ${range.startLine}..${range.endLine} 内未闭合）`,
      'blocking', { objectId }));
  }
  return { fragments, issues };
}

// ============================================================================
// 片段内链接重定位（A 案 §3.2：用目标 ID 重定位到宿主文档的相对路径）
// ============================================================================

function posixDir(docPath: string): string {
  const index = docPath.lastIndexOf('/');
  return index === -1 ? '' : docPath.slice(0, index);
}

/** from 目录视角到 to（同为 release 内 posix 相对路径）的相对链接。 */
function relativeLink(fromDir: string, to: string): string {
  let relative = to;
  if (fromDir) {
    const fromParts = fromDir.split('/');
    const toParts = to.split('/');
    let common = 0;
    while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) common += 1;
    const ups = fromParts.length - common;
    const downs = toParts.slice(common).join('/');
    relative = ups === 0 ? downs : `${'../'.repeat(ups)}${downs}`;
  }
  return relative || '.';
}

function isExternalLink(dest: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(dest) || dest.startsWith('/');
}

function relocateLinks(fragment: string, targetDocPath: string, hostDocPath: string): string {
  const targetDir = posixDir(targetDocPath);
  const hostDir = posixDir(hostDocPath);
  return fragment.replace(MD_LINK_RE, (match, label: string, dest: string) => {
    if (isExternalLink(dest)) return match;
    const anchorIndex = dest.indexOf('#');
    const pathPart = anchorIndex === -1 ? dest : dest.slice(0, anchorIndex);
    const anchor = anchorIndex === -1 ? '' : dest.slice(anchorIndex);
    const looksMarkdown = pathPart === '' || /\.md$/i.test(pathPart) || /\.md#/i.test(dest);
    if (!looksMarkdown) return match;
    if (pathPart === '') {
      // 裸锚（#ko_x）：目标文档内的锚 → 宿主视角相对链接
      return `[${label}](${relativeLink(hostDir, targetDocPath)}${anchor})`;
    }
    const resolved = path.posixNormalize(targetDir, pathPart);
    return `[${label}](${relativeLink(hostDir, resolved)}${anchor})`;
  });
}

// path.posix 封装（保持本模块无 node:path 依赖以外的一致行为）
const path = {
  posixNormalize(dir: string, rel: string): string {
    const base = dir ? `${dir}/${rel}` : rel;
    const parts: string[] = [];
    for (const segment of base.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') parts.pop();
      else parts.push(segment);
    }
    return parts.join('/');
  },
};

// ============================================================================
// 单文档编译（锚点注入 + ID 剥离 + include 展开 + 坐标映射）
// ============================================================================

interface DocCompilePlan {
  path: string;
  header: string;
  bodyLines: string[];
  /** 原行 index（0 基）→ 生成行起点（0 基） */
  mapStart: number[];
  /** 原行 index → 生成行数（展开 >1） */
  span: number[];
  /** 对象 → 锚点行（0 基；发布 bodyRange.startLine = anchorLine + 1） */
  anchorLines: Map<string, number>;
  /** 占位符原行 index → 展开范围（发布 body 坐标，1 基闭区间） */
  expansions: Map<string, BodyRange>;
  /** 声明坐标基准（diting F02/F06）：draft = 按 lineOffset 重映射；
   * published = 基线复制文档，直通保留发布坐标。 */
  basis: 'draft' | 'published';
  /** draft 基准的行号偏移：去头后正文行号 = 声明行号 + lineOffset */
  lineOffset: number;
  output: string[];
}

export interface CompileContext {
  objectsById: Map<string, KnowledgeObject>;
  fragmentsByObject: Map<string, Map<string, string>>;
  /** 精确呈现索引：宿主文档路径 → exact 呈现列表 */
  exactByDoc: Map<string, Presentation[]>;
  issues: ValidationIssue[];
}

function remapRange(doc: DocCompilePlan, range: BodyRange): BodyRange {
  const startIndex = Math.min(Math.max(range.startLine - 1, 0), doc.mapStart.length - 1);
  const endIndex = Math.min(Math.max(range.endLine - 1, 0), doc.span.length - 1);
  const startLine = doc.mapStart[startIndex]! + 1;
  const endLine = doc.mapStart[endIndex]! + doc.span[endIndex]!;
  return { startLine, endLine: Math.max(endLine, startLine) };
}

/** diting F02：声明坐标（markdown 参数基准）→ 去头后正文坐标的统一平移。 */
function shiftRange(range: BodyRange, offset: number): BodyRange {
  return { startLine: range.startLine + offset, endLine: range.endLine + offset };
}

function expandInclude(
  context: CompileContext,
  plan: DocCompilePlan,
  presentation: Presentation,
  targetId: string,
  fragmentKey: string,
  objectId: string,
): string[] {
  const emit = (code: string, message: string, severity: ValidationIssue['severity'] = 'blocking'): void => {
    context.issues.push(issue(code, 'targetObjectId', message, severity, { objectId }));
  };
  const target = context.objectsById.get(targetId);
  if (!target || target.tombstone || !target.canonical) {
    emit('kb_include_invalid', `exact 片段目标缺失或不是活跃 canonical 主定义：${targetId}/${fragmentKey}`);
    return [];
  }
  if (typeof presentation.targetRevision === 'number' && presentation.targetRevision !== target.revision) {
    emit('kb_restatement_stale',
      `exact 片段绑定的目标 revision(${presentation.targetRevision}) 与当前 revision(${target.revision}) 不匹配（字节级校验失败）：${objectId} → ${targetId}/${fragmentKey}`);
    return [];
  }
  const owner = context.objectsById.get(objectId);
  if (owner && owner.scopeKey !== target.scopeKey) {
    emit('kb_include_invalid',
      `exact 片段跨范围错用：宿主 ${objectId}（scope=${owner.scopeKey}）≠ 目标 ${targetId}（scope=${target.scopeKey}）；一致复制一个不适用的公式仍是错误（A 案 §3.2）`);
    return [];
  }
  const fragment = context.fragmentsByObject.get(targetId)?.get(fragmentKey);
  if (fragment === undefined) {
    emit('kb_include_invalid', `exact 片段在目标 canonical 内不存在：${targetId}/${fragmentKey}`);
    return [];
  }
  const fragmentLines = fragment.split('\n');
  for (const line of fragmentLines) {
    if (INCLUDE_RE.test(line)) {
      emit('kb_include_invalid', `exact 片段递归 include（第一阶段不允许）：${targetId}/${fragmentKey} 内含占位符「${line.trim()}」`);
      return [];
    }
  }
  const relocated = relocateLinks(fragment, target.canonical.path, plan.path);
  return relocated.length === 0 ? [] : relocated.split('\n');
}

function compileDoc(context: CompileContext, doc: CompilerDocInput, anchors: Array<{ objectId: string; startLine: number }>, basis: { mode: 'draft' | 'published'; lineOffset: number }): DocCompilePlan {
  const { header, body } = splitHeader(doc.content);
  const bodyLines = body.split('\n');
  const plan: DocCompilePlan = {
    path: doc.path, header, bodyLines,
    mapStart: [], span: [], anchorLines: new Map(), expansions: new Map(), output: [],
    basis: basis.mode, lineOffset: basis.lineOffset,
  };
  if (basis.mode === 'published') {
    // diting F06：基线复制的托管文档——发布产物原样，坐标恒等映射，
    // 不注入锚点、不剥离 HTML、不展开占位符（发布正文无协议语法）。
    for (let index = 0; index < bodyLines.length; index += 1) {
      plan.mapStart.push(index);
      plan.span.push(1);
      plan.output.push(bodyLines[index]!);
    }
    return plan;
  }
  // 同一原行可有多个对象起点（理论上对象范围不交叠；防御性按 objectId 排序稳定注入）
  const anchorsByLine = new Map<number, string[]>();
  for (const anchor of anchors) {
    const key = Math.min(Math.max(anchor.startLine - 1, 0), Math.max(bodyLines.length - 1, 0));
    const list = anchorsByLine.get(key) ?? [];
    list.push(anchor.objectId);
    anchorsByLine.set(key, list);
  }
  for (const [, list] of anchorsByLine) list.sort();

  const exactPresentations = context.exactByDoc.get(doc.path) ?? [];
  const usedPresentations = new Set<string>();
  const fence = new FenceTracker();
  // 每对 (targetId, fragmentKey) 在同一文档内只允许一个占位符/一条声明
  const seenIncludeKeys = new Set<string>();

  for (let index = 0; index < bodyLines.length; index += 1) {
    const raw = bodyLines[index]!;
    for (const objectId of anchorsByLine.get(index) ?? []) {
      plan.anchorLines.set(objectId, plan.output.length);
      plan.output.push(`<a id="${objectId}"></a>`);
    }
    plan.mapStart.push(plan.output.length);
    if (fence.inside) {
      // 代码块内：示例语法不展开、HTML 示例原样保留（A 案 §3.2）
      fence.visit(raw);
      plan.output.push(raw);
      plan.span.push(1);
      continue;
    }
    const includeMatch = INCLUDE_RE.exec(raw.trim());
    if (includeMatch && raw.trim() === raw) {
      const [, targetId, fragmentKey] = includeMatch;
      const includeKey = `${targetId}:${fragmentKey}`;
      if (seenIncludeKeys.has(includeKey)) {
        context.issues.push(issue('kb_include_invalid', 'fragmentKey',
          `同一文档内重复占位同一片段：${doc.path} 第 ${index + 1} 行（${includeKey}）`, 'blocking'));
        plan.output.push(raw); plan.span.push(1);
        continue;
      }
      seenIncludeKeys.add(includeKey);
      const candidates = exactPresentations.filter(
        (presentation) => presentation.kind === 'exact' && presentation.targetObjectId === targetId && presentation.fragmentKey === fragmentKey);
      if (candidates.length === 0) {
        context.issues.push(issue('kb_include_invalid', 'targetObjectId',
          `占位符未登记对应 exact 呈现：${doc.path} 第 ${index + 1} 行（${includeKey}；受控片段引用只存在于草稿协议，必须先声明）`, 'blocking'));
        plan.output.push(raw); plan.span.push(1);
        continue;
      }
      if (candidates.length > 1) {
        context.issues.push(issue('kb_include_invalid', 'fragmentKey',
          `同一片段占位匹配多条 exact 声明（多定义）：${doc.path} 第 ${index + 1} 行（${includeKey}）`, 'blocking'));
        plan.output.push(raw); plan.span.push(1);
        continue;
      }
      const presentation = candidates[0]!;
      usedPresentations.add(presentation.presentationId);
      const owner = context.objectsById.get(presentation.ownerObjectId);
      if (!owner || owner.canonical?.path !== doc.path) {
        context.issues.push(issue('kb_include_invalid', 'ownerObjectId',
          `占位符不在宿主对象 canonical 文档内：${doc.path} 第 ${index + 1} 行（宿主 ${presentation.ownerObjectId}）`, 'blocking'));
        plan.output.push(raw); plan.span.push(1);
        continue;
      }
      const expanded = expandInclude(context, plan, presentation, targetId, fragmentKey!, presentation.ownerObjectId);
      if (expanded.length === 0) {
        plan.output.push(raw); plan.span.push(1);
        continue;
      }
      plan.expansions.set(presentation.presentationId, {
        startLine: plan.mapStart[index]! + 1,
        endLine: plan.mapStart[index]! + expanded.length,
      });
      plan.output.push(...expanded);
      plan.span.push(expanded.length);
      continue;
    }
    // 独占块 = 整行恰为占位符（无缩进/无其余文字）；其余出现按协议残留提示警告
    if (INCLUDE_ANY_RE.test(raw)) {
      context.issues.push(issue('kb_include_invalid', 'body',
        `片段占位未按独占块书写，不展开（发布正文不得残留协议语法）：${doc.path} 第 ${index + 1} 行`, 'warning'));
    }
    fence.visit(raw);
    // 剥离模型注入的 HTML ID（仅放行服务端锚点形态——本行注入的锚点之外一律剥离，A 案 §2.4）
    plan.output.push(raw.replace(HTML_ID_ATTR_RE, ''));
    plan.span.push(1);
  }
  // 声明了 exact 却无独占占位符 → 声明与正文不符
  for (const presentation of exactPresentations) {
    if (!usedPresentations.has(presentation.presentationId)) {
      context.issues.push(issue('kb_include_invalid', 'bodyRange',
        `exact 呈现声明在宿主正文无对应独占占位符：${presentation.presentationId}（宿主 ${presentation.ownerObjectId}，文档 ${doc.path}）`,
        'blocking', { objectId: presentation.ownerObjectId }));
    }
  }
  return plan;
}

// ============================================================================
// compileKnowledgeRelease 主流程
// ============================================================================

export function compileKnowledgeRelease(input: CompileKnowledgeReleaseInput): KnowledgeCompileResult {
  const issues: ValidationIssue[] = [];
  const docsByPath = new Map<string, CompilerDocInput>();
  for (const doc of input.docs) {
    if (docsByPath.has(doc.path)) {
      issues.push(issue('kb_canonical_missing', 'path', `发布文档路径重复：${doc.path}`, 'blocking'));
      continue;
    }
    docsByPath.set(doc.path, doc);
  }

  // diting F02/F06：逐文档坐标基准。draft：声明坐标以 markdown 参数为基准，
  // lineOffset 由 kb_write_doc 计算存入草稿（缺省 0 = 旧式 fixture 语义）；
  // published：基线复制文档直通，声明坐标已是发布坐标。
  const basisOf = (docPath: string): { mode: 'draft' | 'published'; lineOffset: number } => {
    const entry = input.knowledgeDraft.docs[docPath];
    if (entry?.basis === 'published') return { mode: 'published', lineOffset: 0 };
    return { mode: 'draft', lineOffset: entry?.bodyLineOffset ?? 0 };
  };

  const objectsById = new Map(input.knowledgeDraft.objects.map((object) => [object.objectId, object] as const));

  // ---- 片段解析（声明坐标按基准换算到去头后正文；canonical 文档缺失在编译期直接 blocking）----
  const fragmentsByObject = new Map<string, Map<string, string>>();
  for (const object of input.knowledgeDraft.objects) {
    if (object.tombstone || !object.canonical) continue;
    const doc = docsByPath.get(object.canonical.path);
    if (!doc) {
      issues.push(issue('kb_canonical_missing', 'canonical.path',
        `对象 canonical 文档不在发布清单内：${object.objectId} → ${object.canonical.path}`, 'blocking', { objectId: object.objectId }));
      continue;
    }
    const basis = basisOf(object.canonical.path);
    const { body } = splitHeader(doc.content);
    const range = basis.mode === 'draft' ? shiftRange(object.canonical.bodyRange, basis.lineOffset) : object.canonical.bodyRange;
    const parsed = parseFragments(object.objectId, body.split('\n'), range);
    fragmentsByObject.set(object.objectId, parsed.fragments);
    issues.push(...parsed.issues);
  }

  // ---- exact 呈现按宿主文档分组（占位符只认宿主 canonical 文档）----
  const exactByDoc = new Map<string, Presentation[]>();
  for (const presentation of input.knowledgeDraft.presentations) {
    if (presentation.kind !== 'exact') continue;
    const owner = objectsById.get(presentation.ownerObjectId);
    const ownerPath = owner?.canonical?.path;
    if (!ownerPath) {
      issues.push(issue('kb_include_invalid', 'ownerObjectId',
        `exact 呈现宿主无 canonical 位置：${presentation.presentationId}`, 'blocking', { objectId: presentation.ownerObjectId }));
      continue;
    }
    const list = exactByDoc.get(ownerPath) ?? [];
    list.push(presentation);
    exactByDoc.set(ownerPath, list);
  }

  const context: CompileContext = { objectsById, fragmentsByObject, exactByDoc, issues };

  // ---- 逐文档编译（锚点注入 + ID 剥离 + 展开 + 坐标映射）----
  const plans = new Map<string, DocCompilePlan>();
  for (const [docPath, doc] of docsByPath) {
    const basis = basisOf(docPath);
    const anchors = input.knowledgeDraft.objects
      .filter((object) => !object.tombstone && object.canonical && object.canonical.path === docPath)
      .map((object) => ({
        objectId: object.objectId,
        // diting F02：声明坐标换算到去头后正文坐标（published 基准恒等）
        startLine: basis.mode === 'draft' ? object.canonical!.bodyRange.startLine + basis.lineOffset : object.canonical!.bodyRange.startLine,
      }));
    plans.set(docPath, compileDoc(context, doc, anchors, basis));
  }

  // ---- 声明→发布投影 ----
  const documents: KnowledgeManifestDocumentEntry[] = [];
  const docPathSet = new Set<string>();
  for (const doc of input.docs) {
    if (docPathSet.has(doc.path)) continue;
    docPathSet.add(doc.path);
    const docId = input.knowledgeDraft.docs[doc.path]?.docId ?? docIdOf(doc.content);
    if (!docId) {
      issues.push(issue('kb_canonical_missing', 'docId', `发布文档缺少 doc_id：${doc.path}`, 'blocking'));
      continue;
    }
    documents.push({ docId, path: doc.path });
  }

  const objects: KnowledgeObject[] = input.knowledgeDraft.objects.map((object) => {
    if (object.tombstone || !object.canonical) return object;
    const plan = plans.get(object.canonical.path);
    const basis = object.canonical ? basisOf(object.canonical.path) : null;
    const declaredEnd = basis && basis.mode === 'draft'
      ? object.canonical.bodyRange.endLine + basis.lineOffset
      : object.canonical.bodyRange.endLine;
    const anchorLine = plan?.anchorLines.get(object.objectId);
    const publishedRange = plan
      ? {
        startLine: anchorLine !== undefined ? anchorLine + 1 : object.canonical.bodyRange.startLine,
        endLine: plan.mapStart.length > 0
          ? plan.mapStart[Math.min(declaredEnd - 1, plan.mapStart.length - 1)]!
            + plan.span[Math.min(declaredEnd - 1, plan.span.length - 1)]!
          : object.canonical.bodyRange.endLine,
      }
      : object.canonical.bodyRange;
    const claims = plan
      ? object.claims.map((claim) => ({
        ...claim,
        bodyRange: remapRange(plan, basis && basis.mode === 'draft' ? shiftRange(claim.bodyRange, basis.lineOffset) : claim.bodyRange),
      }))
      : object.claims;
    return { ...object, claims, canonical: { ...object.canonical, bodyRange: publishedRange } };
  });

  const publishedObjectsById = new Map(objects.map((object) => [object.objectId, object] as const));
  const presentations: Presentation[] = [];
  for (const presentation of input.knowledgeDraft.presentations) {
    const owner = publishedObjectsById.get(presentation.ownerObjectId);
    const ownerPlan = owner?.canonical ? plans.get(owner.canonical.path) : undefined;
    const ownerBasis = owner?.canonical ? basisOf(owner.canonical.path) : null;
    let published = presentation;
    if (presentation.kind === 'exact' && ownerPlan) {
      const expansion = ownerPlan.expansions.get(presentation.presentationId);
      published = expansion ? { ...presentation, bodyRange: expansion } : presentation;
    } else if (presentation.bodyRange && ownerPlan) {
      const shifted = ownerBasis && ownerBasis.mode === 'draft'
        ? shiftRange(presentation.bodyRange, ownerBasis.lineOffset)
        : presentation.bodyRange;
      published = { ...presentation, bodyRange: remapRange(ownerPlan, shifted) };
    }
    presentations.push(published);
  }
  // canonical 呈现（导航登记）：每个活跃对象恰一条，由登记自动生成（A 案 §6.1/§3.2）
  for (const object of objects) {
    if (object.tombstone || !object.canonical) continue;
    presentations.push({
      presentationId: `kp_canon_${object.objectId}`,
      ownerObjectId: object.objectId,
      kind: 'canonical',
      targetObjectId: object.objectId,
      bodyRange: object.canonical.bodyRange,
    });
  }

  const relations: KnowledgeRelation[] = [...input.knowledgeDraft.relations];
  // restates：由 summary/exact 呈现登记自动生成（A 案 §6.1；校验器核对多定义）
  const declaredRestates = new Set(input.knowledgeDraft.relations
    .filter((relation) => relation.type === 'restates')
    .map((relation) => `${relation.fromObjectId}\u0000${relation.toObjectId}`));
  for (const presentation of presentations) {
    if (presentation.kind !== 'summary' && presentation.kind !== 'exact') continue;
    if (!presentation.targetObjectId) continue;
    const key = `${presentation.ownerObjectId}\u0000${presentation.targetObjectId}`;
    if (declaredRestates.has(key)) continue;
    declaredRestates.add(key);
    const owner = publishedObjectsById.get(presentation.ownerObjectId);
    relations.push({
      edgeId: `ke_restate_${presentation.presentationId}`,
      fromObjectId: presentation.ownerObjectId,
      toObjectId: presentation.targetObjectId,
      type: 'restates',
      scopeKey: owner?.scopeKey ?? '',
      evidenceIds: [],
    });
  }

  const knowledge: KnowledgeManifest = {
    schemaVersion: 1,
    ...(input.releaseId ? { releaseId: input.releaseId } : {}),
    documents,
    objects,
    presentations,
    relations,
    evidence: input.knowledgeDraft.evidence,
    coverage: input.knowledgeDraft.coverage,
    migrations: input.migrations ?? [],
    ...(input.previousObjectIds ? { previousObjectIds: input.previousObjectIds } : {}),
  };

  // ---- 证据资源区段索引（A 案 §5.4）----
  const evidenceResources: EvidenceResourcesFile = {
    schemaVersion: 1,
    normalization: 'utf8-bytes-in-source-contents',
    resources: [],
    evidenceFiles: [],
  };
  const resourcesById = new Map((input.evidenceResources ?? []).map((entry) => [entry.resource.resourceId, entry] as const));
  for (const evidence of knowledge.evidence) {
    if (evidenceResources.resources.some((entry) => entry.resourceId === evidence.sourceRef.resourceId)) continue;
    const entry = resourcesById.get(evidence.sourceRef.resourceId);
    if (!entry) {
      issues.push(issue('kb_evidence_unresolved', 'sourceRef.resourceId',
        `证据引用的资源不在本构建资源表：${evidence.evidenceId} → ${evidence.sourceRef.resourceId}`,
        'blocking', { objectId: evidence.objectId }));
      continue;
    }
    const { resource, span } = entry;
    evidenceResources.resources.push({
      resourceId: resource.resourceId,
      sourceId: resource.sourceId,
      sourceSnapshotHash: resource.sourceSnapshotHash,
      kind: resource.kind,
      resourceHash: resource.resourceHash,
      ...(resource.kind === 'csv' && 'path' in resource && resource.path ? { path: resource.path } : {}),
      ...(span ? { byteOffset: span.byteOffset, byteLength: span.byteLength } : {}),
    });
  }
  evidenceResources.resources.sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0));

  // ---- 展开后总量限制（A 案 §3.2：受既有总量限制约束）----
  if (typeof input.maxTotalBytes === 'number' && input.maxTotalBytes > 0) {
    const compiledDocs = [...plans.values()].map((plan) => ({ path: plan.path, content: plan.header + plan.output.join('\n') }));
    const totalBytes = compiledDocs.reduce((sum, doc) => sum + Buffer.byteLength(splitHeader(doc.content).body, 'utf8'), 0);
    if (totalBytes > input.maxTotalBytes) {
      issues.push(issue('total_too_large', 'docs',
        `展开后产出正文 ${totalBytes} 字节超过上限 ${input.maxTotalBytes} 字节（exact 展开不得放大体量预算）`, 'blocking'));
    }
  }

  const compiledDocs: CompiledDoc[] = input.docs
    .filter((doc) => plans.has(doc.path))
    .map((doc) => {
      const plan = plans.get(doc.path)!;
      return { path: doc.path, content: plan.header + plan.output.join('\n') };
    });

  return { knowledge, compiledDocs, issues, evidenceResources };
}
