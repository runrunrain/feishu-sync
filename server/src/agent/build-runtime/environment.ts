/**
 * build-runtime/environment.ts — 构建 Leader 子进程环境构造
 *
 * 设计来源：设计v2 §3.2/§3.5/§4.1 与核查证据 Q2。
 *
 * 通道事实（amagi-pi 2.21.31 task-run.ts buildMinimalEnv，实测锚点）：
 * - 子任务 env = 硬编码白名单 + PI_* 全量透传 + PROVIDER_KEY_MAP（zhipuai →
 *   ZHIPU_API_KEY，仅发给 provider=zhipuai 的子任务）+ 任务边界与 MCP 凭据。
 * - FEISHU_SYNC_* 不在白名单：Leader 里的应用凭据到不了子任务；桥接变量经
 *   amagi 的 MCP 凭据交付（appendMcpCredentialEnv，按 mcp 配置 envRefs 引用）。
 * - 凭据不得放入 PI_* 命名空间（全量透传）。
 *
 * 因此 Leader env = 最小白名单基础 + PI_CODING_AGENT_DIR（构建 home）+
 * ZHIPU_API_KEY（Leader 模型 + amagi 转发）+ 桥接两变量（供 amagi 引用交付）+
 * Leader 转发扩展两变量 + amagi 自动行为开关。
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  BUILD_MCP_TOKEN_ENV, BUILD_MCP_URL_ENV, ZHIPU_API_KEY_ENV,
  type BuildRunSpec,
} from './contracts.js';
import type { BuildDirectories } from './agent-dir-config.js';
import type { FrozenDispatchConfig } from './dispatch-guard.js';

/** 扩展环境契约（与主树 extension-report.md §1 对齐；并行切片共享名）。 */
export const BUILD_SPEC_ENV = 'FEISHU_SYNC_AGENT_BUILD_SPEC_JSON';
/** 编译后 dispatch-guard 模块绝对路径（扩展 dynamic import，避免逻辑复制）。 */
export const BUILD_GUARD_MODULE_ENV = 'FEISHU_SYNC_BUILD_GUARD_MODULE';
/** FrozenDispatchConfig 序列化 JSON（guardTaskSubmit/guardTaskResume 输入）。 */
export const BUILD_GUARD_CONFIG_ENV = 'FEISHU_SYNC_BUILD_GUARD_CONFIG_JSON';
/**
 * F12-R1 增补（child native 根约束元数据）：child-policy 扩展消费的冻结信封根
 * （PI_* 前缀经 amagi 子任务 env 全量透传——task-run buildMinimalEnv 已核；
 * FEISHU_SYNC_* 不在 amagi 白名单到不了子进程，故用 PI_ 命名）。
 * 数据源 = 冻结 spec + dirs（workflowSkillPath/workDir 均在 agentDirConfigHash
 * 与 dispatch-guard 冻结链内）；写入面仅报告根（与 freezeGuardConfig 默认
 * reportRoot='agent-outputs' 同源——adapter 从不传自定义 reportRoot，若未来
 * 可自定义需同步本处与 child-policy，属最小接口变更）。
 * 子任务侧缺此元数据 → child-policy 对 read/write/edit fail-closed 全阻断。
 */
export const BUILD_CHILD_ROOTS_ENV = 'PI_BUILD_CHILD_ROOTS_JSON';

export interface LeaderEnvInput {
  parentEnv: NodeJS.ProcessEnv;
  spec: BuildRunSpec;
  dirs: BuildDirectories;
  /** zhipuai 密钥值（由调用方从应用配置解析；只进子进程 env，不落盘）。 */
  zhipuApiKey: string;
  /** 应用内部 API 回环地址与 Leader 运行令牌（转发扩展消费）。 */
  agentUrl: string;
  leaderRunToken: string;
  /** MCP 桥接回环地址与子任务凭据（amagi 按 mcp.json ${VAR} 引用交付子任务）。 */
  mcpBridgeUrl: string;
  mcpBridgeToken: string;
  /** 派发守卫冻结配置与 Leader 工具白名单（提供时注入扩展三变量契约）。 */
  guardConfig?: FrozenDispatchConfig;
  leaderTools?: string[];
  /** 编译后 dispatch-guard 模块绝对路径（server/dist/agent/build-runtime/dispatch-guard.js）。 */
  guardModulePath?: string;
}

/** 基础白名单：与 amagi 子进程白名单同源（PATH/HOME/USER/SHELL/LANG/…/代理变量）。 */
const BASE_WHITELIST = [
  'PATH', 'Path', 'HOME', 'USER', 'USERPROFILE', 'LOGNAME', 'SHELL', 'TZ',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'TERM',
  'SystemRoot', 'SystemDrive', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'ComSpec',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
] as const;

/** 危险变量：绝不进入 Leader/子任务链路（PI_* 会全量透传给子任务）。 */
const DANGEROUS = [
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_PRELOAD',
  'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE',
] as const;

export function buildLeaderEnv(input: LeaderEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const dangerous = new Set<string>(DANGEROUS);
  for (const key of Object.keys(input.parentEnv)) {
    if (dangerous.has(key)) continue;
    if ((BASE_WHITELIST as readonly string[]).includes(key)) env[key] = input.parentEnv[key];
  }
  // PI 基础变量（PI_* 全量透传给子任务，只放非凭据项）
  env.PI_CODING_AGENT_DIR = input.dirs.homeDir;
  env.PI_OFFLINE = '1';
  env.PI_SKIP_VERSION_CHECK = '1';
  env.PI_TELEMETRY = '0';
  // F12-R1：冻结信封根元数据（read=skill 同目录协议+任务工作区；write/edit=仅报告根）
  env[BUILD_CHILD_ROOTS_ENV] = JSON.stringify({
    readRoots: [path.dirname(path.resolve(input.spec.workflowSkillPath)), path.resolve(input.dirs.workDir)],
    writeRoots: [path.resolve(input.dirs.workDir, 'agent-outputs')],
  });
  // 子任务启动时由内容寻址 child-policy 强制读取这份冻结技能，避免
  // --skill 只展示摘要却让模型直接猜 kb_write_doc 参数。
  env.PI_BUILD_WORKFLOW_SKILL_PATH = path.resolve(input.spec.workflowSkillPath);
  const roleSkillDir = path.dirname(env.PI_BUILD_WORKFLOW_SKILL_PATH);
  if (['luban', 'diting', 'baize'].every((role) => existsSync(path.join(roleSkillDir, `role-${role}.md`)))) {
    env.PI_BUILD_ROLE_SKILL_REQUIRED = '1';
  }

  // 模型密钥（Leader 直接使用；amagi 只转交给 zhipuai 子任务）
  env[ZHIPU_API_KEY_ENV] = input.zhipuApiKey;

  // Leader 转发扩展（应用工具服务通道）
  env.FEISHU_SYNC_AGENT_URL = input.agentUrl;
  env.FEISHU_SYNC_AGENT_RUN_TOKEN = input.leaderRunToken;

  // MCP 桥接两变量（amagi 按 mcp.json envRefs 引用交付给路由到桥接的子任务）
  env[BUILD_MCP_URL_ENV] = input.mcpBridgeUrl;
  env[BUILD_MCP_TOKEN_ENV] = input.mcpBridgeToken;

  // 扩展构建模式契约三变量（extension-report.md §1 对齐；扩展缺省不进构建模式）
  if (input.guardConfig && input.leaderTools) {
    env[BUILD_SPEC_ENV] = renderExtensionSpecJson(input.guardConfig, input.leaderTools);
    env[BUILD_GUARD_CONFIG_ENV] = JSON.stringify(input.guardConfig);
  }
  if (input.guardModulePath) env[BUILD_GUARD_MODULE_ENV] = input.guardModulePath;

  applyAutoRoundsEnv(env, input.spec);
  return env;
}

/** 扩展仅消费工具白名单与原样冻结守卫；不维护第二套权限字段映射。 */
export function renderExtensionSpecJson(config: FrozenDispatchConfig, tools: string[]): string {
  return JSON.stringify({ tools, guard: config });
}

/** amagi 自动行为显式冻结（设计 §3.5；这些变量由 Leader 进程内 amagi 读取）。 */
export function applyAutoRoundsEnv(env: NodeJS.ProcessEnv, spec: BuildRunSpec): void {
  const { autoRounds } = spec;
  if (!autoRounds.verify) env.AMAGI_AUTO_VERIFY_OFF = '1';
  if (autoRounds.continueRounds >= 0) env.AMAGI_AUTO_CONTINUE_ROUNDS = String(autoRounds.continueRounds);
  if (autoRounds.repairRounds >= 0) env.AMAGI_AUTO_REPAIR_ROUNDS = String(autoRounds.repairRounds);
  if (autoRounds.implicitRetryRounds >= 0) env.AMAGI_AUTORETRY_IMPLICIT_ROUNDS = String(autoRounds.implicitRetryRounds);
}

/** 环境自检（测试与探测共用）：构造结果不得含的项。 */
export function envAuditIssues(env: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];
  const allowedFeishu = new Set([
    'FEISHU_SYNC_AGENT_URL', 'FEISHU_SYNC_AGENT_RUN_TOKEN',
    BUILD_MCP_URL_ENV, BUILD_MCP_TOKEN_ENV,
    BUILD_SPEC_ENV, BUILD_GUARD_MODULE_ENV, BUILD_GUARD_CONFIG_ENV,
  ]);
  for (const key of Object.keys(env)) {
    if (/^FEISHU_SYNC_/.test(key) && !allowedFeishu.has(key)) {
      issues.push(`意外透传 FEISHU_SYNC_* 变量: ${key}`);
    }
    if (/^PI_[A-Z_]*(KEY|TOKEN|SECRET)/.test(key)) {
      issues.push(`PI_* 命名空间出现凭据类变量: ${key}`);
    }
    if (key === 'NODE_OPTIONS' || key === 'NODE_PATH') issues.push(`危险变量泄漏: ${key}`);
  }
  return issues;
}

/** 构建 Leader 启动时的 cwd 相对布局提示（报告目录预创建）。 */
export function ensureWorkLayout(dirs: BuildDirectories): void {
  mkdirSync(path.join(dirs.workDir, 'agent-outputs'), { recursive: true });
}
