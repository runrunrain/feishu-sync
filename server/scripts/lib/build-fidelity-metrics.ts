/** 构建保真评测（S4）——黄金断言集 vs 构建产物文档的确定性指标。
 *
 * 设计边界（docs/design/build-fidelity-eval.md）：
 * - 纯函数、无 IO、无模型调用。匹配规则只有两类：规范化后子串包含、
 *   数值集合包含（千分位/百分号/单位剥离）。改写是否偷换原意等语义
 *   等价性问题不在本模块职责内，由审查流水线与人工承担。
 * - 「冲突并列」的确定性代理 = 断言己方期望与冲突各方文本均在产物中出现；
 *   无法判定是否真的「并排呈现而非互相矛盾」，该局限如实写进文档。
 * - factFidelity / omissionRate 同分母互补但不互为 1−x：部分丢失
 *   （数值集只命中一半）计 factFidelity 失分但不计 omission；整条断言
 *   无任何命中才计 omission。分母为空时返回 null，null 不是 0。
 * - 黄金集加载校验沿用 kb-eval-io 的口径：坏行带 `file:line` 报错、
 *   重复 id / 缺字段 / 混合 provenance 一律拒绝，绝不静默缩水分母。
 */
import fs from 'node:fs';

export type AssertionKind = 'text' | 'number' | 'condition';

export interface GoldenProvenance {
  kind: 'synthetic' | 'human';
  source: string;
  annotator?: string;
  reference?: string;
}

export interface ConflictSide {
  /** 冲突另一方的源对象标识（虚构 objToken 或源路径）。 */
  objToken: string;
  /** 该方在产物中应被保真呈现的原文片段（规范化后子串匹配）。 */
  text: string;
}

export interface GoldenAssertion {
  id: string;
  /** 断言应出现的构建产物文档路径（正斜杠相对路径）。 */
  docPath: string;
  kind: AssertionKind;
  /** 源位置：该断言来自哪个源对象；quote 为可选源原文锚点，仅作人工核对，不参与匹配。 */
  source: { objToken: string; quote?: string };
  expected: {
    /** kind=text|condition：期望被保真表达的事实片段。 */
    text?: string;
    /** kind=number：期望全部出现的数值集合（千分位/百分号归一后比较）。 */
    numbers?: number[];
    /** kind=condition：条件限定词（仅当/不得/超过…），须与 text 同句共现。 */
    conditionTerm?: string;
  };
  /** 可选：期望的冲突并列。sides 为冲突的其它各方（己方即 expected.text）。 */
  conflict?: { sides: ConflictSide[] };
  provenance: GoldenProvenance;
}

/** 确定性文本规范化：NFKC（全角→半角等）、小写、去空白、
 * 直引号弯引号归一、剥离 markdown 强调/标题/引用装饰字符。
 * 有意不去标点：标点参与子串匹配，避免「仅当…时」被空匹配误判命中。 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[“”«»『』「」]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[*_`~#>|]/g, '');
}

/** 数值抽取：千分位分组优先（含前导符号，符号与分组整体归一），其次
 * 普通整数/小数；百分号与单位不参与（"200%"→200，"1,500 星尘"→1500）。
 * 符号只在紧贴数字时计入，因此 skill-1001 类标识符会抽成 -1001——
 * 数值断言需要锚定上下文时应配合 text 断言使用（见 docs 表格）。 */
const THOUSAND_GROUP = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?/g;
const PLAIN_NUMBER = /-?\d+(?:\.\d+)?/g;
export function extractNumbers(text: string): number[] {
  const raw = text.replace(THOUSAND_GROUP, (m) => `\u0000${m.replace(/,/g, '')}\u0000`);
  const values: number[] = [];
  for (const part of raw.split('\u0000')) {
    if (part === '') continue;
    if (/^-?\d+(?:\.\d+)?$/.test(part)) values.push(Number.parseFloat(part));
    else for (const m of part.matchAll(PLAIN_NUMBER)) values.push(Number.parseFloat(m[0]));
  }
  return values;
}

/** 句切分（条件共现的单位）：按中英文句终符与换行切，再各自规范化。 */
export function splitSentences(text: string): string[] {
  return text.split(/[。！？!?；;\n]+/).map(normalizeText).filter(Boolean);
}

export interface FidelityRow {
  id: string;
  docPath: string;
  kind: AssertionKind;
  docMissing: boolean;
  /** 期望元素命中率 0..1；preserved = coverage === 1。 */
  coverage: number;
  preserved: boolean;
  /** 整条断言零命中（含产物文档缺失）才计 omitted。 */
  omitted: boolean;
  conflictExpected: boolean;
  conflictCorrect: boolean | null;
  /** 未命中期望元素的人类可读描述，按断言内声明顺序输出。 */
  missing: string[];
}

export interface FidelityMetrics {
  assertions: number;
  factFidelity: number | null;
  omissionRate: number | null;
  conflictHandlingCorrectness: number | null;
}

export interface FidelityReport {
  metrics: FidelityMetrics;
  rows: FidelityRow[];
  /** 黄金集引用但产物未提供的文档路径（其断言按零命中计 omitted）。 */
  missingDocs: string[];
}

interface Element { label: string; matched: boolean }

function assertionElements(assertion: GoldenAssertion, rawDoc: string | undefined): Element[] {
  const norm = normalizeText(rawDoc ?? '');
  const sentences = splitSentences(rawDoc ?? '');
  const docNumbers = extractNumbers(rawDoc ?? '');
  const els: Element[] = [];
  if (assertion.kind === 'text') {
    const needle = normalizeText(assertion.expected.text ?? '');
    els.push({ label: `text:"${assertion.expected.text}"`, matched: !!needle && norm.includes(needle) });
  } else if (assertion.kind === 'number') {
    for (const n of assertion.expected.numbers ?? []) {
      els.push({ label: `number:${n}`, matched: docNumbers.includes(n) });
    }
  } else {
    const fact = normalizeText(assertion.expected.text ?? '');
    const term = normalizeText(assertion.expected.conditionTerm ?? '');
    els.push({
      label: `condition:"${assertion.expected.conditionTerm}"+"${assertion.expected.text}"`,
      matched: !!fact && !!term && sentences.some((s) => s.includes(fact) && s.includes(term)),
    });
  }
  for (const side of assertion.conflict?.sides ?? []) {
    const needle = normalizeText(side.text);
    els.push({ label: `conflict[${side.objToken}:"${side.text}"]`, matched: !!needle && norm.includes(needle) });
  }
  return els;
}

export function evaluateFidelity(assertions: readonly GoldenAssertion[], docs: ReadonlyMap<string, string>): FidelityReport {
  const rows: FidelityRow[] = [];
  const missingDocs = new Set<string>();
  for (const assertion of assertions) {
    const rawDoc = docs.get(assertion.docPath);
    if (rawDoc === undefined) missingDocs.add(assertion.docPath);
    const elements = assertionElements(assertion, rawDoc);
    const missing = elements.filter((el) => !el.matched).map((el) => el.label);
    const coverage = elements.length ? (elements.length - missing.length) / elements.length : 0;
    const conflictExpected = !!assertion.conflict?.sides.length;
    rows.push({
      id: assertion.id, docPath: assertion.docPath, kind: assertion.kind, docMissing: rawDoc === undefined,
      coverage, preserved: elements.length > 0 && missing.length === 0, omitted: elements.length > 0 && missing.length === elements.length,
      conflictExpected,
      conflictCorrect: conflictExpected ? missing.length === 0 : null,
      missing,
    });
  }
  const total = rows.length;
  const preserved = rows.filter((row) => row.preserved).length;
  const omitted = rows.filter((row) => row.omitted).length;
  const conflictRows = rows.filter((row) => row.conflictExpected);
  return {
    metrics: {
      assertions: total,
      factFidelity: total ? preserved / total : null,
      omissionRate: total ? omitted / total : null,
      conflictHandlingCorrectness: conflictRows.length ? conflictRows.filter((row) => row.conflictCorrect).length / conflictRows.length : null,
    },
    rows,
    missingDocs: [...missingDocs],
  };
}

/** 黄金集 JSONL 解析与校验（纯函数，读文件由调用方负责；坏行报 `label:line`）。
 * 拒绝：非对象行、id 空/重复、docPath/source.objToken 空、kind 非法、
 * 各 kind 期望字段缺失或类型不符、冲突 sides 空或含空字段、
 * provenance 缺失或非法、human 缺 annotator+reference、
 * 合成与人工标注混在同一文件（真实/合成严格分开）、空集。 */
export function parseGoldenSet(text: string, label = 'golden.jsonl'): GoldenAssertion[] {
  const assertions: GoldenAssertion[] = [];
  const ids = new Set<string>();
  const provenanceKinds = new Set<string>();
  for (const [i, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line) as GoldenAssertion;
      if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('invalid_assertion: not an object');
      if (typeof a.id !== 'string' || !a.id || ids.has(a.id)) throw new Error('invalid_or_duplicate_id');
      if (typeof a.docPath !== 'string' || !a.docPath || !a.docPath.endsWith('.md')) throw new Error('invalid_docPath');
      if (!['text', 'number', 'condition'].includes(a.kind)) throw new Error('invalid_kind');
      if (!a.source || typeof a.source.objToken !== 'string' || !a.source.objToken) throw new Error('invalid_source');
      if (a.source.quote !== undefined && typeof a.source.quote !== 'string') throw new Error('invalid_source_quote');
      const e = a.expected ?? {};
      if (a.kind === 'text' && (typeof e.text !== 'string' || !e.text.trim())) throw new Error('text_assertion_requires_expected_text');
      if (a.kind === 'number' && (!Array.isArray(e.numbers) || !e.numbers.length || !e.numbers.every((n) => typeof n === 'number' && Number.isFinite(n)))) {
        throw new Error('number_assertion_requires_finite_numbers');
      }
      if (a.kind === 'condition' && (typeof e.text !== 'string' || !e.text.trim() || typeof e.conditionTerm !== 'string' || !e.conditionTerm.trim())) {
        throw new Error('condition_assertion_requires_text_and_conditionTerm');
      }
      if (a.conflict !== undefined) {
        if (!a.conflict || !Array.isArray(a.conflict.sides) || !a.conflict.sides.length ||
          !a.conflict.sides.every((s) => s && typeof s.objToken === 'string' && !!s.objToken && typeof s.text === 'string' && !!s.text.trim())) {
          throw new Error('invalid_conflict_sides');
        }
      }
      const p = a.provenance;
      if (!p || !['synthetic', 'human'].includes(p.kind) || typeof p.source !== 'string' || !p.source.trim()) throw new Error('provenance_required');
      if (p.kind === 'human' && (!p.annotator?.trim() || !p.reference?.trim())) throw new Error('human_provenance_required: annotator and reference');
      ids.add(a.id);
      provenanceKinds.add(p.kind);
      assertions.push(a);
    } catch (error) {
      throw new Error(`${label}:${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!assertions.length) throw new Error('empty_golden_set');
  if (provenanceKinds.size > 1) throw new Error('mixed_provenance: synthetic and human assertions must live in separate files');
  return assertions;
}

export function readGoldenSetFile(file: string): GoldenAssertion[] {
  return parseGoldenSet(fs.readFileSync(file, 'utf8'), file);
}
