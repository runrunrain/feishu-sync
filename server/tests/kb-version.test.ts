/** 隔离DB/原始源的真实路由与流水线回归；模型由受控工具执行double替代，非真实模型证据。 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { KbVersionStore } from '../src/kb/kb-version-store.js';
import { projectKnowledgeDocuments, recoveredSourceCsvPaths } from '../src/kb/local-source-projection.js';
import { planSourceBatch, executeSourceBatch } from '../src/modules/source-batch.js';
import { lineDiff } from '../src/kb/line-diff.js';
import { hasEditorialHistory, hasSourceMetadata } from '../src/kb/body-policy.js';
import { AgentToolService, type BuildRunState } from '../src/agent/agent-tool-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { kbRoutes } from '../src/routes/kb.js';
import type { DocumentRecord } from '../src/types/index.js';

const roots: string[] = [];
const openedStores: LocalMapStore[] = [];
afterAll(() => {
  for (const store of openedStores) store.close();
  roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-version-')); roots.push(root);
  const raw = path.join(root, 'raw'); fs.mkdirSync(raw);
  const configManager = new ConfigManager(path.join(root, 'config.json'));
  await configManager.load();
  await configManager.updateConfig({ knowledgeBaseRoot: raw, standardKb: { outputRoot: path.join(root, 'standard'), retainReleases: 3 } } as never);
  const store = new LocalMapStore(path.join(root, 'db.sqlite')); openedStores.push(store); store.initialize();
  const documents: DocumentRecord[] = ['a', 'b'].map((token) => ({
    objToken: token, wikiNodeToken: null, objType: 'docx', title: token,
    localRelPath: `${token}.md`, localMdPath: path.join(raw, `${token}.md`),
    lastSyncedAt: new Date().toISOString(), lastSyncedModifyTime: '', status: 'synced',
  }));
  fs.writeFileSync(path.join(raw, 'a.md'), '规则A：怒气消耗10。\n' + '怒气不足时不能释放技能，规则按当前配置生效。\n'.repeat(8));
  fs.writeFileSync(path.join(raw, 'b.md'), '规则B：速度高者先手。\n' + '双方各行动一次，以速度决定行动顺序。\n'.repeat(8));
  for (const doc of documents) store.upsertDocument(doc);
  const documentsProvider = () => projectKnowledgeDocuments(raw, documents);
  const sheetCsvPaths = (token: string) => recoveredSourceCsvPaths(raw, documentsProvider().find((doc) => doc.objToken === token), []);
  const tools = new AgentToolService({ dataRoot: root, documentsProvider, sheetCsvPaths });
  const resolver = new PiRuntimeResolver();
  vi.spyOn(resolver, 'checkReadiness').mockResolvedValue({ code: 'ready', model: { model: 'fixture/model' } } as never);
  const service = new KbBuildService({
    dataRoot: root, pool: new AgentProcessPool(), toolService: tools, resolver,
    configProvider: () => configManager.getConfig(), documentsProvider,
    excludedSourcesProvider: () => store.listKbExcludedSources(raw), sheetCsvPaths,
    internalBaseUrl: () => '', extensionPath: () => null, promptAssets: () => null,
  });
  const prompts: string[] = [];
  let generated: { markdown?: string; summary?: string } | null = null;
  let skipWrites = false; let editorial = false; let beforeFinish: (() => void) | null = null;
  Object.assign(service, { spawnBuildProcess: async (buildId: string, state: BuildRunState) => {
    const { token } = tools.createRunContext({ runKind: 'build', buildId,
      outputRoot: configManager.getConfig()!.standardKb.outputRoot, knowledgeBaseRoot: raw, buildState: state });
    let count = 0;
    return Object.assign(new EventEmitter(), {
      abort: async () => undefined, terminate: async () => undefined,
      prompt: async (prompt: string) => {
        prompts.push(prompt); count++;
        if (count === 1) {
          if (state.snapshot.size && !skipWrites) {
          const markdown = state.snapshot.entries.map((source) => state.snapshot.readVerified(raw, source.objToken).content).join('\n\n');
          await tools.executeTool(token, 'kb_write_doc', { path: '规则.md', title: '规则', markdown: generated?.markdown ?? (editorial ? '## 变更记录\n本次更新：修改规则' : markdown),
            sources: state.snapshot.entries.map((source) => source.objToken), summary: generated?.summary ?? '当前规则汇总', tags: [] });
          }
        } else {
          beforeFinish?.();
          await tools.executeTool(token, 'kb_finish', { summary: '合并当前有效来源，更新独立版本记录。', skipped: [] });
        }
        return { outcome: 'completed' };
      },
    });
  } });
  const app = new Hono(); app.route('/', kbRoutes({ buildService: service, configManager, localMapStore: store, documentsProvider, sheetCsvPaths }));
  async function call(url: string, method = 'GET', body?: unknown) {
    const response = await app.request(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() as any };
  }
  async function build(mode: 'full' | 'incremental' = 'incremental') {
    const accepted = await call('/api/kb/builds', 'POST', { mode, confirm: 'BUILD' });
    expect(accepted.status).toBe(202);
    let result = accepted.data;
    await vi.waitFor(async () => {
      result = (await call(`/api/kb/builds/${accepted.data.id}`)).data;
      expect(['published', 'failed', 'cancelled']).toContain(result.status);
    }, { timeout: 5000, interval: 10 });
    return result;
  }
  return { root, raw, store, call, build, prompts, configManager, documents,
    setGenerated: (value: { markdown?: string; summary?: string }) => { generated = value; }, setSkip: (value: boolean) => { skipWrites = value; },
    setEditorial: (value: boolean) => { editorial = value; }, setBeforeFinish: (fn: () => void) => { beforeFinish = fn; },
    published: () => new StandardKbStore(configManager.getConfig()!.standardKb.outputRoot),
  };
}

describe('源选择 → 源diff → 按变更更新 → 独立版本', () => {
  it('混合来源排除/重新参与，正文同步重写；标记持久且原始字节不变', async () => {
    const f = await fixture();
    const rawBefore = ['a', 'b'].map((name) => fs.readFileSync(path.join(f.raw, `${name}.md`), 'utf8'));
    const initial = await f.build('full'); expect(initial.status, JSON.stringify(initial)).toBe('published');
    const first = f.published().readCurrent()!.releaseId;
    expect((await f.call('/api/kb/sources/a', 'PUT', { included: false })).status).toBe(200);
    const choices = (await f.call('/api/kb/sources')).data.sources;
    expect(choices.find((source: any) => source.objToken === 'a')).toMatchObject({ included: false, pending: 'removed', published: true });
    const pending = (await f.call('/api/kb/changes')).data;
    expect(pending.sources).toHaveLength(1);
    expect(pending.sources[0]).toMatchObject({ key: 'a', kind: 'removed', reason: 'excluded', beforeAvailable: true });
    expect(pending.sources[0].patch).toContain('-规则A');
    expect(pending.affectedDocs).toHaveLength(1);
    expect((await f.call(`/api/kb/docs/${f.published().readManifest()!.docs[0].docId}`)).data.sources[0].state).toBe('excluded');
    expect((await f.build()).status).toBe('published');
    const manifest = f.published().readManifest()!;
    expect(manifest.sourceSnapshot.map((source) => source.objToken)).toEqual(['b']);
    const body = f.published().readReleaseDoc(manifest.releaseId, manifest.docs[0]).markdown;
    expect(body).toContain('规则B'); expect(body).not.toContain('规则A'); expect(hasEditorialHistory(body)).toBe(false);
    const version = (await f.call(`/api/kb/versions/${manifest.releaseId}`)).data;
    expect(version.baseReleaseId).toBe(first);
    expect(version.docChanges[0].patch).toContain('-规则A');
    expect(version.summary).toContain('独立版本记录');
    expect(f.prompts.some((prompt) => prompt.includes('用户标记为不参与构建') && prompt.includes('-规则A'))).toBe(true);
    const reopened = new LocalMapStore(path.join(f.root, 'db.sqlite')); openedStores.push(reopened); reopened.initialize();
    expect(reopened.listKbExcludedSources(f.raw)).toEqual(['a']);
    f.store.upsertDocument({ ...f.store.getAllDocuments()[0], title: '重新同步后的A' });
    expect(f.store.listKbExcludedSources(f.raw)).toEqual(['a']);
    await f.call('/api/kb/sources/a', 'PUT', { included: true });
    expect((await f.call('/api/kb/changes')).data.sources[0].kind).toBe('added');
    expect((await f.build()).status).toBe('published');
    expect(f.published().readManifest()!.sourceSnapshot).toHaveLength(2);
    expect(['a', 'b'].map((name) => fs.readFileSync(path.join(f.raw, `${name}.md`), 'utf8'))).toEqual(rawBefore);
  });

  it('排除全部来源会发布空标准库；未变则不创建新版本', async () => {
    const f = await fixture(); await f.build('full');
    const first = f.published().readCurrent()!.releaseId;
    const noChange = await f.build(); expect(noChange.noChanges).toBe(true);
    expect(f.published().readCurrent()!.releaseId).toBe(first);
    await f.call('/api/kb/sources/a', 'PUT', { included: false });
    await f.call('/api/kb/sources/b', 'PUT', { included: false });
    expect((await f.build()).status).toBe('published');
    expect(f.published().readManifest()!.docs).toEqual([]);
    const version = new KbVersionStore(f.configManager.getConfig()!.standardKb.outputRoot).readVersion(f.published().readCurrent()!.releaseId)!;
    expect(version.docChanges[0].kind).toBe('removed');
    expect(version.sourceChanges).toHaveLength(2);
  });

  it('源正文变化diff真正进入prompt；复制旧草稿而不处理受影响文档时拒绝发布', async () => {
    const f = await fixture(); await f.build('full');
    const original = f.published().readCurrent()!.releaseId;
    fs.writeFileSync(path.join(f.raw, 'a.md'), '规则A：怒气消耗20。');
    const pending = (await f.call('/api/kb/changes')).data;
    expect(pending.sources[0].patch).toContain('-规则A：怒气消耗10');
    expect(pending.sources[0].patch).toContain('+规则A：怒气消耗20');
    f.setSkip(true);
    const failed = await f.build(); expect(failed.status).toBe('failed');
    expect(f.published().readCurrent()!.releaseId).toBe(original);
    expect((await f.call(`/api/kb/builds/${failed.id}`)).data.report.issues.some((i: any) => i.code === 'affected_doc_not_updated')).toBe(true);
    f.setSkip(false); expect((await f.build()).status).toBe('published');
    expect(f.prompts.some((prompt) => prompt.includes('+规则A：怒气消耗20'))).toBe(true);
  });

  it('正文夹带修订记录或构建中源选择变化均不得移动CURRENT', async () => {
    const f = await fixture(); await f.build('full');
    const original = f.published().readCurrent()!.releaseId;
    fs.writeFileSync(path.join(f.raw, 'a.md'), '规则A：消耗30。');
    f.setEditorial(true); const failed = await f.build(); expect(failed.status).toBe('failed');
    expect(failed.error.code).toBe('body_contains_change_history');
    expect(f.published().readCurrent()!.releaseId).toBe(original);
    f.setEditorial(false); f.setBeforeFinish(() => f.store.setKbSourceExcluded(f.raw, 'a', true));
    expect((await f.build()).status).toBe('failed');
    expect(f.published().readCurrent()!.releaseId).toBe(original);
  });

  it.each([
    { markdown: '规则仍然有效。来源：a。' },
    { markdown: '依据原始文件 a.md 执行规则。' },
    { markdown: '## 来源说明\n规则A为当前规则。' },
    { markdown: '构建信息 build_id: b_20261027042732_9c9b93' },
    { summary: '规则来源 objToken=a' },
  ])('生成内容混入来源/构建信息时拒绝写入，保留当前发布：%j', async (generated) => {
    const f = await fixture(); expect((await f.build('full')).status).toBe('published');
    const original = f.published().readCurrent()!.releaseId;
    f.setGenerated(generated);
    const failed = await f.build('full');
    expect(failed.status).toBe('failed');
    expect(failed.error.code).toBe('body_contains_source_metadata');
    expect(f.published().readCurrent()!.releaseId).toBe(original);
  });

  it('发布前检查绕过工具写入的来源说明，并保留原始规则和来源追溯', async () => {
    const f = await fixture(); expect((await f.build('full')).status).toBe('published');
    const manifest = f.published().readManifest()!;
    const doc = (await f.call(`/api/kb/docs/${manifest.docs[0].docId}`)).data;
    expect(doc.markdown).toContain('怒气不足时不能释放技能');
    expect(doc.sources.map((source: any) => source.objToken).sort()).toEqual(['a', 'b']);
    f.setBeforeFinish(() => {
      const staging = path.join(f.root, 'standard', '.staging');
      for (const buildId of fs.readdirSync(staging)) {
        const file = path.join(staging, buildId, 'docs', '规则.md');
        if (fs.existsSync(file)) fs.appendFileSync(file, '\n来源：a\n');
      }
    });
    const failed = await f.build('full');
    expect(failed.status).toBe('failed');
    expect((await f.call(`/api/kb/builds/${failed.id}`)).data.report.issues.some((issue: any) => issue.code === 'body_contains_source_metadata')).toBe(true);
    expect(f.published().readCurrent()!.releaseId).toBe(manifest.releaseId);
  });

  it('来源检查支持真实标识与Markdown，不误删领域内来源规则与限制条件', () => {
    const identifiers = ['f3_local_action', '战斗/行动.md', 'doxcn.a+1'];
    for (const text of ['行动见f3_local_action。', '`战斗/行动.md`', '参考 doxcn.a+1', '**来源**：行动规则', '## 来源追溯', '发布 r_20261027T042823_13cfd5']) {
      expect(hasSourceMetadata(text, identifiers), text).toBe(true);
    }
    for (const text of ['伤害来源包含攻击和技能。', '## 怒气来源\n受到攻击获得怒气。', '格挡的具体减免数值尚未明确。', '## 版本兼容规则', 'doxcnXa11']) {
      expect(hasSourceMetadata(text, identifiers), text).toBe(false);
    }
  });

  it('源标记校验、库根隔离、历史路径拒绝和保留策略', async () => {
    const f = await fixture();
    expect((await f.call('/api/kb/sources/a', 'PUT', { included: 'false' })).status).toBe(400);
    expect((await f.call('/api/kb/sources/unknown', 'PUT', { included: false })).status).toBe(404);
    f.store.setKbSourceExcluded(f.raw, 'a', true);
    expect(f.store.listKbExcludedSources(path.join(f.root, 'other-raw'))).toEqual([]);
    f.store.setKbSourceExcluded(f.raw, 'a', false);
    await f.build('full');
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(f.raw, 'a.md'), `当前数值${i}。`); expect((await f.build()).status).toBe('published');
    }
    expect((await f.call('/api/kb/versions')).data.versions).toHaveLength(3);
    expect((await f.call('/api/kb/versions/%2e%2e%2fsecret')).status).toBe(400);
    expect((await f.call('/api/kb/versions/not-found')).status).toBe(404);
  });

  it('正文与元数据不变时不把buildId头部当作正文差异；旧源无原文时明确标记', async () => {
    const f = await fixture(); await f.build('full');
    const first = f.published().readCurrent()!.releaseId;
    const output = f.configManager.getConfig()!.standardKb.outputRoot;
    fs.unlinkSync(path.join(output, 'releases', first, 'source-contents.json'));
    fs.writeFileSync(path.join(f.raw, 'a.md'), '规则A：有效内容已变化。');
    const preview = (await f.call('/api/kb/changes')).data;
    expect(preview.sources[0]).toMatchObject({ beforeAvailable: false, patch: '' });
    expect((await f.build()).status).toBe('published');
    expect((await f.build('full')).status).toBe('published');
    const version = (await f.call(`/api/kb/versions/${f.published().readCurrent()!.releaseId}`)).data;
    expect(version.docChanges).toEqual([]);
    expect(version.sourceChanges).toEqual([]);
  });

  it('版本记录写入失败时保留原CURRENT；更新进行中拒绝源标记', async () => {
    const f = await fixture(); await f.build('full');
    const first = f.published().readCurrent()!.releaseId;
    fs.writeFileSync(path.join(f.raw, 'a.md'), '规则A：新的有效规则。');
    const original = fs.writeFileSync;
    const fault = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (String(file).endsWith('changes.json')) throw new Error('fixture version write failure');
      return (original as (...args: unknown[]) => void)(file, ...args);
    }) as typeof fs.writeFileSync);
    try { expect((await f.build()).status).toBe('failed'); }
    finally { fault.mockRestore(); }
    expect(f.published().readCurrent()!.releaseId).toBe(first);
    f.store.createKbBuild({ id: 'queued-blocker', mode: 'incremental', status: 'queued', baseReleaseId: first, model: null, createdAt: new Date().toISOString() });
    expect((await f.call('/api/kb/sources/a', 'PUT', { included: false })).status).toBe(409);
    expect(f.store.listKbExcludedSources(f.raw)).toEqual([]);
  });

  it('崩溃遗留但未被CURRENT提交的release不进入版本历史，也不能按id查询', async () => {
    const f = await fixture(); await f.build('full');
    const base = f.published().readManifest()!;
    const orphan = path.join(f.configManager.getConfig()!.standardKb.outputRoot, 'releases', 'r_orphan');
    fs.mkdirSync(orphan);
    fs.writeFileSync(path.join(orphan, 'manifest.json'), JSON.stringify({ ...base, releaseId: 'r_orphan', baseReleaseId: base.releaseId }));
    expect((await f.call('/api/kb/versions')).data.versions.map((version: any) => version.releaseId)).toEqual([base.releaseId]);
    expect((await f.call('/api/kb/versions/r_orphan')).status).toBe(404);
  });
});

describe('diff与正文边界', () => {
  it('逐行增加/删除、跨段上下文与大文件有界降级', () => {
    const diff = lineDiff('相同\n旧行\n末行', '相同\n新行\n末行');
    expect(diff).toMatchObject({ additions: 1, deletions: 1, truncated: false });
    expect(diff.patch).toContain('-旧行'); expect(diff.patch).toContain('+新行');
    expect(lineDiff('same', 'same').patch).toBe('');
    expect(lineDiff('a\n'.repeat(2000), 'b\n'.repeat(2000), 100).truncated).toBe(true);
  });
  it('拒绝编辑历史，保留正常领域规则和版本机制说明', () => {
    expect(hasEditorialHistory('## 修订记录\n本次更新：A')).toBe(true);
    expect(hasEditorialHistory('相较上版，增加A。')).toBe(true);
    expect(hasEditorialHistory('依据新增源 f3_local_action（战斗行动）撰写标准文档：每回合各行动一次。')).toBe(true);
    expect(hasEditorialHistory('新增战斗行动标准文档，规定每回合双方各行动一次。')).toBe(true);
    expect(hasEditorialHistory('说明战斗行动顺序与技能怒气消耗。')).toBe(false);
    expect(hasEditorialHistory('## 版本兼容规则\n客户端版本不匹配时拒绝连接。')).toBe(false);
  });
});


describe('源选择批量事务', () => {
  it('父节点的历史本地正文和子文档都出现在源树并进入构建快照', async () => {
    const f = await fixture();
    const parentFile = path.join(f.raw, '历史父节点.md');
    fs.writeFileSync(parentFile, '<!--\nfeishu_sync:\n  obj_token: "a"\n  wiki_node_token: "wiki-a"\n  obj_type: "slides"\n-->\n# 父文档\n' + '父节点规则：按照当前配置组织玩法。\n'.repeat(8));
    f.documents[0] = { ...f.documents[0], wikiNodeToken: 'wiki-a', objType: 'slides', title: '父文档', localRelPath: null,
      localMdPath: '', lastSyncedAt: '', status: 'error', syncState: 'restricted', lastSyncErrorCode: 'permission_denied' };
    f.documents[1] = { ...f.documents[1], wikiNodeToken: 'wiki-b', parentNodeToken: 'wiki-a', title: '子文档' };
    const tree = await f.call('/api/kb/sources/tree');
    expect(tree.status).toBe(200); expect(tree.data.total).toBe(2);
    const parent = tree.data.nodes.find((node: any) => node.source?.objToken === 'a');
    expect(parent.source).toMatchObject({ objToken: 'a', relPath: '历史父节点.md', recovered: true, included: true });
    expect(parent.children.map((node: any) => node.source?.objToken)).toEqual(['b']);
    expect((await f.call('/api/kb/sources/selection', 'POST', { root: f.raw, action: 'exclude', tokens: ['a', 'b'] })).status).toBe(200);
    expect(f.store.listKbExcludedSources(f.raw)).toEqual(expect.arrayContaining(['a', 'b']));
    expect((await f.call('/api/kb/sources/selection', 'POST', { root: f.raw, action: 'include', tokens: ['a', 'b'] })).status).toBe(200);
    f.setGenerated({ markdown: '父节点规则按照当前配置组织玩法。\n\n规则B：速度高者先手，双方各行动一次。' });
    const build = await f.build('full'); expect(build.status, JSON.stringify(build)).toBe('published');
    expect(f.published().readManifest()!.sourceSnapshot.map((source) => source.objToken).sort()).toEqual(['a', 'b']);
    expect(f.documents[0]).toMatchObject({ localRelPath: null, localMdPath: '', syncState: 'restricted', lastSyncErrorCode: 'permission_denied' });
    expect(fs.readFileSync(parentFile, 'utf8')).toContain('父节点规则');
  });

  it('父节点无可验证本地正文时标明源不可用，不把它虚计入可构建数量', async () => {
    const f = await fixture();
    f.documents[0] = { ...f.documents[0], wikiNodeToken: 'wiki-a', localRelPath: null, localMdPath: '', lastSyncedAt: '', status: 'error' };
    f.documents[1] = { ...f.documents[1], wikiNodeToken: 'wiki-b', parentNodeToken: 'wiki-a' };
    const tree = await f.call('/api/kb/sources/tree');
    expect(tree.data.total).toBe(1);
    expect(tree.data.nodes[0]).toMatchObject({ title: 'a', sourceUnavailable: true, children: [{ source: { objToken: 'b' } }] });
    expect(tree.data.nodes[0].source).toBeUndefined();
  });

  it('超过分页范围仍一次处理全部；反选去重、隔离根目录并保持原始字节', async () => {
    const f = await fixture();
    const before = fs.readFileSync(path.join(f.raw, 'a.md'), 'utf8');
    fs.mkdirSync(path.join(f.raw, '目录'));
    for (let i = 0; i < 120; i++) { fs.writeFileSync(path.join(f.raw, `目录/文档${i}.md`), '规则'); f.documents.push({ ...f.documents[0], objToken: `extra${i}`, title: `文档${i}`, localRelPath: `目录/文档${i}.md` }); }
    const tree = await f.call('/api/kb/sources/tree'); expect(tree.status).toBe(200); expect(tree.data.total).toBe(122);
    const tokens = f.documents.map((doc) => doc.objToken);
    const body = (action: string, target = tokens) => ({ root: f.raw, action, tokens: target });
    expect((await f.call('/api/kb/sources/selection', 'POST', body('exclude'))).status).toBe(200);
    expect(f.store.listKbExcludedSources(f.raw)).toHaveLength(122);
    await f.call('/api/kb/sources/selection', 'POST', body('invert', ['a', 'a', 'b']));
    expect(f.store.listKbExcludedSources(f.raw)).toHaveLength(120);
    expect(f.store.listKbExcludedSources(path.join(f.root, 'different-root'))).toEqual([]);
    await f.call('/api/kb/sources/selection', 'POST', body('include')); expect(f.store.listKbExcludedSources(f.raw)).toEqual([]);
    expect(fs.readFileSync(path.join(f.raw, 'a.md'), 'utf8')).toBe(before);
  });
  it('未知源、库切换、非法请求或构建进行中均整批拒绝，不部分保存', async () => {
    const f = await fixture();
    for (const [body, status] of [
      [{ root: f.raw, action: 'exclude', tokens: ['a', 'missing'] }, 404],
      [{ root: 'old-root', action: 'exclude', tokens: ['a'] }, 409],
      [{ root: f.raw, action: 'other', tokens: ['a'] }, 400],
      [{ root: f.raw, action: 'exclude', tokens: [] }, 400],
    ] as const) { expect((await f.call('/api/kb/sources/selection', 'POST', body)).status).toBe(status); expect(f.store.listKbExcludedSources(f.raw)).toEqual([]); }
    f.store.createKbBuild({ id: 'queued', mode: 'full', status: 'queued', baseReleaseId: null, model: null, createdAt: new Date().toISOString() });
    expect((await f.call('/api/kb/sources/selection', 'POST', { root: f.raw, action: 'exclude', tokens: ['a', 'b'] })).status).toBe(409);
    expect(f.store.listKbExcludedSources(f.raw)).toEqual([]);
  });
});

describe('手动删源与标准库更新闭环', () => {
  it('已发布源手动删除后从当前选择消失，保留移除差异；更新消除旧正文，历史仍可追溯', async () => {
    const f = await fixture(); await f.build('full'); const first = f.published().readCurrent()!.releaseId;
    fs.unlinkSync(path.join(f.raw, 'a.md'));
    const choices = (await f.call('/api/kb/sources')).data;
    expect(choices.total).toBe(1); expect(choices.sources[0].objToken).toBe('b');
    expect((await f.call('/api/kb/changes')).data.sources[0]).toMatchObject({ key: 'a', kind: 'removed' });
    expect((await f.build()).status).toBe('published');
    const manifest = f.published().readManifest()!;
    expect(manifest.sourceSnapshot.map((source) => source.objToken)).toEqual(['b']);
    expect(f.published().readReleaseDoc(manifest.releaseId, manifest.docs[0]).markdown).not.toContain('规则A');
    expect((await f.call(`/api/kb/versions/${first}`)).status).toBe(200);
    fs.unlinkSync(path.join(f.raw, 'b.md'));
    expect((await f.build()).status).toBe('published'); expect(f.published().readManifest()!.docs).toEqual([]);
    expect((await f.call('/api/kb/sources/tree')).data.total).toBe(0);
  });
});


it('批量删除预览列出具体受影响标准文档，执行后通过按变更更新收敛正文', async () => {
  const f = await fixture(); await f.build('full');
  const config = f.configManager.getConfig()!;
  const request = { root: f.raw, tokens: ['b'], action: 'delete' as const, includeDescendants: false, deleteFiles: true, block: false };
  const plan = planSourceBatch(f.store, config, request);
  expect(plan.preview.affectedStandardDocs).toEqual(f.published().readManifest()!.docs.map(({docId,title}) => ({docId,title})));
  executeSourceBatch(f.store, config, request, plan.preview.revision);
  expect((await f.build()).status).toBe('published'); const manifest = f.published().readManifest()!;
  expect(f.published().readReleaseDoc(manifest.releaseId, manifest.docs[0]).markdown).not.toContain('规则B');
});
