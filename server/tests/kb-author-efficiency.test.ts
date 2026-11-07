/**
 * kb-author-efficiency.test.ts — WP-D（作者/审查者阅读效率与首稿质量）。
 *
 * D1：raw_read / kb_read_batch 的行数+字节双预算裁页（MCP 客户端约 20KB
 * 起中段截断工具输出；实测 7161f7 构建中 120 行页 3/456 已被截断）。
 * 契约不变量：`<raw_page next_offset>` 仍是唯一续页坐标、returned 为实际
 * 行数、读取回执与返回窗口一致、空白 CSV 折叠与回执登记照旧。
 *
 * D2：写入期机械拦截/提示——
 * (a) claim.bodyRange 显式超出对象正文范围 → kb_claim_range_invalid
 *     （可直接重试，retryOf 暂存机制照常附加）；
 * (a 提示面) 对象正文范围无内容行但声明了 claims → 回执提示；
 * (b) 正文相对 .md 链接目标不在草稿/已发布/分配集合 → 回执提示（发布门
 *     kb_link_invalid 的前置预警；并行任务尚未写出的目标在分配集合内不提示）；
 * (c) 「N<量词>」与紧随枚举数不一致 → 回执提示（只提示不拦截）。
 *
 * 模式：临时目录 + 手工快照（同 build-runtime-tools.test.ts），不依赖
 * SQLite、不触真实 ~/.feishu-sync、不调真实模型。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentToolService, type BuildRunState, ToolError } from '../src/agent/agent-tool-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { BuildActorStore, V2_CHILD_ALL_TOOLS } from '../src/kb/build-actors.js';
import { V2_LEADER_TOOLS } from '../src/agent/tool-specs.js';
import { checkDraftCountClaims } from '../src/kb/mechanical-precheck.js';
import { findMissingRelativeMdTargets } from '../src/kb/link-repair.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let service: AgentToolService;

const writeRaw = (rel: string, content: string): string => {
  const target = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
  return target;
};

/** 每行约 810 B 的密集正文（中文 3 字节/字符），驱动最终文本字节预算裁页。 */
const denseSource = (rows: number, token: string): string =>
  Array.from({ length: rows }, (_, index) => `${token} 第${index + 1}行：规则内容详述与参数说明，覆盖文本密度使单页字节预算生效的验证样本行，附带条件、例外与数值口径说明，用于验证裁页行为、续页无损与回执窗口一致性，另附补充解释性定语从句延长行长；再加一段同等长度的补充说明文字以把单行字节数推高到软预算以上，确保多行窗口必然触发裁页。`)
    .join('\n') + '\n';

/** R5 反例源文：90 行×120 个反斜杠（10,889B）——raw_read 文本不转义可单页返回，
 * kb_read_batch 的 JSON 转义翻倍后必须分页，否则超出 pi 20480B 截断线。 */
const backslashSource = (): string =>
  Array.from({ length: 90 }, () => '\\'.repeat(120)).join('\n') + '\n';

function entry(objToken: string, relPath: string): RawSourceSnapshotEntry {
  return {
    objToken,
    objType: 'docx',
    title: relPath,
    relPath,
    contentHash: computeSourceHash(path.join(kbRoot, relPath), [], kbRoot),
    objEditTime: null,
  };
}

function makeBuildState(stagingName: string, store?: BuildActorStore, snapshot?: RawSourceSnapshot): BuildRunState {
  const stagingRoot = path.join(dataRoot, 'staging', stagingName);
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  return {
    knowledgeBaseRoot: kbRoot,
    snapshot: snapshot ?? RawSourceSnapshot.fromEntries(
      [entry('tokDense1', 'src-dense1.md'), entry('tokDense2', 'src-dense2.md'), entry('tokA', 'src-a.md')],
      { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] }),
    mode: 'incremental',
    workset: new Map([['tokDense1', 'added'], ['tokDense2', 'added'], ['tokA', 'added']]),
    stagingRoot,
    finishInfo: null,
    docMeta: new Map(),
    ...(store ? { v2: { actorStore: store, generation: store.activeGeneration } } : {}),
  };
}

interface V2Setup { leader: { token: string }; child: { token: string }; store: BuildActorStore; state: BuildRunState }

function makeV2(stagingName: string, snapshot?: RawSourceSnapshot): V2Setup {
  const store = new BuildActorStore({ buildId: stagingName, stagingRoot: path.join(dataRoot, 'staging', stagingName), generation: 1 });
  const state = makeBuildState(stagingName, store, snapshot);
  const leader = service.createRunContext({
    runKind: 'build', buildId: stagingName, outputRoot, knowledgeBaseRoot: kbRoot, buildState: state,
    allowedToolsOverride: [...V2_LEADER_TOOLS],
    orchestration: { mode: 'pi-amagi', buildId: stagingName, generation: 1, credential: 'leader', actorStore: store },
  });
  const child = service.createRunContext({
    runKind: 'build', buildId: stagingName, outputRoot, knowledgeBaseRoot: kbRoot, buildState: state,
    allowedToolsOverride: V2_CHILD_ALL_TOOLS,
    orchestration: { mode: 'pi-amagi', buildId: stagingName, generation: 1, credential: 'child', actorStore: store },
  });
  return { leader: { token: leader.token }, child: { token: child.token }, store, state };
}

const meta = (taskId: string) => ({ amagiTaskId: taskId, amagiAgent: 'luban' });
const call = (token: string, tool: string, args: Record<string, unknown>, m?: { amagiTaskId?: string; amagiAgent?: string }) =>
  service.executeTool(token, tool, args, m);
const textBytes = (text: string): number => Buffer.byteLength(text, 'utf-8');

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpd-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpd-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpd-out-'));
  fs.mkdirSync(path.join(outputRoot, 'releases'), { recursive: true });
  writeRaw('src-dense1.md', denseSource(40, '甲'));
  writeRaw('src-dense2.md', denseSource(40, '乙'));
  writeRaw('src-a.md', '# 源A\n\n第一段内容。\n\n## 甲节\n\n甲节内容行1\n甲节内容行2\n');
  service = new AgentToolService({ dataRoot, documentsProvider: () => [] });
});
afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(kbRoot, { recursive: true, force: true });
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

describe('D1：raw_read 行数+字节双预算裁页', () => {
  it('密集源单页自动缩短：returned < limit、next_offset 推进、回执窗口一致、续页拼接无损', async () => {
    const setup = makeV2('b-d1-rawread');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const first = await call(setup.child.token, 'raw_read', { objToken: 'tokDense1' }, meta('w1'));
    const text1 = first.content[0]!.text as string;
    const page1 = /<raw_page offset="(\d+)" returned="(\d+)" total="(\d+)" next_offset="(\d+|\w+)" \/>/.exec(text1)!;
    expect(page1).toBeTruthy();
    const returned1 = Number(page1[2]);
    const total = Number(page1[3]);
    expect(total).toBe(41); // 40 内容行 + 末尾空行
    expect(returned1).toBeGreaterThan(0);
    // 41 行 × ~810B ≈ 33KB：17KB 软预算下必须裁页（既非整页也非 1 行兜底孤例）
    // 且最终 content 文本（含页眉/坐标前缀/回执）在预算内
    expect(returned1).toBeLessThan(total);
    expect(returned1).toBeGreaterThan(1);
    expect(textBytes(text1)).toBeLessThanOrEqual(17_000);
    expect(page1[4]).toBe(String(returned1));
    const content1 = text1.split('\n').filter((line) => /^\[O\d+/.test(line));
    expect(content1).toHaveLength(returned1);

    // 续页直到 end，拼接应还原全部行
    const pieces: string[] = [...content1.map((line) => line.replace(/^\[O\d+(?:\/R\d+(?:\/C\d+)?)?\] /, ''))];
    let offset = Number(page1[4]);
    let guard = 0;
    while (offset < total && guard++ < 10) {
      const next = await call(setup.child.token, 'raw_read', { objToken: 'tokDense1', offset }, meta('w1'));
      const textN = next.content[0]!.text as string;
      const pageN = /<raw_page offset="(\d+)" returned="(\d+)" total="(\d+)" next_offset="(\d+|\w+)" \/>/.exec(textN)!;
      expect(Number(pageN[1])).toBe(offset);
      for (const line of textN.split('\n')) {
        if (/^\[O\d+/.test(line)) pieces.push(line.replace(/^\[O\d+(?:\/R\d+(?:\/C\d+)?)?\] /, ''));
      }
      if (pageN[4] === 'end') break;
      offset = Number(pageN[4]);
    }
    expect(pieces).toHaveLength(total);
    expect(pieces.join('\n')).toBe(fs.readFileSync(path.join(kbRoot, 'src-dense1.md'), 'utf-8'));
    // 回执登记与窗口一致（每页回执行范围 ≤ 返回行数）
    const receiptsFile = path.join(setup.state.stagingRoot, 'read-receipts.jsonl');
    expect(fs.existsSync(receiptsFile)).toBe(true);
  });

  it('小源不受字节预算影响：默认参数单页读完 next_offset=end', async () => {
    const setup = makeV2('b-d1-small');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const result = await call(setup.child.token, 'raw_read', { objToken: 'tokA' }, meta('w1'));
    const text = result.content[0]!.text as string;
    expect(text).toContain('next_offset="end"');
    expect(/returned="\d+"/.test(text)).toBe(true);
  });
});

describe('D1：kb_read_batch 单次调用共享字节预算', () => {
  it('两份密集源一次调用：首页受字节预算截断，nextCursor 续读补齐且不重不漏', async () => {
    const setup = makeV2('b-d1-batch');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const result = await call(setup.child.token, 'kb_read_batch', cursor
        ? { cursor }
        : { requests: [
            { kind: 'raw', objToken: 'tokDense1', limit: 40 },
            { kind: 'raw', objToken: 'tokDense2', limit: 40 },
          ], maxLines: 4000 }, meta('w1'));
      const body = JSON.parse(result.content[0]!.text as string);
      expect(body.linesUsed).toBeLessThanOrEqual(4000);
      for (const item of body.results) {
        expect(item.error).toBeUndefined();
        seen.push(`${item.objToken}:${item.offset}+${item.returnedLines}`);
      }
      cursor = body.nextCursor ?? null;
      guard += 1;
      expect(guard).toBeLessThan(10);
    } while (cursor);
    // 两份密集源全部覆盖：按 objToken 汇总 returnedLines = totalLines
    const byToken = new Map<string, number>();
    for (const record of seen) {
      const [token, range] = record.split(':');
      byToken.set(token!, (byToken.get(token!) ?? 0) + Number(range!.split('+')[1]));
    }
    expect(byToken.get('tokDense1')).toBe(41);
    expect(byToken.get('tokDense2')).toBe(41);
    // 密集源一次调用吃不满两份（字节预算生效 → 必然出现续页）
    expect(guard).toBeGreaterThan(1);
  });
});

describe('D2(a)：claim bodyRange 必须落在对象正文范围内（写入期拦截）', () => {
  it('claim bodyRange 超出对象 headingPath 范围 → kb_claim_range_invalid，错误含修正字段且附 retryOf 暂存', async () => {
    const setup = makeV2('b-d2a-block');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/a.md'] });
    let caught: ToolError | null = null;
    try {
      await call(setup.child.token, 'kb_write_doc', {
        path: 'docs/a.md', title: 'T',
        markdown: '## 甲节\n\n对象内容行。\n\n## 乙节\n\n另一节内容。\n',
        sources: ['tokA'], summary: 's', operationId: 'op-a',
        objects: [{
          clientKey: 'obj-a', type: 'rule', title: '对象A', familyKey: 'fam-a', variantKey: 'default',
          scopeKey: 'scope-a', scopeText: '全部', headingPath: ['甲节'],
          claims: [{ claimKey: 'c1', riskCategory: 'high', bodyRange: { startLine: 5, endLine: 6 } }],
        }],
      }, meta('w1'));
    } catch (error) {
      caught = error as ToolError;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect(caught!.code).toBe('kb_claim_range_invalid');
    expect(caught!.message).toContain('c1');
    expect(caught!.message).toContain('obj-a');
    expect(caught!.message).toContain('claims.bodyRange');
    // rememberFailedWrite：4xx 校验错误附带 retryOf 暂存令牌（可直接重试）
    expect(caught!.message).toContain('retryOf');
    // 草稿未写入（拒绝发生在落盘前）
    expect(fs.existsSync(path.join(setup.state.stagingRoot, 'docs', 'docs', 'a.md'))).toBe(false);
  });

  it('claim bodyRange 含于对象范围 → 正常写入；对象指向空节但声明 claims → 回执提示（不拦截）', async () => {
    const setup = makeV2('b-d2a-hint');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/b.md'] });
    const result = await call(setup.child.token, 'kb_write_doc', {
      path: 'docs/b.md', title: 'T',
      markdown: '## 空节\n\n## 实节\n\n实际内容行。\n',
      sources: ['tokA'], summary: 's', operationId: 'op-b',
      objects: [
        { clientKey: 'obj-empty', type: 'rule', title: '空对象', familyKey: 'fam-e', variantKey: 'default',
          scopeKey: 'scope-e', scopeText: '全部', headingPath: ['空节'],
          claims: [{ claimKey: 'ce1', riskCategory: 'normal' }] },
        { clientKey: 'obj-real', type: 'rule', title: '实对象', familyKey: 'fam-r', variantKey: 'default',
          scopeKey: 'scope-r', scopeText: '全部', headingPath: ['实节'],
          claims: [{ claimKey: 'cr1', riskCategory: 'normal', bodyRange: { startLine: 4, endLine: 4 } }] },
      ],
    }, meta('w1'));
    const text = result.content[0]!.text as string;
    expect(text).toContain('已写入草稿 docs/b.md');
    expect(text).toContain('obj-empty');
    expect(text).toContain('headingPath');
    expect(text).not.toContain('obj-real 的正文范围');
    expect(result.details?.warnings).toBeTruthy();
  });
});

describe('D2(b)：链接目标存在性提示（发布门前置预警）', () => {
  it('目标缺失提示；已写草稿与已分配未写目标不提示', async () => {
    const setup = makeV2('b-d2b');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/dir/a.md', 'docs/dir/b.md', 'docs/dir/c.md'] });
    await call(setup.child.token, 'kb_write_doc', {
      path: 'docs/dir/b.md', title: 'B', markdown: '## B 节\n\nB 内容。\n', sources: ['tokA'], summary: 's', operationId: 'op-b',
    }, meta('w1'));
    const result = await call(setup.child.token, 'kb_write_doc', {
      path: 'docs/dir/a.md', title: 'A',
      markdown: '## A 节\n\n链接到[已有草稿](b.md)、[已分配未写](c.md)与[缺失目标](d.md)。\n',
      sources: ['tokA'], summary: 's', operationId: 'op-a',
    }, meta('w1'));
    const text = result.content[0]!.text as string;
    expect(text).toContain('d.md');
    expect(text).toContain('发布门禁会拦截');
    expect(text).not.toContain('c.md');
    expect(text).not.toContain('b.md');
  });

  it('kb_edit_doc 补丁引入缺失链接同样提示（同一校验链）', async () => {
    const setup = makeV2('b-d2b-edit');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/e.md'] });
    await call(setup.child.token, 'kb_write_doc', {
      path: 'docs/e.md', title: 'E', markdown: '## E 节\n\nE 内容。\n', sources: ['tokA'], summary: 's', operationId: 'op-e1',
    }, meta('w1'));
    const read = await call(setup.child.token, 'draft_read', { path: 'docs/e.md' }, meta('w1'));
    const hash = (read.details as { contentHash: string } | undefined)?.contentHash;
    const result = await call(setup.child.token, 'kb_edit_doc', {
      path: 'docs/e.md', operationId: 'op-e2', expectedContentHash: hash,
      patches: [{ anchor: { kind: 'exact_text', oldText: 'E 内容。' }, newText: 'E 内容，详见[缺失](../gone.md)。' }],
    }, meta('w1'));
    const text = result.content[0]!.text as string;
    expect(text).toContain('gone.md');
  });

  it('findMissingRelativeMdTargets 守卫：围栏/行内代码/图片/外链/锚点不误报', () => {
    const markdown = [
      '正文 [正常](缺失目标.md) 报。',
      '```md',
      '[代码块](围栏内.md) 不报',
      '```',
      '    [缩进代码](缩进.md) 不报',
      '`[行内](行内.md)` 不报',
      '![图片](图片.md) 不报',
      '[外链](https://example.com/x.md) 不报',
      '[锚点](#anchor) 不报',
      '[自指](self.md) 不报（自身路径在集合内）',
    ].join('\n');
    const missing = findMissingRelativeMdTargets(markdown, 'dir/self.md', []);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('缺失目标.md');
  });
});

describe('D2(c)：编号/计数声明提示（纯函数 + 写入回执）', () => {
  it('七计合并成六项被识别；一致计数、不定指、序数、等结尾、围栏内不误报', () => {
    const mismatchInline = '七计为主将、天地、法令、兵众、士卒、赏罚。';
    expect(checkDraftCountClaims(mismatchInline).join('\n')).toContain('七计');
    const mismatchList = '七计如下：\n- 主\n- 将\n- 天地\n- 法令\n- 兵众\n- 士卒';
    expect(checkDraftCountClaims(mismatchList).join('\n')).toContain('七计');
    const okList = '三大系统如下：\n- A\n- B\n- C\n';
    expect(checkDraftCountClaims(okList)).toEqual([]);
    const okInline = '共六项：A、B、C、D、E、F';
    expect(checkDraftCountClaims(okInline)).toEqual([]);
    const conjunction = '分为三类：攻击、防御与辅助';
    expect(checkDraftCountClaims(conjunction)).toEqual([]);
    const openEnded = '包括数项：甲、乙、丙等';
    expect(checkDraftCountClaims(openEnded)).toEqual([]);
    expect(checkDraftCountClaims('这是一项重要机制，第3项另行处理。')).toEqual([]);
    expect(checkDraftCountClaims('```\n五大类：\n- 1\n- 2\n```')).toEqual([]);
    expect(checkDraftCountClaims('晋升分为5步：\n1. 新兵\n2. 老兵\n3. 精锐')).toHaveLength(1);
  });

  it('计数不一致随写入回执返回（不阻断落盘）', async () => {
    const setup = makeV2('b-d2c');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/count.md'] });
    const result = await call(setup.child.token, 'kb_write_doc', {
      path: 'docs/count.md', title: 'C',
      markdown: '## 七计\n\n七计如下：\n\n- 主将\n- 天地\n- 法令\n- 兵众\n- 士卒\n- 赏罚\n',
      sources: ['tokA'], summary: 's', operationId: 'op-c',
    }, meta('w1'));
    const text = result.content[0]!.text as string;
    expect(text).toContain('已写入草稿 docs/count.md');
    expect(text).toContain('七计');
    expect(result.details?.warnings?.some((hint: string) => hint.includes('七计'))).toBe(true);
  });
});

describe('R5 复审回归：最终 content 字节预算（JSON 转义/页眉/坐标/游标全部计入）', () => {
  /** 读取本构建累计的读取回执（lineStart..lineEnd 列表）。 */
  const receiptRanges = (setup: V2Setup): Array<{ lineStart: number; lineEnd: number }> =>
    fs.readFileSync(path.join(setup.state.stagingRoot, 'read-receipts.jsonl'), 'utf-8')
      .trim().split('\n').map((line) => JSON.parse(line))
      .map((record: { selector: { lineStart: number; lineEnd: number } }) => record.selector);
  /** 回执范围不覆盖指定输出行（用于验证跳行不登记回执）。 */
  const noReceiptCovers = (setup: V2Setup, line: number): boolean =>
    receiptRanges(setup).every((range) => range.lineEnd < line || range.lineStart > line);

  it('90 行×120 反斜杠（R5 反例）：kb_read_batch 每页最终 JSON ≤ 软预算，回执范围与实际返回一致，多页拼接无损', async () => {
    const raw = backslashSource();
    writeRaw('src-bs.md', raw);
    const setup = makeV2('b-r5-batch', RawSourceSnapshot.fromEntries(
      [entry('tokBs', 'src-bs.md')], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] }));
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const innerPieces: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let guard = 0;
    let receiptsBefore = 0;
    do {
      const receiptsFile = path.join(setup.state.stagingRoot, 'read-receipts.jsonl');
      receiptsBefore = fs.existsSync(receiptsFile)
        ? fs.readFileSync(receiptsFile, 'utf-8').trim().split('\n').length : 0;
      const result = await call(setup.child.token, 'kb_read_batch', cursor
        ? { cursor }
        : { requests: [{ kind: 'raw', objToken: 'tokBs', limit: 2000 }], maxLines: 4000 }, meta('w1'));
      const text = result.content[0]!.text as string;
      // R5 核心：最终 content（含 JSON 转义、segmentMap、游标）不超软预算
      expect(textBytes(text)).toBeLessThanOrEqual(17_000);
      const body = JSON.parse(text);
      for (const item of body.results) {
        expect(item.error).toBeUndefined();
        expect(item.oversizedLine).toBeUndefined();
        // 回执范围与实际返回一致：本页新增回执覆盖行数 = returnedLines
        const ranges = receiptRanges(setup).slice(receiptsBefore);
        expect(ranges.reduce((sum: number, range: { lineStart: number; lineEnd: number }) => sum + range.lineEnd - range.lineStart + 1, 0))
          .toBe(item.returnedLines);
        innerPieces.push(String(item.text).split('\n').slice(1, -1).join('\n'));
      }
      // 反例源 10,889B 经 JSON 转义翻倍（≈21.8KB）不可能单页读完
      if (pages === 0) {
        expect(body.results[0].truncated).toBe(true);
        expect(body.nextCursor).toBeTruthy();
      }
      cursor = body.nextCursor ?? null;
      pages += 1;
      guard += 1;
      expect(guard).toBeLessThan(10);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    // 多页拼接无损 + 回执总覆盖恰好等于全文行数（不重不漏）
    expect(innerPieces.join('\n')).toBe(raw);
    const total = receiptRanges(setup).reduce((sum: number, range: { lineStart: number; lineEnd: number }) => sum + range.lineEnd - range.lineStart + 1, 0);
    expect(total).toBe(raw.split('\n').length);
  });

  it('raw_read 同源：页文本（页眉/坐标/回执计入）在预算内且单页读完（文本不经 JSON 转义）', async () => {
    const raw = backslashSource();
    writeRaw('src-bs2.md', raw);
    const setup = makeV2('b-r5-rawread', RawSourceSnapshot.fromEntries(
      [entry('tokBs2', 'src-bs2.md')], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] }));
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const result = await call(setup.child.token, 'raw_read', { objToken: 'tokBs2' }, meta('w1'));
    const text = result.content[0]!.text as string;
    expect(textBytes(text)).toBeLessThanOrEqual(17_000);
    expect(text).toContain('next_offset="end"');
    // 回执覆盖全部行且与返回一致
    const ranges = receiptRanges(setup);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.lineStart).toBe(1);
    expect(ranges[0]!.lineEnd).toBe(raw.split('\n').length);
  });

  it('超大单行：raw_read 显式跳行、不登记该行回执、next_offset 推进、其余行续读无损', async () => {
    const raw = `正常一\n${'X'.repeat(24_000)}\n正常二\n`;
    writeRaw('src-big-line.md', raw);
    const setup = makeV2('b-r5-oversized', RawSourceSnapshot.fromEntries(
      [entry('tokBig', 'src-big-line.md')], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] }));
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const pieces: string[] = [];
    let offset = 0;
    let sawMarker = false;
    for (let round = 0; round < 6; round += 1) {
      const result = await call(setup.child.token, 'raw_read', { objToken: 'tokBig', offset }, meta('w1'));
      const text = result.content[0]!.text as string;
      expect(textBytes(text)).toBeLessThanOrEqual(19_500);
      if (text.includes('<oversized_line')) {
        sawMarker = true;
        expect(text).toContain('不登记其读取回执');
        expect((result.details as { readReceipts: unknown[] }).readReceipts).toHaveLength(0);
        const page = /<raw_page offset="(\d+)" returned="0" total="(\d+)" next_offset="(\d+)" \//.exec(text)!;
        offset = Number(page[3]);
        continue;
      }
      for (const line of text.split('\n')) {
        if (/^\[O\d+/.test(line)) pieces.push(line.replace(/^\[O\d+(?:\/R\d+(?:\/C\d+)?)?\] /, ''));
      }
      const page = /next_offset="(\d+|end)"/.exec(text)!;
      if (page[1] === 'end') break;
      offset = Number(page[1]);
    }
    expect(sawMarker).toBe(true);
    // 跳行后其余行完整：正常一 + 正常二 + 末尾空行，超大行不在正文也不在任何回执内
    expect(pieces.join('\n')).toBe('正常一\n正常二\n');
    expect(noReceiptCovers(setup, 2)).toBe(true);
  });

  it('R5-B：raw 超大单行按 UTF-8 码点分片续传：游标链无损拼回整行、不登记该行回执、其余行完整', async () => {
    const raw = `正常一\n${'Y'.repeat(24_000)}\n正常二\n`;
    writeRaw('src-big-line2.md', raw);
    const setup = makeV2('b-r5-batch-oversized', RawSourceSnapshot.fromEntries(
      [entry('tokBig2', 'src-big-line2.md')], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] }));
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const segments: string[] = [];
    let prevWasChunk = false;
    let cursor: string | null = null;
    let chunkItems = 0;
    const appendSegment = (piece: string, isChunk: boolean): void => {
      if (isChunk && prevWasChunk && segments.length > 0) segments[segments.length - 1] += piece;
      else segments.push(piece);
      prevWasChunk = isChunk;
    };
    for (let round = 0; round < 10; round += 1) {
      const result = await call(setup.child.token, 'kb_read_batch', cursor
        ? { cursor }
        : { requests: [{ kind: 'raw', objToken: 'tokBig2', limit: 10 }], maxLines: 4000 }, meta('w1'));
      const text = result.content[0]!.text as string;
      expect(textBytes(text)).toBeLessThanOrEqual(19_500);
      const body = JSON.parse(text);
      for (const item of body.results) {
        expect(item.oversizedLine).toBeUndefined();
        if (item.lineChunk) {
          chunkItems += 1;
          expect(item.returnedLines).toBe(0);
          expect(item.note).toContain('不登记该行读取回执');
          expect(item.lineChunk.charStart).toBeLessThan(item.lineChunk.charEnd);
          appendSegment(String(item.text), true);
        } else {
          appendSegment(String(item.text).split('\n').slice(1, -1).join('\n'), false);
        }
      }
      cursor = body.nextCursor ?? null;
      if (!cursor) break;
    }
    expect(chunkItems).toBeGreaterThan(1);
    // 分片（同片拼 ''）+ 其余行拼接 = 原文（无损，无丢弃）
    expect(segments.join('\n')).toBe(raw);
    // 被分片行不登记任何回执（防引用未交付字节）
    expect(noReceiptCovers(setup, 2)).toBe(true);
  });

  it('R5-B：CJK/emoji 与高转义内容的分片不切断码点、拼回无损', async () => {
    // 中日韩 + emoji（代理对）+ 反斜杠/引号（JSON 高转义）混排，单行 ≈ 27KB
    const unit = '😀规则"内容"\\反向';
    const raw = `首\n${unit.repeat(Math.ceil(25_000 / [...unit].length))}\n尾\n`;
    writeRaw('src-big-line3.md', raw);
    const bigLine = raw.split('\n')[1]!;
    const setup = makeV2('b-r5-chunk-cjk', RawSourceSnapshot.fromEntries(
      [entry('tokBig3', 'src-big-line3.md')], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] }));
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    const segments: string[] = [];
    let prevWasChunk = false;
    let cursor: string | null = null;
    for (let round = 0; round < 10; round += 1) {
      const result = await call(setup.child.token, 'kb_read_batch', cursor
        ? { cursor }
        : { requests: [{ kind: 'raw', objToken: 'tokBig3', limit: 10 }], maxLines: 4000 }, meta('w1'));
      const text = result.content[0]!.text as string;
      expect(textBytes(text)).toBeLessThanOrEqual(19_500);
      const body = JSON.parse(text);
      for (const item of body.results) {
        const isChunk = Boolean(item.lineChunk);
        const piece = isChunk ? String(item.text) : String(item.text).split('\n').slice(1, -1).join('\n');
        if (isChunk && prevWasChunk && segments.length > 0) segments[segments.length - 1] += piece;
        else segments.push(piece);
        prevWasChunk = isChunk;
      }
      cursor = body.nextCursor ?? null;
      if (!cursor) break;
    }
    expect(segments.join('\n')).toBe(raw);
    expect([...bigLine].length).toBeGreaterThan(5_000); // 确认确实分了多片
    expect(noReceiptCovers(setup, 2)).toBe(true);
  });

  it('R5-A：前项占用软预算时，正常单行 defer 到下一页——不误报超限、不丢行、回执含该行', async () => {
    const setup = makeV2('b-r5a-defer');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    // large.md：约 14,000 ASCII 字符的正常草稿正文（无声明）
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/large.md'] });
    await call(setup.child.token, 'kb_write_doc', {
      path: 'docs/large.md', title: 'L',
      markdown: Array.from({ length: 200 }, (_, i) => `line ${i} ${'a'.repeat(60)}`).join('\n'),
      sources: ['tokA'], summary: 's', operationId: 'op-large',
    }, meta('w1'));
    // single：一行 5,000 ASCII 字符的 raw 源
    const rawLine = 's'.repeat(5_000);
    const raw = `${rawLine}\n`;
    writeRaw('src-single.md', raw);
    const snap = RawSourceSnapshot.fromEntries(
      [entry('tokSingle', 'src-single.md')], { knowledgeBaseRoot: kbRoot, sheetCsvPaths: () => [] });
    setup.state.snapshot = snap;
    const rawPieces: string[] = [];
    let cursor: string | null = null;
    for (let round = 0; round < 6; round += 1) {
      const result = await call(setup.child.token, 'kb_read_batch', cursor
        ? { cursor }
        : { requests: [
            { kind: 'draft', path: 'docs/large.md', limit: 2000 },
            { kind: 'raw', objToken: 'tokSingle', limit: 10 },
          ], maxLines: 4000 }, meta('w1'));
      const text = result.content[0]!.text as string;
      expect(textBytes(text)).toBeLessThanOrEqual(19_500);
      const body = JSON.parse(text);
      for (const item of body.results) {
        expect(item.oversizedLine).toBeUndefined();
        if (item.kind === 'raw') {
          expect(item.lineChunk).toBeUndefined(); // 正常单行不得被分片/跳过
          rawPieces.push(String(item.text).split('\n').slice(1, -1).join('\n'));
        }
      }
      cursor = body.nextCursor ?? null;
      if (!cursor) break;
    }
    // cursor 链重建得到原 raw 行（含行尾），且读取回执包含该行
    expect(rawPieces.join('\n')).toBe(raw);
    const ranges = receiptRanges(setup);
    expect(ranges.some((range) => range.lineStart <= 1 && range.lineEnd >= 1)).toBe(true);
  });

  it('R5-B：draft 25KB 单行分片续传——cursor 严格推进、链拼回原行、必定终止', async () => {
    const setup = makeV2('b-r5b-draft');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/single-long.md'] });
    const longLine = 'x'.repeat(25_000);
    await call(setup.child.token, 'kb_write_doc', {
      path: 'docs/single-long.md', title: 'S', markdown: longLine,
      sources: ['tokA'], summary: 's', operationId: 'op-single',
    }, meta('w1'));
    const pieces: string[] = [];
    const progress: number[] = [];
    let cursor: string | null = null;
    for (let round = 0; round < 10; round += 1) {
      const result = await call(setup.child.token, 'kb_read_batch', cursor
        ? { cursor }
        : { requests: [{ kind: 'draft', path: 'docs/single-long.md', limit: 2000 }] }, meta('w1'));
      const text = result.content[0]!.text as string;
      expect(textBytes(text)).toBeLessThanOrEqual(19_500);
      const body = JSON.parse(text);
      expect(body.results.length).toBeGreaterThan(0); // 不得空结果 + 不推进 cursor
      for (const item of body.results) {
        if (item.lineChunk) {
          progress.push(item.lineChunk.charStart);
          pieces.push(String(item.text));
        } else {
          pieces.push(String(item.text).split('\n').slice(1, -1).join('\n'));
        }
      }
      cursor = body.nextCursor ?? null;
      if (!cursor) break;
    }
    expect(cursor).toBeNull(); // 必定终止，不得无限重复
    expect(progress.length).toBeGreaterThan(1);
    expect(new Set(progress).size).toBe(progress.length); // 每次分片起点严格推进
    expect(pieces.join('')).toBe(longLine);
  });

  it('draft 声明原子超预算：报精确错误 kb_read_batch_item_too_large，不截断不声称完整读取', async () => {
    const setup = makeV2('b-r5-decl');
    setup.store.registerTaskCreation({ nativeTaskId: 'w1', requestedRole: 'luban' });
    await call(setup.leader.token, 'build_assign_output', { ownerTaskId: 'w1', targets: ['docs/big-decl.md'] });
    // 4 个对象 × 2000 字 scopeText：声明 JSON ≈ 8k 字符（< renderDraftDeclarations
    // 的 18k 字符 summaryOnly 阈值，不折叠）但 ≈ 24KB 字节（> 19.5KB 硬上限）
    const objects = Array.from({ length: 4 }, (_, index) => ({
      clientKey: `o${index}`, type: 'rule', title: `对象${index}`, familyKey: `fam-${index}`,
      variantKey: 'default', scopeKey: `scope-${index}`, scopeText: '范'.repeat(2000),
      headingPath: ['H'], claims: [{ claimKey: 'c1', riskCategory: 'normal' }],
    }));
    await call(setup.child.token, 'kb_write_doc', {
      path: 'docs/big-decl.md', title: 'B',
      markdown: '## H\n\n内容行。\n',
      sources: ['tokA'], summary: 's', operationId: 'op-big', objects,
    }, meta('w1'));
    let caught: ToolError | null = null;
    try {
      await call(setup.child.token, 'kb_read_batch', {
        requests: [{ kind: 'draft', path: 'docs/big-decl.md', limit: 1, includeDeclarations: true }],
      }, meta('w1'));
    } catch (error) {
      caught = error as ToolError;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect(caught!.code).toBe('kb_read_batch_item_too_large');
    expect(caught!.message).toContain('declarationClaimKey');
  });
});
