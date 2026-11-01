/**
 * build-actors — v2 编排（pi-amagi）成果侧权限账本（设计 v2 §4/§8）
 *
 * 一次构建一个 BuildActorStore，持久化在候选目录（staging/<buildId>/
 * build-actors/*.json|jsonl）：身份（ActorBinding）、输出分配
 * （OutputAssignment）、成果回执（ArtifactReceipt，幂等重放）、审查回执
 * （ReviewReceipt，独立性与哈希绑定）、运行事件（RuntimeEvent）、交接
 * 记录、问题清单与发布申请。不建新 DB 表（任务书约定：候选目录 JSON）。
 *
 * 身份链（§4.1）：桥接从 env 读 AMAGI_TASK_ID/AMAGI_AGENT（受信，不采信
 * 模型参数）→ 创建事件（Leader RPC 侧）确认身份；先到者建 pending，只能
 * 读。续接（task_resume/自动续跑）经 parentTaskId 继承分配并撤销旧任务
 * 写资格。
 *
 * 本模块不依赖 agent 层与 DB；工具名常量为纯字符串（与 tool-specs.ts
 * 的 V2 名单一致性由测试 build-runtime-tools.test.ts 保证）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../agent/path-guard.js';

// ============================================================================
// §8 契约类型（成果侧；运行时 BuildRuntimeAdapter/contracts.ts 由另一模块
// 提供，此处类型即对接真相）
// ============================================================================

export type ActorStatus = 'pending' | 'confirmed' | 'revoked';
export type CredentialKind = 'leader' | 'child';

/** ActorBinding（§8）：amagi 任务 ID ↔ 应用权限。 */
export interface ActorBinding {
  actorId: string;
  nativeTaskId: string;
  parentTaskId: string | null;
  generation: number;
  /** amagi 角色（AMAGI_AGENT）：luban/diting/baize（创建事件确认的角色） */
  role: string;
  /** Leader 请求角色（创建事件参数；与 role 不一致时拒绝确认） */
  requestedRole: string;
  status: ActorStatus;
  createdAt: string;
  confirmedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

/** OutputAssignment（§8）：写入资格。targets 为文档路径（kind='doc'）或
 * `family:<familyKey>`（kind='family'，对象族）。 */
export interface OutputAssignment {
  assignmentId: string;
  generation: number;
  targetKind: 'doc' | 'family';
  targets: string[];
  ownerTaskId: string;
  status: 'active' | 'revoked' | 'superseded';
  supersedes: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** ArtifactReceipt（§8）：已接受成果与重放结果。 */
export interface ArtifactReceipt {
  artifactId: string;
  buildId: string;
  generation: number;
  authorTaskId: string;
  kind: 'write_doc' | 'edit_doc' | 'delete_doc' | 'handoff' | 'review';
  operationId: string;
  idempotencyKey: string;
  payloadHash: string;
  result: Record<string, unknown>;
  createdAt: string;
}

export type ReviewVerdict = 'pass' | 'needs_revision' | 'insufficient_material' | 'fail';

/** ReviewReceipt（§8）：独立审查及其有效范围。 */
export interface ReviewReceipt {
  reviewId: string;
  buildId: string;
  generation: number;
  reviewerTaskId: string;
  /** 审查时全部 staging 草稿的候选哈希（computeCandidateHash 同形） */
  draftHash: string;
  /** 依赖哈希绑定：正文（doc:<path>）+ 对象/证据声明（knowledge-declaration）
   * + 来源快照（source-snapshot）+ 冻结 workflow 规则（workflow-rules），
   * 键名→sha256（F08：metadata-only 声明变化/来源漂移/规则漂移均使回执失效）。 */
  dependencyHashes: Record<string, string>;
  ruleVersion: string;
  /** 报告文件绑定（F07）：unitId = reviews/<unitId>.json 文件名；reportId
   * 与文件内 reportId 双向绑定（报告被覆盖/删除时回执不再覆盖候选）。 */
  reportUnitId?: string;
  reportId?: string;
  issues: Array<{
    issueId: string;
    severity: 'blocking' | 'suggestion';
    draftLocation: string;
    sourceLocation: string | null;
    description: string;
  }>;
  verdict: ReviewVerdict;
  status: 'valid' | 'stale';
  staleReason: string | null;
  createdAt: string;
}

/** RuntimeEvent（§8）：去重、进度展示与诊断。 */
export interface RuntimeEventRecord {
  eventId: string;
  source: 'leader-rpc' | 'tool-service' | 'amagi-artifact';
  nativeEventId: string | null;
  generation: number;
  taskId: string | null;
  type: string;
  occurredAt: string | null;
  receivedAt: string;
  payload: Record<string, unknown>;
}

/** 交接记录（§5.2）：子任务→Leader，只携带引用与摘要，不回传正文。 */
export interface HandoffRecord {
  handoffId: string;
  buildId: string;
  generation: number;
  taskId: string;
  role: string;
  summary: string;
  artifactRefs: string[];
  sourceScope: string[];
  openIssues: string[];
  nextInfo: string[];
  createdAt: string;
}

/** Leader 聚合问题清单（§5.3：修订只接收聚合后的阻断问题与相关范围）。 */
export interface IssueListRecord {
  issueListId: string;
  buildId: string;
  generation: number;
  revision: number;
  summary: string | null;
  issues: Array<{
    issueKey: string;
    severity: 'blocking' | 'suggestion';
    targetPath: string | null;
    draftLocation: string | null;
    sourceLocation: string | null;
    description: string;
    fromReviewId: string | null;
  }>;
  createdAt: string;
}

/** 发布申请（§5.4）：Leader 申请具体候选版本；校验管线由集成者注入。 */
export interface PublishRequestRecord {
  requestId: string;
  buildId: string;
  generation: number;
  requestedRevision: string | null;
  candidateHash: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'not_wired';
  result: Record<string, unknown> | null;
  createdAt: string;
  settledAt: string | null;
}

/** 检查点载荷（集成者写入 BuildCheckpoint 的 additive 字段）。 */
export interface BuildActorCheckpointPayload {
  schemaVersion: 1;
  buildId: string;
  generation: number;
  actors: ActorBinding[];
  assignments: OutputAssignment[];
  receipts: ArtifactReceipt[];
  reviews: ReviewReceipt[];
  handoffs: HandoffRecord[];
  issueLists: IssueListRecord[];
  publishRequests: PublishRequestRecord[];
  eventCursor: string | null;
}

// ============================================================================
// 角色→工具面（§3.4/§3.5；与 tool-specs.ts V2 名单一致性由测试保证）
// ============================================================================

/** 子任务通用读取面（三类角色相同；审查/交接读取项含于其中）。 */
export const V2_CHILD_READ_TOOLS = [
  'raw_list',
  'raw_read',
  'raw_search',
  'raw_links',
  'draft_list',
  'draft_read',
  'draft_search',
  'kb_read_batch',
  'build_issues_list',
] as const;

export const V2_WRITER_TOOLS = [...V2_CHILD_READ_TOOLS, 'kb_write_doc', 'kb_edit_doc', 'kb_delete_doc', 'build_handoff_submit'] as const;
export const V2_REVIEWER_TOOLS = [...V2_CHILD_READ_TOOLS, 'kb_submit_review', 'build_handoff_submit'] as const;
export const V2_RESEARCH_TOOLS = [...V2_CHILD_READ_TOOLS, 'build_handoff_submit'] as const;

export interface V2RoleToolset {
  role: string;
  /** 角色可用工具全量名单（读取面 + 角色专属写入面） */
  tools: readonly string[];
  /** 其中需走写入链（身份+分配/幂等）的工具 */
  writeTools: readonly string[];
  /** 该角色是否有草稿写权（决定分配校验面） */
  canWriteDocs: boolean;
  isReviewer: boolean;
}

const V2_WRITER_WRITE_TOOLS = ['kb_write_doc', 'kb_edit_doc', 'kb_delete_doc', 'build_handoff_submit'] as const;

const BUILTIN_ROLE_TOOLSETS: Record<string, V2RoleToolset> = {
  luban: { role: 'luban', tools: V2_WRITER_TOOLS, writeTools: V2_WRITER_WRITE_TOOLS, canWriteDocs: true, isReviewer: false },
  diting: { role: 'diting', tools: V2_REVIEWER_TOOLS, writeTools: ['kb_submit_review', 'build_handoff_submit'] as const, canWriteDocs: false, isReviewer: true },
  baize: { role: 'baize', tools: V2_RESEARCH_TOOLS, writeTools: ['build_handoff_submit'] as const, canWriteDocs: false, isReviewer: false },
};

/** 角色工具面解析（未知角色返回 null——派发守卫应先拒绝，不在这里放宽）。 */
export function resolveV2RoleToolset(role: string, extra: Record<string, V2RoleToolset> = {}): V2RoleToolset | null {
  return extra[role] ?? BUILTIN_ROLE_TOOLSETS[role] ?? null;
}

/** 子任务共享凭据的白名单 = 各角色工具面并集（每次调用的角色校验在服务端）。 */
export const V2_CHILD_ALL_TOOLS = [...new Set<string>([...V2_WRITER_TOOLS, ...V2_REVIEWER_TOOLS, ...V2_RESEARCH_TOOLS])];

export function isReviewerRole(role: string, extra: Record<string, V2RoleToolset> = {}): boolean {
  return resolveV2RoleToolset(role, extra)?.isReviewer ?? false;
}

// ============================================================================
// 工具错误（与 AgentToolService.ToolError 同形；本模块不 import agent 层）
// ============================================================================

export class BuildActorError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ============================================================================
// BuildActorStore
// ============================================================================

const VALID_TASK_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const nowIso = () => new Date().toISOString();

export interface RegisterTaskCreationInput {
  nativeTaskId: string;
  parentTaskId?: string | null;
  /** Leader 请求的角色（RPC task_submit 参数） */
  requestedRole: string;
  /** amagi 实际派发角色（AMAGI_AGENT；缺省取 requestedRole） */
  agent?: string;
  occurredAt?: string;
  nativeEventId?: string | null;
}

export interface AssignOutputsInput {
  targets: string[];
  targetKind?: 'doc' | 'family';
  ownerTaskId: string;
  /** 显式转移：撤销 ownerTaskId 对同目标的旧分配（supersedes 链） */
  supersedes?: boolean;
}

export class BuildActorStore {
  readonly buildId: string;
  readonly stagingRoot: string;
  private generation: number;
  private readonly extraRoles: Record<string, V2RoleToolset>;
  private actors = new Map<string, ActorBinding>();
  private assignments = new Map<string, OutputAssignment>();
  private receipts = new Map<string, ArtifactReceipt>(); // idempotencyKey → receipt
  private reviews = new Map<string, ReviewReceipt>();
  private handoffs: HandoffRecord[] = [];
  private issueLists: IssueListRecord[] = [];
  private publishRequests: PublishRequestRecord[] = [];
  private events: RuntimeEventRecord[] = [];
  private seenEventIds = new Set<string>(); // source|nativeEventId 去重
  /** 最近作者账本：doc path → nativeTaskId（审查独立性用） */
  private lastAuthorByPath = new Map<string, string>();
  private publishWindow: { draftHash: string; requestId: string } | null = null;
  /** 已追加到 events.jsonl 的事件数（load 后同步；避免全量重写追加型日志） */
  private persistedEventCount = 0;

  constructor(input: { buildId: string; stagingRoot: string; generation?: number; extraRoles?: Record<string, V2RoleToolset> }) {
    if (!VALID_TASK_ID.test(input.buildId)) throw new BuildActorError('invalid_request', `无效构建标识: ${input.buildId}`);
    this.buildId = input.buildId;
    this.stagingRoot = input.stagingRoot;
    this.generation = input.generation ?? 1;
    this.extraRoles = input.extraRoles ?? {};
  }

  // ------------------------------------------------------------------
  // 持久化（候选目录 JSON；内存权威 + 原子落盘）
  // ------------------------------------------------------------------

  private get actorDir(): string {
    return path.join(this.stagingRoot, 'build-actors');
  }

  private writeJson(name: string, value: unknown): void {
    fs.mkdirSync(this.actorDir, { recursive: true });
    atomicWriteFile(path.join(this.actorDir, name), `${JSON.stringify(value, null, 2)}\n`);
  }

  /** 全量落盘（写入工具成功后与检查点时调用）。 */
  persist(): void {
    this.writeJson('actors.json', [...this.actors.values()]);
    this.writeJson('assignments.json', [...this.assignments.values()]);
    this.writeJson('receipts.json', [...this.receipts.values()]);
    this.writeJson('reviews.json', [...this.reviews.values()]);
    this.writeJson('handoffs.json', this.handoffs);
    this.writeJson('issue-lists.json', this.issueLists);
    this.writeJson('publish-requests.json', this.publishRequests);
    const pendingEvents = this.events.slice(this.persistedEventCount);
    if (pendingEvents.length > 0) {
      fs.mkdirSync(this.actorDir, { recursive: true });
      fs.appendFileSync(path.join(this.actorDir, 'events.jsonl'), `${pendingEvents.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf-8');
      this.persistedEventCount = this.events.length;
    }
  }

  load(): void {
    const read = <T>(name: string): T => {
      const file = path.join(this.actorDir, name);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) as T : ([] as unknown as T);
    };
    this.actors = new Map((read<ActorBinding[]>('actors.json')).map((actor) => [actor.nativeTaskId, actor]));
    this.assignments = new Map((read<OutputAssignment[]>('assignments.json')).map((item) => [item.assignmentId, item]));
    this.receipts = new Map((read<ArtifactReceipt[]>('receipts.json')).map((item) => [item.idempotencyKey, item]));
    this.reviews = new Map((read<ReviewReceipt[]>('reviews.json')).map((item) => [item.reviewId, item]));
    this.handoffs = read<HandoffRecord[]>('handoffs.json');
    this.issueLists = read<IssueListRecord[]>('issue-lists.json');
    this.publishRequests = read<PublishRequestRecord[]>('publish-requests.json');
    const eventsFile = path.join(this.actorDir, 'events.jsonl');
    if (fs.existsSync(eventsFile)) {
      for (const line of fs.readFileSync(eventsFile, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as RuntimeEventRecord;
          this.events.push(event);
          if (event.nativeEventId) this.seenEventIds.add(`${event.source}|${event.nativeEventId}`);
        } catch { /* 损坏行跳过（追加型日志） */ }
      }
    }
    this.persistedEventCount = this.events.length;
    // 最近作者账本从回执恢复（写入序）
    for (const receipt of this.receipts.values()) {
      const paths = Array.isArray(receipt.result?.paths) ? receipt.result.paths : [];
      for (const docPath of paths) if (typeof docPath === 'string') this.lastAuthorByPath.set(docPath, receipt.authorTaskId);
    }
  }

  // ------------------------------------------------------------------
  // 代次与凭据（§4.1/§9：取消或换代立即失效）
  // ------------------------------------------------------------------

  get activeGeneration(): number {
    return this.generation;
  }

  /** 断点恢复：换代（签发新代次凭据前调用）。撤销旧代次全部身份与分配。 */
  rotateGeneration(generation: number, reason: string): void {
    if (generation <= this.generation) throw new BuildActorError('invalid_request', `新代次必须大于当前代次 ${this.generation}`);
    for (const actor of this.actors.values()) {
      if (actor.status !== 'revoked') {
        actor.status = 'revoked';
        actor.revokedAt = nowIso();
        actor.revokedReason = `generation_rotated: ${reason}`;
      }
    }
    for (const assignment of this.assignments.values()) {
      if (assignment.status === 'active') {
        assignment.status = 'revoked';
        assignment.revokedAt = nowIso();
      }
    }
    this.generation = generation;
    this.appendEvent({ source: 'tool-service', type: 'generation_rotated', generation, payload: { generation, reason } });
    this.persist();
  }

  assertGeneration(generation: number): void {
    if (generation !== this.generation) {
      throw new BuildActorError('credential_generation_revoked', `凭据代次 ${generation} 已失效（当前代次 ${this.generation}）`, 401);
    }
  }

  // ------------------------------------------------------------------
  // 身份（§4.1：创建事件确认；pending 只读）
  // ------------------------------------------------------------------

  /** 桥接调用先于创建事件：建立待确认身份（只能读）。 */
  ensurePendingIdentity(nativeTaskId: string, agent: string | undefined): ActorBinding {
    const existing = this.actors.get(nativeTaskId);
    if (existing) return existing;
    if (!VALID_TASK_ID.test(nativeTaskId)) throw new BuildActorError('amagi_task_invalid', `无效任务标识: ${nativeTaskId}`, 401);
    const actor: ActorBinding = {
      actorId: `actor_${crypto.randomBytes(6).toString('hex')}`,
      nativeTaskId,
      parentTaskId: null,
      generation: this.generation,
      role: agent ?? 'unknown',
      requestedRole: agent ?? 'unknown',
      status: 'pending',
      createdAt: nowIso(),
      confirmedAt: null,
      revokedAt: null,
      revokedReason: null,
    };
    this.actors.set(nativeTaskId, actor);
    this.appendEvent({ source: 'tool-service', type: 'actor_pending', taskId: nativeTaskId, payload: { actorId: actor.actorId, agent: agent ?? null } });
    return actor;
  }

  /**
   * 登记创建事件（集成者从 Leader RPC 事件转发）：确认 pending 身份或直接
   * 建 confirmed。续接（parentTaskId）继承父分配并撤销父任务写入资格。
   */
  registerTaskCreation(input: RegisterTaskCreationInput): ActorBinding {
    if (!VALID_TASK_ID.test(input.nativeTaskId)) throw new BuildActorError('amagi_task_invalid', `无效任务标识: ${input.nativeTaskId}`, 401);
    if (input.parentTaskId != null && !VALID_TASK_ID.test(input.parentTaskId)) {
      throw new BuildActorError('amagi_task_invalid', `无效父任务标识: ${input.parentTaskId}`);
    }
    if (input.parentTaskId === input.nativeTaskId) {
      throw new BuildActorError('amagi_task_invalid', '续接父任务不能是自身');
    }
    if (input.parentTaskId != null && !this.actors.has(input.parentTaskId)) {
      throw new BuildActorError('amagi_parent_unknown', `父任务未登记: ${input.parentTaskId}`, 409);
    }
    const agent = input.agent ?? input.requestedRole;
    const existing = this.actors.get(input.nativeTaskId);
    const actor: ActorBinding = existing
      ? { ...existing, parentTaskId: input.parentTaskId ?? existing.parentTaskId, requestedRole: input.requestedRole, role: agent, status: existing.status === 'revoked' ? 'revoked' : 'confirmed', confirmedAt: existing.status === 'revoked' ? existing.confirmedAt : nowIso() }
      : {
        actorId: `actor_${crypto.randomBytes(6).toString('hex')}`,
        nativeTaskId: input.nativeTaskId,
        parentTaskId: input.parentTaskId ?? null,
        generation: this.generation,
        role: agent,
        requestedRole: input.requestedRole,
        status: 'confirmed',
        createdAt: nowIso(),
        confirmedAt: nowIso(),
        revokedAt: null,
        revokedReason: null,
      };
    if (existing?.status === 'revoked') {
      throw new BuildActorError('actor_revoked', `任务 ${input.nativeTaskId} 已撤销，不能确认`, 401);
    }
    if (!resolveV2RoleToolset(agent, this.extraRoles)) {
      throw new BuildActorError('actor_role_unknown', `角色不在构建角色表内: ${agent}`, 403);
    }
    this.actors.set(input.nativeTaskId, actor);
    // 续接继承：父任务的 active 分配转移到新任务 ID，父任务写资格撤销（§4.2）
    if (input.parentTaskId) {
      const inherited: string[] = [];
      for (const assignment of this.assignments.values()) {
        if (assignment.ownerTaskId === input.parentTaskId && assignment.status === 'active') {
          assignment.status = 'superseded';
          assignment.revokedAt = nowIso();
          const successor: OutputAssignment = {
            assignmentId: `asg_${crypto.randomBytes(6).toString('hex')}`,
            generation: this.generation,
            targetKind: assignment.targetKind,
            targets: [...assignment.targets],
            ownerTaskId: input.nativeTaskId,
            status: 'active',
            supersedes: assignment.assignmentId,
            createdAt: nowIso(),
            revokedAt: null,
          };
          this.assignments.set(successor.assignmentId, successor);
          inherited.push(successor.assignmentId);
        }
      }
      const parent = this.actors.get(input.parentTaskId);
      if (parent && parent.status === 'confirmed') {
        parent.status = 'revoked';
        parent.revokedAt = nowIso();
        parent.revokedReason = 'superseded_by_resume';
      }
      this.appendEvent({ source: 'leader-rpc', type: 'actor_inherited', taskId: input.nativeTaskId, payload: { parentTaskId: input.parentTaskId, assignments: inherited } });
    }
    this.appendEvent({
      source: 'leader-rpc',
      nativeEventId: input.nativeEventId ?? null,
      taskId: input.nativeTaskId,
      type: 'actor_confirmed',
      payload: { role: agent, requestedRole: input.requestedRole, parentTaskId: input.parentTaskId ?? null },
      occurredAt: input.occurredAt,
    });
    this.persist();
    return actor;
  }

  lookupActor(nativeTaskId: string): ActorBinding | null {
    return this.actors.get(nativeTaskId) ?? null;
  }

  /** 已确认身份的解析入口（工具面统一校验）。 */
  requireConfirmedActor(nativeTaskId: string, expectedAgent: string | undefined): ActorBinding {
    const actor = this.actors.get(nativeTaskId);
    if (!actor) throw new BuildActorError('amagi_task_unknown', `任务未登记: ${nativeTaskId}`, 401);
    if (actor.status === 'revoked') {
      throw new BuildActorError('actor_revoked', `任务 ${nativeTaskId} 写入资格已撤销（${actor.revokedReason ?? 'revoked'}）`, 401);
    }
    if (actor.status === 'pending') {
      throw new BuildActorError('actor_pending', `任务 ${nativeTaskId} 身份待确认（创建事件未到达，当前只能读取）`, 403);
    }
    if (expectedAgent !== undefined && actor.role !== expectedAgent) {
      throw new BuildActorError('actor_role_mismatch', `桥接角色 ${expectedAgent} 与登记角色 ${actor.role} 不一致`, 403);
    }
    return actor;
  }

  revokeActor(nativeTaskId: string, reason: string): void {
    const actor = this.actors.get(nativeTaskId);
    if (!actor) return;
    actor.status = 'revoked';
    actor.revokedAt = nowIso();
    actor.revokedReason = reason;
    for (const assignment of this.assignments.values()) {
      if (assignment.ownerTaskId === nativeTaskId && assignment.status === 'active') {
        assignment.status = 'revoked';
        assignment.revokedAt = nowIso();
      }
    }
    this.appendEvent({ source: 'tool-service', type: 'actor_revoked', taskId: nativeTaskId, payload: { reason } });
    this.persist();
  }

  listActors(): ActorBinding[] {
    return [...this.actors.values()];
  }

  /** 角色工具面（内置+额外角色表）。 */
  roleToolset(role: string): V2RoleToolset | null {
    return resolveV2RoleToolset(role, this.extraRoles);
  }

  /** 续接链上溯（含自身）：审查独立性判定用。 */
  ancestryOf(nativeTaskId: string): Set<string> {
    const chain = new Set<string>();
    let cursor: string | null = nativeTaskId;
    while (cursor && !chain.has(cursor)) {
      chain.add(cursor);
      cursor = this.actors.get(cursor)?.parentTaskId ?? null;
    }
    return chain;
  }

  // ------------------------------------------------------------------
  // 输出分配（§4.2：同一目标同时只有一个有效分配）
  // ------------------------------------------------------------------

  assignOutputs(input: AssignOutputsInput): OutputAssignment {
    if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length > 200) {
      throw new BuildActorError('invalid_request', 'targets 必须是 1..200 项的数组');
    }
    for (const target of input.targets) {
      if (typeof target !== 'string' || !target || target.length > 600) {
        throw new BuildActorError('invalid_request', 'targets 每项必须是非空字符串（≤600 字符）');
      }
    }
    const owner = this.requireConfirmedActor(input.ownerTaskId, undefined);
    const targetKind = input.targetKind ?? 'doc';
    const normalized = [...new Set(input.targets)];
    // 冲突检查：目标已被其他活动任务持有 → 返回冲突与持有者（§4.2）。
    // F03：family 目标统一按 `family:<familyKey>` 归一化探测——targets 存储
    // 已剥前缀，此前用剥前缀 key 探测导致同族分配互相不报冲突（归一化
    // 仅收口在 activeAssignmentFor/activeFamilyAssignmentFor 两侧）。
    for (const target of normalized) {
      const probe = targetKind === 'family' ? `family:${target}` : target;
      const holder = this.activeAssignmentFor(probe);
      if (holder && holder.ownerTaskId !== input.ownerTaskId) {
        throw new BuildActorError(
          'kb_output_assignment_conflict',
          `目标 ${target} 已由任务 ${holder.ownerTaskId} 持有（assignmentId=${holder.assignmentId}）；请先收回该分配或等待其完成`,
          409,
        );
      }
    }
    // 覆盖旧分配（supersedes=true 显式转移；同 owner 重复分配同目标=幂等更新）
    const supersededIds: string[] = [];
    for (const assignment of this.assignments.values()) {
      if (assignment.ownerTaskId !== input.ownerTaskId || assignment.status !== 'active') continue;
      const overlap = assignment.targets.some((target) => normalized.includes(target));
      if (overlap && (input.supersedes || assignment.targetKind === targetKind)) {
        assignment.status = 'superseded';
        assignment.revokedAt = nowIso();
        supersededIds.push(assignment.assignmentId);
      }
    }
    const assignment: OutputAssignment = {
      assignmentId: `asg_${crypto.randomBytes(6).toString('hex')}`,
      generation: this.generation,
      targetKind,
      targets: normalized,
      ownerTaskId: owner.nativeTaskId,
      status: 'active',
      supersedes: supersededIds[0] ?? null,
      createdAt: nowIso(),
      revokedAt: null,
    };
    this.assignments.set(assignment.assignmentId, assignment);
    this.appendEvent({ source: 'tool-service', type: 'output_assigned', taskId: input.ownerTaskId, payload: { assignmentId: assignment.assignmentId, targets: normalized, targetKind, superseded: supersededIds } });
    this.persist();
    return assignment;
  }

  revokeOutputs(selector: { assignmentId?: string; ownerTaskId?: string }): number {
    let count = 0;
    for (const assignment of this.assignments.values()) {
      if (assignment.status !== 'active') continue;
      if (selector.assignmentId ? assignment.assignmentId === selector.assignmentId : assignment.ownerTaskId === selector.ownerTaskId) {
        assignment.status = 'revoked';
        assignment.revokedAt = nowIso();
        count += 1;
        this.appendEvent({ source: 'tool-service', type: 'output_revoked', taskId: assignment.ownerTaskId, payload: { assignmentId: assignment.assignmentId, targets: assignment.targets } });
      }
    }
    if (selector.assignmentId && count === 0) throw new BuildActorError('invalid_request', `分配不存在或已失效: ${selector.assignmentId}`, 404);
    this.persist();
    return count;
  }

  activeAssignmentFor(target: string): OutputAssignment | null {
    for (const assignment of this.assignments.values()) {
      if (assignment.status !== 'active') continue;
      if (assignment.targetKind === 'doc' && assignment.targets.includes(target)) return assignment;
      if (assignment.targetKind === 'family' && target.startsWith('family:') && assignment.targets.includes(target.slice('family:'.length))) return assignment;
    }
    return null;
  }

  /** F03：familyKey 的活动分配探测（`family:` 前缀归一化唯一收口）。 */
  activeFamilyAssignmentFor(familyKey: string): OutputAssignment | null {
    return this.activeAssignmentFor(`family:${familyKey}`);
  }

  /** F03（对象声明影响面授权）：actor 是否对文档路径或对象族
   * family:<familyKey> 持有当前有效分配。跨路径重申/迁移既有对象
   * （clientKey 或 family 三元组命中沿用 objectId）时，写者须对旧主定义
   * 文档或该对象族持有分配——两条显式授权通道任一命中即可（Leader 用
   * build_assign_output 显式授予，合法迁移能力保留）。 */
  authorizedForDeclarationTarget(nativeTaskId: string, target: { docPath?: string; familyKey?: string }): OutputAssignment | null {
    if (target.docPath) {
      const docAssignment = this.activeAssignmentFor(target.docPath);
      if (docAssignment?.ownerTaskId === nativeTaskId) return docAssignment;
    }
    if (target.familyKey) {
      const familyAssignment = this.activeFamilyAssignmentFor(target.familyKey);
      if (familyAssignment?.ownerTaskId === nativeTaskId) return familyAssignment;
    }
    return null;
  }

  listAssignments(): OutputAssignment[] {
    return [...this.assignments.values()];
  }

  /** 写入前分配校验（§4.2：未分配 → 可重试错误）。 */
  assertOutputAssignment(nativeTaskId: string, docPath: string): OutputAssignment {
    const assignment = this.activeAssignmentFor(docPath);
    if (!assignment) {
      throw new BuildActorError(
        'kb_output_not_assigned',
        `文档 ${docPath} 未分配给任何任务；Leader 需先 build_assign_output（若刚派发，稍候重试）`,
        409,
      );
    }
    if (assignment.ownerTaskId !== nativeTaskId) {
      throw new BuildActorError(
        'kb_output_owned_by_other_task',
        `文档 ${docPath} 由任务 ${assignment.ownerTaskId} 持有；本任务 ${nativeTaskId} 无写入资格`,
        409,
      );
    }
    return assignment;
  }

  // ------------------------------------------------------------------
  // 成果回执（§4.4 幂等：同键同载荷返回原回执，同键异载荷拒绝）
  // ------------------------------------------------------------------

  /** 幂等预检/重放：返回原回执或 null（首次）。payloadHash 不符拒绝。 */
  replayReceipt(idempotencyKey: string, payloadHash: string): ArtifactReceipt | null {
    const prior = this.receipts.get(idempotencyKey);
    if (!prior) return null;
    if (prior.payloadHash !== payloadHash) {
      throw new BuildActorError(
        'kb_idempotency_conflict',
        `operationId 已用于不同载荷（首次提交 ${prior.createdAt}，kind=${prior.kind}）；换一个 operationId`,
        409,
      );
    }
    return prior;
  }

  recordReceipt(input: {
    authorTaskId: string;
    kind: ArtifactReceipt['kind'];
    operationId: string;
    payloadHash: string;
    paths: string[];
    result: Record<string, unknown>;
  }): ArtifactReceipt {
    const idempotencyKey = deriveIdempotencyKey(this.buildId, this.generation, input.authorTaskId, input.operationId);
    const prior = this.replayReceipt(idempotencyKey, input.payloadHash);
    if (prior) return prior;
    const receipt: ArtifactReceipt = {
      artifactId: `art_${crypto.randomBytes(6).toString('hex')}`,
      buildId: this.buildId,
      generation: this.generation,
      authorTaskId: input.authorTaskId,
      kind: input.kind,
      operationId: input.operationId,
      idempotencyKey,
      payloadHash: input.payloadHash,
      result: { ...input.result, paths: input.paths },
      createdAt: nowIso(),
    };
    this.receipts.set(idempotencyKey, receipt);
    for (const docPath of input.paths) this.lastAuthorByPath.set(docPath, input.authorTaskId);
    this.appendEvent({ source: 'tool-service', type: `artifact_${input.kind}`, taskId: input.authorTaskId, payload: { artifactId: receipt.artifactId, operationId: input.operationId, paths: input.paths } });
    this.persist();
    return receipt;
  }

  listReceipts(): ArtifactReceipt[] {
    return [...this.receipts.values()];
  }

  // ------------------------------------------------------------------
  // 审查（§4.3：独立性与哈希绑定；作者修订使被改内容审查失效）
  // ------------------------------------------------------------------

  /** 审查独立性（§4.3）：审查者不得是任一受审草稿路径的作者，也不得
   * 与作者处于同一续接链（作者链含审查者，或审查者链含作者，双向拒）。 */
  assertReviewerIndependent(reviewerTaskId: string, paths: string[]): void {
    const reviewerAncestry = this.ancestryOf(reviewerTaskId);
    for (const docPath of paths) {
      const author = this.lastAuthorByPath.get(docPath);
      if (!author) continue;
      const authorAncestry = this.ancestryOf(author);
      if (reviewerAncestry.has(author) || authorAncestry.has(reviewerTaskId)) {
        throw new BuildActorError(
          'kb_review_not_independent',
          `审查者 ${reviewerTaskId} 是 ${docPath} 作者（或与其同处续接链，作者链: ${[...authorAncestry].join('→')}）`,
          403,
        );
      }
    }
  }

  recordReview(input: Omit<ReviewReceipt, 'reviewId' | 'buildId' | 'generation' | 'status' | 'staleReason' | 'createdAt'>): ReviewReceipt {
    const review: ReviewReceipt = {
      ...input,
      reviewId: `krev_${crypto.randomBytes(8).toString('hex')}`,
      buildId: this.buildId,
      generation: this.generation,
      status: 'valid',
      staleReason: null,
      createdAt: nowIso(),
    };
    this.reviews.set(review.reviewId, review);
    this.appendEvent({ source: 'tool-service', type: 'review_submitted', taskId: input.reviewerTaskId, payload: { reviewId: review.reviewId, draftHash: review.draftHash, verdict: review.verdict, issues: review.issues.length } });
    this.persist();
    return review;
  }

  /** 作者提交修订后：绑定受影响路径的审查失效（draftHash 亦不再匹配）。 */
  invalidateReviewsForPaths(paths: string[], reason: string): number {
    const affected = new Set(paths);
    let count = 0;
    for (const review of this.reviews.values()) {
      if (review.status !== 'valid') continue;
      const coveredPaths = Object.keys(review.dependencyHashes).filter((key) => key.startsWith('doc:') && affected.has(key.slice('doc:'.length)));
      if (coveredPaths.length > 0) {
        review.status = 'stale';
        review.staleReason = `${reason}（受影响: ${coveredPaths.join(', ')}）`;
        count += 1;
      }
    }
    if (count > 0) {
      this.appendEvent({ source: 'tool-service', type: 'reviews_invalidated', payload: { paths, reason, count } });
      this.persist();
    }
    return count;
  }

  listReviews(): ReviewReceipt[] {
    return [...this.reviews.values()];
  }

  /** 未解决 blocking 问题计数（发布门禁输入）。 */
  openBlockingIssues(): number {
    const latest = this.issueLists[this.issueLists.length - 1];
    return latest ? latest.issues.filter((issue) => issue.severity === 'blocking').length : 0;
  }

  // ------------------------------------------------------------------
  // 交接 / 问题清单 / 发布申请
  // ------------------------------------------------------------------

  recordHandoff(input: Omit<HandoffRecord, 'handoffId' | 'buildId' | 'generation' | 'createdAt'>): HandoffRecord {
    const record: HandoffRecord = { ...input, handoffId: `ho_${crypto.randomBytes(6).toString('hex')}`, buildId: this.buildId, generation: this.generation, createdAt: nowIso() };
    this.handoffs.push(record);
    this.appendEvent({ source: 'tool-service', type: 'handoff_submitted', taskId: input.taskId, payload: { handoffId: record.handoffId } });
    this.persist();
    return record;
  }

  listHandoffs(filter?: { taskId?: string }): HandoffRecord[] {
    return this.handoffs.filter((record) => !filter?.taskId || record.taskId === filter.taskId);
  }

  recordIssueList(input: Omit<IssueListRecord, 'issueListId' | 'buildId' | 'generation' | 'revision' | 'createdAt'>): IssueListRecord {
    const record: IssueListRecord = {
      ...input,
      issueListId: `kil_${crypto.randomBytes(6).toString('hex')}`,
      buildId: this.buildId,
      generation: this.generation,
      revision: this.issueLists.length + 1,
      createdAt: nowIso(),
    };
    this.issueLists.push(record);
    this.appendEvent({ source: 'tool-service', type: 'issues_submitted', payload: { issueListId: record.issueListId, revision: record.revision, issues: record.issues.length } });
    this.persist();
    return record;
  }

  listIssueLists(): IssueListRecord[] {
    return [...this.issueLists];
  }

  /** 发布窗口（§5.4：校验期间到达的新写入被拒）。 */
  get publishing(): { draftHash: string; requestId: string } | null {
    return this.publishWindow;
  }

  /** 开启发布窗口并登记 pending 申请（返回 requestId）。 */
  beginPublishWindow(draftHash: string, requestedRevision: string | null): PublishRequestRecord {
    if (this.publishWindow) {
      throw new BuildActorError('build_publishing', `发布校验进行中（requestId=${this.publishWindow.requestId}）`, 409);
    }
    const record: PublishRequestRecord = {
      requestId: `pub_${crypto.randomBytes(6).toString('hex')}`,
      buildId: this.buildId,
      generation: this.generation,
      requestedRevision,
      candidateHash: draftHash,
      status: 'pending',
      result: null,
      createdAt: nowIso(),
      settledAt: null,
    };
    this.publishRequests.push(record);
    this.publishWindow = { draftHash, requestId: record.requestId };
    this.appendEvent({ source: 'tool-service', type: 'publish_requested', payload: { requestId: record.requestId, candidateHash: draftHash } });
    this.persist();
    return record;
  }

  /** 结算发布申请（关闭窗口）。 */
  settlePublishRequest(requestId: string, status: PublishRequestRecord['status'], result: Record<string, unknown> | null): void {
    const record = this.publishRequests.find((item) => item.requestId === requestId);
    if (!record) throw new BuildActorError('invalid_request', `发布申请不存在: ${requestId}`, 404);
    record.status = status;
    record.result = result;
    record.settledAt = nowIso();
    if (this.publishWindow?.requestId === requestId) this.publishWindow = null;
    this.appendEvent({ source: 'tool-service', type: 'publish_settled', payload: { requestId, status } });
    this.persist();
  }

  // ------------------------------------------------------------------
  // 运行事件（§8：去重；source|nativeEventId 唯一）
  // ------------------------------------------------------------------

  appendEvent(input: {
    source: RuntimeEventRecord['source'];
    nativeEventId?: string | null;
    generation?: number;
    taskId?: string | null;
    type: string;
    occurredAt?: string | null;
    payload: Record<string, unknown>;
  }): RuntimeEventRecord {
    const dedupeKey = input.nativeEventId ? `${input.source}|${input.nativeEventId}` : null;
    if (dedupeKey && this.seenEventIds.has(dedupeKey)) {
      const prior = this.events.find((event) => event.nativeEventId === input.nativeEventId && event.source === input.source);
      if (prior) return prior;
    }
    const event: RuntimeEventRecord = {
      eventId: `evt_${crypto.randomBytes(9).toString('hex')}`,
      source: input.source,
      nativeEventId: input.nativeEventId ?? null,
      generation: input.generation ?? this.generation,
      taskId: input.taskId ?? null,
      type: input.type,
      occurredAt: input.occurredAt ?? null,
      receivedAt: nowIso(),
      payload: input.payload,
    };
    this.events.push(event);
    if (dedupeKey) this.seenEventIds.add(dedupeKey);
    return event;
  }

  /** 事件游标读取（observe 适配层用；游标=eventId，exclusive）。 */
  eventsSince(cursor?: string | null): RuntimeEventRecord[] {
    if (!cursor) return [...this.events];
    const index = this.events.findIndex((event) => event.eventId === cursor);
    return index < 0 ? [...this.events] : this.events.slice(index + 1);
  }

  // ------------------------------------------------------------------
  // 检查点（集成者接入 BuildCheckpoint 的 additive 字段）
  // ------------------------------------------------------------------

  exportCheckpointPayload(): BuildActorCheckpointPayload {
    return {
      schemaVersion: 1,
      buildId: this.buildId,
      generation: this.generation,
      actors: [...this.actors.values()],
      assignments: [...this.assignments.values()],
      receipts: [...this.receipts.values()],
      reviews: [...this.reviews.values()],
      handoffs: [...this.handoffs],
      issueLists: [...this.issueLists],
      publishRequests: [...this.publishRequests],
      eventCursor: this.events[this.events.length - 1]?.eventId ?? null,
    };
  }

  restoreCheckpointPayload(payload: BuildActorCheckpointPayload): void {
    if (payload.schemaVersion !== 1 || payload.buildId !== this.buildId) {
      throw new BuildActorError('invalid_request', '成果账本检查点载荷无效（buildId/schema 不匹配）');
    }
    this.actors = new Map(payload.actors.map((actor) => [actor.nativeTaskId, actor]));
    this.assignments = new Map(payload.assignments.map((item) => [item.assignmentId, item]));
    this.receipts = new Map(payload.receipts.map((item) => [item.idempotencyKey, item]));
    this.reviews = new Map(payload.reviews.map((item) => [item.reviewId, item]));
    this.handoffs = [...payload.handoffs];
    this.issueLists = [...payload.issueLists];
    this.publishRequests = [...payload.publishRequests];
    this.lastAuthorByPath.clear();
    for (const receipt of this.receipts.values()) {
      for (const docPath of Array.isArray(receipt.result?.paths) ? receipt.result.paths : []) {
        if (typeof docPath === 'string') this.lastAuthorByPath.set(docPath, receipt.authorTaskId);
      }
    }
    this.generation = Math.max(this.generation, payload.generation);
    this.persist();
  }
}

/** 幂等键（§4.4）：buildId + generation + nativeTaskId + operationId。 */
export function deriveIdempotencyKey(buildId: string, generation: number, nativeTaskId: string, operationId: string): string {
  return crypto.createHash('sha256').update(`${buildId}\n${generation}\n${nativeTaskId}\n${operationId}`).digest('hex');
}
