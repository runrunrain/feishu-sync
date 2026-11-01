/**
 * 派发守卫纯函数测试（设计v2 §3.4）
 *
 * 参数形状对齐 amagi SubmitParams/ResumeParams（2.21.31 task-facets.ts）。
 * 覆盖：角色白名单、模型冻结、shell deny、写面/报告面冻结、禁区追加、
 * 精确 MCP 名单、workspace 固定、resume 仅校验模型。
 */

import { describe, expect, it } from 'vitest';
import {
  DISPATCH_GUARD_SCHEMA_VERSION, freezeGuardConfig, guardTaskResume, guardTaskSubmit,
  validateGuardConfig, type FrozenDispatchConfig,
} from '../src/agent/build-runtime/dispatch-guard.js';
import { createHash } from 'node:crypto';

const WORK_DIR = '/data/builds/b_demo/work';

function makeConfig(overrides: Partial<FrozenDispatchConfig> = {}): FrozenDispatchConfig {
  return freezeGuardConfig({
    buildId: 'b_demo',
    generation: 2,
    workDir: WORK_DIR,
    forbiddenZones: ['/data/config.json', '/data/raw-lib', `${WORK_DIR}/amagi.json`, `${WORK_DIR}/.pi`],
    roles: {
      luban: { key: 'writer', models: ['zhipuai/glm-5.3-flash:low'], mcpTools: ['kb_read_sources', 'kb_submit_draft', 'kb_submit_review'] },
      diting: { key: 'reviewer', models: ['zhipuai/glm-5.3'], mcpTools: ['kb_read_sources', 'kb_submit_review'] },
      baize: { key: 'research', models: ['zhipuai/glm-5.3'], mcpTools: ['kb_read_sources'] },
    },
    ...overrides,
  });
}

describe('validateGuardConfig / freezeGuardConfig', () => {
  it('合法配置通过；非法配置抛错并指出问题', () => {
    expect(validateGuardConfig(makeConfig())).toEqual([]);
    expect(() => freezeGuardConfig({
      buildId: 'b_x', generation: 1, workDir: 'relative/path', forbiddenZones: [],
      roles: { luban: { key: 'writer', models: [], mcpTools: [] } },
    })).toThrow('workDir');
  });

  it('schemaVersion 冻结', () => {
    expect(makeConfig().schemaVersion).toBe(DISPATCH_GUARD_SCHEMA_VERSION);
  });
});

describe('guardTaskSubmit', () => {
  it('合法派发：冻结 shell/write/mcp/workspace，禁区覆写，产出审计', () => {
    const config = makeConfig();
    const result = guardTaskSubmit(config, {
      agent: 'luban',
      task: '写作任务书',
      model: 'zhipuai/glm-5.3-flash:low',
      scope: {
        shell: 'guarded',
        read: ['/any'],
        write: ['agent-outputs/report.md', '/tmp/evil.txt'],
        deny: ['/extra-deny'],
        mcp: ['kb_read_sources', 'wildcard_tool'],
        lsp: ['diagnostics'],
        advisor: 'consult',
      },
      workspace: { cwd: '/elsewhere', mode: 'worktree', worktreeName: 'evil' },
      profile: 'expert',
      outputs: ['agent-outputs/out1.md', '/etc/passwd'],
    });
    expect(result.decision).toBe('allow');
    if (result.decision !== 'allow') return;
    const scope = result.args.scope as Record<string, unknown>;
    expect(scope.shell).toBe('deny');
    expect(scope.write).toEqual(['agent-outputs/**', 'agent-outputs/report.md'].sort());
    expect(scope.mcp).toEqual(['kb_read_sources', 'kb_submit_draft', 'kb_submit_review']);
    expect(scope.deny).toEqual(config.forbiddenZones.slice().sort()); // 覆写：模型自加 deny 被替换
    expect(scope.lsp).toBeUndefined();
    expect(scope.advisor).toBeUndefined();
    const workspace = result.args.workspace as Record<string, unknown>;
    expect(workspace).toEqual({ cwd: WORK_DIR, mode: 'existing' });
    expect(result.args.profile).toBeUndefined();
    expect(result.args.outputs).toEqual(['agent-outputs/out1.md']);
    // 审计：任务书只留哈希
    expect(result.audit.agent).toBe('luban');
    expect(result.audit.roleKey).toBe('writer');
    expect(result.audit.taskSha256).toBe(createHash('sha256').update('写作任务书', 'utf-8').digest('hex'));
    expect(JSON.stringify(result.audit)).not.toContain('写作任务书');
    expect(result.audit.changes.length).toBeGreaterThan(0);
  });

  it('role 不在构建角色表 → 阻止（允许集 = spec.roles，非全部内置角色）', () => {
    const result = guardTaskSubmit(makeConfig(), { agent: 'fuxi', task: 'x' });
    expect(result.decision).toBe('block');
    if (result.decision === 'block') {
      expect(result.code).toBe('dispatch_role_not_allowed');
      expect(result.message).toContain('fuxi');
    }
  });

  it('模型覆盖不在冻结集 → 阻止；在冻结集 → 放行', () => {
    const blocked = guardTaskSubmit(makeConfig(), { agent: 'luban', task: 'x', model: 'zhipuai/glm-5.3' });
    expect(blocked.decision).toBe('block');
    if (blocked.decision === 'block') expect(blocked.code).toBe('dispatch_model_not_frozen');
    const allowed = guardTaskSubmit(makeConfig(), { agent: 'luban', task: 'x', model: 'zhipuai/glm-5.3-flash:low' });
    expect(allowed.decision).toBe('allow');
  });

  it('taskFile 越出工作目录 → 阻止（../ 与绝对路径）', () => {
    expect(guardTaskSubmit(makeConfig(), { agent: 'luban', taskFile: '../escape.md' }).decision).toBe('block');
    expect(guardTaskSubmit(makeConfig(), { agent: 'luban', taskFile: '/etc/passwd' }).decision).toBe('block');
    expect(guardTaskSubmit(makeConfig(), { agent: 'luban', taskFile: 'docs/task.md' }).decision).toBe('allow');
  });

  it('报告写面外条目被剥除（reportFiles 与 write 全量替换语义）', () => {
    const result = guardTaskSubmit(makeConfig(), {
      agent: 'diting',
      task: 'x',
      scope: { reportFiles: ['agent-outputs/r.md', '/var/log/x'], write: ['/var/tmp/y'] },
    });
    expect(result.decision).toBe('allow');
    if (result.decision !== 'allow') return;
    const scope = result.args.scope as Record<string, unknown>;
    expect(scope.reportFiles).toEqual(['agent-outputs/r.md']);
    expect(scope.write).toEqual(['agent-outputs/**']);
  });

  it('模型未传 scope → 仍生成冻结 scope（缺省写面/禁区/mcp）', () => {
    const result = guardTaskSubmit(makeConfig(), { agent: 'baize', task: 'x' });
    expect(result.decision).toBe('allow');
    if (result.decision !== 'allow') return;
    const scope = result.args.scope as Record<string, unknown>;
    expect(scope.shell).toBe('deny');
    expect(scope.mcp).toEqual(['kb_read_sources']);
    expect(scope.deny).toEqual(expect.arrayContaining(['/data/raw-lib']));
    expect(scope.write).toEqual(['agent-outputs/**']);
    // workspace 缺省也固定
    expect(result.args.workspace).toEqual({ cwd: WORK_DIR, mode: 'existing' });
  });

  it('dryRun 派发走同一冻结（预检口径一致）', () => {
    const result = guardTaskSubmit(makeConfig(), { agent: 'luban', task: 'x', dryRun: true, model: 'zhipuai/glm-5.3-flash:low' });
    expect(result.decision).toBe('allow');
    if (result.decision !== 'allow') return;
    expect((result.args.scope as Record<string, unknown>).shell).toBe('deny');
    expect(result.args.dryRun).toBe(true);
  });
});

describe('guardTaskResume', () => {
  it('合法续接放行；权限字段防御性剥离', () => {
    const result = guardTaskResume(makeConfig(), {
      handle: 'task-123', message: '请继续', model: 'zhipuai/glm-5.3', scope: { shell: 'guarded' },
    });
    expect(result.decision).toBe('allow');
    if (result.decision !== 'allow') return;
    expect(result.args.scope).toBeUndefined();
    expect(result.args.model).toBe('zhipuai/glm-5.3');
    expect(result.audit.changes.join()).toContain('删除 scope');
  });

  it('模型覆盖不在任何角色冻结集 → 阻止', () => {
    const result = guardTaskResume(makeConfig(), { handle: 'task-123', message: 'x', model: 'openai/gpt-5' });
    expect(result.decision).toBe('block');
    if (result.decision === 'block') expect(result.code).toBe('dispatch_model_not_frozen');
  });

  it('缺 handle → 阻止', () => {
    expect(guardTaskResume(makeConfig(), { message: 'x' }).decision).toBe('block');
  });
});
