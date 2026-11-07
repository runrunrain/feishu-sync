/**
 * 派发守卫纯函数测试（设计v2 §3.4）
 *
 * 参数形状对齐 amagi SubmitParams/ResumeParams（2.21.31 task-facets.ts）。
 * 覆盖：角色白名单、模型冻结、shell deny、写面/报告面冻结、禁区追加、
 * 精确 MCP 名单、workspace 固定、resume 仅校验模型。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DISPATCH_GUARD_SCHEMA_VERSION, DISPATCH_INFLIGHT_STALE_MS, DISPATCH_UNACKED_TTL_MS, freezeGuardConfig, guardTaskResume, guardTaskSubmit,
  resetDispatchGuardAdmissionState, validateGuardConfig, type DispatchInflightSnapshot, type FrozenDispatchConfig,
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

  it('schemaVersion 冻结（v3：integrity 必填 + 可选 dispatch 准入段）', () => {
    expect(makeConfig().schemaVersion).toBe(DISPATCH_GUARD_SCHEMA_VERSION);
    expect(DISPATCH_GUARD_SCHEMA_VERSION).toBe(3);
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

  it('标准模式只提示写作范围，并保留审查 taskFile 围栏', () => {
    const config = makeConfig({ strictGates: false });
    expect(config.strictGates).toBe(false);
    const writer = guardTaskSubmit(config, { agent: 'luban', task: '来源 docx 正文 342 行，请覆盖全文。' });
    expect(writer.decision).toBe('allow');
    expect(writer.audit.changes.some(change => change.startsWith('advisory:'))).toBe(true);
    expect(guardTaskSubmit(config, { agent: 'diting', task: '审查 A.md 与 B.md' }).decision).toBe('allow');
    const reviewerFile = guardTaskSubmit(config, { agent: 'diting', taskFile: 'docs/review.md' });
    expect(reviewerFile.decision).toBe('allow');
    expect(reviewerFile.audit.changes.some(change => change.startsWith('advisory:'))).toBe(true);
    expect(guardTaskSubmit(config, { agent: 'diting', taskFile: '../escape.md' }).decision).toBe('block');
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

  it('输出坐标加多子表不能因提及 csvTableImports 绕过拆分', () => {
    const task = [
      '【写作】人塔寨综合战术工作表：总输出 3707 行。',
      '②Concept 输出 1428–1652；③-1 分析拆解 输出 1655–1858；',
      '③-2 主流程 输出 1861–2060；④Detail-1 规则与交互 输出 2265–2500；',
      '①idea 输出 1226–1425。③-1 明细可用 csvTableImports 导入。',
      '本篇还需归纳概念、主流程、规则、表现和交互，并登记全部子表覆盖。',
    ].join('\n');
    const result = guardTaskSubmit(makeConfig(), { agent: 'luban', task });
    expect(result.decision).toBe('block');
    if (result.decision === 'block') {
      expect(result.code).toBe('dispatch_writer_scope_too_broad');
      expect(result.message).toContain('1065 行');
    }
  });

  it('高密度规则表不能凭可选导入提示绕过分篇', () => {
    const broad = guardTaskSubmit(makeConfig(), { agent: 'luban', task: [
      '【写作】经济体模拟器功能规则，一篇目标文档。',
      '来源：②功能规则.csv，约 267 行、667 个非空单元格。',
      '按输出区间 2296–2562 分页读完，归纳触发条件、参数、流程与边界。',
      '明细行数多且属纯数据清单时可用 kb_write_doc.csvTableImports。',
    ].join('\n') });
    expect(broad.decision).toBe('block');
    if (broad.decision === 'block') expect(broad.message).toContain('667 个非空');
    const imported = guardTaskSubmit(makeConfig(), { agent: 'luban', task:
      '【写作】单张纯明细表，输出 2296–2562，667 个非空单元格；必须使用 csvTableImports 服务端导入全部记录，只解读表头和少量示例。' });
    expect(imported.decision).toBe('allow');
  });

  it('明确通读 272 行正文的写作任务须先分篇', () => {
    const result = guardTaskSubmit(makeConfig(), { agent: 'luban', task:
      '【写作】主界面设计。来源（唯一主要来源，整篇读完）：docx《主界面设计》，约 272 行；raw_read 翻到文末后一次写入。' });
    expect(result.decision).toBe('block');
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

// ── A2 在途派发准入（R2：新写作不拖后修订/复审）─────────────────────

describe('A2 派发准入（dispatch 段 + 在途快照）', () => {
  beforeEach(() => resetDispatchGuardAdmissionState());

  const POOLS = {
    inflightStatePath: '/data/builds/b_demo/epochs/e1/dispatch-inflight.json',
    rolePoolKeys: { writer: 'zhipuai/glm-5.3-flash', reviewer: 'zhipuai/glm-5.3', research: 'zhipuai/glm-5.3' },
    poolCapacities: { 'zhipuai/glm-5.3-flash': 4, 'zhipuai/glm-5.3': 2 },
  };
  const admitConfig = (): FrozenDispatchConfig => makeConfig({ dispatch: { ...POOLS } });
  const samePoolConfig = (capacity: number): FrozenDispatchConfig => makeConfig({
    dispatch: {
      inflightStatePath: POOLS.inflightStatePath,
      rolePoolKeys: { writer: 'zhipuai/glm-5.3-flash', reviewer: 'zhipuai/glm-5.3-flash', research: 'zhipuai/glm-5.3-flash' },
      poolCapacities: { 'zhipuai/glm-5.3-flash': capacity },
    },
  });
  const WRITE_TASK = '【写作】方阵：参考定义 L100；目标规则 L140-L160';
  const REVIEW_TASK = '【独立审查】审查对象：A.md\nkb_submit_review：coverage.docPaths=["A.md"]';

  function snapshot(partial: Partial<DispatchInflightSnapshot> = {}): DispatchInflightSnapshot {
    return {
      schemaVersion: 1,
      buildId: 'b_demo',
      generation: 2,
      seq: 1,
      updatedAt: new Date().toISOString(),
      inflight: [],
      pendingReview: 0,
      pendingRevision: 0,
      ...partial,
    };
  }
  const submitWriter = (config: FrozenDispatchConfig, inflight: DispatchInflightSnapshot | null) =>
    guardTaskSubmit(config, { agent: 'luban', task: WRITE_TASK }, { inflight });
  const submitReviewer = (config: FrozenDispatchConfig, inflight: DispatchInflightSnapshot | null) =>
    guardTaskSubmit(config, { agent: 'diting', task: REVIEW_TASK }, { inflight });
  const resume = (config: FrozenDispatchConfig, inflight: DispatchInflightSnapshot | null) =>
    guardTaskResume(config, { handle: 'task-123', message: '修订回执 krev_1' }, { inflight });

  it('validateGuardConfig：dispatch 形状校验（相对路径/缺角色池映射/容量非正整数）；freezeGuardConfig 非法即抛', () => {
    expect(validateGuardConfig(admitConfig())).toEqual([]);
    // validateGuardConfig 直测（freezeGuardConfig 对非法 dispatch 会先 throw）
    expect(validateGuardConfig({ ...admitConfig(), dispatch: { ...POOLS, inflightStatePath: 'relative/dispatch.json' } })[0]).toContain('inflightStatePath');
    const missingRole = { ...POOLS } as never;
    delete (missingRole as Record<string, unknown>).rolePoolKeys;
    expect(validateGuardConfig({ ...admitConfig(), dispatch: missingRole }).join('\n')).toContain('池映射');
    expect(validateGuardConfig({ ...admitConfig(), dispatch: { ...POOLS, poolCapacities: { 'zhipuai/glm-5.3-flash': 0, 'zhipuai/glm-5.3': 2 } } }).join('\n')).toContain('≥1 整数');
    expect(() => makeConfig({ dispatch: { ...POOLS, inflightStatePath: 'relative/dispatch.json' } })).toThrow('inflightStatePath');
  });

  it('writer 池满拒新写作；reviewer 池独立且有审查放行（互不挤占）', () => {
    // baize 与 diting 同模型（research 池键=reviewer 池键）→ 不占 writer 池
    const full = snapshot({ inflight: [
      { role: 'luban', state: 'running' }, { role: 'luban', state: 'queued' },
      { role: 'luban', state: 'running' }, { role: 'luban', state: 'running' },
    ] });
    const blocked = submitWriter(admitConfig(), full);
    expect(blocked.decision).toBe('block');
    if (blocked.decision === 'block') {
      expect(blocked.code).toBe('dispatch_inflight_write_exhausted');
      expect(blocked.message).toContain('完成通知');
    }
    expect(submitReviewer(admitConfig(), full).decision).toBe('allow');
    // reviewer 池（容量 2）满：审查被拒，但 writer 池空 → 新写作仍放行
    const reviewerFull = snapshot({ inflight: [{ role: 'diting', state: 'running' }, { role: 'diting', state: 'running' }] });
    const reviewBlocked = submitReviewer(admitConfig(), reviewerFull);
    expect(reviewBlocked.decision).toBe('block');
    if (reviewBlocked.decision === 'block') expect(reviewBlocked.code).toBe('dispatch_inflight_pool_saturated');
    expect(submitWriter(admitConfig(), reviewerFull).decision).toBe('allow');
  });

  it('存在待审/待修订文档时新写作最多占容量−1；无积压可占满', () => {
    const config = admitConfig();
    const threeOfFour = snapshot({ inflight: [
      { role: 'luban', state: 'running' }, { role: 'luban', state: 'running' }, { role: 'luban', state: 'running' },
    ] });
    expect(submitWriter(config, threeOfFour).decision).toBe('allow'); // 无积压：占满第 4 槽
    resetDispatchGuardAdmissionState();
    const withBacklog = snapshot({
      inflight: threeOfFour.inflight,
      pendingReview: 1,
    });
    const blocked = submitWriter(config, withBacklog);
    expect(blocked.decision).toBe('block');
    if (blocked.decision === 'block') expect(blocked.message).toContain('保留槽位');
    expect(submitReviewer(config, withBacklog).decision).toBe('allow'); // 审查优先，不受保留槽限制
    expect(resume(config, withBacklog).decision).toBe('allow'); // 修订续接优先
  });

  it('capacity=1：满载全拒；空载+积压 → 拒写作、放行审查与修订；空载无积压 → 放行写作', () => {
    const config = samePoolConfig(1);
    const busy = snapshot({ inflight: [{ role: 'luban', state: 'running' }] });
    expect(submitWriter(config, busy).decision).toBe('block');
    expect(submitReviewer(config, busy).decision).toBe('block');
    expect(resume(config, busy).decision).toBe('block'); // 全池满才拒 resume
    const idleBacklog = snapshot({ pendingRevision: 1 });
    expect(submitWriter(config, idleBacklog).decision).toBe('block');
    // 单槽先到先得：同一轮先派审查后修订时修订等下一轮；此处分别独立评价
    expect(resume(config, idleBacklog).decision).toBe('allow');
    expect(submitReviewer(config, idleBacklog).decision).toBe('allow');
    // 空载无积压时写作可占满（seq 前进重置上一轮审查的未入账计数，独立评价）
    expect(submitWriter(config, snapshot({ seq: 2 })).decision).toBe('allow');
  });

  it('resume：单池满但另一池空 → 放行；全部池满 → 拒', () => {
    const config = admitConfig();
    const writerFullOnly = snapshot({ inflight: [
      { role: 'luban', state: 'running' }, { role: 'luban', state: 'running' },
      { role: 'luban', state: 'running' }, { role: 'luban', state: 'running' },
    ] });
    expect(resume(config, writerFullOnly).decision).toBe('allow');
    const allFull = snapshot({ inflight: [...writerFullOnly.inflight, { role: 'diting', state: 'running' }, { role: 'diting', state: 'running' }] });
    const blocked = resume(config, allFull);
    expect(blocked.decision).toBe('block');
    if (blocked.decision === 'block') expect(blocked.code).toBe('dispatch_inflight_pool_saturated');
  });

  it('同一轮连发：快照未前进时未入账计数累加，超限被拒；快照 seq 前进后重置', () => {
    const config = samePoolConfig(4);
    const empty = snapshot();
    for (let i = 0; i < 4; i += 1) {
      expect(submitWriter(config, empty).decision, `第 ${i + 1} 个写作应放行`).toBe('allow');
    }
    const fifth = submitWriter(config, empty);
    expect(fifth.decision).toBe('block');
    // host 已把 4 个写作登记进快照（seq 前进）→ 未入账重置，按文件在途判定
    const caughtUp = snapshot({ seq: 2, inflight: Array.from({ length: 4 }, () => ({ role: 'luban', state: 'running' })) });
    expect(submitWriter(config, caughtUp).decision).toBe('block'); // 单池（同模型）4/4：写作与审查都满
    expect(submitReviewer(config, caughtUp).decision).toBe('block');
    // 两池配置：writer 池 4/4 满、reviewer 池空 → 写作拒、审查放行（重置后按文件计数）
    const twoPools = admitConfig();
    expect(submitWriter(twoPools, caughtUp).decision).toBe('block');
    expect(submitReviewer(twoPools, caughtUp).decision).toBe('allow');
  });

  it('R3 反例：错 model 被拒不占额度，修正后重试立即放行（空池不误报满载）', () => {
    const config = samePoolConfig(1); // capacity=1：任一虚占即满
    const empty = snapshot();
    const wrong = guardTaskSubmit(config, { agent: 'luban', task: WRITE_TASK, model: 'zhipuai/glm-5.3' }, { inflight: empty });
    expect(wrong.decision).toBe('block');
    if (wrong.decision === 'block') expect(wrong.code).toBe('dispatch_model_not_frozen');
    // 修正 model 重试：准入判定不受此前拒绝影响
    const corrected = guardTaskSubmit(config, { agent: 'luban', task: WRITE_TASK, model: 'zhipuai/glm-5.3-flash:low' }, { inflight: empty });
    expect(corrected.decision).toBe('allow');
  });

  it('R3：多次参数失败（role/model/taskFile/范围）不耗尽额度，合法派发仍放行', () => {
    const config = admitConfig();
    const empty = snapshot();
    expect(guardTaskSubmit(config, { agent: 'fuxi', task: WRITE_TASK }, { inflight: empty }).decision).toBe('block');
    expect(guardTaskSubmit(config, { agent: 'luban', task: WRITE_TASK, model: 'zhipuai/glm-5.3' }, { inflight: empty }).decision).toBe('block');
    expect(guardTaskSubmit(config, { agent: 'luban', taskFile: '../escape.md' }, { inflight: empty }).decision).toBe('block');
    expect(guardTaskSubmit(config, {
      agent: 'luban',
      task: ['【写作】人塔寨综合战术工作表：总输出 3707 行。②Concept 输出 1428–1652；③-1 分析拆解 输出 1655–1858；', '③-2 主流程 输出 1861–2060；④Detail-1 规则与交互 输出 2265–2500；①idea 输出 1226–1425。'].join('\n'),
    }, { inflight: empty }).decision).toBe('block');
    expect(submitWriter(config, empty).decision).toBe('allow'); // 4 次拒绝后额度未被虚耗
  });

  it('R3：放行预留带 TTL——未被 host 确认的预留 60s 后过期释放，不再持续到 staleMs', () => {
    const config = samePoolConfig(2);
    let clock = Date.parse('2026-11-06T12:00:00.000Z');
    const now = () => new Date(clock).toISOString();
    const empty = snapshot({ updatedAt: now() });
    expect(guardTaskSubmit(config, { agent: 'luban', task: WRITE_TASK }, { inflight: empty, now }).decision).toBe('allow');
    expect(guardTaskSubmit(config, { agent: 'luban', task: WRITE_TASK }, { inflight: empty, now }).decision).toBe('allow');
    // 占满（快照 seq 未前进、TTL 未过）：第 3 个拒绝
    const third = guardTaskSubmit(config, { agent: 'luban', task: WRITE_TASK }, { inflight: empty, now });
    expect(third.decision).toBe('block');
    // 原生派发未创建任务（快照永远不前进）：61s 后 TTL 过期，预留释放
    clock += DISPATCH_UNACKED_TTL_MS + 1_000;
    expect(guardTaskSubmit(config, { agent: 'luban', task: WRITE_TASK }, { inflight: empty, now }).decision).toBe('allow');
  });

  it('fail-open：无 dispatch 段 / buildId 或 generation 不匹配 / 快照过旧 → 跳过准入', () => {
    const stale = new Date(Date.now() - DISPATCH_INFLIGHT_STALE_MS - 60_000).toISOString();
    expect(submitWriter(makeConfig(), snapshot()).decision).toBe('allow'); // 无 dispatch 段
    const config = admitConfig();
    expect(submitWriter(config, snapshot({ buildId: 'b_other' })).decision).toBe('allow');
    expect(submitWriter(config, snapshot({ generation: 3 })).decision).toBe('allow');
    expect(submitWriter(config, snapshot({ updatedAt: stale })).decision).toBe('allow');
    expect(submitWriter(config, null).decision).toBe('allow'); // 扩展读不到文件
  });
});
