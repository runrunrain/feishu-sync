/** 真实工具、检查点、SQLite 和发布链路；仅模型进程用受控替身。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { ConfigManager } from '../src/modules/config-manager.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { AgentToolService, type VisionDescriberLike } from '../src/agent/agent-tool-service.js';
import type { PiRpcProcess, RunOutcome } from '../src/agent/pi-rpc-process.js';
import type { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { KbBuildService, cleanupOldStaging } from '../src/kb/kb-build-service.js';
import { BuildCheckpointStore } from '../src/kb/build-checkpoint.js';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { kbRoutes } from '../src/routes/kb.js';
import type { DocumentRecord } from '../src/types/index.js';

const fixtures: Array<{ dir: string; store: LocalMapStore; pools: AgentProcessPool[] }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { dir, store, pools } of fixtures.splice(0)) {
    await Promise.all(pools.map((pool) => pool.closeAll()));
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function fixture(count = 32, parallelism = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-resume-'));
  const raw = path.join(dir, 'raw'); fs.mkdirSync(raw);
  const outputRoot = path.join(dir, 'standard');
  const config = new ConfigManager(path.join(dir, 'config.json')); await config.load();
  await config.updateConfig({ knowledgeBaseRoot: raw,
    agent: { runtime: { backend: 'pi' }, model: { source: 'pi-agent-dir', piModel: 'fixture/model' }, maxConcurrentProcesses: 3 },
    standardKb: { outputRoot, buildParallelism: parallelism, buildBatchSize: 10, buildBatchWordBudget: 0 },
  } as never);
  const store = new LocalMapStore(path.join(dir, 'db.sqlite')); store.initialize();
  const pools: AgentProcessPool[] = []; fixtures.push({ dir, store, pools });
  const body = '角色每回合可行动一次，行动结束进入结算。'.repeat(20);
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const imageHash = crypto.createHash('sha256').update(image).digest('hex');
  fs.writeFileSync(path.join(raw, 'figure.png'), image);
  const tokens = Array.from({ length: count }, (_, i) => `tok${String(i).padStart(2, '0')}`);
  for (const token of tokens) {
    const relPath = parallelism > 1 ? `分类${Math.floor(tokens.indexOf(token) / 10)}/${token}.md` : `${token}.md`;
    fs.mkdirSync(path.dirname(path.join(raw, relPath)), { recursive: true });
    fs.writeFileSync(path.join(raw, relPath), `${body}\n![流程](${parallelism > 1 ? '../' : ''}figure.png)`);
    store.upsertDocument({ objToken: token, title: '行动规则', objType: 'docx', wikiNodeToken: null, localRelPath: relPath,
      localMdPath: path.join(raw, relPath), lastSyncedAt: new Date().toISOString(), lastSyncedModifyTime: '', status: 'synced' } as DocumentRecord);
  }
  const describeMany = vi.fn(async (items: Array<{ src: string }>) => new Map(items.map(({ src }) => [src, { src, imageHash, state: 'described' as const, text: '角色依次执行行动与结算。' }])));
  const vision: VisionDescriberLike = { describeMany, lookup: async () => null, describeOne: vi.fn(), status: async () => ({ state: 'ready', model: 'fixture/vision', message: '' }) };
  const resolver = { checkReadiness: async () => ({ code: 'ready', model: { model: 'fixture/model' } }),
    resolveRuntime: async () => ({ nodePath: 'fixture', piCliPath: 'fixture', piPackageRoot: '' }) } as unknown as PiRuntimeResolver;
  const excluded: string[] = [];
  const unselected: string[] = [];
  const prompts: Array<{ generation: number; text: string }> = [];
  const written: string[] = [];
  let generation = 0; let failAt = 2; let batchCount = 0; let allowFailure = true; let hangOnFailure = false;
  let damageOnFinish = false; let damaged = false;
  const makeService = () => {
    generation += 1; const currentGeneration = generation;
    const pool = new AgentProcessPool({ maxConcurrentProcesses: 3, idleTimeoutMinutes: 10 }); pools.push(pool);
    const documentsProvider = () => store.getAllDocuments();
    const tools = new AgentToolService({ dataRoot: dir, documentsProvider, sheetCsvPaths: () => [] });
    const service = new KbBuildService({ dataRoot: dir, configProvider: () => config.getConfig(), documentsProvider, sheetCsvPaths: () => [],
      excludedSourcesProvider: () => excluded, unselectedSourcesProvider: () => unselected,
      pool, resolver, toolService: tools, internalBaseUrl: () => '', extensionPath: () => null, promptAssets: () => null, visionDescriber: vision,
      processFactory: (options) => {
        const token = String(options.env.FEISHU_SYNC_AGENT_RUN_TOKEN);
        class Fake extends EventEmitter {
          exited = false;
          pending: ((value: RunOutcome) => void) | null = null;
          isExited() { return this.exited; }
          async start() {}
          async sendCommand() { return { success: true }; }
          async abort() { this.pending?.({ outcome: 'aborted' }); this.pending = null; }
          async terminate() { await this.abort(); if (!this.exited) { this.exited = true; this.emit('exit'); } }
          async prompt(text: string): Promise<RunOutcome> {
            prompts.push({ generation: currentGeneration, text });
            if (text.includes('请处理以下')) {
              batchCount += 1;
              const batch = [...text.matchAll(/^\| (tok\d+) \|/gm)].map((match) => match[1]);
              for (const source of batch) {
                await tools.executeTool(token, 'kb_write_doc', { path: `规则/${source}.md`, title: '行动规则', markdown: body,
                  summary: '行动与结算', sources: [source], tags: [] });
                written.push(source);
                if (allowFailure && (parallelism > 1 ? source === 'tok10' : batchCount === failAt)) {
                  if (hangOnFailure) return await new Promise<RunOutcome>((resolve) => { this.pending = resolve; });
                  if (parallelism > 1) await vi.waitFor(() => expect(new BuildCheckpointStore(outputRoot).read(String(store.getActiveKbBuild()!.id))!.unitDone.length).toBeGreaterThan(0), { timeout: 5000, interval: 5 });
                  return { outcome: 'failed', error: { code: parallelism > 1 ? 'fixture_fatal' : 'pi_process_exited', message: '受控模拟进程中断' } };
                }
              }
              if (text.includes('本批是本单元最后一批')) await tools.executeTool(token, 'kb_unit_done', { summary: '单元完成', skipped: [] });
            } else if (text.includes('kb_unit_done') && !text.includes('kb_finish')) {
              await tools.executeTool(token, 'kb_unit_done', { summary: '单元完成', skipped: [] });
            } else if (text.includes('kb_finish')) {
              if (damageOnFinish || damaged) {
                await tools.executeTool(token, 'kb_write_doc', { path: '规则/tok00.md', title: '行动规则', markdown: damageOnFinish ? body.repeat(100) : body,
                  summary: '行动与结算', sources: ['tok00'], tags: [] });
                damaged = damageOnFinish;
              }
              await tools.executeTool(token, 'kb_finish', { summary: '整体完成', skipped: [] });
            }
            return { outcome: 'completed' };
          }
        }
        return new Fake() as unknown as PiRpcProcess;
      },
    });
    const app = new Hono(); app.route('/', kbRoutes({ buildService: service, configManager: config, localMapStore: store, documentsProvider, sheetCsvPaths: () => [] }));
    const request = async (url: string, body?: unknown) => {
      const response = await app.request(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
      return { status: response.status, data: await response.json() as any };
    };
    return { service, request };
  };
  const terminal = async (id: string) => {
    await vi.waitFor(() => expect(['failed', 'published', 'cancelled', 'interrupted']).toContain(store.getKbBuild(id)?.status), { interval: 10, timeout: 10000 });
    return store.getKbBuild(id)!;
  };
  return { dir, raw, config, outputRoot, store, tokens, prompts, written, describeMany, makeService, terminal, excluded, unselected,
    stopFailing: () => { allowFailure = false; }, failOn: (batch: number) => { failAt = batch; }, hangFailure: () => { hangOnFailure = true; }, damageOnFinish: (enabled: boolean) => { damageOnFinish = enabled; } };
}

describe('构建断点继续', () => {
  it('32份文档在第二批写入后中断：重启恢复完整草稿、跳过第一批、图片不重新识别，最终发布全部文档', async () => {
    const f = await fixture(); const first = f.makeService();
    const accepted = await first.request('/api/kb/builds', { mode: 'full', confirm: 'BUILD' }); expect(accepted.status).toBe(202);
    const id = accepted.data.id;
    const failed = await f.terminal(id);
    expect(failed.status).toBe('failed');
    expect(failed.error_code, String(failed.error_message)).toBe('pi_process_exited');
    const checkpoints = new BuildCheckpointStore(f.outputRoot);
    const saved = checkpoints.read(id)!;
    expect(saved.singleCompleted).toBe(1); expect(saved.singleBatches).toHaveLength(4);
    expect(saved.writtenPaths).toHaveLength(11); expect(saved.docMeta).toHaveLength(11);
    const descriptionCalls = f.describeMany.mock.calls.length;
    expect(new StandardKbStore(f.outputRoot).readCurrent()).toBeNull();
    const savedDoc = path.join(f.outputRoot, '.staging', id, 'docs', '规则', 'tok00.md');
    const bytes = fs.readFileSync(savedDoc, 'utf8');
    f.store.updateKbBuild(id, { status: 'running', finishedAt: null }); // 进程退出前的数据库状态
    const restarted = f.makeService(); restarted.service.reconcileOnStartup(f.store);
    expect(f.store.getKbBuild(id)?.status).toBe('interrupted');
    expect(fs.readFileSync(savedDoc, 'utf8')).toBe(bytes);
    const detail = await restarted.request(`/api/kb/builds/${id}`);
    expect(detail.data.recovery).toMatchObject({ canResume: true, draftCount: 11, completedBatches: 1, totalBatches: 4 });
    const history = await restarted.request(`/api/kb/builds/${id}/logs`);
    expect(history.data.events.some((event: any) => event.event === 'tool')).toBe(true);
    f.stopFailing();
    expect((await restarted.request(`/api/kb/builds/${id}/resume`, {})).status).toBe(400);
    const resumedResponse = await restarted.request(`/api/kb/builds/${id}/resume`, { confirm: 'RESUME' });
    expect(resumedResponse.status).toBe(202);
    expect(resumedResponse.data.eventSeq).toBeGreaterThan(history.data.events.at(-1).seq);
    expect(restarted.service.eventsSince(id, resumedResponse.data.eventSeq).some((event) => event.event === 'build_status' && (event.data as { status: string }).status === 'failed')).toBe(false);
    expect((await f.terminal(id)).status).toBe('published');
    const resumed = f.prompts.filter((prompt) => prompt.generation === 2 && prompt.text.includes('请处理以下'));
    expect(resumed).toHaveLength(3); expect(resumed[0].text).toContain('断点继续');
    expect(resumed.every(({ text }) => !text.includes('| tok00 |'))).toBe(true);
    expect(f.written.filter((token) => token === 'tok00')).toHaveLength(1);
    expect(f.describeMany).toHaveBeenCalledTimes(descriptionCalls);
    const kb = new StandardKbStore(f.outputRoot), manifest = kb.readManifest()!;
    expect(manifest.docs).toHaveLength(32); expect(manifest.sourceSnapshot).toHaveLength(32);
    expect(fs.readFileSync(path.join(f.outputRoot, 'releases', manifest.releaseId, 'docs', '规则', 'tok00.md'), 'utf8')).toBe(bytes);
    const events = restarted.service.eventsSince(id, null);
    expect(events.every((event, index) => !index || event.seq > events[index - 1].seq)).toBe(true);
  });

  it.each(['changed', 'excluded', 'version', 'tampered'] as const)('恢复前拒绝%s输入，不调用模型也不修改发布指针', async (scenario) => {
    const f = await fixture(12); const first = f.makeService();
    const { data } = await first.request('/api/kb/builds', { mode: 'full', confirm: 'BUILD' }); await f.terminal(data.id);
    if (scenario === 'changed') fs.appendFileSync(path.join(f.raw, 'tok00.md'), '变更');
    if (scenario === 'excluded') f.excluded.push('tok00');
    if (scenario === 'version') fs.writeFileSync(path.join(f.outputRoot, 'CURRENT.json'), JSON.stringify({ releaseId: 'r_other', publishedAt: new Date().toISOString() }));
    if (scenario === 'tampered') {
      const cpDir = path.join(f.outputRoot, '.builds', data.id, 'checkpoints');
      const pointer = JSON.parse(fs.readFileSync(path.join(cpDir, 'CURRENT.json'), 'utf8'));
      fs.appendFileSync(path.join(cpDir, pointer.generation, 'docs', '规则', 'tok00.md'), '损坏');
    }
    const calls = f.prompts.length; const next = f.makeService();
    const response = await next.request(`/api/kb/builds/${data.id}/resume`, { confirm: 'RESUME' });
    expect(response.status).toBe(409); expect(f.prompts).toHaveLength(calls);
    expect(new StandardKbStore(f.outputRoot).readCurrent()?.releaseId ?? null).toBe(scenario === 'version' ? 'r_other' : null);
  });

  it('旧版本无检查点时明确说明，仍可读取历史日志；不伪造可继续状态', async () => {
    const f = await fixture(1); const { service, request } = f.makeService();
    f.store.createKbBuild({ id: 'b_legacy', mode: 'full', status: 'interrupted', baseReleaseId: null, model: null, createdAt: new Date().toISOString() });
    expect(service.toDto(f.store.getKbBuild('b_legacy')!).recovery).toMatchObject({ canResume: false, reason: expect.stringContaining('图片缓存') });
    expect((await request('/api/kb/builds/b_legacy/resume', { confirm: 'RESUME' })).status).toBe(409);
  });

  it('保留已提交检查点：暂存目录丢失后可恢复，旧目录清理不会删除可恢复草稿', async () => {
    const f = await fixture(12); const { request } = f.makeService();
    const { data } = await request('/api/kb/builds', { mode: 'full', confirm: 'BUILD' }); await f.terminal(data.id);
    const stage = path.resolve(f.outputRoot, '.staging', data.id);
    expect(stage.startsWith(path.resolve(f.dir) + path.sep)).toBe(true);
    for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(f.outputRoot, '.staging', `orphan-${i}`));
    cleanupOldStaging(f.outputRoot); expect(fs.existsSync(stage)).toBe(true);
    fs.rmSync(stage, { recursive: true });
    f.stopFailing(); const next = f.makeService();
    expect((await next.request(`/api/kb/builds/${data.id}/resume`, { confirm: 'RESUME' })).status).toBe(202);
    const result = await f.terminal(data.id);
    expect(result.status, String(result.error_message)).toBe('published');
  });

  it('并行构建保留已完成单元与路径认领，恢复只执行未完成单元', async () => {
    const f = await fixture(20, 2); const initial = f.makeService();
    const { data } = await initial.request('/api/kb/builds', { mode: 'full', confirm: 'BUILD' });
    const failed = await f.terminal(data.id); expect(failed.error_code, String(failed.error_message)).toBe('kb_unit_failed');
    const cp = new BuildCheckpointStore(f.outputRoot).read(data.id)!;
    expect(cp.unitDone).toHaveLength(1); expect(cp.claims.length).toBeGreaterThanOrEqual(11);
    const completed = cp.units.find((unit) => unit.id === cp.unitDone[0][0])!;
    f.stopFailing(); const restarted = f.makeService();
    expect((await restarted.request(`/api/kb/builds/${data.id}/resume`, { confirm: 'RESUME' })).status).toBe(202);
    const final = await f.terminal(data.id); expect(final.status, String(final.error_message)).toBe('published');
    const resumed = f.prompts.filter((prompt) => prompt.generation === 2 && prompt.text.includes('请处理以下'));
    expect(resumed).toHaveLength(1);
    expect(completed.sources.every((token) => !resumed[0].text.includes(`| ${token} |`))).toBe(true);
    expect(new StandardKbStore(f.outputRoot).readManifest()!.docs).toHaveLength(20);
  });

  it('检查点复制中途失败不会推进指针，下一次成功保存保留真正的上一代', async () => {
    const f = await fixture(12); const initial = f.makeService();
    const { data } = await initial.request('/api/kb/builds', { mode: 'full', confirm: 'BUILD' }); await f.terminal(data.id);
    const checkpoints = new BuildCheckpointStore(f.outputRoot); const state = checkpoints.read(data.id)!;
    const cpDir = path.join(f.outputRoot, '.builds', data.id, 'checkpoints');
    const pointerFile = path.join(cpDir, 'CURRENT.json'), before = fs.readFileSync(pointerFile, 'utf8');
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => { throw new Error('fixture disk write failed'); });
    expect(() => checkpoints.save(state, path.join(f.outputRoot, '.staging', data.id))).toThrow('fixture disk write failed');
    copy.mockRestore();
    expect(fs.readFileSync(pointerFile, 'utf8')).toBe(before); expect(checkpoints.read(data.id)!.writtenPaths).toHaveLength(11);
    checkpoints.save(state, path.join(f.outputRoot, '.staging', data.id));
    const generations = fs.readdirSync(cpDir).filter((name) => name.startsWith('cp_'));
    expect(generations).toHaveLength(2); expect(generations).toContain(JSON.parse(before).generation);
  });

  it('所选文档的增量构建中断后继续，保留原有标准库与文档身份', async () => {
    const f = await fixture(13); const initial = f.makeService();
    f.unselected.push(...f.tokens.slice(1));
    const first = await initial.request('/api/kb/builds', { mode: 'incremental', confirm: 'BUILD', rebuildSelected: true });
    expect((await f.terminal(first.data.id)).status).toBe('published');
    const kb = new StandardKbStore(f.outputRoot); const base = kb.readManifest()!;
    const oldDoc = base.docs[0]; const oldBytes = fs.readFileSync(path.join(f.outputRoot, 'releases', base.releaseId, 'docs', oldDoc.path), 'utf8');
    f.unselected.splice(0, f.unselected.length, 'tok00'); f.failOn(3);
    const second = await initial.request('/api/kb/builds', { mode: 'incremental', confirm: 'BUILD', rebuildSelected: true });
    const failed = await f.terminal(second.data.id); expect(failed.error_code, String(failed.error_message)).toBe('pi_process_exited');
    expect(kb.readCurrent()!.releaseId).toBe(base.releaseId);
    f.stopFailing(); const restarted = f.makeService();
    expect((await restarted.request(`/api/kb/builds/${second.data.id}/resume`, { confirm: 'RESUME' })).status).toBe(202);
    const final = await f.terminal(second.data.id); expect(final.status, String(final.error_message)).toBe('published');
    const manifest = kb.readManifest()!;
    expect(manifest.docs).toHaveLength(13); expect(manifest.docs.find((doc) => doc.path === oldDoc.path)?.docId).toBe(oldDoc.docId);
    expect(fs.readFileSync(path.join(f.outputRoot, 'releases', manifest.releaseId, 'docs', oldDoc.path), 'utf8')).toBe(oldBytes);
  });

  it('取消时保留最新完整草稿，可在重启后继续', async () => {
    const f = await fixture(12); f.hangFailure(); const initial = f.makeService();
    const { data } = await initial.request('/api/kb/builds', { mode: 'full', confirm: 'BUILD' });
    await vi.waitFor(() => expect(f.written).toHaveLength(11), { timeout: 5000 });
    expect((await initial.request(`/api/kb/builds/${data.id}/cancel`, {})).status).toBe(200);
    expect((await f.terminal(data.id)).status).toBe('cancelled');
    f.stopFailing(); const restarted = f.makeService();
    expect((await restarted.request(`/api/kb/builds/${data.id}/resume`, { confirm: 'RESUME' })).status).toBe(202);
    const final = await f.terminal(data.id); expect(final.status, String(final.error_message)).toBe('published');
  });

  it('长构建日志采用有界内存且序号递增，释放内存后仍能从磁盘读取最近日志', async () => {
    const f = await fixture(12); const initial = f.makeService();
    const { data } = await initial.request('/api/kb/builds', { mode: 'full', confirm: 'BUILD' }); await f.terminal(data.id);
    const internals = initial.service as unknown as { emitLog: (id: string, level: string, text: string) => void; active: Map<string, unknown> };
    const oldSeq = initial.service.eventsSince(data.id, null).at(-1)!.seq;
    for (let i = 0; i < 1100; i++) internals.emitLog(data.id, 'info', `进度 ${i}`);
    const events = initial.service.eventsSince(data.id, null); expect(events).toHaveLength(1000);
    expect(events.at(-1)!.seq).toBe(oldSeq + 1100);
    internals.active.delete(data.id);
    expect(initial.service.eventsSince(data.id, oldSeq + 1099)).toEqual(events.slice(-1));
  });

  it('校验失败后保留已完成批次，将上次问题交给收尾轮修复，通过后清理过期报告', async () => {
    const f = await fixture(1); f.damageOnFinish(true); const initial = f.makeService();
    const { data } = await initial.request('/api/kb/builds', { mode: 'full', confirm: 'BUILD' });
    expect((await f.terminal(data.id)).error_code).toBe('kb_validation_failed');
    expect(new BuildCheckpointStore(f.outputRoot).read(data.id)!.finishInfo).not.toBeNull();
    f.damageOnFinish(false); const next = f.makeService();
    expect((await next.request(`/api/kb/builds/${data.id}/resume`, { confirm: 'RESUME' })).status).toBe(202);
    const final = await f.terminal(data.id); expect(final.status, String(final.error_message)).toBe('published');
    const prompts = f.prompts.filter((prompt) => prompt.generation === 2);
    expect(prompts).toHaveLength(1); expect(prompts[0].text).toContain('total_too_large');
    expect((await next.request(`/api/kb/builds/${data.id}`)).data.report).toBeUndefined();
  });
});
