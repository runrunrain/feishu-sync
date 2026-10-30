/** 真实源选择、构建流水线和发布落盘；模型由通过真实工具写稿的受控替身代替。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { filterDeletedLocalDocuments } from '../src/modules/local-index-reconcile.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { AgentToolService, type BuildRunState, type VisionDescriberLike } from '../src/agent/agent-tool-service.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { KbBuildService } from '../src/kb/kb-build-service.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { KbVersionStore } from '../src/kb/kb-version-store.js';
import { kbRoutes } from '../src/routes/kb.js';
import type { DocumentRecord } from '../src/types/index.js';

const fixtures: Array<{ dir: string; store: LocalMapStore }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { dir, store } of fixtures.splice(0)) { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

async function fixture(visionDescriber?: VisionDescriberLike) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-selected-'));
  const raw = path.join(dir, 'raw'); fs.mkdirSync(raw);
  const config = new ConfigManager(path.join(dir, 'config.json')); await config.load();
  await config.updateConfig({ knowledgeBaseRoot: raw, standardKb: { outputRoot: path.join(dir, 'standard'), buildParallelism: 1 } } as never);
  const store = new LocalMapStore(path.join(dir, 'db.sqlite')); store.initialize(); fixtures.push({ dir, store });
  const output: Record<string, string> = {};
  for (const [token, title, rule] of [['a', '行动规则', '每回合执行一次行动，行动结束后进入结算。'], ['b', '费用规则', '技能消耗十点怒气，怒气不足时不能使用。'], ['c', '世界规则', '城市归属于国家，国家拥有各自的城市。']]) {
    const content = rule.repeat(8);
    fs.writeFileSync(path.join(raw, `${token}.md`), content); output[token] = content;
    store.upsertDocument({ objToken: token, title, objType: 'docx', wikiNodeToken: null, localRelPath: `${token}.md`, localMdPath: path.join(raw, `${token}.md`),
      lastSyncedAt: new Date().toISOString(), lastSyncedModifyTime: '', status: 'synced' } as DocumentRecord);
  }
  const documentsProvider = () => filterDeletedLocalDocuments(store, raw, store.getAllDocuments());
  const tools = new AgentToolService({ dataRoot: dir, documentsProvider, sheetCsvPaths: () => [] });
  const resolver = new PiRuntimeResolver(); vi.spyOn(resolver, 'checkReadiness').mockResolvedValue({ code: 'ready', model: { model: 'fixture/model' } } as never);
  const service = new KbBuildService({ dataRoot: dir, configProvider: () => config.getConfig(), documentsProvider, sheetCsvPaths: () => [],
    excludedSourcesProvider: () => store.listKbExplicitlyExcludedSources(raw), unselectedSourcesProvider: () => store.listKbExcludedSources(raw),
    pool: new AgentProcessPool(), resolver, toolService: tools, internalBaseUrl: () => '', extensionPath: () => null, promptAssets: () => null, visionDescriber });
  let behavior: 'normal' | 'drop' | 'overwrite' | 'merge' = 'normal';
  const worksets: string[][] = [];
  Object.assign(service, { spawnBuildProcess: async (buildId: string, state: BuildRunState) => {
    worksets.push([...state.workset.keys()].sort());
    const { token } = tools.createRunContext({ runKind: 'build', buildId, outputRoot: config.getConfig()!.standardKb.outputRoot, knowledgeBaseRoot: raw, buildState: state });
    let batches = 0;
    return Object.assign(new EventEmitter(), {
      isExited: () => false, abort: async () => undefined, terminate: async () => undefined,
      prompt: async (message: string) => {
        if (message.includes('【批次') && message.includes('请处理以下') && batches++ === 0) {
          for (const sourceToken of state.workset.keys()) {
            const entry = state.snapshot.get(sourceToken)!;
            await tools.executeTool(token, 'kb_write_doc', { path: `${sourceToken}.md`, title: entry.title, markdown: output[sourceToken], summary: '完整的当前规则说明', tags: [], sources: [sourceToken] });
          }
          if (behavior === 'drop' || behavior === 'merge') await tools.executeTool(token, 'kb_delete_doc', { path: 'a.md' });
          if (behavior === 'overwrite' || behavior === 'merge') {
            await tools.executeTool(token, 'kb_write_doc', { path: behavior === 'overwrite' ? 'a.md' : 'b.md', title: '规则汇总', markdown: output.a + '\n' + output.b,
              summary: '行动与费用的完整规则', tags: [], sources: behavior === 'merge' ? ['a', 'b'] : ['b'] });
          }
        } else {
          await tools.executeTool(token, 'kb_finish', { summary: '保留现有规则并整理所选内容。', skipped: [], ...(behavior === 'merge' ? { docMerges: [{ path: 'a.md', mergedInto: ['b.md'] }] } : {}) });
        }
        return { outcome: 'completed' };
      },
    });
  } });
  const app = new Hono(); app.route('/', kbRoutes({ buildService: service, configManager: config, localMapStore: store, documentsProvider, sheetCsvPaths: () => [] }));
  const request = async (url: string, body?: unknown) => {
    const response = await app.request(url, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() as any };
  };
  const select = (tokens: string[]) => { store.setKbSourcesIncluded(raw, ['a', 'b', 'c'], 'exclude'); if (tokens.length) store.setKbSourcesIncluded(raw, tokens, 'include'); };
  const build = async (options: { refreshImages?: boolean } = {}) => {
    const accepted = await request('/api/kb/builds', { mode: 'incremental', confirm: 'BUILD', rebuildSelected: true, ...options });
    expect(accepted.status).toBe(202);
    let final: any;
    await vi.waitFor(async () => {
      final = (await request(`/api/kb/builds/${accepted.data.id}`)).data;
      expect(['published', 'failed', 'cancelled']).toContain(final.status);
    }, { timeout: 5000, interval: 10 });
    return final;
  };
  const published = () => new StandardKbStore(config.getConfig()!.standardKb.outputRoot);
  const markdown = (docPath: string) => {
    const kb = published(); const manifest = kb.readManifest()!;
    return kb.readReleaseDoc(manifest.releaseId, manifest.docs.find((doc) => doc.path === docPath)!).markdown;
  };
  return { raw, store, output, select, build, request, worksets, published, markdown, setBehavior: (value: typeof behavior) => { behavior = value; } };
}

describe('所选源在现有标准库上继续构建', () => {
  it('先构建一组，再选择其他来源，旧文档、来源与docId均保留，状态标为已构建', async () => {
    const f = await fixture(); f.select(['a']); expect((await f.build()).status).toBe('published');
    const old = f.published().readManifest()!;
    const bytes = f.markdown('a.md');
    f.select(['b']); expect((await f.build()).status).toBe('published');
    const manifest = f.published().readManifest()!;
    expect(manifest.baseReleaseId).toBe(old.releaseId);
    expect(manifest.docs.map((doc) => doc.path)).toEqual(['a.md', 'b.md']);
    expect(manifest.docs.find((doc) => doc.path === 'a.md')!.docId).toBe(old.docs[0].docId);
    expect(f.markdown('a.md')).toBe(bytes);
    expect(manifest.sourceSnapshot.map((source) => source.objToken).sort()).toEqual(['a', 'b']);
    expect(f.worksets).toEqual([['a'], ['b']]);
    const choices = (await f.request('/api/kb/sources')).data.sources;
    expect(choices.find((source: any) => source.objToken === 'a')).toMatchObject({ included: false, published: true, pending: 'unchanged' });
    expect(choices.find((source: any) => source.objToken === 'b')).toMatchObject({ included: true, published: true, pending: 'unchanged' });
    expect(choices.find((source: any) => source.objToken === 'c')).toMatchObject({ published: false });
    const version = new KbVersionStore(f.published().outputRootPath).readVersion(manifest.releaseId)!;
    expect(version.docChanges.map((change) => change.path)).toEqual(['b.md']);
  });

  it('已构建源可主动重新构建，原文未变也会执行，并保留其他文档', async () => {
    const f = await fixture(); f.select(['a', 'b']); await f.build();
    const old = f.published().readManifest()!; const preserved = f.markdown('b.md');
    f.output.a = '行动按回合执行，每回合完成一次行动后进行结算。'.repeat(8);
    f.select(['a']); const result = await f.build({ refreshImages: true });
    expect(result.status, JSON.stringify(result)).toBe('published'); expect(result.noChanges).toBe(false);
    expect(f.published().readManifest()!.docs.find((doc) => doc.path === 'a.md')!.docId).toBe(old.docs.find((doc) => doc.path === 'a.md')!.docId);
    expect(f.worksets.at(-1)).toEqual(['a']);
    expect(f.markdown('a.md')).toContain('行动按回合执行'); expect(f.markdown('b.md')).toBe(preserved);
  });

  it('继续构建时也更新已有来源的真实变更，避免将旧正文标记为最新', async () => {
    const f = await fixture(); f.select(['a', 'b']); await f.build(); const preserved = f.markdown('a.md');
    f.output.b = '技能消耗二十点怒气，怒气不足时不能使用。'.repeat(8); fs.writeFileSync(path.join(f.raw, 'b.md'), f.output.b);
    f.select(['c']); expect((await f.build()).status).toBe('published');
    expect(f.worksets.at(-1)).toEqual(['b', 'c']);
    expect(f.markdown('a.md')).toBe(preserved); expect(f.markdown('b.md')).toContain('二十点怒气');
    expect(f.published().readManifest()!.docs).toHaveLength(3);
    expect((await f.request('/api/kb/changes')).data.sources).toEqual([]);
  });

  it('保留的图文文档复用本地识图缓存，不重新识别，也不会因遗漏旧描述预算而构建失败', async () => {
    const description = '行动流程分为准备、行动与结算，角色每回合执行一次行动。'.repeat(400);
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const imageHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const describeMany = vi.fn(async (items: Array<{ file: string; src: string }>) => new Map(items.map((item) => [item.src, { src: item.src, imageHash, state: 'described' as const, text: description }])));
    const lookup = vi.fn(async (hash: string) => hash === imageHash ? description : null);
    const f = await fixture({ status: async () => ({ state: 'ready', model: 'fixture/vision', message: '' }), describeMany, lookup, describeOne: vi.fn() });
    fs.writeFileSync(path.join(f.raw, 'figure.png'), bytes); fs.writeFileSync(path.join(f.raw, 'a.md'), '![行动流程](figure.png)'); f.output.a = description;
    f.select(['a']); const initial = await f.build(); expect(initial.status, JSON.stringify(initial)).toBe('published');
    const preserved = f.markdown('a.md');
    f.select(['b']); const result = await f.build(); expect(result.status, JSON.stringify(result)).toBe('published');
    expect(result.progress.images.total).toBe(0); expect(describeMany).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith(imageHash); expect(f.markdown('a.md')).toBe(preserved);
  });

  it.each(['drop', 'overwrite'] as const)('模型误%s未受影响的旧文档时拒绝发布，旧版本与已构建状态不变', async (behavior) => {
    const f = await fixture(); f.select(['a']); await f.build(); const old = f.published().readCurrent()!.releaseId;
    const preserved = f.markdown('a.md'); f.select(['b']); f.setBehavior(behavior);
    const result = await f.build(); expect(result.status).toBe('failed');
    expect(result.report.issues).toContainEqual(expect.objectContaining({ code: behavior === 'drop' ? 'existing_doc_removed' : 'existing_source_removed' }));
    expect(f.published().readCurrent()!.releaseId).toBe(old); expect(f.markdown('a.md')).toBe(preserved);
    expect((await f.request('/api/kb/sources')).data.sources.find((source: any) => source.objToken === 'b').published).toBe(false);
  });

  it('相关主题可显式合并，目标必须继续保留旧来源', async () => {
    const f = await fixture(); f.select(['a']); await f.build(); f.select(['b']); f.setBehavior('merge');
    const result = await f.build(); expect(result.status, JSON.stringify(result)).toBe('published');
    const manifest = f.published().readManifest()!;
    expect(manifest.docs).toHaveLength(1); expect(manifest.docs[0]).toMatchObject({ path: 'b.md', sources: ['a', 'b'] });
    expect(f.markdown('b.md')).toContain('每回合执行一次行动');
  });

  it('真正删除的来源不会被继续构建恢复；无所选源时拒绝执行', async () => {
    const f = await fixture(); f.select(['a', 'b']); await f.build();
    f.store.markLocalSourceDeleted(f.raw, f.store.getDocumentByObjToken('a')!);
    f.select(['b']); expect((await f.build()).status).toBe('published');
    expect(f.published().readManifest()!.sourceSnapshot.map((source) => source.objToken)).toEqual(['b']);
    const release = f.published().readCurrent()!.releaseId;
    f.select([]); const failed = await f.build(); expect(failed.status).toBe('failed'); expect(failed.error.code).toBe('no_sources_selected');
    expect(f.published().readCurrent()!.releaseId).toBe(release);
  });

  it('路由校验继续构建选项，拒绝非法值或与全量替换同时使用', async () => {
    const f = await fixture();
    expect((await f.request('/api/kb/builds', { mode: 'incremental', confirm: 'BUILD', rebuildSelected: 'true' })).status).toBe(400);
    expect((await f.request('/api/kb/builds', { mode: 'full', confirm: 'BUILD', rebuildSelected: true })).status).toBe(400);
  });
});
