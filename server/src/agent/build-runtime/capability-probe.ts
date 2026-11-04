/**
 * build-runtime/capability-probe.ts — 能力探测（诚实区分静态/实测）
 *
 * 设计来源：设计v2 §13.1。原则：
 * - 静态检查：只做文件/配置/版本可判定的事实核对，产出 pass/fail/warn。
 * - 实测检查：必须真实运行 Leader/子任务才能判定；本模块只登记描述符，
 *   状态一律 not-measured，绝不按静态推断标 pass（“不假通过”）。
 * - 探测不可用（静态 fail 或缺运行时）→ assertProbeUsable 抛错，明确拒绝
 *   启用新模式；不静默 fallback 到 legacy（设计 §13.1/§1.2）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  BUILD_MODEL_PROVIDER, KNOWN_AMAGI_KEY_MAPPED_PROVIDERS, ZHIPU_API_KEY_ENV,
  validateBuildRunSpec,
  type AmagiPackageRef, type BuildRunSpec, type CapabilityCheck, type CapabilityReport, type ProbeInput,
} from './contracts.js';
import {
  AmagiPackageError, computePackageContentHash, inspectAmagiPackageLayout,
  verifyAmagiPackage,
} from './amagi-package.js';
import {
  planBuildDirectories, validateRenderedConfig, agentDirConfigMatchesSpec,
} from './agent-dir-config.js';

export class BuildRuntimeProbeError extends Error {
  constructor(message: string, readonly checks: CapabilityCheck[]) {
    super(message);
  }
}

/** 实测检查描述符（13.1 表中必须真实运行的项）。 */
export const MEASURED_PROBE_RUNBOOK: ReadonlyArray<{ id: string; title: string; how: string }> = [
  { id: 'extension-load', title: '扩展加载', how: 'Leader 同时加载版本化 amagi-core 与应用转发扩展（-e 两项），无同名工具诊断；实际可调用工具与白名单一致；子进程加载同一安装目录的 amagi-pi' },
  { id: 'model-call', title: '模型调用', how: '静态声明的 zhipuai 模型让 Leader 与子任务完成一次派发和工具调用；子进程环境只含所需密钥' },
  { id: 'mcp-channel', title: 'MCP 通道', how: '子任务经 mcp_call 调用桥接工具；scope.mcp 显式列出的写入工具放行、未列出被拒；工具面无自动启用的 codemode/tool_search' },
  { id: 'identity', title: '身份一致', how: '桥接读到的 AMAGI_TASK_ID/AMAGI_AGENT 与创建事件一致；两个并行子任务各自正确；续接链继承分配' },
  { id: 'guard-effect', title: '派发守卫生效', how: '守卫修改后的 scope 出现在冻结任务契约（v2-store spec）中；非构建角色与越界模型被阻止' },
  { id: 'completion-notify', title: '完成通知', how: '后台完成触发 Leader 新一轮，RPC 宿主正确处理自触发轮次；构建流程不依赖界面确认' },
  { id: 'quota', title: '配额', how: '子任务并发不超过各池容量之和，排队原因可见（amagi registry queueReason）' },
  { id: 'cancel', title: '取消', how: '停止后无残留子进程（启动锚点/orphan 核对），旧凭据写入被拒绝' },
  { id: 'recovery', title: '恢复', how: '原会话续接后 amagi 对账正确，或成果级恢复可用' },
  { id: 'prompt-injection-overhead', title: '通用规则注入开销', how: '记录 Leader 输入 token 与偏离构建规则的次数（amagi L0 模板无开关，设计 §3.4）' },
];

/** pi 支持范围（与 PiRuntimeResolver 同口径）。 */
export const PI_SUPPORTED_RANGE = '>=1.4.0 <2.0.0';

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^[^0-9]*/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^[^0-9]*/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function piVersionInRange(version: string): boolean {
  return compareSemver(version, '1.4.0') >= 0 && compareSemver(version, '2.0.0') < 0;
}

export interface StaticProbeInput extends ProbeInput {
  amagiContentHash?: string;
  amagiInstallDir?: string;
  /** 已解析的 pi 版本（PiRuntimeResolver 探测值）。 */
  piVersion: string;
  /** 期望冻结的 spec（可选：探测阶段可能尚未构造完整 spec，缺省跳过 spec 相关项）。 */
  spec?: BuildRunSpec;
  /** 已存在的构建 agentDir（start 前复核用；缺省只查包与运行时）。 */
  agentDir?: string;
  /** 桥接启动命令（与冻结时一致才做 mcp.json 字节比对；缺省退为形状校验）。 */
  bridge?: { bridgeCommand: string; bridgeArgs: string[] };
}

/** 运行静态探测。只做事实核对；任何静态 fail 都会让 report.staticOk=false。 */
export function runStaticProbes(input: StaticProbeInput): CapabilityReport {
  const checks: CapabilityCheck[] = [];
  const push = (check: CapabilityCheck): void => { checks.push(check); };

  // 1. pi 版本
  if (!input.piVersion) {
    push({ id: 'pi-version', title: 'pi 版本', kind: 'static', state: 'fail', detail: '未探测到 pi 版本（运行时未就绪）' });
  } else if (piVersionInRange(input.piVersion)) {
    push({ id: 'pi-version', title: 'pi 版本', kind: 'static', state: 'pass', detail: `pi ${input.piVersion} 在 ${PI_SUPPORTED_RANGE}` });
  } else {
    push({ id: 'pi-version', title: 'pi 版本', kind: 'static', state: 'fail', detail: `pi ${input.piVersion} 不在支持范围 ${PI_SUPPORTED_RANGE}` });
  }

  // 2. amagi 包安装
  let amagiPackage: AmagiPackageRef | null = null;
  try {
    const verified = verifyAmagiPackage({ dataRoot: input.dataRoot, version: input.amagiVersion,
      contentHash: input.amagiContentHash, installDir: input.amagiInstallDir ?? input.spec?.amagiPackage.installDir, verifyHash: false });
    amagiPackage = { version: verified.version, installDir: verified.installDir, packageRoot: verified.packageRoot, contentHash: verified.contentHash };
    const layout = inspectAmagiPackageLayout(verified.packageRoot);
    if (layout.ok) {
      push({ id: 'amagi-package', title: 'amagi-pi 安装', kind: 'static', state: 'pass', detail: `amagi-pi@${verified.version} @ ${verified.packageRoot}（hash ${verified.contentHash.slice(0, 12)}，结构完整）` });
    } else {
      push({ id: 'amagi-package', title: 'amagi-pi 安装', kind: 'static', state: 'fail', detail: `包结构不完整: ${layout.issues.join('、')}` });
    }
    // 完整哈希核对（漂移=fail：版本化目录不允许原地修改）
    try {
      const current = computePackageContentHash(verified.packageRoot);
      if (current.contentHash !== verified.record.contentHash) {
        push({ id: 'amagi-package-hash', title: 'amagi-pi 内容哈希', kind: 'static', state: 'fail', detail: `内容漂移（安装时 ${verified.record.contentHash.slice(0, 12)}，当前 ${current.contentHash.slice(0, 12)}）` });
      } else {
        push({ id: 'amagi-package-hash', title: 'amagi-pi 内容哈希', kind: 'static', state: 'pass', detail: `哈希一致（${current.files} 文件 / ${Math.round(current.bytes / 1024)} KiB）` });
      }
    } catch (error) {
      push({ id: 'amagi-package-hash', title: 'amagi-pi 内容哈希', kind: 'static', state: 'fail', detail: `重算失败: ${error instanceof Error ? error.message : String(error)}` });
    }
  } catch (error) {
    const detail = error instanceof AmagiPackageError ? `${error.code}: ${error.message}` : String(error);
    push({ id: 'amagi-package', title: 'amagi-pi 安装', kind: 'static', state: 'fail', detail: `版本化安装不可用（${detail}）——在设置「构建编排」卡安装：默认官方 Git 固定 commit 获取，或填本地 amagi-pi@${input.amagiVersion} 目录` });
  }

  // 3. 模型密钥映射（静态知识对账）
  if ((KNOWN_AMAGI_KEY_MAPPED_PROVIDERS as readonly string[]).includes(BUILD_MODEL_PROVIDER)) {
    push({ id: 'model-key-mapping', title: '模型密钥映射', kind: 'static', state: 'pass', detail: `provider ${BUILD_MODEL_PROVIDER} 在 amagi PROVIDER_KEY_MAP 内（密钥变量 ${ZHIPU_API_KEY_ENV}；静态表源自 amagi-pi 源码，升版须重核）` });
  } else {
    push({ id: 'model-key-mapping', title: '模型密钥映射', kind: 'static', state: 'fail', detail: `provider ${BUILD_MODEL_PROVIDER} 不在已知 amagi 密钥映射表内，子任务收不到凭据` });
  }
  if (!input.hasZhipuApiKey) {
    push({ id: 'model-key-present', title: '模型密钥可用', kind: 'static', state: 'fail', detail: '应用配置中无可用 GLM 密钥（探测阶段不读取密钥值）' });
  } else {
    push({ id: 'model-key-present', title: '模型密钥可用', kind: 'static', state: 'pass', detail: '应用配置已提供 GLM 密钥（布尔核对，未取值）' });
  }

  // 4. spec 与 agentDir 配置（可选输入）
  if (input.spec) {
    const specIssues = validateBuildRunSpec(input.spec);
    push(specIssues.length === 0
      ? { id: 'spec-valid', title: '运行规格', kind: 'static', state: 'pass', detail: `BuildRunSpec 校验通过（pools ${Object.entries(input.spec.limits.admissionPools).map(([k, v]) => `${k}:${v}`).join(' ')}）` }
      : { id: 'spec-valid', title: '运行规格', kind: 'static', state: 'fail', detail: specIssues.join('；') });

    // thinking 档位支持核对
    const missingMaps: string[] = [];
    for (const descriptor of input.spec.modelDescriptors) {
      if (descriptor.thinking && !descriptor.thinkingLevelMap) missingMaps.push(descriptor.id);
    }
    if (missingMaps.length > 0) {
      push({ id: 'thinking-level-map', title: '思考档位映射', kind: 'static', state: 'warn', detail: `模型 ${missingMaps.join('、')} 声明了冻结档位但无 thinkingLevelMap，amagi M2 校验可能拒绝该档位 spec——接入试验实测` });
    } else {
      push({ id: 'thinking-level-map', title: '思考档位映射', kind: 'static', state: 'pass', detail: '全部模型档位映射已声明' });
    }

    // 禁区存在性核对（原始库/标准库根应存在）
    if (input.knowledgeBaseRoot && !fs.existsSync(input.knowledgeBaseRoot)) {
      push({ id: 'forbidden-roots', title: '禁区根存在性', kind: 'static', state: 'warn', detail: `原始库根不存在: ${input.knowledgeBaseRoot}（增量构建前应已初始化）` });
    } else {
      push({ id: 'forbidden-roots', title: '禁区根存在性', kind: 'static', state: 'pass', detail: '原始库/标准库根可定位' });
    }

    if (input.agentDir) {
      // 5. agentDir 配置复核（start 前真实落盘核对）
      const dirs = planBuildDirectories(input.dataRoot, input.spec.buildId);
      const home = input.agentDir;
      const read = (name: string): string | null => {
        try { return fs.readFileSync(path.join(home, name), 'utf-8'); } catch { return null; }
      };
      const settings = read('settings.json');
      const amagi = read('amagi.json');
      const models = read('models.json');
      const mcp = read('mcp.json');
      if (!settings || !amagi || !models || !mcp) {
        push({ id: 'agent-dir-config', title: 'agentDir 配置', kind: 'static', state: 'fail', detail: `构建 agentDir 缺配置文件（${['settings.json', 'amagi.json', 'models.json', 'mcp.json'].filter((n) => !read(n)).join('、')}）` });
      } else {
        const issues = validateRenderedConfig(
          { settings, amagi, models, mcp } as Record<'settings' | 'amagi' | 'models' | 'mcp', string>,
          input.spec, dirs,
        );
        // 容忍式漂移：settings.json 允许 amagi 会话韧性链追加字段；amagi/models 逐字节比对；
        // mcp.json 字节比对需与冻结时同机同 bridge（probe 未携带时退为形状校验）。
        const matches = fs.existsSync(input.agentDir)
          ? agentDirConfigMatchesSpec(input.agentDir, input.spec, input.bridge)
          : { ok: false, issues: ['agentDir 不存在'] };
        if (issues.length === 0 && matches.ok) {
          push({ id: 'agent-dir-config', title: 'agentDir 配置', kind: 'static', state: 'pass', detail: `四文件齐全且校验通过（spec 哈希 ${input.spec.agentDirConfigHash.slice(0, 12)}）` });
        } else if (issues.length > 0) {
          push({ id: 'agent-dir-config', title: 'agentDir 配置', kind: 'static', state: 'fail', detail: issues.join('；') });
        } else {
          push({ id: 'agent-dir-config', title: 'agentDir 配置', kind: 'static', state: 'fail', detail: `${matches.issues.join('；')}（spec 哈希 ${input.spec.agentDirConfigHash.slice(0, 12)}）——配置被改动或 spec 未更新` });
        }
      }
      // 工作目录干净度
      const workDirty = ['amagi.json', '.mcp.json'].filter((name) => fs.existsSync(path.join(dirs.workDir, name)));
      if (workDirty.length > 0) {
        push({ id: 'workdir-clean', title: '工作目录干净度', kind: 'static', state: 'fail', detail: `工作目录存在配置面文件: ${workDirty.join('、')}（项目级配置会覆盖构建冻结配置）` });
      } else {
        push({ id: 'workdir-clean', title: '工作目录干净度', kind: 'static', state: 'pass', detail: '工作目录无项目级 amagi.json/.mcp.json' });
      }
    }
  }

  // 实测项全部登记 not-measured
  for (const item of MEASURED_PROBE_RUNBOOK) {
    push({ id: item.id, title: item.title, kind: 'measured', state: 'not-measured', detail: item.how });
  }

  const staticChecks = checks.filter((c) => c.kind === 'static');
  const staticOk = staticChecks.every((c) => c.state === 'pass' || c.state === 'warn');
  return {
    buildId: input.spec?.buildId,
    staticOk,
    fullyVerified: false, // 实测未跑，永远不在此处置 true（由接入试验填充）
    piVersion: input.piVersion || null,
    amagiPackage,
    checks,
    checkedAt: new Date().toISOString(),
  };
}

/** 探测不可用时明确拒绝启用（fail-closed；不静默 fallback）。 */
export function assertProbeUsable(report: CapabilityReport): void {
  const failures = report.checks.filter((c) => c.state === 'fail');
  if (!report.staticOk || failures.length > 0) {
    throw new BuildRuntimeProbeError(
      `构建运行时探测未通过，拒绝启用 pi-amagi 模式：\n${failures.map((f) => `- [${f.id}] ${f.detail}`).join('\n')}`,
      report.checks,
    );
  }
}
