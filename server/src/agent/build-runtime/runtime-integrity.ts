/**
 * build-runtime/runtime-integrity.ts — 派发前运行期完整性重核验（F12 审核修复）
 *
 * 背景（review F12，已复现）：Leader 启动时 start/probe 核验通过后，若
 * child-policy 文件被删除或 settings.json 资源面被外部改动，Pi 对 settings
 * 中不存在的 extension 会静默跳过（missing-policy-probe：code=0、模型请求
 * 1 次、含 codemode），子任务失去调用拒绝层；而原派发钩子只跑纯参数守卫，
 * 不重验冻结面。要求：每次真实 task_submit/task_resume 调用前重新核验
 * 冻结 settings/policy 必要内容/包与相关配置，缺失/篡改/资源注入必须阻止
 * child 模型请求（fail-closed），而不是只测 helper 返回 false。
 *
 * 消费方式（与 dispatch-guard 同一装载契约）：
 * - 模块经 dispatch-guard 再导出（feishu-sync-agent.js 的 guardApi 消费），
 *   生产为 dist 编译 JS、开发/测试源码 .ts 由 jiti 加载——因此本模块保持
 *   【零第三方依赖：node:crypto/fs/path + 同目录 amagi-package 的纯 Node walker】，
 *   输入输出全部 JSON 可序列化，不落任何 secret（expectedFiles 中 apiKey/env
 *   均为引用占位）。
 * - 冻结必要引用进 guard envelope（FrozenDispatchConfig.integrity），不落盘、
 *   不进日志；包校验复用现有全量内容哈希（computePackageContentHash，
 *   3545 文件/≈82MiB 实测 ≈150ms，逐次派发可承受）。
 *
 * 边界：文件围栏/哈希核验不是 OS 沙箱——同 uid 外部可信代码仍可物理改盘；
 * 本模块保证的是「派发时刻磁盘冻结面与启动冻结引用一致，否则拒绝派发」。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isAbsolute } from 'node:path';

/** 包全量内容哈希计算器（server 侧注入 amagi-package.computePackageContentHash；
 * 注入而非相对 import——本模块需保持单文件可加载性（pi/jiti 不解析 .js→.ts
 * 相对引用），walker 唯一实现仍在 amagi-package.ts，不复制）。 */
export type PackageContentHasher = (packageRoot: string) => { contentHash: string };

/** 完整性引用形状版本（与 DISPATCH_GUARD_SCHEMA_VERSION 独立演进）。 */
export const RUNTIME_INTEGRITY_SCHEMA_VERSION = 1;

/** 派发前重核验的冻结引用（全部为公开事实，不含密钥值）。 */
export interface RuntimeIntegrityRefs {
  schemaVersion: number;
  /** 构建 agentDir 绝对路径（= PI_CODING_AGENT_DIR；子任务从这里加载 settings/policy/包）。 */
  homeDir: string;
  /** 四配置的 spec 渲染期望内容（renderAgentDirConfigFiles 输出；apiKey/env 是引用占位非密钥值）。 */
  expectedFiles: {
    settings: string;
    amagi: string;
    models: string;
    mcp: string;
  };
  /** child-policy 内容寻址文件名与源码 sha256。 */
  childPolicy: { fileName: string; sha256: string };
  /** 版本化 amagi-pi 包根与全量内容哈希（复用现有安装冻结值）。 */
  amagiPackage: { packageRoot: string; contentHash: string };
  /**
   * 冻结工作流规则（Leader steer 补强）：child 经 amagi.json skills 读此文件，
   * F08 审查回执绑定 spec.workflowRevision——若运行中字节被改，child 会读到新
   * 规则而回执仍绑旧版本。sha256 = spec.workflowRevision（文件字节哈希，与
   * adapter.verifyWorkflow 同公式）；路径可为新 epoch 目录引用（含旧 basehome），
   * 核验只对哈希负责，不微路径世系判断。
   */
  workflowSkill: { path: string; sha256: string };
}

// ── settings.json 字段感知比对（与 agent-dir-config.agentDirConfigMatchesSpec 同一口径）──

/** 冻结资源/工具面键：必须与 spec 渲染结果深度一致（spec 未写 → 磁盘不得出现）。 */
export const SETTINGS_FROZEN_KEYS = ['$schema', 'packages', 'extensions', 'skills', 'prompts', 'themes', 'defaultTools'] as const;
/** 容忍键：amagi doctor 实测会写入 retry.provider.timeoutMs（terminal-doctor mergeProviderTimeout）。 */
export const SETTINGS_TOLERATED_KEYS = ['retry'] as const;

/** retry 容忍形状：{ provider: { timeoutMs: <正有限数> } } 且无任何多余键。 */
export function isToleratedRetryShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const retry = value as Record<string, unknown>;
  if (Object.keys(retry).length !== 1) return false;
  const provider = retry.provider;
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return false;
  const providerRecord = provider as Record<string, unknown>;
  if (Object.keys(providerRecord).length !== 1) return false;
  const timeoutMs = providerRecord.timeoutMs;
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;
}

/**
 * settings.json 冻结面比对（actualRaw/expectedRaw 均为文件字节）：
 * 1) 冻结键深度比对（含“spec 未写 → 磁盘不得出现”——资源注入收口）；
 * 2) 容忍键 retry：仅 doctor 写入的精确形状；
 * 3) 其余任何键 → 不匹配。
 */
export function settingsFrozenSurfaceIssues(actualRaw: string, expectedRaw: string): string[] {
  const issues: string[] = [];
  let actual: unknown;
  let expected: unknown;
  try {
    actual = JSON.parse(actualRaw);
    expected = JSON.parse(expectedRaw);
  } catch (error) {
    return [`settings.json 解析失败: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return ['settings.json 不是 JSON 对象'];
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return ['期望 settings 内容不是 JSON 对象（冻结引用损坏）'];
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  for (const key of SETTINGS_FROZEN_KEYS) {
    const a = actualRecord[key];
    const e = expectedRecord[key];
    const aMissing = a === undefined;
    const eMissing = e === undefined;
    if (aMissing !== eMissing) {
      issues.push(`settings.json ${key} 冻结面被${eMissing ? '新增' : '移除'}（资源/工具注入面收口）`);
    } else if (!aMissing && JSON.stringify(a) !== JSON.stringify(e)) {
      issues.push(`settings.json ${key} 与 spec 渲染结果不一致（构建冻结面被改动）`);
    }
  }
  if (actualRecord.retry !== undefined && !isToleratedRetryShape(actualRecord.retry)) {
    issues.push('settings.json retry 键形状超出已实测可接受项（仅 amagi doctor 写入的 provider.timeoutMs）');
  }
  for (const key of Object.keys(actualRecord)) {
    if (!(SETTINGS_TOLERATED_KEYS as readonly string[]).includes(key) && !(SETTINGS_FROZEN_KEYS as readonly string[]).includes(key)) {
      issues.push(`settings.json 出现未知字段 ${key}（不在冻结/容忍清单，疑似资源注入）`);
    }
  }
  return issues;
}

// ── 引用构造（server 侧：adapter.buildGuardConfigInput 调用）──────────────

/** child-policy 内容寻址文件名契约（与 child-policy.ts 同规则；此处独立校验防引用被换名）。 */
const CHILD_POLICY_NAME_PATTERN = /^child-policy-[0-9a-f]{12}\.js$/;

export function buildRuntimeIntegrityRefs(input: {
  homeDir: string;
  expectedFiles: RuntimeIntegrityRefs['expectedFiles'];
  /** 内容寻址 policy 引用（caller 用 child-policy.ts 的确定性函数计算：fileName/sha256 同源单点）。 */
  childPolicy: { fileName: string; sha256: string };
  amagiPackage: { packageRoot: string; contentHash: string };
  /** 冻结工作流规则引用（path=spec.workflowSkillPath；sha256=spec.workflowRevision）。 */
  workflowSkill: { path: string; sha256: string };
}): RuntimeIntegrityRefs {
  const refs: RuntimeIntegrityRefs = {
    schemaVersion: RUNTIME_INTEGRITY_SCHEMA_VERSION,
    homeDir: input.homeDir,
    expectedFiles: input.expectedFiles,
    childPolicy: input.childPolicy,
    amagiPackage: input.amagiPackage,
    workflowSkill: input.workflowSkill,
  };
  const issues = validateRuntimeIntegrityRefs(refs);
  if (issues.length > 0) {
    throw new Error(`运行期完整性引用非法：${issues.join('；')}`);
  }
  return refs;
}

/** 引用形状校验（信封装载时用；不触盘）。 */
export function validateRuntimeIntegrityRefs(refs: RuntimeIntegrityRefs): string[] {
  const issues: string[] = [];
  if (refs.schemaVersion !== RUNTIME_INTEGRITY_SCHEMA_VERSION) {
    issues.push(`integrity.schemaVersion 不支持（期望 ${RUNTIME_INTEGRITY_SCHEMA_VERSION}）`);
  }
  if (!refs.homeDir || !isAbsolute(refs.homeDir)) issues.push('integrity.homeDir 须为绝对路径');
  for (const [key, value] of Object.entries(refs.expectedFiles ?? {})) {
    if (typeof value !== 'string' || value.length === 0) issues.push(`integrity.expectedFiles.${key} 缺失`);
  }
  if (Object.keys(refs.expectedFiles ?? {}).length !== 4) issues.push('integrity.expectedFiles 须含 settings/amagi/models/mcp 四项');
  const policy = refs.childPolicy;
  if (!policy || !CHILD_POLICY_NAME_PATTERN.test(policy.fileName ?? '')) {
    issues.push('integrity.childPolicy.fileName 须为内容寻址 child-policy-<hash12>.js');
  }
  if (!/^[0-9a-f]{64}$/.test(policy?.sha256 ?? '')) issues.push('integrity.childPolicy.sha256 须为 hex64');
  const pkg = refs.amagiPackage;
  if (!pkg || !isAbsolute(pkg.packageRoot ?? '')) issues.push('integrity.amagiPackage.packageRoot 须为绝对路径');
  if (!pkg?.contentHash) issues.push('integrity.amagiPackage.contentHash 缺失');
  if (!refs.workflowSkill?.path || !isAbsolute(refs.workflowSkill.path ?? '')) {
    issues.push('integrity.workflowSkill.path 须为绝对路径');
  }
  if (!/^[0-9a-f]{64}$/.test(refs.workflowSkill?.sha256 ?? '')) issues.push('integrity.workflowSkill.sha256 须为 hex64（= spec.workflowRevision）');
  return issues;
}

// ── 派发前重核验（Leader 进程内：tool_call 钩子逐次调用）──────────────────

/**
 * 重核验磁盘冻结面与冻结引用一致（fs 同步读 + 全量包哈希，实测 ≈150ms）：
 * 1) amagi.json/models.json/mcp.json 逐字节比对期望渲染；
 * 2) settings.json 字段感知比对（retry 容忍；未知/漂移字段一律拒）；
 * 3) child-policy 文件存在且内容 sha256 = 冻结值（文件名与内容哈希互相印证）；
 * 4) amagi-pi 包全量内容哈希 = 安装冻结值（缺失/symlink/超预算均失败）；
 * 5) workflow skill 实文件字节 sha256 = spec.workflowRevision（缺失/篡改/符号链接拒；
 *    与 adapter.verifyWorkflow 同公式，启动/逐次派发/续接同一接缝）。
 * 任何一项不 ok → 调用方必须阻止派发（不降级为仅记录）。
 * deps.computePackageContentHash 由调用方注入（server：amagi-package；扩展：同目录装载后传入）。
 */
export function verifyRuntimeIntegrity(
  refs: RuntimeIntegrityRefs,
  deps: { computePackageContentHash: PackageContentHasher },
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const shapeIssues = validateRuntimeIntegrityRefs(refs);
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues };

  const read = (name: string): string | null => {
    try { return fs.readFileSync(path.join(refs.homeDir, name), 'utf-8'); } catch { return null; }
  };
  for (const [name, expected] of [
    ['amagi.json', refs.expectedFiles.amagi],
    ['models.json', refs.expectedFiles.models],
    ['mcp.json', refs.expectedFiles.mcp],
  ] as const) {
    const actual = read(name);
    if (actual === null) issues.push(`缺少 ${name}（agentDir 冻结面不完整）`);
    else if (actual !== expected) issues.push(`${name} 与冻结渲染结果不一致（构建冻结面被改动）`);
  }
  const settingsRaw = read('settings.json');
  if (settingsRaw === null) issues.push('缺少 settings.json（agentDir 冻结面不完整）');
  else issues.push(...settingsFrozenSurfaceIssues(settingsRaw, refs.expectedFiles.settings));

  // child-policy：文件本体字节级核验（settings 只锁文件名，这里验内容）
  const policyPath = path.join(refs.homeDir, refs.childPolicy.fileName);
  let policySource: string | null = null;
  try {
    policySource = fs.readFileSync(policyPath, 'utf-8');
  } catch {
    issues.push(`child-policy 文件缺失（${refs.childPolicy.fileName}）——子任务工具面防御未物化，拒绝派发`);
  }
  if (policySource !== null) {
    const actualHash = createHash('sha256').update(policySource, 'utf-8').digest('hex');
    if (actualHash !== refs.childPolicy.sha256) {
      issues.push('child-policy 文件内容与冻结 sha256 不一致（疑似篡改/损坏），拒绝派发');
    } else if (!CHILD_POLICY_NAME_PATTERN.test(refs.childPolicy.fileName)) {
      issues.push('child-policy 文件名与内容哈希不互相印证，拒绝派发');
    }
  }

  // amagi-pi 包全量哈希（复用现有 walker：symlink/超预算/缺失都抛错 → 记 issue）
  try {
    const { contentHash } = deps.computePackageContentHash(refs.amagiPackage.packageRoot);
    if (contentHash !== refs.amagiPackage.contentHash) {
      issues.push(`amagi-pi 包内容哈希漂移（冻结 ${refs.amagiPackage.contentHash.slice(0, 12)}，当前 ${contentHash.slice(0, 12)}），拒绝派发`);
    }
  } catch (error) {
    issues.push(`amagi-pi 包核验失败（${refs.amagiPackage.packageRoot}）：${error instanceof Error ? error.message : String(error)}`);
  }

  // 冻结工作流规则实文件哈希（Leader steer 补强）：child 读此文件、F08 回执绑
  // workflowRevision——缺失/篡改/符号链接（未哈希的可变入口）一律拒。
  const skillPath = refs.workflowSkill.path;
  let skillStat: fs.Stats | null = null;
  try {
    skillStat = fs.lstatSync(skillPath);
  } catch {
    issues.push(`workflow skill 文件缺失（${skillPath}）——child 规则未冻结，拒绝派发`);
  }
  if (skillStat !== null) {
    if (skillStat.isSymbolicLink()) {
      issues.push(`workflow skill 是符号链接（${skillPath}）——未哈希的可变入口，拒绝派发`);
    } else if (!skillStat.isFile()) {
      issues.push(`workflow skill 不是常规文件（${skillPath}），拒绝派发`);
    } else {
      const skillHash = createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex');
      if (skillHash !== refs.workflowSkill.sha256) {
        issues.push(`workflow skill 内容与冻结 workflowRevision 不一致（${skillPath}，冻结 ${refs.workflowSkill.sha256.slice(0, 12)}，当前 ${skillHash.slice(0, 12)}）——child 将读到被改规则而回执仍绑旧版本，拒绝派发`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}
