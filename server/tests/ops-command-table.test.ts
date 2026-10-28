/**
 * OPS 命令表（S8）单元测试 — 纯数据模块行为锚定
 *
 *  - 表级不变量：名称唯一、risk 值域、destructive/remote_write 必带 confirm
 *  - request(args) 纯函数：典型参数可构造、禁止路径/互斥参数抛 OpsArgumentError
 *  - fillDefaults：root/llm 缺省注入（纯内存，无 IO）
 */

import { describe, expect, it } from 'vitest';
import {
  OPS_COMMANDS,
  findOpsCommand,
  opsCommandMetadata,
  OpsArgumentError,
  type OpsFillContext,
} from '../src/ops/command-table.js';

const ctx = (knowledgeBaseRoot = '/tmp/kb'): OpsFillContext => ({
  config: {
    knowledgeBaseRoot,
    llm: { openAiCompatBaseUrl: 'https://x', apiKey: 'k', model: 'm', temperature: 0.2, fallbackOnFailure: false, primaryChannel: 'direct' },
  } as OpsFillContext['config'],
});

describe('表级不变量', () => {
  it('命令名唯一', () => {
    const names = OPS_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('risk 值域合法', () => {
    const valid = new Set(['read', 'mutate', 'destructive', 'remote_write']);
    for (const command of OPS_COMMANDS) {
      expect(valid.has(command.risk), command.name).toBe(true);
    }
  });

  it('destructive/remote_write 命令必须登记 confirm', () => {
    for (const command of OPS_COMMANDS) {
      if (command.risk === 'destructive' || command.risk === 'remote_write') {
        expect(command.confirm, `${command.risk} 命令 ${command.name} 缺 confirm`).toBeDefined();
        expect(command.confirm!.field.length, command.name).toBeGreaterThan(0);
        expect(command.confirm!.value.length, command.name).toBeGreaterThan(0);
      }
    }
  });

  it('source.* 已登记（S13）且每条登记 agentExposed', () => {
    for (const command of OPS_COMMANDS) {
      expect(typeof command.agentExposed, command.name).toBe('boolean');
    }
    const names = OPS_COMMANDS.map((c) => c.name);
    for (const expected of ['source.edit-status', 'source.edit', 'source.revert', 'source.push-preview', 'source.push']) {
      expect(names, expected).toContain(expected);
    }
  });

  it('findOpsCommand 命中与未命中', () => {
    expect(findOpsCommand('kb.build')?.risk).toBe('mutate');
    expect(findOpsCommand('no.such')).toBeUndefined();
  });

  it('opsCommandMetadata 剥离函数字段', () => {
    const meta = opsCommandMetadata();
    expect(meta.length).toBe(OPS_COMMANDS.length);
    for (const item of meta) {
      expect((item as Record<string, unknown>).request).toBeUndefined();
      expect((item as Record<string, unknown>).fillDefaults).toBeUndefined();
      expect(item.name).toBeTruthy();
    }
  });
});

describe('request(args) 纯函数', () => {
  it('read 命令空参数可构造且为 GET', () => {
    for (const name of ['status', 'auth.status', 'config.get', 'kb.status', 'kb.changes', 'kb.versions', 'clean.trash.list']) {
      const specs = findOpsCommand(name)!.request({});
      expect(specs.length, name).toBeGreaterThan(0);
      for (const spec of specs) expect(spec.method, name).toBe('GET');
    }
  });

  it('status 聚合四步并带聚合键', () => {
    const specs = findOpsCommand('status')!.request({});
    expect(specs.map((s) => s.key)).toEqual(['health', 'larkCli', 'agent', 'kb']);
  });

  it('kb.build 默认 incremental 且内置 confirm BUILD', () => {
    const [spec] = findOpsCommand('kb.build')!.request({});
    expect(spec.method).toBe('POST');
    expect(spec.path).toBe('/api/kb/builds');
    expect((spec.body as Record<string, unknown>).mode).toBe('incremental');
    expect((spec.body as Record<string, unknown>).confirm).toBe('BUILD');
  });

  it('kb.build full 模式透传', () => {
    const [spec] = findOpsCommand('kb.build')!.request({ mode: 'full' });
    expect((spec.body as Record<string, unknown>).mode).toBe('full');
  });

  it('kb.cancel 路径参数转义', () => {
    const [spec] = findOpsCommand('kb.cancel')!.request({ buildId: 'b_1' });
    expect(spec.path).toBe('/api/kb/builds/b_1/cancel');
  });

  it('clean.orphans：缺省/apply=false → GET 预览；apply=true → POST 带 APPLY', () => {
    const def = findOpsCommand('clean.orphans')!;
    expect(def.request({})[0].method).toBe('GET');
    expect(def.request({ apply: false })[0].method).toBe('GET');
    const applied = def.request({ apply: true })[0];
    expect(applied.method).toBe('POST');
    expect((applied.body as Record<string, unknown>).confirmation).toBe('APPLY');
    // items 透传（可选）
    const withItems = def.request({ apply: true, items: [{ relPath: 'a.md', type: 'file' }] })[0];
    expect((withItems.body as Record<string, unknown>).items).toEqual([{ relPath: 'a.md', type: 'file' }]);
  });

  it('clean.trash.purge：objToken / all 二选一，互斥即拒', () => {
    const def = findOpsCommand('clean.trash.purge')!;
    expect(def.request({ objToken: 'tok1' })[0].query).toEqual({ obj_token: 'tok1' });
    expect(def.request({ all: true })[0].query).toEqual({ all: '1' });
    expect(() => def.request({})).toThrowError(OpsArgumentError);
    expect(() => def.request({ objToken: 'a', all: true })).toThrowError(OpsArgumentError);
  });

  it('clean.trash.restore 映射 obj_token snake 字段', () => {
    const [spec] = findOpsCommand('clean.trash.restore')!.request({ objToken: 't' });
    expect(spec.body).toEqual({ obj_token: 't' });
  });

  it('kb.sources.cleanup 内置 CLEANUP 确认与 sources 清单', () => {
    const [spec] = findOpsCommand('kb.sources.cleanup')!.request({ sources: [{ objToken: 'a', relPath: 'a.md' }] });
    expect((spec.body as Record<string, unknown>).confirm).toBe('CLEANUP');
    expect(spec.method).toBe('POST');
    expect(() => findOpsCommand('kb.sources.cleanup')!.request({})).toThrowError(OpsArgumentError);
  });
});

describe('source.* 命令（S13 登记）', () => {
  it('风险级与 confirm 登记与任务书一致', () => {
    expect(findOpsCommand('source.edit-status')).toMatchObject({ risk: 'read' });
    expect(findOpsCommand('source.push-preview')).toMatchObject({ risk: 'read' });
    expect(findOpsCommand('source.edit')).toMatchObject({ risk: 'mutate', confirm: { field: 'confirm', value: 'EDIT' } });
    expect(findOpsCommand('source.revert')).toMatchObject({ risk: 'mutate', confirm: { field: 'confirm', value: 'REVERT' } });
    expect(findOpsCommand('source.push')).toMatchObject({ risk: 'remote_write', confirm: { field: 'confirm', value: 'PUSH' } });
  });

  it('source.edit-status / push-preview 映射到 S11/S12 路由且为只读语义', () => {
    const [status] = findOpsCommand('source.edit-status')!.request({ objToken: 'tok A' });
    expect(status.method).toBe('GET');
    expect(status.path).toBe('/api/sources/tok%20A/edit-status');

    const [preview] = findOpsCommand('source.push-preview')!.request({ objToken: 'tok' });
    expect(preview.method).toBe('POST');
    expect(preview.path).toBe('/api/sources/tok/push/preview');
  });

  it('source.edit：newText/op 二选一，互斥与缺失均拒；body 内置 EDIT + actor', () => {
    const def = findOpsCommand('source.edit')!;
    const [viaText] = def.request({ objToken: 't', baseHash: 'h1', newText: '# 新正文\n' });
    expect(viaText.method).toBe('POST');
    expect(viaText.path).toBe('/api/sources/t/edit');
    expect(viaText.body).toEqual({ newText: '# 新正文\n', baseHash: 'h1', confirm: 'EDIT', actor: 'cli' });

    const [viaOp] = def.request({ objToken: 't', baseHash: 'h1', op: { mode: 'str_replace', old: 'a', new: 'b' } });
    expect((viaOp.body as Record<string, unknown>).op).toEqual({ mode: 'str_replace', old: 'a', new: 'b' });
    expect((viaOp.body as Record<string, unknown>).newText).toBeUndefined();

    expect(() => def.request({ objToken: 't', baseHash: 'h1' })).toThrowError(OpsArgumentError);
    expect(() => def.request({ objToken: 't', baseHash: 'h1', newText: 'x', op: { mode: 'replace_body', body: 'x' } })).toThrowError(OpsArgumentError);
    expect(() => def.request({ objToken: 't', baseHash: 'h1', op: 'not-an-object' })).toThrowError(OpsArgumentError);
    expect(() => def.request({ objToken: 't', newText: 'x' })).toThrowError(OpsArgumentError);
  });

  it('source.revert：REVERT 确认内置', () => {
    const [spec] = findOpsCommand('source.revert')!.request({ objToken: 't' });
    expect(spec.body).toEqual({ confirm: 'REVERT', actor: 'cli' });
  });

  it('source.push：confirm 按 allowOverwrite/force 派生（PUSH ↔ OVERWRITE_CLOUD）', () => {
    const def = findOpsCommand('source.push')!;
    const [append] = def.request({ objToken: 't' });
    expect(append.body).toEqual({ allowOverwrite: false, force: false, confirm: 'PUSH', actor: 'cli' });

    const [overwrite] = def.request({ objToken: 't', allowOverwrite: true });
    expect((overwrite.body as Record<string, unknown>).confirm).toBe('OVERWRITE_CLOUD');
    expect((overwrite.body as Record<string, unknown>).allowOverwrite).toBe(true);

    const [forced] = def.request({ objToken: 't', force: true });
    expect((forced.body as Record<string, unknown>).confirm).toBe('OVERWRITE_CLOUD');
    expect((forced.body as Record<string, unknown>).force).toBe(true);
  });

  it('T3e-R3-01：source.push confirmPlan previewSpecs 与实际执行同参（force 时 preview body 携带 force）', () => {
    const def = findOpsCommand('source.push')!;
    // 非 force：preview 不带 body（路由缺省 force=false，向后兼容）
    const plain = def.confirmPlan!.previewSpecs({ objToken: 'tokA' });
    expect(plain).toEqual([{ method: 'POST', path: '/api/sources/tokA/push/preview' }]);
    // force：preview 请求体携带 force——服务端时间门降为 warning，
    // 批准卡可派生 OVERWRITE_CLOUD（见 source-push 全链测试）
    const forced = def.confirmPlan!.previewSpecs({ objToken: 'tokA', force: true });
    expect(forced[0].body).toEqual({ force: true });
    // force 不可越过权限/内容类 blocker：preview 仍 blocked 时派生一律拒绝
    expect(() => def.confirmPlan!.deriveConfirm(
      { mode: 'blocked', blockedReason: 'write_scope_missing' }, { force: true },
    )).toThrowError(/不可推送/);
    // force + 可行计划（时间门已降为 warning）→ OVERWRITE_CLOUD
    expect(def.confirmPlan!.deriveConfirm({ mode: 'append' }, { force: true })).toBe('OVERWRITE_CLOUD');
  });
});

describe('cloud.* 命令（P0-S4 登记）', () => {
  it('风险级 / confirm / agentExposed 与任务书一致（destructive 必带 confirm → CLI 无 --yes 拒）', () => {
    expect(findOpsCommand('cloud.history_list')).toMatchObject({ risk: 'read', agentExposed: true });
    const revert = findOpsCommand('cloud.revert')!;
    expect(revert).toMatchObject({
      risk: 'destructive',
      agentExposed: true,
      confirm: { field: 'confirm', value: 'REVERT_CLOUD' }, // 表基线值（CLI --yes 门）
    });
    // destructive → 发非 GET 请求：cli-app 确认预检必生效（无 --yes → 退出码 4）
    const specs = revert.request({ objToken: 't', historyVersionId: '2048' });
    expect(specs.some((spec) => spec.method !== 'GET')).toBe(true);
  });

  it('cloud.history_list：GET 映射；pageToken 透传查询参数', () => {
    const def = findOpsCommand('cloud.history_list')!;
    const [plain] = def.request({ objToken: 'tok' });
    expect(plain).toMatchObject({ method: 'GET', path: '/api/sources/tok/history' });
    expect(plain.query).toBeUndefined();
    const [paged] = def.request({ objToken: 'tok', pageToken: 't2' });
    expect(paged.query).toEqual({ pageToken: 't2' });
    expect(() => def.request({})).toThrowError(OpsArgumentError);
  });

  it('cloud.revert：request() 内置派生确认值 REVERT_CLOUD:<historyVersionId>（锚点 id 必须出现在确认值中）', () => {
    const def = findOpsCommand('cloud.revert')!;
    const [spec] = def.request({ objToken: 'tok', historyVersionId: '2048' });
    expect(spec.method).toBe('POST');
    expect(spec.path).toBe('/api/sources/tok/history-revert');
    expect(spec.body).toEqual({ historyVersionId: '2048', confirm: 'REVERT_CLOUD:2048', actor: 'cli' });
    // 缺参 / 互斥字段形态拒
    expect(() => def.request({ objToken: 'tok' })).toThrowError(OpsArgumentError);
    expect(() => def.request({ historyVersionId: '2048' })).toThrowError(OpsArgumentError);
  });

  it('cloud.revert confirmPlan：previewSpecs 同参；blocked 派生拒绝（history_revert_blocked）；planKey 随目标与警告变化', () => {
    const def = findOpsCommand('cloud.revert')!;
    const [preview] = def.confirmPlan!.previewSpecs({ objToken: 'tokA', historyVersionId: '2048' });
    expect(preview).toEqual({
      method: 'POST',
      path: '/api/sources/tokA/history-revert/preview',
      body: { historyVersionId: '2048' },
    });
    // 可行计划 → 确认值含目标 id
    expect(def.confirmPlan!.deriveConfirm({
      blockedReason: null,
      target: { historyVersionId: '2048', createdAt: null, editorName: null, editorIds: [] },
      warnings: [],
    })).toBe('REVERT_CLOUD:2048');
    // 阻断 → 不产生确认值（也不产生批准请求）
    for (const blockedReason of ['cloud_revert_running', 'history_not_found', 'invalid_target', 'anchor_missing']) {
      expect(() => def.confirmPlan!.deriveConfirm({ blockedReason, target: { historyVersionId: '2048' } }))
        .toThrowError(OpsArgumentError);
    }
    expect(() => def.confirmPlan!.deriveConfirm({ blockedReason: null, target: { historyVersionId: '' } }))
      .toThrowError(/缺少目标版本/);
    // planKey：目标 + 排序后警告集
    const key1 = def.confirmPlan!.planKey({
      target: { historyVersionId: '2048' }, warnings: ['cloud_changed_since_push', 'anchor_inexact'],
    });
    expect(key1).toBe('2048|anchor_inexact,cloud_changed_since_push');
    const key2 = def.confirmPlan!.planKey({
      target: { historyVersionId: '2048' }, warnings: ['anchor_inexact'],
    });
    const key3 = def.confirmPlan!.planKey({
      target: { historyVersionId: '1024' }, warnings: ['anchor_inexact', 'cloud_changed_since_push'],
    });
    expect(key2).not.toBe(key1); // 警告集变化 → 过期
    expect(key3).not.toBe(key1); // 目标变化 → 过期
  });
});

describe('config.set 禁止路径', () => {
  const def = findOpsCommand('config.set')!;

  it('cli 自我提权路径被拒', () => {
    for (const p of ['cli', 'cli.enabled']) {
      expect(() => def.request({ path: p, value: true })).toThrowError(OpsArgumentError);
    }
  });

  it('feishuWrite 被 CLI 通道拒绝（T3b-02：只接受 desktop 修改）', () => {
    for (const p of ['feishuWrite', 'feishuWrite.enabled']) {
      expect(() => def.request({ path: p, value: { enabled: true } })).toThrowError(OpsArgumentError);
    }
  });

  it('LLM 密钥面被拒（整段 / apiKey / providers）', () => {
    for (const p of ['llm', 'llm.apiKey', 'llm.providers', 'llm.providers.0']) {
      expect(() => def.request({ path: p, value: {} })).toThrowError(OpsArgumentError);
    }
  });

  it('agent.workspaces 被拒；普通路径放行', () => {
    expect(() => def.request({ path: 'agent.workspaces', value: [] })).toThrowError(OpsArgumentError);
    expect(() => def.request({ path: 'agent.workspaces.0', value: {} })).toThrowError(OpsArgumentError);
    const [spec] = def.request({ path: 'pollIntervalMinutes', value: 15 });
    expect(spec.method).toBe('PUT');
    expect(spec.body).toEqual({ pollIntervalMinutes: 15 });
  });

  it('缺 path/value 抛 invalid_args', () => {
    expect(() => def.request({ value: 1 })).toThrowError(OpsArgumentError);
    expect(() => def.request({ path: 'a' })).toThrowError(OpsArgumentError);
  });
});

describe('fillDefaults（纯函数，无 IO）', () => {
  it('kb.sources.* 注入当前 knowledgeBaseRoot', () => {
    const def = findOpsCommand('kb.sources.include')!;
    const filled = def.fillDefaults!({ tokens: ['a'] }, ctx('/data/kb'));
    expect(filled.root).toBe('/data/kb');
    // 显式 root 不覆盖
    const kept = def.fillDefaults!({ tokens: ['a'], root: '/other' }, ctx('/data/kb'));
    expect(kept.root).toBe('/other');
  });

  it('llm.test 参数面收窄：只接受 providerId/modelId/timeoutMs 引用（T3b-01）', () => {
    const def = findOpsCommand('llm.test')!;
    expect(Object.keys(def.params.properties).sort()).toEqual(['modelId', 'providerId', 'timeoutMs']);
    // 引用已保存配置：请求体不携带 llm 对象（端点/密钥由 server 解析）
    const [ref] = def.request({ providerId: 'p1', modelId: 'm1', timeoutMs: 2000 });
    expect(ref.method).toBe('POST');
    expect(ref.path).toBe('/api/llm/test-channel');
    expect(ref.body).toEqual({ channel: 'direct', providerId: 'p1', modelId: 'm1', timeoutMs: 2000 });
    // 缺省：不带任何覆盖字段（server 端用已保存的当前激活配置）
    const [plain] = def.request({});
    expect(plain.body).toEqual({ channel: 'direct' });
    // 恶意传入完整 llm 对象：request() 不透传（无法携带端点/密钥覆盖）
    const [attack] = def.request({ llm: { apiKey: '***', providers: [{ id: 'p1', apiKey: '***', openAiCompatBaseUrl: 'https://evil.example/v1' }] } });
    expect(attack.body).toEqual({ channel: 'direct' });
    expect(JSON.stringify(attack.body)).not.toContain('evil.example');
  });
});
