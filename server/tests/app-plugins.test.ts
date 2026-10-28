import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { AppPluginStore } from '../src/agent/app-plugin-store.js';
import { agentPluginRoutes } from '../src/routes/agent-plugins.js';
import { checkRootOverlap } from '../src/agent/path-guard.js';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-plugins-')); roots.push(root);
  const data = path.join(root, 'app'); fs.mkdirSync(data);
  const generic = path.join(root, '.pi', 'agent'); fs.mkdirSync(generic, { recursive: true });
  fs.writeFileSync(path.join(generic, 'settings.json'), '{"extensions":["generic-plugin"]}');
  const store = new AppPluginStore(data, () => ({ buildRules: 'BUILD_RULES', styleGuide: 'STYLE_GUIDE' }));
  const app = new Hono(); app.route('/', agentPluginRoutes(store));
  const call = async (route: string, method = 'GET', body?: unknown) => {
    const response = await app.request('/api/agent/plugin-contexts' + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() as any };
  };
  return { root, data, generic, store, call };
}

describe('应用专属Pi上下文插件', () => {
  it('默认规则迁移、修改/停用/恢复、进程间持久化，不改通用Pi', async () => {
    const f = fixture();
    const original = fs.readFileSync(path.join(f.generic, 'settings.json'), 'utf8');
    const initial = await f.call(''); expect(initial.status).toBe(200); expect(initial.data.plugins).toHaveLength(5); // S6: +orchestration
    expect(initial.data.plugins.find((p: any) => p.id === 'kb-build-rules').content).toBe('BUILD_RULES');
    const edit = await f.call('/kb-style', 'PUT', { expectedRevision: initial.data.revision, content: 'MY_STYLE', enabled: false });
    expect(edit.status).toBe(200);
    const reloaded = new AppPluginStore(f.data, () => ({ buildRules: 'NEW_BUILD_DEFAULT', styleGuide: 'STYLE_GUIDE' })).list();
    expect(reloaded.plugins.find((p) => p.id === 'kb-style')).toMatchObject({ content: 'MY_STYLE', enabled: false });
    expect(reloaded.plugins.find((p) => p.id === 'kb-build-rules')?.content).toBe('NEW_BUILD_DEFAULT');
    const reset = await f.call('/kb-style/reset', 'POST', { expectedRevision: edit.data.revision });
    expect(reset.data.plugins.find((p: any) => p.id === 'kb-style')).toMatchObject({ content: 'STYLE_GUIDE', enabled: true });
    expect(fs.readFileSync(path.join(f.generic, 'settings.json'), 'utf8')).toBe(original);
    expect(fs.readdirSync(f.generic)).toEqual(['settings.json']);
  });

  it('新增自定义范围、删除、并发版本保护及输入限制', async () => {
    const f = fixture(); const initial = f.store.list();
    const created = await f.call('', 'POST', { expectedRevision: initial.revision, name: '产品术语', content: 'TERM_SENTINEL', scopes: ['discuss', 'work'] });
    expect(created.status).toBe(201); const plugin = created.data.plugins.at(-1);
    expect(plugin).toMatchObject({ builtin: false, enabled: true, kind: 'context' });
    expect((await f.call('/' + plugin.id, 'PUT', { expectedRevision: initial.revision, content: 'STALE' })).status).toBe(409);
    const base = { expectedRevision: created.data.revision };
    for (const input of [{ enabled: 'false' }, { scopes: ['shell'] }, { scopes: [] }, { content: 'a'.repeat(65537) }, { extensionPath: '/tmp/unsafe.js' }]) {
      expect((await f.call('/' + plugin.id, 'PUT', { ...base, ...input })).status).toBe(400);
    }
    expect((await f.call('/kb-style', 'PUT', { ...base, scopes: ['work'] })).status).toBe(400);
    expect((await f.call('/kb-style', 'DELETE', base)).status).toBe(400);
    expect((await f.call('/no-such-plugin', 'PUT', { ...base, enabled: false })).status).toBe(404);
    expect((await f.call('/' + plugin.id, 'DELETE', base)).status).toBe(200);
    expect(f.store.list().plugins).toHaveLength(5); // S6: +orchestration
  });

  it('运行快照按范围冻结；修改仅影响下次运行，不跨范围重启', () => {
    const f = fixture();
    const first = f.store.snapshot('discuss'); const build = f.store.snapshot('build');
    const oldBytes = fs.readFileSync(first.path, 'utf8');
    const current = f.store.list();
    f.store.mutate('update', 'discuss-context', current.revision, { content: 'DISCUSS_V2' });
    const second = f.store.snapshot('discuss');
    expect(second.revision).not.toBe(first.revision); expect(fs.readFileSync(first.path, 'utf8')).toBe(oldBytes);
    expect(fs.readFileSync(second.path, 'utf8')).toContain('DISCUSS_V2');
    expect(f.store.snapshot('build').revision).toBe(build.revision);
    expect(fs.readFileSync(build.path, 'utf8')).toContain('BUILD_RULES');
    expect(fs.readFileSync(build.path, 'utf8')).not.toContain('DISCUSS_V2');
    const next = f.store.list(); f.store.mutate('update', 'discuss-context', next.revision, { enabled: false });
    expect(JSON.parse(fs.readFileSync(f.store.snapshot('discuss').path, 'utf8')).plugins).toEqual([]);
    expect(checkRootOverlap(path.dirname(first.path), { dataRoot: f.data, knowledgeBaseRoot: '', outputRoot: '' }).ok).toBe(false);
  });

  it('配置损坏、快照篡改或目录symlink逃逸时拒绝，不静默加载外部内容', () => {
    const f = fixture(); const snapshot = f.store.snapshot('work');
    fs.writeFileSync(snapshot.path, 'TAMPERED'); expect(() => f.store.snapshot('work')).toThrow('快照被修改');
    fs.writeFileSync(path.join(f.data, 'agent/plugins/registry.json'), '{}');
    expect(() => f.store.list()).toThrow('应用插件配置无效');
    const other = fixture(); fs.mkdirSync(path.join(other.data, 'agent')); fs.symlinkSync(other.generic, path.join(other.data, 'agent/plugins'), 'dir');
    const before = fs.readFileSync(path.join(other.generic, 'settings.json'), 'utf8');
    expect(() => other.store.snapshot('work')).toThrow();
    expect(fs.readFileSync(path.join(other.generic, 'settings.json'), 'utf8')).toBe(before);
  });
});

describe('R2-05：frozenSnapshot 原生资源版本一致性', () => {
  it('nativeRevision 变化 → plugin_snapshot_stale 诚实阻断；一致时返回快照；文件缺失仍 null', () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'app-plugins-r205-'));
    roots.push(dataRoot);
    const native = { sources: ['/x/native-a.js'], revision: 'native_rev_a', external: true };
    const store = new AppPluginStore(dataRoot, undefined, () => native);
    const snapshot = store.snapshot('work');
    expect(snapshot.extensionPaths).toEqual(['/x/native-a.js']);

    // 版本一致：按 revision 复用快照，native 路径与冻结时一致
    const frozen = store.frozenSnapshot('work', snapshot.revision);
    expect(frozen?.revision).toBe(snapshot.revision);
    expect(frozen?.extensionPaths).toEqual(['/x/native-a.js']);

    // 插件原生资源变更（更新/增删包）：旧 revision 快照不能装当前资源执行
    native.revision = 'native_rev_b';
    native.sources = ['/x/native-b.js'];
    expect(() => store.frozenSnapshot('work', snapshot.revision))
      .toThrowError(/plugin_snapshot_stale|原生插件资源已变化/);

    // 未知 revision（快照文件缺失）：既有降级语义（null，不抛）
    expect(store.frozenSnapshot('work', 'deadbeef00')).toBeNull();
  });
});
