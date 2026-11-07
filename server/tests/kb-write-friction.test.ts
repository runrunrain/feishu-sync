/**
 * kb-write-friction.test.ts — WP-G（新构建 b_20261107061134_8b2173 暴露的
 * 剩余写作工具摩擦）：
 * G1 kb_coverage_invalid（修订轮整篇重写）：
 *    - draft_read 声明把无 clientKey 登记的对象以 objectId 作显示 clientKey；
 *      作者照抄重申但省略 variantKey/scopeKey → clientKeys 落空 + 三元组
 *      因 scopeKey 派生差异不命中 → 身份漂移、覆盖映射悬空被拒。修复：
 *      ko_ 前缀 clientKey 精确命中 objectId 时沿用身份。
 *    - 错误一次给出完整修复参数（title/family 三元组/引用它的覆盖项
 *      itemId/精确读取调用/“按原 itemId 改去向”替代路径）。
 *    - 门禁对照：静默移除（换新对象/objects:[]）仍拒，草稿不被部分写入。
 * G2 图片证据资源错误：未描述/不可用图片引用 → 一次给出该源已登记图片
 *    资源、真实状态与判别（不给构建面不可达的 raw_read_image 建议）；
 *    已描述图片引用照常成功（门禁：无描述仍拒）。
 * G3 not_found token 建议（双拼 token）+ raw_search queries 超批形状回显
 *    + draft_read includeCoverage 指向 metadataOnly。
 *
 * 模式：临时目录 + 手工快照（同 kb-edit-rebind.test.ts），不依赖 SQLite、
 * 不调用真实模型。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentToolService, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { RawSourceSnapshot, computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import type { RawSourceSnapshotEntry } from '../src/types/agent-knowledge.js';
import type { ImageDescription } from '../src/agent/vision/vision-describer.js';

let dataRoot: string;
let kbRoot: string;
let outputRoot: string;
let service: AgentToolService;

const DOC_PATH = '战斗/伤害规则.md';
const TOK_A = 'tokA';
const TOK_IMG = 'tokImg';

const TINY_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('wpg-image-fixture'),
]);
const shaOf = (bytes: Buffer | string): string => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

const writeRaw = (rel: string, content: string | Buffer): string => {
  const target = path.join(kbRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
};

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

function makeBuildState(stagingName: string, descriptions?: Map<string, Map<string, ImageDescription>>): BuildRunState {
  const stagingRoot = path.join(dataRoot, 'staging', stagingName);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  return {
    knowledgeBaseRoot: kbRoot,
    snapshot: RawSourceSnapshot.fromEntries([entry(TOK_A, 'src-a.md'), entry(TOK_IMG, 'src-img.md')], { knowledgeBaseRoot: kbRoot }),
    mode: 'full',
    workset: new Map([[TOK_A, 'rebuild'], [TOK_IMG, 'rebuild']]),
    stagingRoot,
    finishInfo: null,
    ...(descriptions ? { imageDescriptions: descriptions } : {}),
  };
}

function tokenFor(state: BuildRunState): string {
  return service.createRunContext({
    runKind: 'build',
    buildId: 'b-wpg',
    outputRoot,
    knowledgeBaseRoot: kbRoot,
    buildState: state,
  }).token;
}

const call = (token: string, tool: string, args: Record<string, unknown>) => service.executeTool(token, tool, args);

const readDraft = (state: BuildRunState): any =>
  JSON.parse(fs.readFileSync(path.join(state.stagingRoot, 'knowledge-draft.json'), 'utf8'));

const V1_OBJECT = {
  clientKey: 'orig-obj', type: 'rule', title: '伤害规则', familyKey: 'damage-family',
  variantKey: 'manual-variant', scopeKey: 'manual-scope', scopeText: '伤害规则总则',
  headingPath: ['伤害规则'], claims: [{ claimKey: 'cap', riskCategory: 'normal' }],
};

/** 基线：写 v1 草稿（1 对象 + 1 文本证据 + mapped 覆盖项），返回读取凭据。 */
async function seedDraft(state: BuildRunState): Promise<{ objectId: string }> {
  const token = tokenFor(state);
  await call(token, 'raw_read', { objToken: TOK_A, offset: 0, limit: 10 });
  await call(token, 'kb_write_doc', {
    path: DOC_PATH, markdown: '## 伤害规则\n倍率 2.0。\n', sources: [TOK_A], summary: '伤害规则',
    objects: [V1_OBJECT],
    evidenceClaims: [{
      clientKey: 'ev-cap', objectKey: 'orig-obj', claimKey: 'cap',
      sourceRef: { sourceId: TOK_A, resourceId: TOK_A },
      selector: { kind: 'text_span', lineStart: 1, lineEnd: 2 }, role: 'supports', nature: 'direct',
    }],
    coverageUpdates: [{
      itemId: 'cov_g1', sourceId: TOK_A, category: 'rule', importance: 'important',
      disposition: 'mapped', targetKeys: ['orig-obj'],
    }],
  });
  return { objectId: readDraft(state).objects[0].objectId as string };
}

const rewriteArgs = (objectKey: string) => ({
  path: DOC_PATH, markdown: '## 伤害规则\n倍率 2.5（修订）。\n', sources: [TOK_A], summary: '伤害规则',
  // 修订作者形态：objectKey=objectId（draft_read 声明的显示回退形态）、
  // variantKey/scopeKey 省略、scopeText 改写 → 派生三元组与登记不命中。
  objects: [{
    clientKey: objectKey, type: 'rule', title: '伤害规则（修订）', familyKey: 'damage-family',
    scopeText: '伤害规则总则（修订）', headingPath: ['伤害规则'], claims: [{ claimKey: 'cap', riskCategory: 'normal' }],
  }],
  evidenceClaims: [{
    clientKey: 'ev-cap', objectKey: objectKey, claimKey: 'cap',
    sourceRef: { sourceId: TOK_A, resourceId: TOK_A },
    selector: { kind: 'text_span', lineStart: 1, lineEnd: 2 }, role: 'supports', nature: 'direct',
  }],
});

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpg-data-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpg-kb-'));
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpg-out-'));
  service = new AgentToolService({ dataRoot, documentsProvider: () => [] });
  writeRaw('src-a.md', '倍率 2.0\n上限 500\n');
  writeRaw('pic1.png', TINY_PNG);
  writeRaw('pic2.png', TINY_PNG);
  writeRaw('src-img.md', '# 图片源\n![图一](pic1.png)\n![图二](pic2.png)\n正文。\n');
});

afterAll(() => {
  for (const dir of [dataRoot, kbRoot, outputRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// G1：kb_coverage_invalid（修订轮整篇重写）
// ============================================================================
describe('WP-G G1：修订轮整篇重写的对象身份与覆盖映射拒绝', () => {
  it('clientKey=objectId + 省略 variantKey/scopeKey（派生三元组不命中）→ 身份保留、重写成功', async () => {
    const state = makeBuildState('g1-a');
    const { objectId } = await seedDraft(state);
    const token = tokenFor(state);
    await call(token, 'raw_read', { objToken: TOK_A, offset: 0, limit: 10 });
    const write = await call(token, 'kb_write_doc', rewriteArgs(objectId));
    expect(write.content[0]!.text).toContain(DOC_PATH);
    const draft = readDraft(state);
    const objects = draft.objects.filter((object: any) => object.canonical?.path === DOC_PATH);
    expect(objects).toHaveLength(1);
    expect(objects[0].objectId).toBe(objectId); // 身份未漂移
    expect(objects[0].revision).toBe(2); // 正文/scopeText 变化 → revision 递增
    // 新 clientKey（=objectId）已登记，后续重申可直接命中
    expect(draft.clientKeys[objectId]).toBe(objectId);
    // 覆盖项仍指向该对象（未悬空）
    expect(draft.coverage.some((item: any) => item.itemId === 'cov_g1' && item.targetObjectIds.includes(objectId))).toBe(true);
  });

  it('既有语义不回归：原 clientKey（登记命中）重申照常成功', async () => {
    const state = makeBuildState('g1-d');
    await seedDraft(state);
    const token = tokenFor(state);
    await call(token, 'raw_read', { objToken: TOK_A, offset: 0, limit: 10 });
    const write = await call(token, 'kb_write_doc', rewriteArgs('orig-obj'));
    expect(write.content[0]!.text).toContain(DOC_PATH);
    expect(readDraft(state).objects.filter((object: any) => object.canonical?.path === DOC_PATH)).toHaveLength(1);
  });

  it('门禁对照：换成全新对象且覆盖项未改去向 → 仍拒且错误一次给全修复参数', async () => {
    const state = makeBuildState('g1-b');
    const { objectId } = await seedDraft(state);
    const token = tokenFor(state);
    await call(token, 'raw_read', { objToken: TOK_A, offset: 0, limit: 10 });
    await expect(call(token, 'kb_write_doc', {
      path: DOC_PATH, markdown: '## 新章\n新对象正文。\n', sources: [TOK_A], summary: '伤害规则',
      objects: [{
        clientKey: 'brand-new', type: 'rule', title: '新对象', familyKey: 'other-family',
        scopeText: '另一族', headingPath: ['新章'], claims: [{ claimKey: 'n', riskCategory: 'normal' }],
      }],
      evidenceClaims: [{
        clientKey: 'ev-n', objectKey: 'brand-new', claimKey: 'n',
        sourceRef: { sourceId: TOK_A, resourceId: TOK_A },
        selector: { kind: 'text_span', lineStart: 1, lineEnd: 1 }, role: 'supports', nature: 'direct',
      }],
    })).rejects.toThrow(new RegExp(
      `会移除仍被覆盖映射引用的对象[\\s\\S]*${objectId}[\\s\\S]*伤害规则[\\s\\S]*family=damage-family/manual-variant/manual-scope[\\s\\S]*cov_g1[\\s\\S]*declarationObjectKey[\\s\\S]*按原 itemId`));
    await expect(call(token, 'kb_write_doc', {
      path: DOC_PATH, markdown: '## 新章\n新对象正文。\n', sources: [TOK_A], summary: '伤害规则',
      objects: [{
        clientKey: 'brand-new', type: 'rule', title: '新对象', familyKey: 'other-family',
        scopeText: '另一族', headingPath: ['新章'], claims: [{ claimKey: 'n', riskCategory: 'normal' }],
      }],
      evidenceClaims: [{
        clientKey: 'ev-n', objectKey: 'brand-new', claimKey: 'n',
        sourceRef: { sourceId: TOK_A, resourceId: TOK_A },
        selector: { kind: 'text_span', lineStart: 1, lineEnd: 1 }, role: 'supports', nature: 'direct',
      }],
    })).rejects.toMatchObject({ code: 'kb_coverage_invalid' });
    // 拒绝是原子的：草稿未被部分写入（旧对象与覆盖项保持原状）
    const draft = readDraft(state);
    expect(draft.objects.some((object: any) => object.objectId === objectId)).toBe(true);
    expect(draft.coverage.some((item: any) => item.itemId === 'cov_g1')).toBe(true);
  });

  it('门禁对照：objects:[]（全部不重申）→ 仍拒（静默丢失零容忍）', async () => {
    const state = makeBuildState('g1-c');
    const { objectId } = await seedDraft(state);
    const token = tokenFor(state);
    await expect(call(token, 'kb_write_doc', {
      path: DOC_PATH, markdown: '## 空章\n无对象正文。\n', sources: [TOK_A], summary: '伤害规则', objects: [],
    })).rejects.toThrow(new RegExp(`会移除仍被覆盖映射引用的对象[\\s\\S]*${objectId}`));
  });
});

// ============================================================================
// G2：图片证据资源错误
// ============================================================================
describe('WP-G G2：图片证据资源缺失的一次性精确错误', () => {
  const descriptionsWith = (entries: Array<[string, ImageDescription]>) =>
    new Map([[TOK_IMG, new Map(entries)]]);

  const IMG_DOC = {
    path: '战斗/图片证据.md', markdown: '## 倍率图\n上限由图给出。\n', sources: [TOK_IMG], summary: '图片证据',
  };
  const imageWrite = (resourceId: string) => ({
    ...IMG_DOC,
    objects: [{
      clientKey: 'obj-img', type: 'rule', title: '倍率图', familyKey: 'img-family',
      scopeKey: 'img', scopeText: '倍率图', headingPath: ['倍率图'], claims: [{ claimKey: 'cap', riskCategory: 'normal' }],
    }],
    evidenceClaims: [{
      clientKey: 'ev-img', objectKey: 'obj-img', claimKey: 'cap',
      sourceRef: { sourceId: TOK_IMG, resourceId },
      selector: { kind: 'media_region' }, role: 'supports', nature: 'machine_description',
    }],
  });

  it('引用未描述图片 → 拒绝并列出该源已登记图片资源与真实状态', async () => {
    const state = makeBuildState('g2-a', descriptionsWith([
      ['pic1.png', { src: 'pic1.png', imageHash: '', state: 'described', text: '图中标注上限 500。' }],
    ]));
    const token = tokenFor(state);
    await call(token, 'raw_read', { objToken: TOK_IMG, offset: 0, limit: 10 });
    await expect(call(token, 'kb_write_doc', imageWrite(`${TOK_IMG}#image:pic2.png`)))
      .rejects.toThrow(new RegExp(
        `证据资源不在本构建资源表[\\s\\S]*无识图描述[\\s\\S]*该源已登记图片资源[\\s\\S]*${TOK_IMG}#image:pic1\\.png`));
    // 不给构建面不可达的工具建议
    await expect(call(token, 'kb_write_doc', imageWrite(`${TOK_IMG}#image:pic2.png`)))
      .rejects.toThrow(/无识图描述(?!.*raw_read_image\()/s);
    // 草稿未写入
    expect(fs.existsSync(path.join(state.stagingRoot, '战斗/图片证据.md'))).toBe(false);
  });

  it('引用识图不可用（unavailable）图片 → 拒绝并注明 reason', async () => {
    const state = makeBuildState('g2-d', descriptionsWith([
      ['pic2.png', { src: 'pic2.png', imageHash: '', state: 'unavailable', reason: 'too_large' }],
    ]));
    const token = tokenFor(state);
    await call(token, 'raw_read', { objToken: TOK_IMG, offset: 0, limit: 10 });
    await expect(call(token, 'kb_write_doc', imageWrite(`${TOK_IMG}#image:pic2.png`)))
      .rejects.toThrow(new RegExp(`reason=too_large[\\s\\S]*不能作为 machine_description 证据`));
  });

  it('src 不属于该源图片引用 → 拒绝并列出该源全部图片', async () => {
    const state = makeBuildState('g2-b');
    const token = tokenFor(state);
    await call(token, 'raw_read', { objToken: TOK_IMG, offset: 0, limit: 10 });
    await expect(call(token, 'kb_write_doc', imageWrite(`${TOK_IMG}#image:pic3.png`)))
      .rejects.toThrow(new RegExp(`不属于该源的本地图片引用[\\s\\S]*pic1\\.png[\\s\\S]*pic2\\.png`));
  });

  it('对照：已描述图片的 media_region 证据照常成功（imageHash 服务端钉住）', async () => {
    const state = makeBuildState('g2-c', descriptionsWith([
      ['pic2.png', { src: 'pic2.png', imageHash: '', state: 'described', text: '图中标注上限 500。' }],
    ]));
    const token = tokenFor(state);
    await call(token, 'raw_read', { objToken: TOK_IMG, offset: 0, limit: 10 });
    const write = await call(token, 'kb_write_doc', imageWrite(`${TOK_IMG}#image:pic2.png`));
    expect(write.content[0]!.text).toContain(IMG_DOC.path);
    const evidence = readDraft(state).evidence[0];
    expect(evidence.selector.imageHash).toBe(shaOf(TINY_PNG));
  });
});

// ============================================================================
// G3：not_found token 建议 / queries 形状回显 / includeCoverage 指向
// ============================================================================
describe('WP-G G3：not_found 建议与形状错误回显', () => {
  it('raw_read 双拼 token → 「你是不是想读 <最近 token>」', async () => {
    const state = makeBuildState('g3-a');
    const token = tokenFor(state);
    await expect(call(token, 'raw_read', { objToken: `${TOK_A}${TOK_A}`, offset: 0, limit: 10 }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(call(token, 'raw_read', { objToken: `${TOK_A}${TOK_A}`, offset: 0, limit: 10 }))
      .rejects.toThrow(new RegExp(`原始文档不存在[\\s\\S]*你是不是想读 ${TOK_A}`));
  });

  it('对照：无近似 token → 不给建议（避免误导）', async () => {
    const state = makeBuildState('g3-b');
    const token = tokenFor(state);
    await expect(call(token, 'raw_read', { objToken: 'zzzzqqqqwwww', offset: 0, limit: 10 }))
      .rejects.toThrow(/原始文档不存在(?!.*你是不是想读)/s);
  });

  it('raw_search queries 12 项 → 错误回显收到项数与拆批修法', async () => {
    const state = makeBuildState('g3-c');
    const token = tokenFor(state);
    await expect(call(token, 'raw_search', {
      objToken: TOK_A, queries: Array.from({ length: 12 }, (_, i) => `关键词${i}`),
    })).rejects.toThrow(new RegExp('queries 须为 1[\\s\\S]*收到 12 项[\\s\\S]*拆成多批'));
  });

  it('draft_read includeCoverage → 指向 metadataOnly（不新增参数）', async () => {
    const state = makeBuildState('g3-d');
    const token = tokenFor(state);
    await expect(call(token, 'draft_read', { path: '任意/路径.md', includeCoverage: true }))
      .rejects.toThrow(new RegExp('includeCoverage[\\s\\S]*metadataOnly:true[\\s\\S]*coverageItems'));
  });
});

// ============================================================================
// R5-01（review-5）：构建态 not_found 建议不得泄露构建外 objToken
// ============================================================================
describe('R5-01：not_found 建议的构建信封隔离', () => {
  // 全局同步表中存在一个未纳入本构建快照的文档（前缀可被 4 字符探测）。
  const OUTSIDE_TOKEN = 'PrivateSourceSecretToken9876';
  const outsideRecord = {
    objToken: OUTSIDE_TOKEN, wikiNodeToken: null, objType: 'docx' as const,
    title: '构建外文档', localMdPath: 'src-a.md', localRelPath: 'src-a.md',
    lastSyncedModifyTime: '2026-11-07T00:00:00Z', lastSyncedAt: '2026-11-07T00:00:00Z',
    status: 'synced' as const,
  };
  let serviceWithDocs: AgentToolService;

  it('构建态前缀探测构建外 token → 不泄露（无建议）', async () => {
    serviceWithDocs = new AgentToolService({ dataRoot, documentsProvider: () => [outsideRecord as never] });
    const state = makeBuildState('r5-01-build');
    const token = serviceWithDocs.createRunContext({
      runKind: 'build', buildId: 'b-wpg', outputRoot, knowledgeBaseRoot: kbRoot, buildState: state,
    }).token;
    await expect(serviceWithDocs.executeTool(token, 'raw_read', { objToken: 'Priv', offset: 0, limit: 10 }))
      .rejects.toThrow(/原始文档不存在(?!.*你是不是想读)/s);
    await expect(serviceWithDocs.executeTool(token, 'raw_read', { objToken: 'Priv', offset: 0, limit: 10 }))
      .rejects.toThrow(new RegExp(`原始文档不存在(?!.*${OUTSIDE_TOKEN})`));
    // 快照内 token 的建议照常（双拼仍命中 tokA，且不因全局表干扰）
    await expect(serviceWithDocs.executeTool(token, 'raw_read', { objToken: `${TOK_A}${TOK_A}`, offset: 0, limit: 10 }))
      .rejects.toThrow(new RegExp(`你是不是想读 ${TOK_A}`));
  });

  it('非构建态（discuss）→ 用会话可见 documents 给建议（照常）', async () => {
    const token = serviceWithDocs.createRunContext({
      runKind: 'discuss', outputRoot, knowledgeBaseRoot: kbRoot,
    }).token;
    await expect(serviceWithDocs.executeTool(token, 'raw_read', { objToken: 'Priv', offset: 0, limit: 10 }))
      .rejects.toThrow(new RegExp(`原始文档不存在[\\s\\S]*你是不是想读 ${OUTSIDE_TOKEN}`));
  });
});

// ============================================================================
// R5-03（review-5）：同次重写中改覆盖去向即可移除对象（有效覆盖状态判定）
// ============================================================================
describe('R5-03：kb_write_doc 同 call 改去向移除对象', () => {
  it('objects:[] + coverageUpdates 重述为 unresolved → 成功且无悬空', async () => {
    const state = makeBuildState('r5-03-a');
    const { objectId } = await seedDraft(state);
    const token = tokenFor(state);
    const write = await call(token, 'kb_write_doc', {
      path: DOC_PATH, markdown: '## 收录范围变更\n本篇不再覆盖该规则。\n', sources: [TOK_A], summary: '伤害规则', objects: [],
      coverageUpdates: [{ itemId: 'cov_g1', sourceId: TOK_A, category: 'rule', disposition: 'unresolved' }],
    });
    expect(write.content[0]!.text).toContain(DOC_PATH);
    const draft = readDraft(state);
    expect(draft.objects.some((object: any) => object.objectId === objectId)).toBe(false); // 对象已移除
    const cov = draft.coverage.find((item: any) => item.itemId === 'cov_g1');
    expect(cov.disposition).toBe('unresolved'); // 去向已改，未悬空
  });

  it('换承接对象 + coverageUpdates 重述 mapped→新对象 → 成功', async () => {
    const state = makeBuildState('r5-03-b');
    const { objectId } = await seedDraft(state);
    const token = tokenFor(state);
    await call(token, 'raw_read', { objToken: TOK_A, offset: 0, limit: 10 });
    const write = await call(token, 'kb_write_doc', {
      path: DOC_PATH, markdown: '## 承接章\n承接正文。\n', sources: [TOK_A], summary: '伤害规则',
      objects: [{
        clientKey: 'successor', type: 'rule', title: '承接对象', familyKey: 'next-family',
        scopeText: '承接范围', headingPath: ['承接章'], claims: [{ claimKey: 'cap', riskCategory: 'normal' }],
      }],
      evidenceClaims: [{
        clientKey: 'ev-cap2', objectKey: 'successor', claimKey: 'cap',
        sourceRef: { sourceId: TOK_A, resourceId: TOK_A },
        selector: { kind: 'text_span', lineStart: 1, lineEnd: 1 }, role: 'supports', nature: 'direct',
      }],
      coverageUpdates: [{ itemId: 'cov_g1', sourceId: TOK_A, category: 'rule', importance: 'important', disposition: 'mapped', targetKeys: ['successor'] }],
    });
    expect(write.content[0]!.text).toContain(DOC_PATH);
    const draft = readDraft(state);
    expect(draft.objects.some((object: any) => object.objectId === objectId)).toBe(false);
    const successorId = draft.clientKeys['successor'];
    const cov = draft.coverage.find((item: any) => item.itemId === 'cov_g1');
    expect(cov.disposition).toBe('mapped');
    expect(cov.targetObjectIds).toEqual([successorId]);
  });

  it('门禁守卫：重述项仍指向被移除对象 → 拒绝（无悬空落盘）', async () => {
    const state = makeBuildState('r5-03-c');
    const { objectId } = await seedDraft(state);
    const token = tokenFor(state);
    await expect(call(token, 'kb_write_doc', {
      path: DOC_PATH, markdown: '## 收录范围变更\n本篇不再覆盖该规则。\n', sources: [TOK_A], summary: '伤害规则', objects: [],
      coverageUpdates: [{ itemId: 'cov_g1', sourceId: TOK_A, category: 'rule', disposition: 'mapped', targetKeys: [objectId] }],
    })).rejects.toThrow(new RegExp(`重述后仍指向本次移除的对象[\\s\\S]*${objectId}`));
    // 草稿未被部分写入：对象与旧去向保持原状
    const draft = readDraft(state);
    expect(draft.objects.some((object: any) => object.objectId === objectId)).toBe(true);
    expect(draft.coverage.find((item: any) => item.itemId === 'cov_g1').disposition).toBe('mapped');
  });
});
