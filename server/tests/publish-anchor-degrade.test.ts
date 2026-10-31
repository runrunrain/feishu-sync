/**
 * D4（A 案 §7.5 补齐）：反向发布锚点降级与状态提示测试。
 *
 * 覆盖任务书验收点：
 *   - 锚点剥离与链接降级（renderForPublish）：`<a id="ko_…"></a>` 空锚点
 *     剥离、`path.md#ko_x` fragment 丢弃文字保留、裸 `#ko_x` 降级、警告
 *     结构（code/objectId/reason）与计数、代码保护、确定性。
 *   - 状态提示自然化（KbPublishService）：候选/争议/废弃对象正文含状态
 *     边界说明 → 可分发；无说明 → 阻止该文档反向分发
 *     （kb_status_prompt_missing）；approved/unknown 无强制；v1 release
 *     无对象语义跳过；sidecar 损坏 fail-closed 全文档阻断。
 *   - 分发说明：distributionNote 附着于计划与执行结果（分发成功与内容
 *     权威无关）。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderForPublish } from '../src/kb/publish-render.js';
import {
  hasStatusPromptInBody,
  KbPublishService,
  PUBLISH_DISTRIBUTION_NOTE,
} from '../src/kb/publication-service.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { countText } from '../src/kb/text-stats.js';
import type { KnowledgeObject } from '../src/kb/knowledge-schema.js';
import type { PublishTargetConfig } from '../src/types/index.js';

const TARGET: PublishTargetConfig = { kind: 'drive_folder', token: 'fldcnD4AnchorRoot', label: '发布根' };

// ===========================================================================
// A. renderForPublish — 锚点剥离与链接降级（A 案 §7.5）
// ===========================================================================

const HEADER = ['<!--', 'feishu_sync_kb:', '  doc_id: doc-0', '  build_id: build-rel-001', '  sources:', '    - src-0', '-->'].join('\n');

describe('renderForPublish — A 案 §7.5 锚点降级', () => {
  it('空锚点 <a id="ko_…"></a> 剥离并给 invisible_anchor 警告（行保留为空行，段落不合并）', () => {
    const markdown = [
      HEADER,
      '# 标题',
      '',
      '<a id="ko_a1"></a>',
      '## 攻防修正',
      '正文段落。',
      '',
    ].join('\n');
    const result = renderForPublish({ kbPath: 'dirA/a.md', markdown, publishedUrlByKbPath: new Map() });
    expect(result.body).not.toContain('<a id');
    expect(result.body).not.toContain('ko_a1');
    // 剥离只移除标签本身：锚点行变空行而非删行，两侧段落不被合并
    // （去头正文 6 行，同名 H1 移除 1 行，锚点行保留为空行）
    expect(result.body.split('\n')).toEqual(['', '', '## 攻防修正', '正文段落。', '']);
    expect(result.warnings).toEqual([
      { code: 'object_anchor_not_preserved', kbPath: 'dirA/a.md', objectId: 'ko_a1', reason: 'invisible_anchor' },
    ]);
  });

  it('对象链接 path.md#ko_x 目标已发布：降级为文档级链接，fragment 丢弃、文字保留 + link_fragment 警告', () => {
    const markdown = [
      HEADER,
      '# 标题',
      '',
      '参见 [伤害规则](../rule/dmg.md#ko_obj9) 的说明。',
      '',
    ].join('\n');
    const urlMap = new Map([['rule/dmg.md', 'https://x.feishu.cn/docx/docxCloudDmg01']]);
    const result = renderForPublish({ kbPath: 'dirA/a.md', markdown, publishedUrlByKbPath: urlMap });
    expect(result.body).toContain('[伤害规则](https://x.feishu.cn/docx/docxCloudDmg01)');
    expect(result.body).not.toContain('#ko_obj9');
    expect(result.warnings).toEqual([
      { code: 'object_anchor_not_preserved', kbPath: 'dirA/a.md', target: 'rule/dmg.md', objectId: 'ko_obj9', reason: 'link_fragment' },
    ]);
  });

  it('对象链接目标未发布：去链接保留文字，link_target_unpublished 表达（不叠加锚点警告）', () => {
    const markdown = [
      HEADER,
      '# 标题',
      '',
      '参见 [伤害规则](../rule/dmg.md#ko_obj9)。',
      '',
    ].join('\n');
    const result = renderForPublish({ kbPath: 'dirA/a.md', markdown, publishedUrlByKbPath: new Map() });
    expect(result.body).toContain('参见 伤害规则。');
    expect(result.body).not.toContain('dmg.md');
    expect(result.warnings.filter((w) => w.code === 'object_anchor_not_preserved')).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === 'link_target_unpublished' && w.target === 'rule/dmg.md')).toBe(true);
  });

  it('裸锚 #ko_x（防御性路径）：降级为纯文字 + link_fragment 警告；普通锚点 #section 原样保留', () => {
    const markdown = [
      HEADER,
      '# 标题',
      '',
      '见 [本页对象](#ko_self1) 与 [普通锚](#section)。',
      '',
    ].join('\n');
    const result = renderForPublish({ kbPath: 'a.md', markdown, publishedUrlByKbPath: new Map() });
    expect(result.body).toContain('见 本页对象 与 [普通锚](#section)。');
    expect(result.warnings).toEqual([
      { code: 'object_anchor_not_preserved', kbPath: 'a.md', objectId: 'ko_self1', reason: 'link_fragment' },
    ]);
  });

  it('非 ko_ fragment（#section）：已发布目标照常改写，无锚点降级警告', () => {
    const markdown = [
      HEADER,
      '# 标题',
      '',
      '见 [说明](b.md#section)。',
      '',
    ].join('\n');
    const urlMap = new Map([['b.md', 'https://x.feishu.cn/docx/docxCloudB']]);
    const result = renderForPublish({ kbPath: 'a.md', markdown, publishedUrlByKbPath: urlMap });
    expect(result.body).toContain('[说明](https://x.feishu.cn/docx/docxCloudB)');
    expect(result.warnings).toHaveLength(0);
  });

  it('代码保护：围栏与行内代码内的锚点/对象链接原样保留、零警告', () => {
    const markdown = [
      HEADER,
      '# 标题',
      '',
      '```md',
      '<a id="ko_in_code"></a>',
      '[例](b.md#ko_code_link)',
      '```',
      '',
      '行内 `<a id="ko_span"></a>` 与 `[例](b.md#ko_span_link)`。',
      '',
    ].join('\n');
    const urlMap = new Map([['b.md', 'https://x.feishu.cn/docx/docxCloudB']]);
    const result = renderForPublish({ kbPath: 'a.md', markdown, publishedUrlByKbPath: urlMap });
    expect(result.body).toContain('<a id="ko_in_code"></a>');
    expect(result.body).toContain('[例](b.md#ko_code_link)');
    expect(result.body).toContain('<a id="ko_span"></a>');
    expect(result.body).toContain('[例](b.md#ko_span_link)');
    expect(result.warnings).toHaveLength(0);
  });

  it('警告去重：同一 (objectId, reason) 多处出现只报一次；不同 reason 分别可见', () => {
    const markdown = [
      HEADER,
      '# 标题',
      '',
      '<a id="ko_dup1"></a>',
      '一处 [链接](b.md#ko_dup1) 与二处 [再链](b.md#ko_dup1)。',
      '',
    ].join('\n');
    const urlMap = new Map([['b.md', 'https://x.feishu.cn/docx/docxCloudB']]);
    const result = renderForPublish({ kbPath: 'a.md', markdown, publishedUrlByKbPath: urlMap });
    const anchorWarnings = result.warnings.filter((w) => w.code === 'object_anchor_not_preserved');
    expect(anchorWarnings).toHaveLength(2); // invisible_anchor + link_fragment 各一条
    expect(new Set(anchorWarnings.map((w) => w.reason))).toEqual(new Set(['invisible_anchor', 'link_fragment']));
  });

  it('确定性：同输入两次渲染 body/contentHash/warnings 完全一致', () => {
    const markdown = [HEADER, '# 标题', '', '<a id="ko_det"></a>', '见 [x](b.md#ko_det)。', ''].join('\n');
    const urlMap = new Map([['b.md', 'https://x.feishu.cn/docx/docxCloudB']]);
    const input = { kbPath: 'a.md', markdown, publishedUrlByKbPath: urlMap };
    const first = renderForPublish(input);
    const second = renderForPublish(input);
    expect(second.body).toBe(first.body);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.warnings).toEqual(first.warnings);
  });
});

// ===========================================================================
// B. hasStatusPromptInBody — 状态关键词存在性（A 案 §7.5）
// ===========================================================================

describe('hasStatusPromptInBody', () => {
  it('含状态关键词的正文行命中；围栏代码块内的示例不计；空片段视为缺失', () => {
    expect(hasStatusPromptInBody(['本方案为候选方案，数值尚未确定。'])).toBe(true);
    expect(hasStatusPromptInBody(['两方案并存，尚待裁决。'])).toBe(true);
    expect(hasStatusPromptInBody(['该接口已废弃，不再使用。'])).toBe(true);
    expect(hasStatusPromptInBody(['普通规则正文。'])).toBe(false);
    expect(hasStatusPromptInBody([])).toBe(false);
    // 围栏内示例语法不算业务状态声明（与 renderForPublish 代码保护同口径）
    expect(hasStatusPromptInBody(['```', '候选', '```'])).toBe(false);
    expect(hasStatusPromptInBody(['```', '候选', '```', '但正文有争议说明。'])).toBe(true);
  });
});

// ===========================================================================
// C. KbPublishService — 状态提示门与分发说明（A 案 §7.5）
// ===========================================================================

const BASE_TIME = 1759000000;

function makeLarkStub(): Record<string, unknown> & { calls: Array<{ op: string }>; createdDocs: Map<string, string> } {
  const calls: Array<{ op: string }> = [];
  const createdDocs = new Map<string, string>();
  let seq = 0;
  const stub = {
    calls,
    createdDocs,
    checkAuthReady: async () => ({
      ready: true, verified: true, identity: 'user',
      currentScopes: ['docx:document:write_only', 'wiki:node:retrieve'], missingScopes: [],
    }),
    getDocumentMetas: async (reqs: Array<{ docToken: string }>) => ({
      metas: reqs.map((req) => ({ docToken: req.docToken, docType: 'docx', latestModifyTime: BASE_TIME, title: '' })),
      failed: [],
    }),
    fetchDocumentRevision: async (token: string) => {
      if (!createdDocs.has(token)) throw new Error('doc not found: 404');
      return { revisionId: 11, title: 'cloud' };
    },
    createDocumentMarkdown: async (options: { title: string; markdown: string; parentToken: string }) => {
      calls.push({ op: 'create' });
      seq += 1;
      const id = `docxcnD4${String(seq).padStart(4, '0')}`;
      createdDocs.set(id, options.markdown);
      return { documentId: id, url: `https://x.feishu.cn/docx/${id}`, revisionId: 1 };
    },
    overwriteDocument: async (token: string, markdown: string) => {
      calls.push({ op: 'overwrite' });
      createdDocs.set(token, markdown);
      return { revisionId: 12, warnings: [], raw: {} };
    },
    parseDocumentProfile: async (token: string) => ({ charCount: countText(createdDocs.get(token) ?? '').chars, wordCount: 1, blockCount: 1 }),
    listDocumentHistory: async (token: string) => ({
      entries: [{ historyVersionId: `hist-${token}`, revisionId: 9, editTime: new Date(BASE_TIME * 1000).toISOString(), editorIds: ['ou-test'], type: 2, raw: {} }],
      hasMore: false, nextPageToken: null,
    }),
    getNode: async (token: string) => ({ node_token: token, parent_node_token: '' }),
  };
  return stub;
}

/** 知识对象 fixture（canonical.path 指向 release 内文档；bodyRange 为去头正文行坐标）。 */
function ko(objectId: string, docPath: string, businessStatus: KnowledgeObject['businessStatus'], bodyRange: { startLine: number; endLine: number }): KnowledgeObject {
  return {
    objectId, type: 'rule', title: objectId, aliases: [], domainIds: [],
    familyKey: `fam-${objectId}`, variantKey: 'v1', scopeKey: 'scope', scopeText: '测试范围',
    canonical: { docId: 'doc-0', path: docPath, anchor: objectId, bodyRange },
    revision: 1, locationRevision: 1, payloadHash: `ph-${objectId}`, reviewSubjectHash: `rh-${objectId}`,
    businessStatus, reviewStatus: 'pending', claims: [],
  };
}

/** v2 release：schemaVersion 2 + organization（knowledge.json 哈希描述）+ 对象表。 */
function writeV2Release(
  outputRoot: string,
  releaseId: string,
  docBodyLines: string[],
  objects: KnowledgeObject[],
): void {
  const releaseDir = path.join(outputRoot, 'releases', releaseId);
  const docPath = 'dirA/a.md';
  fs.mkdirSync(path.dirname(path.join(releaseDir, 'docs', docPath)), { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'docs', docPath), `${HEADER}\n${docBodyLines.join('\n')}`, 'utf-8');
  const knowledge = {
    schemaVersion: 1, releaseId,
    documents: [{ docId: 'doc-0', path: docPath }],
    objects, presentations: [], relations: [], evidence: [], coverage: [], migrations: [],
  };
  const knowledgeBytes = Buffer.from(JSON.stringify(knowledge), 'utf8');
  const hash = `sha256:${createHash('sha256').update(knowledgeBytes).digest('hex')}`;
  fs.writeFileSync(path.join(releaseDir, 'knowledge.json'), knowledgeBytes, 'utf-8');
  const manifest = {
    schemaVersion: 2,
    releaseId,
    buildId: `build-${releaseId}`,
    mode: 'incremental' as const,
    baseReleaseId: null,
    publishedAt: new Date().toISOString(),
    model: null,
    sourceSnapshot: [],
    skippedSources: [],
    organization: { schemaVersion: 1, path: 'knowledge.json', hash, coverageMode: 'managed' as const },
    docs: [{
      docId: 'doc-0', path: docPath, title: '标题A', summary: '',
      headings: [], tags: [], sources: ['src-0'],
      contentHash: `h-${releaseId}-0`, updatedInBuild: `build-${releaseId}`,
    }],
  };
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  fs.writeFileSync(path.join(outputRoot, 'CURRENT.json'), JSON.stringify({ schemaVersion: 1, releaseId, publishedAt: manifest.publishedAt }), 'utf-8');
}

/** v1 release：无 organization（无对象语义）。 */
function writeV1Release(outputRoot: string, releaseId: string, docBodyLines: string[]): void {
  const releaseDir = path.join(outputRoot, 'releases', releaseId);
  fs.mkdirSync(path.join(releaseDir, 'docs', 'dirA'), { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'docs/dirA/a.md'), `${HEADER}\n${docBodyLines.join('\n')}`, 'utf-8');
  const manifest = {
    schemaVersion: 1, releaseId, buildId: `build-${releaseId}`,
    mode: 'incremental' as const, baseReleaseId: null,
    publishedAt: new Date().toISOString(), model: null,
    sourceSnapshot: [], skippedSources: [],
    docs: [{
      docId: 'doc-0', path: 'dirA/a.md', title: '标题A', summary: '',
      headings: [], tags: [], sources: ['src-0'],
      contentHash: `h-${releaseId}-0`, updatedInBuild: `build-${releaseId}`,
    }],
  };
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  fs.writeFileSync(path.join(outputRoot, 'CURRENT.json'), JSON.stringify({ schemaVersion: 1, releaseId, publishedAt: manifest.publishedAt }), 'utf-8');
}

interface Fixture {
  outputRoot: string;
  dataRoot: string;
  store: LocalMapStore;
  lark: ReturnType<typeof makeLarkStub>;
  service: KbPublishService;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-kb-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-data-'));
  const store = new LocalMapStore(path.join(dataRoot, 'test.db'));
  store.initialize();
  const lark = makeLarkStub();
  const config = {
    knowledgeBaseRoot: path.join(dataRoot, 'raw'),
    standardKb: { outputRoot },
    feishuWrite: { enabled: true },
    feishuPublish: { enabled: true, target: TARGET },
    watchedRoots: [],
  };
  const configManager = { getConfig: () => config, load: async () => config };
  const service = new KbPublishService({
    configManager: configManager as never,
    localMapStore: store,
    larkCliClient: lark,
    dataRoot,
  });
  return {
    outputRoot, dataRoot, store, lark, service,
    cleanup: () => {
      store.close();
      fs.rmSync(outputRoot, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

describe('KbPublishService — A 案 §7.5 状态提示门', () => {
  it('候选对象正文含状态边界说明 → 可分发；distributionNote 附着于计划与执行结果', async () => {
    const fx = makeFixture();
    try {
      const bodyLines = ['', '## 攻防修正', '本方案为候选方案，数值尚未确定。', ''];
      writeV2Release(fx.outputRoot, 'rel-v2-ok', bodyLines, [
        ko('ko_cand1', 'dirA/a.md', 'candidate', { startLine: 2, endLine: 3 }),
      ]);
      const plan = await fx.service.plan({});
      expect(plan.items).toHaveLength(1);
      const item = plan.items[0]!;
      expect(item.action).toBe('create');
      expect(item.warnings.some((w) => w.code === 'kb_status_prompt_missing')).toBe(false);
      expect(plan.distributionNote).toBe(PUBLISH_DISTRIBUTION_NOTE);
      const result = await fx.service.execute({ confirm: 'PUBLISH' });
      expect(result.counts.created).toBe(1);
      expect(result.counts.blocked).toBe(0);
      expect(result.distributionNote).toBe(PUBLISH_DISTRIBUTION_NOTE);
      // A 案 §7.5 注文语义：分发说明声明组织元数据不随飞书分发
      expect(PUBLISH_DISTRIBUTION_NOTE).toContain('不随飞书分发');
      expect(PUBLISH_DISTRIBUTION_NOTE).toContain('权威以本地 release 为准');
    } finally {
      fx.cleanup();
    }
  });

  it('候选/争议对象正文无状态说明 → 阻止该文档反向分发（blocked + kb_status_prompt_missing）', async () => {
    const fx = makeFixture();
    try {
      const bodyLines = ['', '## 攻防修正', '伤害公式固定。', ''];
      writeV2Release(fx.outputRoot, 'rel-v2-missing', bodyLines, [
        ko('ko_cand1', 'dirA/a.md', 'candidate', { startLine: 2, endLine: 3 }),
      ]);
      const plan = await fx.service.plan({});
      const item = plan.items[0]!;
      expect(item.action).toBe('blocked');
      expect(item.blockedReason).toBe('kb_status_prompt_missing');
      const warning = item.warnings.find((w) => w.code === 'kb_status_prompt_missing')!;
      expect(warning.objectId).toBe('ko_cand1');
      expect(warning.reason).toBe('candidate');
      // 执行：blocked 项不产生任何云端写入
      const result = await fx.service.execute({ confirm: 'PUBLISH' });
      expect(result.counts.blocked).toBe(1);
      expect(result.counts.created).toBe(0);
      expect(fx.lark.calls.filter((c) => c.op === 'create')).toHaveLength(0);
      expect(fx.store.getKbPublication('dirA/a.md')).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  it('争议（disputed）与废弃（deprecated）对象同样受门禁；approved/unknown 无强制', async () => {
    const fx = makeFixture();
    try {
      // 同一文档：disputed 对象正文无说明 → 阻断；approved/unknown 不触发
      const bodyLines = ['', '## 伤害事件', '顺序固定的流程正文。', ''];
      writeV2Release(fx.outputRoot, 'rel-v2-mixed', bodyLines, [
        ko('ko_disp1', 'dirA/a.md', 'disputed', { startLine: 2, endLine: 3 }),
        ko('ko_ok1', 'dirA/a.md', 'approved', { startLine: 2, endLine: 3 }),
        ko('ko_unk1', 'dirA/a.md', 'unknown', { startLine: 2, endLine: 3 }),
      ]);
      const plan = await fx.service.plan({});
      const item = plan.items[0]!;
      expect(item.action).toBe('blocked');
      const warnings = item.warnings.filter((w) => w.code === 'kb_status_prompt_missing');
      expect(warnings.map((w) => w.objectId).sort()).toEqual(['ko_disp1']);
      expect(warnings[0]!.reason).toBe('disputed');
    } finally {
      fx.cleanup();
    }
  });

  it('v1 release 无对象语义 → 跳过状态检查、无警告（回归锚定）', async () => {
    const fx = makeFixture();
    try {
      const bodyLines = ['', '## 攻防修正', '伤害公式固定。', ''];
      writeV1Release(fx.outputRoot, 'rel-v1', bodyLines);
      const plan = await fx.service.plan({});
      const item = plan.items[0]!;
      expect(item.action).toBe('create');
      expect(item.warnings.some((w) => w.code === 'kb_status_prompt_missing')).toBe(false);
      expect(plan.distributionNote).toBe(PUBLISH_DISTRIBUTION_NOTE);
    } finally {
      fx.cleanup();
    }
  });

  it('v2 sidecar 损坏（knowledge.json 哈希不一致）→ fail-closed 阻止全部文档', async () => {
    const fx = makeFixture();
    try {
      const bodyLines = ['', '## 攻防修正', '本方案为候选方案，数值尚未确定。', ''];
      writeV2Release(fx.outputRoot, 'rel-v2-corrupt', bodyLines, [
        ko('ko_cand1', 'dirA/a.md', 'candidate', { startLine: 2, endLine: 3 }),
      ]);
      // 篡改 knowledge.json 内容 → 与 manifest organization.hash 不一致
      fs.writeFileSync(path.join(fx.outputRoot, 'releases/rel-v2-corrupt/knowledge.json'), '{"schemaVersion":1,"tampered":true}', 'utf-8');
      const plan = await fx.service.plan({});
      const item = plan.items[0]!;
      expect(item.action).toBe('blocked');
      expect(item.blockedReason).toBe('kb_status_prompt_missing');
      const warning = item.warnings.find((w) => w.code === 'kb_status_prompt_missing')!;
      expect(warning.reason).toBe('knowledge_index_unavailable');
      const result = await fx.service.execute({ confirm: 'PUBLISH' });
      expect(result.counts.blocked).toBe(1);
      expect(fx.lark.calls.filter((c) => c.op === 'create')).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  it('已发布未变化（skip_unchanged）的文档同样受门禁：状态提示缺失 → blocked（第二遍互链回写防护）', async () => {
    const fx = makeFixture();
    try {
      const bodyLines = ['', '## 攻防修正', '伤害公式固定。', ''];
      writeV2Release(fx.outputRoot, 'rel-v2-skip', bodyLines, [
        ko('ko_cand1', 'dirA/a.md', 'candidate', { startLine: 2, endLine: 3 }),
      ]);
      // 首次计划：create 场景被拦，但渲染成功 → contentHash 可取
      const firstPlan = await fx.service.plan({});
      expect(firstPlan.items[0]!.action).toBe('blocked');
      const contentHash = firstPlan.items[0]!.contentHash;
      expect(contentHash).not.toBe('');
      // 预置已发布行（hash 一致）：decideAction 本应 skip_unchanged
      fx.store.upsertKbPublication({
        kbPath: 'dirA/a.md', cloudToken: 'docxcnExisting1', cloudUrl: 'https://x.feishu.cn/docx/docxcnExisting1',
        targetToken: TARGET.token, publishedReleaseId: 'rel-v2-skip', publishedContentHash: contentHash,
        publishedObjEditTime: String(BASE_TIME), state: 'published', warningsJson: null, lastError: null,
      });
      const plan = await fx.service.plan({});
      const item = plan.items[0]!;
      // 状态提示缺失 → skip_unchanged 也被阻止（第二遍互链回写会对 skip 项
      // overwrite，同样构成分发动作）
      expect(item.action).toBe('blocked');
      expect(item.blockedReason).toBe('kb_status_prompt_missing');
      expect(item.warnings.some((w) => w.code === 'kb_status_prompt_missing' && w.objectId === 'ko_cand1')).toBe(true);
      // 修复正文补状态说明 → hash 变化 → update 候选 → 门禁解除可分发
      const docFile = path.join(fx.outputRoot, 'releases/rel-v2-skip/docs/dirA/a.md');
      fs.writeFileSync(docFile, `${HEADER}
${['', '## 攻防修正', '本方案为候选方案，数值尚未确定。', ''].join('\n')}`, 'utf-8');
      const healed = await fx.service.plan({});
      expect(healed.items[0]!.action).toBe('update');
      expect(healed.items[0]!.warnings.some((w) => w.code === 'kb_status_prompt_missing')).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it('对象正文范围含围栏代码内的「候选」示例不算说明 → 仍阻断（代码保护口径一致）', async () => {
    const fx = makeFixture();
    try {
      const bodyLines = ['', '## 攻防修正', '```md', '候选', '```', '公式固定。', ''];
      writeV2Release(fx.outputRoot, 'rel-v2-fence', bodyLines, [
        ko('ko_cand1', 'dirA/a.md', 'candidate', { startLine: 2, endLine: 6 }),
      ]);
      const plan = await fx.service.plan({});
      expect(plan.items[0]!.action).toBe('blocked');
      expect(plan.items[0]!.blockedReason).toBe('kb_status_prompt_missing');
    } finally {
      fx.cleanup();
    }
  });
});
