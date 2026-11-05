/**
 * build-runtime/contracts.ts — 构建 v2「运行时隔离与 Pi 宿主底座」共享契约
 *
 * 设计来源：基于Agent基座与工作流插件的构建重构设计-v2.md §3/§6/§8。
 * 本文件只放跨模块复用的类型、常量与纯校验函数，不依赖 server 其他模块——
 * kb-build-service（编排接线切片）、pi-extension（扩展切片）与工具切片都以
 * 本文件为契约面。改这里的公共形状前先通知 Leader 协调并行切片。
 *
 * 关键语义（设计 §3.1/§3.2）：
 * - 每次构建一个专用 agentDir（`<dataRoot>/agent/builds/<buildId>/home`）与
 *   运行目录（`.../work`）；子任务经继承的 PI_CODING_AGENT_DIR 加载其中
 *   settings.json 声明的全部包，因此 settings.json 只声明版本化 amagi-pi。
 * - 模型静态声明在 agentDir models.json；provider 仅支持 amagi 密钥映射表
 *   内的 provider（当前构建 = zhipuai / $ZHIPU_API_KEY），凭据不落盘。
 * - `agentDirConfigHash` 只覆盖四个配置文件的规范 JSON，不含任何密钥值。
 */

/** 编排模式（设计 §13.5）。本模块只实现 `pi-amagi`。 */
export type OrchestrationMode = 'legacy' | 'pi-amagi' | 'claude-native';

/** 构建角色键（应用侧语义角色，非 amagi agent 名）。 */
export type BuildRoleKey = 'writer' | 'reviewer' | 'research';

/** amagi 内置角色名（核查证据 Q3：角色卡只能来自包内 agents/）。 */
export const KNOWN_AMAGI_AGENTS = ['luban', 'diting', 'baize', 'fuxi', 'luoshen'] as const;
export type AmagiAgentName = (typeof KNOWN_AMAGI_AGENTS)[number];

/** 角色键 → 默认 amagi agent（设计 §3.5）。 */
export const DEFAULT_ROLE_AGENTS: Readonly<Record<BuildRoleKey, AmagiAgentName>> = {
  writer: 'luban',
  reviewer: 'diting',
  research: 'baize',
};

/** amagi 任务面工具（Leader 白名单必须包含；设计 §3.4）。 */
export const AMAGI_TASK_TOOLS = [
  'task_submit',
  'task_query',
  'task_control',
  'task_resume',
  'amagi_resource',
] as const;

/**
 * amagi 已知密钥映射 provider（核查证据 Q2，task-run.ts PROVIDER_KEY_MAP，
 * 源自 amagi-pi 2.21.31）。静态知识：amagi 升版后必须重核此表（能力探测
 * 项 model-key-mapping 负责对账说明）。
 */
export const KNOWN_AMAGI_KEY_MAPPED_PROVIDERS = [
  'openrouter', 'zhipuai', 'yescode', 'minimax', 'deepseek', 'anthropic',
  'anthropic-relay', 'google', 'openai', 'moonshot', 'kimi-for-coding',
  'kimi-coding', 'tbrouter', 'bailian-coding', 'dashscope', 'bailian',
] as const;

/** 当前构建唯一受支持的模型 provider（设计 §3.2）。 */
export const BUILD_MODEL_PROVIDER = 'zhipuai' as const;
/** 该 provider 对应的 amagi 密钥环境变量（PROVIDER_KEY_MAP['zhipuai']）。 */
export const ZHIPU_API_KEY_ENV = 'ZHIPU_API_KEY';

/**
 * 子任务 MCP 桥接 server 名（agentDir mcp.json 登记 + amagi.json 路由引用）。
 * 必须避开用户目录兼容配置（~/.agents/.mcp.json）中已定义的名称——设计 §3.3。
 */
export const BUILD_MCP_SERVER_NAME = 'feishu-kb-bridge';

/** 桥接 mcp.json env 引用的两个变量名（值只以 ${VAR} 引用，不落盘明文）。 */
export const BUILD_MCP_URL_ENV = 'FEISHU_SYNC_BUILD_MCP_URL';
export const BUILD_MCP_TOKEN_ENV = 'FEISHU_SYNC_BUILD_MCP_TOKEN';

/** 子任务唯一写面：报告目录（设计 §3.1/§3.4）。 */
export const REPORT_WRITE_GLOB = 'agent-outputs/**';

/** thinking 档位合法值（amagi model-resolver VALID_THINKING_LEVELS）。 */
export const VALID_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];

/** models.json 单模型描述（静态声明输入；形状见 pi models-configuration.md）。 */
export interface BuildModelDescriptor {
  /** 模型 id（发给 API 的模型名，不含 provider 前缀）。 */
  id: string;
  /** OpenAI 兼容端点 baseUrl（来自应用 llm 配置，不含 key）。 */
  baseUrl: string;
  /** API 协议；当前构建固定 openai-completions。 */
  api: 'openai-completions';
  /** 是否支持思考。 */
  reasoning?: boolean;
  /** 各档位映射到 provider 的值（null = 不支持该档）。缺省时不写 amagi 侧 thinking 档位。 */
  thinkingLevelMap?: Record<string, string | null>;
  /** 冻结的思考档位；须被 thinkingLevelMap 支持（若声明了 map）。 */
  thinking?: ThinkingLevel;
  contextWindow?: number;
  maxTokens?: number;
}

/** 一次构建的模型集（按角色键冻结；Leader 用 leader 字段）。 */
export interface BuildModelSet {
  leader: string;
  writer: string;
  reviewer: string;
  research?: string;
}

/** 自动行为显式冻结（设计 §3.5）。各轮次 -1 表示「不设置（用 amagi 默认）」。 */
export interface BuildAutoRounds {
  /** 自动验证：false → 置 AMAGI_AUTO_VERIFY_OFF=1。 */
  verify: boolean;
  /** 自动续跑轮数 → AMAGI_AUTO_CONTINUE_ROUNDS。 */
  continueRounds: number;
  /** 自动修复轮数 → AMAGI_AUTO_REPAIR_ROUNDS。 */
  repairRounds: number;
  /** 隐式重试轮数 → AMAGI_AUTORETRY_IMPLICIT_ROUNDS。 */
  implicitRetryRounds: number;
}

export const DEFAULT_AUTO_ROUNDS: BuildAutoRounds = {
  verify: false,
  continueRounds: 1,
  repairRounds: 1,
  implicitRetryRounds: 1,
};

/** 并发准入（设计 §3.6）：各角色池容量，合计 ≤ maxConcurrentAgents。 */
export interface BuildLimits {
  maxConcurrentAgents: number;
  /** role → 该角色模型的池容量（同名模型合并为一个池，容量须一致）。 */
  admissionPools: Partial<Record<BuildRoleKey, number>>;
  /** 实验目标（分钟）；仅评估用，不参与任何停止判定。 */
  targetMinutes?: number;
  /** Leader 终止宽限 ms（建议 10000，覆盖 amagi 2s 清理 + pi 关闭流程）。 */
  leaderTerminateGraceMs?: number;
}

export const DEFAULT_LEADER_TERMINATE_GRACE_MS = 10_000;

/**
 * F10：子进程回收宽限（SIGTERM → 等待 → 复核身份 → SIGKILL）。
 * 与 amagi 自身清理链同量级（TERM→2s→KILL），覆盖其内部清理窗口。
 */
export const DEFAULT_CHILD_REAP_GRACE_MS = 3_000;

/** 版本化 amagi-pi 安装记录（见 amagi-package.ts）。 */
export interface AmagiPackageRef {
  /** 包版本（npm 固定版本号）。 */
  version: string;
  /** 版本化安装目录（= 安装时使用的 PI_CODING_AGENT_DIR）。 */
  installDir: string;
  /** amagi-pi 包根（<installDir>/npm/node_modules/amagi-pi）。 */
  packageRoot: string;
  /** 包内容哈希（确定性遍历）。 */
  contentHash: string;
}

/** 冻结一次运行的输入与执行组合（设计 §8）。 */
export interface BuildRunSpec {
  buildId: string;
  generation: number;
  orchestrationMode: 'pi-amagi';
  mode: 'full' | 'incremental';
  /** 材料快照内容哈希（由应用在准备阶段冻结）。 */
  sourceManifestHash: string;
  /** 构建 skill 内容哈希。 */
  workflowRevision: string;
  /** 构建 skill 路径（写入 amagi.json agents.<role>.skills）。 */
  workflowSkillPath: string;
  amagiPackage: AmagiPackageRef;
  /** 探测得到的实际 pi 版本（probe 填充）。 */
  piVersion: string;
  /** agentDir 四配置文件哈希（不含密钥）。 */
  agentDirConfigHash: string;
  models: BuildModelSet;
  /** 各角色使用的模型描述符（去重后写入 models.json）。 */
  modelDescriptors: BuildModelDescriptor[];
  /** role → amagi agent 名（须在 KNOWN_AMAGI_AGENTS 内）。 */
  roles: Record<BuildRoleKey, AmagiAgentName>;
  limits: BuildLimits;
  autoRounds: BuildAutoRounds;
  publicationPolicy: 'auto' | 'manual';
}

/** 定位一次运行与其恢复方式（设计 §8；F09：epoch/launch 身份持久化）。 */
export interface RuntimeBinding {
  buildId: string;
  generation: number;
  /**
   * F09：运行 epoch（Pi 会话/amagi 内部库边界）。fresh 从 1 起；成果级 rebuild
   * 递增；原会话续接保持不变。每个 epoch 独立 home/work/sessions 与全新
   * amagi 内部存储（v2-store/process-audits），rebuild 不复用旧会话或内部库。
   * 旧检查点缺省 undefined → 按 legacy 布局（<buildRoot>/home|work）解释。
   */
  runtimeEpoch?: number;
  /**
   * F09：每次进程启动身份（同一 epoch 内多次启动各异；进程账本关联键）。
   * 业务租约是 generation，进程边界是 runtimeEpoch，单次启动是 launchId——
   * 三者分开，不用 generation 冒充进程身份。
   */
  launchId: string;
  /** 构建 agentDir（PI_CODING_AGENT_DIR）。 */
  agentDir: string;
  /** Leader 与子任务工作目录。 */
  workDir: string;
  /** F09：会话目录持久化（resume 路径核对；legacy binding 可能缺省）。 */
  sessionDir: string | null;
  /** Leader 会话 id（pi --session-id；epoch 内稳定，rebuild 换新）。 */
  leaderSessionId: string | null;
  leaderPid: number | null;
  /**
   * F09：Leader 进程启动时刻（ISO）。pid 复用评估与残留核对的时间基准；
   * 只作对账参考，不单独作为身份证明。
   */
  leaderStartedAt?: string | null;
  /**
   * F10：本绑定最近一次终止对账结果（持久化在检查点；unconfirmed 阻断
   * 第二个 Leader——换 epoch 也不能绕过）。null=尚未终止或已确认清理。
   */
  termination?: TerminationOutcome | null;
  resumeCapability: BuildResumeCapability;
}

export interface BuildResumeCapability {
  /** 原会话续接（同 agentDir + session id 重启 Leader）。 */
  session: boolean;
  /** 成果级重建（凭应用回执重组，不依赖会话记忆）。 */
  artifact: boolean;
}

/** 运行事件（设计 §8）：去重与进度展示统一信封。 */
export interface RuntimeEvent {
  /** 事件 id（按 source 分配：leader-rpc 用 pi 事件序号/工具调用 id）。 */
  eventId: string;
  source: 'leader-rpc' | 'tool-service' | 'amagi-artifact';
  /** 上游原生 id（无可靠 id 时为 null，观察精度见 precision）。 */
  nativeEventId: string | null;
  generation: number;
  taskId: string | null;
  type: string;
  occurredAt: string;
  receivedAt: string;
  payload: Record<string, unknown>;
}

/** 能力探测检查项（诚实区分静态/实测；设计 §13.1）。 */
export interface CapabilityCheck {
  id: string;
  title: string;
  kind: 'static' | 'measured';
  state: 'pass' | 'fail' | 'warn' | 'not-measured';
  detail: string;
}

export interface CapabilityReport {
  buildId?: string;
  /** 静态检查全部 pass（无 fail）才为 true；warn 不阻断。 */
  staticOk: boolean;
  /** 完整启用（含实测）前必须为 true；静态 ok 但实测未跑时仍为 false。 */
  fullyVerified: boolean;
  piVersion: string | null;
  amagiPackage: AmagiPackageRef | null;
  checks: CapabilityCheck[];
  /** 生成时间（ISO）。 */
  checkedAt: string;
}

/**
 * F10：子进程/桥残留核对的单个个体结论。
 * verdict 语义：exited=已证明退出（自然退出或 pid 复用排除）；reaped=核对身份
 * 后回收；not-ours=身份不匹配（pid 被无关进程复用，绝不发信号）；
 * abandoned=已撤权并自动清理专属进程范围的未完成派发，不声称物理退出或成功；
 * unconfirmed=系统核验或自动清理尚未收敛，暂不启动新 Leader。
 */
export interface ChildProcessFinding {
  /** amagi 原生任务 id（anchor 来源；ledger 来源时为 null）。 */
  taskId: string | null;
  pid: number;
  /** 证据来源：anchor=受信原生启动锚点；ledger=应用进程账本；v2-store=派发意图扫描。 */
  source: 'anchor' | 'ledger' | 'v2-store';
  verdict: 'exited' | 'reaped' | 'not-ours' | 'unconfirmed' | 'abandoned';
  /** 身份证明等级：birth-token=内核出生令牌精确匹配；pgid-invariant=POSIX
   * 进程组不变量（组长 pid 存续期间不复用）；none=无可用证明。 */
  proof: 'birth-token' | 'pgid-invariant' | 'none' | 'scope-scan';
  detail: string;
}

/** F10：终止对账结果（随 CancelResult/检查点持久化；贯穿 supervisor/host）。 */
export interface TerminationOutcome {
  /** confirmed=已核验退出或完成撤权后的自动隔离；abandoned 不声称物理退出。
   * unconfirmed=自动清理尚未收敛或系统探测失败（暂不启动第二个 Leader）。 */
  state: 'confirmed' | 'unconfirmed';
  at: string;
  /** Leader 退出事实（不可得时 null，不伪称）。 */
  leaderExit: { code: number | null; signal: string | null } | null;
  /** 子进程/桥个体结论明细。 */
  children: ChildProcessFinding[];
  note: string;
}

/** 取消结果（设计 §9；F10 增补终止对账）。 */
export interface CancelResult {
  leaderExit: { code: number | null; signal: string | null } | null;
  /** 凭据是否已按代次撤销（由注入的撤销钩子回报）。 */
  credentialsRevoked: boolean;
  /** 残留子进程处置说明；amagi 子进程由其自身 TERM→KILL 链收口。 */
  residualNote: string;
  /** F10：结构化终止对账（unconfirmed 时消费方必须阻断第二 Leader）。 */
  termination?: TerminationOutcome | null;
}

/** 恢复检查点（应用侧持久化结构的最小面；内容归接线切片扩展）。 */
export interface BuildCheckpoint {
  buildId: string;
  generation: number;
  spec: BuildRunSpec;
  binding: RuntimeBinding;
  /** 已接受成果/有效审查/输出分配/未解决问题等由应用登记，这里只引用。 */
  artifactReceiptRefs: string[];
  eventCursor: string | null;
}

/** start 的 epoch 输入（F09：epoch 由集成方按检查点分配，adapter 不自行递增）。 */
export interface AdapterStartOptions {
  /** 运行 epoch（≥1；fresh=1，rebuild=检查点 epoch+1；缺省按 1 处理）。 */
  runtimeEpoch?: number;
}

/** 运行适配层唯一入口（设计 §8；不新增 scheduleTasks/角色队列）。 */
export interface BuildRuntimeAdapter {
  probe(input: ProbeInput): Promise<CapabilityReport>;
  start(spec: BuildRunSpec, options?: AdapterStartOptions): Promise<RuntimeBinding>;
  observe(binding: RuntimeBinding, after?: string): AsyncIterable<RuntimeEvent>;
  resume(binding: RuntimeBinding, checkpoint: BuildCheckpoint): Promise<RuntimeBinding>;
  cancel(binding: RuntimeBinding): Promise<CancelResult>;
  /**
   * F10：残留对账（observe/reap）。读取受信原生启动锚点 + 应用进程账本，
   * 以 OS 出生身份/进程组不变量交叉核验后回收可证明个体；无法证明的个体
   * 不发信号，返回 unconfirmed。reap=true 时才允许对已证明个体发信号。
   */
  reconcileResiduals(binding: RuntimeBinding, options?: { reap?: boolean }): Promise<TerminationOutcome>;
}

/** probe 输入：运行时定位 + 应用侧路径与凭据可用性（不含密钥值）。 */
export interface ProbeInput {
  dataRoot: string;
  /** 期望安装/使用的 amagi-pi 版本（npm 固定版本）。 */
  amagiVersion: string;
  /** 应用侧根：原始库、标准库（禁区核对用）。 */
  knowledgeBaseRoot: string;
  outputRoot: string;
  /** zhipuai key 是否已在应用配置中可用（只传布尔，不传值）。 */
  hasZhipuApiKey: boolean;
}

// ── 纯校验（供 spec 构造方与能力探测共用）────────────────────────────

export class BuildSpecValidationError extends Error {
  constructor(message: string, readonly fields: string[]) {
    super(message);
  }
}

function stripThinkingSuffix(spec: string): string {
  const colon = spec.lastIndexOf(':');
  if (colon > Math.max(spec.indexOf('/'), 0)) {
    const suffix = spec.slice(colon + 1);
    if ((VALID_THINKING_LEVELS as readonly string[]).includes(suffix)) return spec.slice(0, colon);
  }
  return spec;
}

/**
 * buildId 前缀契约：b_ 前缀是现有真实生成规则（kb-build-service.ts:574
 * `b_${yyyyMMddHHmmss}_${6hex}`），不是新约束；kb_ 等其他前缀不属于构建 id
 * （Leader 调整 #4 已核实）。若未来生成规则变化，同步改这里与测试。
 */
export const BUILD_ID_PATTERN = /^b_[A-Za-z0-9_-]+$/;

/** 去除合法 thinking 后缀后的 `provider/model`（与 amagi 池键同语义）。 */
export function modelSpecPoolKey(spec: string): string {
  return stripThinkingSuffix(spec);
}

/** 校验 BuildRunSpec 的不变量；返回问题列表（空 = 合法）。 */
export function validateBuildRunSpec(spec: BuildRunSpec): string[] {
  const issues: string[] = [];
  if (!BUILD_ID_PATTERN.test(spec.buildId)) issues.push('buildId 形式非法（期望 b_ 前缀，现有 createBuild 生成规则）');
  if (!Number.isInteger(spec.generation) || spec.generation < 1) issues.push('generation 须为 ≥1 整数');
  if (spec.orchestrationMode !== 'pi-amagi') issues.push('本适配层只支持 orchestrationMode=pi-amagi');
  if (spec.mode !== 'full' && spec.mode !== 'incremental') issues.push('mode 须为 full|incremental');
  if (!/^[0-9a-f]{8,}$/i.test(spec.workflowRevision)) issues.push('workflowRevision 须为内容哈希');
  if (!spec.workflowSkillPath) issues.push('workflowSkillPath 缺失');
  if (!spec.amagiPackage?.packageRoot || !spec.amagiPackage?.contentHash) issues.push('amagiPackage 不完整');
  if (!spec.piVersion) issues.push('piVersion 缺失（须先探测）');

  for (const role of Object.keys(spec.roles) as BuildRoleKey[]) {
    const agent = spec.roles[role];
    if (!(KNOWN_AMAGI_AGENTS as readonly string[]).includes(agent)) {
      issues.push(`roles.${role}=${agent} 不是内置 amagi 角色`);
    }
  }
  for (const [key, model] of Object.entries(spec.models)) {
    if (!model) continue;
    if (!model.startsWith(`${BUILD_MODEL_PROVIDER}/`)) {
      issues.push(`models.${key}=${model} 不在受支持 provider（${BUILD_MODEL_PROVIDER}）下`);
    }
  }
  // 三角色模型均必填。实测（2026-11-01，真实 pi + amagi 2.21.31）：未写
  // agents.<role>.model 时 amagi 回退到角色卡 frontmatter（baize→deepseek），
  // 不是 Leader 模型——未冻结模型的 research 子任务会拿到无凭据的 provider。
  for (const role of ['writer', 'reviewer', 'research'] as const) {
    if (!spec.models[role] && (role !== 'research' || spec.roles[role])) {
      issues.push(`models.${role} 缺失`);
    }
  }
  if (spec.modelDescriptors.length === 0) issues.push('modelDescriptors 为空');
  const endpoints = new Set(spec.modelDescriptors.map((descriptor) => descriptor.baseUrl));
  if (endpoints.size !== 1 || endpoints.has('')) {
    issues.push('单一 zhipuai provider 的所有模型必须使用同一非空 baseUrl，不可静默路由到首个端点');
  }
  const declaredModels = new Set(spec.modelDescriptors.map((descriptor) => descriptor.id));
  for (const [role, model] of Object.entries(spec.models)) {
    if (!model) continue;
    const id = modelSpecPoolKey(model).split('/').slice(1).join('/');
    if (!declaredModels.has(id)) issues.push(`models.${role} 未在 modelDescriptors 声明：${id}`);
  }

  const limits = spec.limits;
  if (!Number.isInteger(limits.maxConcurrentAgents) || limits.maxConcurrentAgents < 1 || limits.maxConcurrentAgents > 6) {
    issues.push('limits.maxConcurrentAgents 须为 1..6');
  }
  const poolSum = Object.values(limits.admissionPools).reduce((a, b) => a + (b ?? 0), 0);
  if (poolSum > limits.maxConcurrentAgents) {
    issues.push(`admissionPools 合计 ${poolSum} 超过 maxConcurrentAgents=${limits.maxConcurrentAgents}`);
  }
  for (const [role, cap] of Object.entries(limits.admissionPools)) {
    if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) issues.push(`admissionPools.${role} 须为 ≥1 整数`);
  }
  // 同池（同模型）多角色容量必须一致，否则 amagi 侧单池取值有歧义。
  const roleKeys: BuildRoleKey[] = ['writer', 'reviewer', 'research'];
  const byModel = new Map<string, Set<number>>();
  for (const role of roleKeys) {
    const model = spec.models[role];
    const cap = limits.admissionPools[role];
    if (!model || cap === undefined) continue;
    const key = modelSpecPoolKey(model);
    if (!byModel.has(key)) byModel.set(key, new Set());
    byModel.get(key)!.add(cap);
  }
  for (const [model, caps] of byModel) {
    if (caps.size > 1) issues.push(`模型 ${model} 被多个角色共用但池容量不一致（${[...caps].join('/')}）`);
  }
  for (const role of roleKeys) {
    const model = spec.models[role];
    if (model && !byModel.has(modelSpecPoolKey(model))) {
      issues.push(`models.${role} 缺少冻结准入池容量（禁止回落到 amagi 默认池突破总上限）`);
    }
  }
  if (spec.autoRounds.continueRounds < 0 || spec.autoRounds.repairRounds < 0 || spec.autoRounds.implicitRetryRounds < 0) {
    issues.push('autoRounds 轮数不得为负');
  }
  if (spec.publicationPolicy !== 'auto' && spec.publicationPolicy !== 'manual') {
    issues.push('publicationPolicy 须为 auto|manual');
  }
  return issues;
}
