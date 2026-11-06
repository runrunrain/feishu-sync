/**
 * 构建 Leader 环境构造测试（设计v2 §3.2/§3.5，核查证据 Q2）
 *
 * 断言通道事实：白名单基础 + PI_*（非凭据）+ ZHIPU_API_KEY + 桥接两变量 +
 * Leader 转发扩展两变量；FEISHU_SYNC_* 其余变量不透传；危险变量剔除；
 * amagi 自动行为开关按 spec 冻结。
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { applyAutoRoundsEnv, buildLeaderEnv, envAuditIssues } from '../src/agent/build-runtime/environment.js';
import { planBuildDirectories } from '../src/agent/build-runtime/agent-dir-config.js';
import { makeSpec } from './build-runtime-contracts.test.js';

const DIRS = planBuildDirectories('/data', 'b_demo');

function envFor(spec = makeSpec(), parent: NodeJS.ProcessEnv = {}) {
  return buildLeaderEnv({
    parentEnv: {
      PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai',
      HTTP_PROXY: 'http://proxy:1', NODE_OPTIONS: '--inspect', ZHIPU_API_KEY: 'parent-leak',
      FEISHU_SYNC_AGENT_API_KEY: 'stale', FEISHU_SYNC_UNRELATED: 'x',
      ...parent,
    },
    spec,
    dirs: DIRS,
    apiKeys: { zhipuai: 'sk-test-key' },
    agentUrl: 'http://127.0.0.1:32100',
    leaderRunToken: 'leader-token',
    mcpBridgeUrl: 'http://127.0.0.1:32100/api/agent-internal/mcp',
    mcpBridgeToken: 'bridge-token',
  });
}

describe('buildLeaderEnv', () => {
  it('白名单基础变量保留，危险变量剔除，其余不透传', () => {
    const env = envFor();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.HTTP_PROXY).toBe('http://proxy:1');
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.SOMETHING_ELSE).toBeUndefined();
    expect(env.FEISHU_SYNC_UNRELATED).toBeUndefined();
    // 父进程密钥不透传（子进程只拿显式注入的值）
    expect(env.ZHIPU_API_KEY).toBe('sk-test-key');
    expect(env.FEISHU_SYNC_AGENT_API_KEY).toBeUndefined();
  });

  it('F12-R1 二段：PI_BUILD_CHILD_ROOTS_JSON 与冻结 spec 同源（readRoots=skill 目录+workDir；writeRoots=仅报告根）且过凭据审计', () => {
    const spec = makeSpec();
    const env = envFor(spec);
    const roots = JSON.parse(String(env.PI_BUILD_CHILD_ROOTS_JSON)) as { readRoots: string[]; writeRoots: string[] };
    expect(roots.readRoots).toEqual([
      path.dirname(path.resolve(spec.workflowSkillPath)),
      path.resolve(DIRS.workDir),
    ]);
    expect(roots.writeRoots).toEqual([path.resolve(DIRS.workDir, 'agent-outputs')]);
    // PI_* 凭据审计不误伤（ROOTS 非凭据名）
    expect(envAuditIssues(env)).toEqual([]);
  });

  it('PI 基础变量：agentDir 指向构建 home，offline/telemetry 固定；F12-R1 冻结信封根元数据注入（skill 同目录+工作区读，仅报告写）', () => {
    const spec = makeSpec();
    const env = envFor(spec);
    expect(env.PI_CODING_AGENT_DIR).toBe(DIRS.homeDir);
    expect(env.PI_OFFLINE).toBe('1');
    expect(env.PI_SKIP_VERSION_CHECK).toBe('1');
    expect(env.PI_TELEMETRY).toBe('0');
    expect(env.PI_BUILD_WORKFLOW_REVISION).toBe(spec.workflowRevision);
  });

  it('Leader 转发扩展与 MCP 桥接变量注入（桥接变量名固定，供 amagi envRefs 交付）', () => {
    const env = envFor();
    expect(env.FEISHU_SYNC_AGENT_URL).toBe('http://127.0.0.1:32100');
    expect(env.FEISHU_SYNC_AGENT_RUN_TOKEN).toBe('leader-token');
    expect(env.FEISHU_SYNC_BUILD_MCP_URL).toContain('127.0.0.1');
    expect(env.FEISHU_SYNC_BUILD_MCP_TOKEN).toBe('bridge-token');
  });

  it('扩展契约三变量：提供 guardConfig+leaderTools 时注入（与 extension-report §1 对齐）', () => {
    const guardConfig = {
      schemaVersion: 1, buildId: 'b_demo', generation: 2, workDir: DIRS.workDir,
      reportRoot: 'agent-outputs', forbiddenZones: ['/data/config.json'],
      roles: {
        luban: { key: 'writer', models: ['zhipuai/glm-5.3-flash:low'], mcpTools: ['kb_read_sources'] },
        diting: { key: 'reviewer', models: ['zhipuai/glm-5.3'], mcpTools: [] },
        baize: { key: 'research', models: ['zhipuai/glm-5.3'], mcpTools: [] },
      },
    };
    const tools = ['task_submit', 'task_query', 'task_control', 'task_resume', 'amagi_resource', 'kb_build_probe'];
    const env = envFor(makeSpec(), {});
    const full = buildLeaderEnv({
      parentEnv: { PATH: '/usr/bin' }, spec: makeSpec(), dirs: DIRS,
      apiKeys: { zhipuai: 'k' }, agentUrl: 'http://127.0.0.1:1', leaderRunToken: 't',
      mcpBridgeUrl: 'http://127.0.0.1:1/mcp', mcpBridgeToken: 'b',
      guardConfig, leaderTools: tools, guardModulePath: '/app/dist/agent/build-runtime/dispatch-guard.js',
    });
    const parsedSpec = JSON.parse(full.FEISHU_SYNC_AGENT_BUILD_SPEC_JSON ?? '');
    expect(parsedSpec).toEqual({ tools, guard: guardConfig });
    // 扩展解析同一信封；不允许旧的9字段映射悄悄复活。
    expect(parsedSpec.roleModels).toBeUndefined();
    expect(envAuditIssues(full)).toEqual([]);
    expect(full.FEISHU_SYNC_BUILD_GUARD_MODULE).toBe('/app/dist/agent/build-runtime/dispatch-guard.js');
    expect(JSON.parse(full.FEISHU_SYNC_BUILD_GUARD_CONFIG_JSON ?? '')).toEqual(guardConfig);
    // 缺 guardConfig 时三变量都不注入（扩展保持普通会话行为）
    expect(env.FEISHU_SYNC_AGENT_BUILD_SPEC_JSON).toBeUndefined();
    expect(env.FEISHU_SYNC_BUILD_GUARD_MODULE).toBeUndefined();
  });

  it('自动行为开关按 spec 冻结（verify 关、轮数显式）', () => {
    const env = envFor();
    expect(env.AMAGI_AUTO_VERIFY_OFF).toBe('1');
    expect(env.AMAGI_AUTO_CONTINUE_ROUNDS).toBe('1');
    expect(env.AMAGI_AUTO_REPAIR_ROUNDS).toBe('1');
    expect(env.AMAGI_AUTORETRY_IMPLICIT_ROUNDS).toBe('1');
    const spec2 = makeSpec();
    spec2.autoRounds = { verify: true, continueRounds: 0, repairRounds: 2, implicitRetryRounds: 0 };
    const env2 = envFor(spec2);
    expect(env2.AMAGI_AUTO_VERIFY_OFF).toBeUndefined();
    expect(env2.AMAGI_AUTO_CONTINUE_ROUNDS).toBe('0');
    expect(env2.AMAGI_AUTO_REPAIR_ROUNDS).toBe('2');
  });

  it('applyAutoRoundsEnv：负数轮不写 env（回落 amagi 默认）', () => {
    const env: NodeJS.ProcessEnv = {};
    const spec = makeSpec();
    spec.autoRounds = { verify: false, continueRounds: -1, repairRounds: 1, implicitRetryRounds: -1 };
    applyAutoRoundsEnv(env, spec);
    expect(env.AMAGI_AUTO_CONTINUE_ROUNDS).toBeUndefined();
    expect(env.AMAGI_AUTORETRY_IMPLICIT_ROUNDS).toBeUndefined();
    expect(env.AMAGI_AUTO_REPAIR_ROUNDS).toBe('1');
  });
});

describe('envAuditIssues', () => {
  it('检出意外 FEISHU_SYNC_*、PI_* 凭据与危险变量', () => {
    expect(envAuditIssues({
      FEISHU_SYNC_AGENT_URL: 'ok', FEISHU_SYNC_BUILD_MCP_TOKEN: 'ok',
      FEISHU_SYNC_SECRET: 'leak', PI_MY_TOKEN: 'x', NODE_OPTIONS: '--evil',
    })).toEqual([
      '意外透传 FEISHU_SYNC_* 变量: FEISHU_SYNC_SECRET',
      'PI_* 命名空间出现凭据类变量: PI_MY_TOKEN',
      '危险变量泄漏: NODE_OPTIONS',
    ]);
    expect(envAuditIssues(envFor())).toEqual([]);
  });
});
