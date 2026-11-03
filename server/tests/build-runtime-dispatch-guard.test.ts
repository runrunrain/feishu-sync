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
import { RUNTIME_INTEGRITY_SCHEMA_VERSION, type RuntimeIntegrityRefs } from '../src/agent/build-runtime/runtime-integrity.js';
import { createHash } from 'node:crypto';

const WORK_DIR = '/data/builds/b_demo/work';

/** F12 完整性引用 fixture（形状合法；触盘核验在 build-runtime-integrity.test 覆盖）。 */
function makeIntegrity(): RuntimeIntegrityRefs {
  return {
    schemaVersion: RUNTIME_INTEGRITY_SCHEMA_VERSION,
    homeDir: '/data/builds/b_demo/home',
    expectedFiles: {
      settings: '{"packages":[]}\n',
      amagi: '{"agents":{}}\n',
      models: '{"providers":{}}\n',
      mcp: '{"mcpServers":{}}\n',
    },
    childPolicy: { fileName: `child-policy-${'a'.repeat(12)}.js`, sha256: 'b'.repeat(64) },
    amagiPackage: { packageRoot: '/data/agent/runtime-packages/amagi-pi@2.21.31/package', contentHash: 'c'.repeat(64) },
    workflowSkill: { path: '/data/skills/kb-build/SKILL.md', sha256: 'd'.repeat(64) },
  };
}

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
    integrity: makeIntegrity(),
    ...overrides,
  });
}

describe('validateGuardConfig / freezeGuardConfig', () => {
  it('合法配置通过；非法配置抛错并指出问题', () => {
    expect(validateGuardConfig(makeConfig())).toEqual([]);
    expect(() => freezeGuardConfig({
      buildId: 'b_x', generation: 1, workDir: 'relative/path', forbiddenZones: [],
      roles: { luban: { key: 'writer', models: [], mcpTools: [] } },
      integrity: makeIntegrity(),
    })).toThrow('workDir');
  });

  it('schemaVersion 冻结（v2：integrity 必填）', () => {
    expect(makeConfig().schemaVersion).toBe(DISPATCH_GUARD_SCHEMA_VERSION);
    expect(DISPATCH_GUARD_SCHEMA_VERSION).toBe(2);
  });

  it('F12：integrity 缺失/形状非法 → 信封整体非法（旧代次信封 fail-closed）', () => {
    const noIntegrity = { ...makeConfig() } as Partial<FrozenDispatchConfig>;
    delete noIntegrity.integrity;
    expect(validateGuardConfig(noIntegrity as FrozenDispatchConfig).join('\n')).toContain('integrity 缺失');
    const badShape = { ...makeConfig(), integrity: { ...makeIntegrity(), childPolicy: { fileName: 'evil.js', sha256: 'zz' } } };
    expect(validateGuardConfig(badShape).join('\n')).toContain('childPolicy.fileName');
    const badHome = { ...makeConfig(), integrity: { ...makeIntegrity(), homeDir: 'relative/home' } };
    expect(validateGuardConfig(badHome).join('\n')).toContain('homeDir');
    expect(() => freezeGuardConfig({
      buildId: 'b_x', generation: 1, workDir: WORK_DIR, forbiddenZones: [],
      roles: { luban: { key: 'writer', models: [], mcpTools: [] } },
      // @ts-expect-error 旧代次输入形状（无 integrity）应被拒
      integrity: undefined,
    })).toThrow('integrity');
  });

  it('F13：workDir 绝对路径判定与宿主平台一致（POSIX 宿主拒绝 Windows 盘符字符串）', () => {
    const windowsWorkDir = {
      buildId: 'b_x', generation: 1, workDir: 'C:\\build\\work', forbiddenZones: [],
      roles: { luban: { key: 'writer', models: [], mcpTools: [] } },
      integrity: makeIntegrity(),
    };
    if (process.platform !== 'win32') {
      // POSIX 宿主：盘符字符串不是本机合法绝对路径 → 拒绝（不把 Windows 字符串当本机路径）
      expect(() => freezeGuardConfig(windowsWorkDir)).toThrow('workDir');
    } else {
      // win32 真机分支（本仓未在 Windows 真机跑过，静态形状断言）
      expect(validateGuardConfig(freezeGuardConfig(windowsWorkDir))).toEqual([]);
    }
  });

  it('F13：分隔符规范化比较——混合分隔符条目不逃逸同目录 workDir（Windows 路径形态数据；非宿主验证）', () => {
    // 绕过 freezeGuardConfig 的宿主平台校验（guardTaskSubmit 不重复校验，只做路径比较）
    const config: FrozenDispatchConfig = { ...makeConfig(), workDir: 'C:\\data\\builds\\b_demo\\work' };
    expect(guardTaskSubmit(config, {
      agent: 'luban', task: 'x',
      workspace: { cwd: 'C:/data/builds/b_demo/work/sub', mode: 'existing' },
    }).decision).toBe('allow');
    const blocked = guardTaskSubmit(config, {
      agent: 'luban', taskFile: 'C:/data/builds/b_demo/work/../escape.md',
    }) as { decision: string };
    expect(blocked.decision).toBe('block');
    const inside = guardTaskSubmit(config, {
      agent: 'luban', taskFile: 'C:\\data\\builds\\b_demo\\work\\docs\\task.md',
    }) as { decision: string };
    expect(inside.decision).toBe('allow');
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
    expect(result.args.delivery).toBe('handle');
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

  it('真实 342 行多章节写作在派发前要求拆分，稀疏引用及审查任务仍可派发', () => {
    const broad = [
      '[当前任务书]',
      '【写作】战斗系统R/部队移动与军阵物理规则.md',
      '主要来源：Lj9DdZpCTozpvkx5MQxcqNHBn2f —— docx，342 行。',
      '跳读坐标：一 L103；1.1 L105；1.2 L111；二 L121；2.1 L125；2.2 L134；2.3 L144；',
      '三 L162；3.1 L166；3.2 L180；四 L198；4.1 L202；4.2 L213；4.3 L223；',
      '4.4 L228；4.5 L241；五 L258；5.1 L262；5.2 L269；5.3 L283；六 L298；',
      '6.1 L302；6.2 L318；6.3 L332。',
    ].join('\n');
    const blocked = guardTaskSubmit(makeConfig(), { agent: 'luban', task: broad });
    expect(blocked.decision).toBe('block');
    if (blocked.decision === 'block') {
      expect(blocked.code).toBe('dispatch_writer_scope_too_broad');
      expect(blocked.message).toContain('100–150 行');
      expect(JSON.stringify(blocked.audit)).not.toContain('部队移动');
    }
    const splitButStillDense = guardTaskSubmit(makeConfig(), { agent: 'luban', task: [
      '【写作】军阵流体物理与配置',
      '四 L198、4.1 L202、4.2 L213、4.3 L223、4.4 L228、4.5 L241、',
      '五 L258、5.1 L262、5.2 L269、5.3 L283、六 L298、6.1 L302、6.2 L318、6.3 L332',
    ].join('\n') });
    expect(splitButStillDense.decision).toBe('block');
    const narrow = guardTaskSubmit(makeConfig(), { agent: 'luban', task: '【写作】部队指挥规则：二 L121、2.1 L125、2.2 L134、2.3 L144' });
    expect(narrow.decision).toBe('allow');
    const sparse = guardTaskSubmit(makeConfig(), { agent: 'luban', task: '【写作】方阵：参考定义 L100；目标规则 L900' });
    expect(sparse.decision).toBe('allow');
    expect(guardTaskSubmit(makeConfig(), { agent: 'diting', task: broad }).decision).toBe('allow');
  });

  it('同源多篇审查在派发前拆为单篇，精确单篇范围放行', () => {
    const grouped = [
      '【独立审查】部队移动验证两篇草稿',
      '审查对象：',
      '1. 战斗系统R/部队移动验证部队与军团规则.md',
      '2. 战斗系统R/部队移动验证军阵流体与碰撞规则.md',
      'kb_submit_review：coverage.docPaths=上述 2 个完整路径',
    ].join('\n');
    const blocked = guardTaskSubmit(makeConfig(), { agent: 'diting', task: grouped });
    expect(blocked.decision).toBe('block');
    if (blocked.decision === 'block') expect(blocked.code).toBe('dispatch_reviewer_scope_too_broad');
    const multiple = guardTaskSubmit(makeConfig(), { agent: 'diting', task: '【独立审查】coverage.docPaths=["A.md","B.md"]' });
    expect(multiple.decision).toBe('block');
    const misleading = guardTaskSubmit(makeConfig(), { agent: 'diting', task: grouped.replace('上述 2 个完整路径', '["战斗系统R/部队移动验证部队与军团规则.md"]') });
    expect(misleading.decision).toBe('block');
    const one = guardTaskSubmit(makeConfig(), { agent: 'diting', task: '【独立审查】审查对象：A.md\nkb_submit_review：coverage.docPaths=["A.md"]' });
    expect(one.decision).toBe('allow');
    const literalWording = guardTaskSubmit(makeConfig(), { agent: 'diting', task: '【独立审查】审查对象：A.md\n提交：kb_submit_review，coverage.docPaths 字面 = ["A.md"]' });
    expect(literalWording.decision).toBe('allow');
    const literalMultiple = guardTaskSubmit(makeConfig(), { agent: 'diting', task: '【独立审查】coverage.docPaths 字面 = ["A.md", "B.md"]' });
    expect(literalMultiple.decision).toBe('block');
    expect(guardTaskSubmit(makeConfig(), { agent: 'diting', taskFile: 'docs/review-task.md' }).decision).toBe('block');
  });

  it('明确要求通读长源的写作任务即使未列章节坐标也被拦截', () => {
    const blocked = guardTaskSubmit(makeConfig(), {
      agent: 'luban', task: '【写作】整篇规则。主要来源：docx 文档，342 行。请覆盖全文后一次写入。',
    });
    expect(blocked.decision).toBe('block');
    if (blocked.decision === 'block') expect(blocked.code).toBe('dispatch_writer_scope_too_broad');
  });

  it('少量锚点但跨三张大表累计 629 行的写作任务也在启动前拦截', () => {
    const blocked = guardTaskSubmit(makeConfig(), { agent: 'luban', task: [
      '【写作】人塔寨补给与克制机制',
      '②Concept 子表 L1428-1652；③-1 分析拆解 L1655-1858；日志 L3506-3705。',
      '正文归纳克制原则、补给状态和版本变化，提交完整文档。',
    ].join('\n') });
    expect(blocked.decision).toBe('block');
    if (blocked.decision === 'block') expect(blocked.message).toContain('629 行');
    const imported = guardTaskSubmit(makeConfig(), { agent: 'luban', task: '【写作】明细表 L1-600，使用 csvTableImports 服务端导入。' });
    expect(imported.decision).toBe('allow');
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
    expect(result.args.delivery).toBe('handle');
    expect(result.audit.changes.join()).toContain('删除 scope');
  });

  it('等待式续接被改为立即返回句柄，避免运行中的子任务始终只有只读面', () => {
    const result = guardTaskResume(makeConfig(), { handle: 'task-123', message: '请继续', delivery: 'wait' });
    expect(result.decision).toBe('allow');
    if (result.decision === 'allow') expect(result.args.delivery).toBe('handle');
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
