/**
 * KnowledgeGovernanceService —— 人工业务决定与高风险人审凭据（A 案 §4.2/§5.1/§7.4）
 *
 * 职责（三权分置中「业务裁定」的人工通道）：
 * - 人工业务决定：追加式 JSONL `<outputRoot>/.governance/decisions.jsonl`，
 *   server 生成 decisionId/时间；rationale 必填（裁定必须有实质理由）；
 *   修改决定 = 新记录 supersede 旧记录（不物理删除，保留可追溯）；
 *   expectedRevision 防并发覆盖（diting S-F02：revision = 追加记录总数，
 *   每次 append 严格递增的日志序号；GET/POST/snapshotForBuild 同一真相）。
 * - 人工内容复核：`<outputRoot>/.governance/human-reviews.jsonl` 追加，
 *   绑定 reviewSubjectHash（载荷/证据/关系变化 → 旧复核不可继承，A 案 §4.1）。
 *   同（objectId, reviewSubjectHash）的有效结论 = 日志序最新一条（diting
 *   S-F03：历史任意一次通过不能覆盖最新拒绝）。
 * - snapshotForBuild()：构建冻结用决定集 + 整体哈希（D5 接线 kb-build-service
 *   构建期冻结、发布前复核；validator 消费该快照做决定门禁）。
 *
 * 写入口纪律（A 案 §4.2）：仅 desktop 人工入口接受——Build/Task/CLI/
 * app_command 均不获得此写权限。本服务不自行鉴权；路由层（routes/kb.ts）
 * 拒绝 CLI 主体（cliActor / X-Feishu-Sync-Actor / X-Cli-Token）后才能调用。
 *
 * 身份披露（A 案 §4.2 原文）：单机版可由同一用户兼任，但必须分别记录行为
 * 与依据；不宣称 desktop token 能证明真实人员身份或抵御同 uid 恶意程序。
 * recordHumanReview 不校验真实人员身份——reviewerId 只是自愿署名。
 *
 * 决定语义（A 案 §4.3）：
 * - unknown/candidate/disputed → approved 需人工决定（绑定当前载荷与范围）；
 * - approved → deprecated 需决定；deprecated → approved（恢复使用）需新决定；
 * - 决定绑定的 payloadHash 与当前对象不匹配 → 标记 payloadMismatch 登记
 *   （不阻断登记；消费端拒绝当轮生效，validator 报 kb_decision_stale）。
 * - 决定对标准库消费者的生效点是下一次成功发布（D5 冻结接线）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolError } from '../agent/agent-tool-service.js';
import { canonicalJsonSha256, type BusinessStatus, type KnowledgeManifest, type KnowledgeObject } from './knowledge-schema.js';
import { KbVersionStore } from './kb-version-store.js';
import { StandardKbStore } from './standard-kb-store.js';

// ============================================================================
// 记录类型（A 案 §4.2 决定记录契约）
// ============================================================================

/** 人工业务决定记录（追加式；supersede 不物理删除）。 */
export interface GovernanceDecisionRecord {
  /** `kbd_` 前缀，server 生成 */
  decisionId: string;
  /** ISO UTC，server 生成 */
  createdAt: string;
  /** 操作人署名（desktop 人工入口提交；不校验真实身份，见文件头披露） */
  actor: string;
  objectId: string;
  /** 决定绑定的对象载荷哈希（A 案 §4.3：批准不自动继承到新载荷） */
  payloadHash: string;
  scopeKey: string;
  businessStatus: BusinessStatus;
  /** 实质理由（空理由拒绝登记） */
  rationale: string;
  /** 决定依据的证据集合（可选） */
  evidenceIds?: string[];
  /** 修改决定时指向被取代记录 */
  supersedesDecisionId?: string;
  /** 登记时与当前对象 payloadHash 不匹配 → true（不阻断登记；消费端拒绝当轮生效） */
  payloadMismatch?: boolean;
}

/** 人工内容复核记录（A 案 §4.2/§5.1：高风险断言至少一次人工复核）。 */
export interface HumanReviewRecord {
  /** `kbr_` 前缀，server 生成 */
  reviewId: string;
  createdAt: string;
  actor: string;
  objectId: string;
  /** 复核绑定对象审查主体哈希（变化即失效，A 案 §4.1） */
  reviewSubjectHash: string;
  /** 自愿署名；不校验真实人员身份（单机版披露） */
  reviewerId?: string;
  passed: boolean;
  note?: string;
}

/** 有效决定视图（diting S-F02：revision = 决定日志追加记录总数，每次
 * append 严格递增；GET/POST/快照共用同一真相，旧 revision 即可检出并发修改）。 */
export interface DecisionListView {
  /** 文件内全部记录（按登记顺序；含被取代记录，可追溯） */
  records: GovernanceDecisionRecord[];
  /** 每对象当前有效决定（被取代记录不出现） */
  effective: GovernanceDecisionRecord[];
  /** 决定日志追加序号（全部记录数；修改既有对象的决定同样推进——
 * supersede 后 revision 不变旧断言已按日志序修正） */
  revision: number;
}

/** 构建冻结快照（A 案 §4.2：构建冻结决定集合及其哈希，发布前复核）。 */
export interface GovernanceSnapshotForBuild {
  takenAt: string;
  /** diting S-F02：决定日志追加序号（全部决定记录数；与 listDecisions 同源） */
  revision: number;
  /** 决定集整体哈希（覆盖全部记录与人工复核——任何追加都会改变，供 D5 发布前复核） */
  snapshotHash: string;
  /** 全部决定记录（含被取代；哈希冻结与 decisionRef 解引用用） */
  decisionRecords: GovernanceDecisionRecord[];
  /** 每对象当前有效决定（validator 决定门禁消费） */
  effectiveDecisions: GovernanceDecisionRecord[];
  humanReviews: HumanReviewRecord[];
}

/** 待治理对象（前端人工面板数据源；当前 release 对象 × 治理状态联查）。 */
export interface KbGovernancePendingObject {
  objectId: string;
  title: string;
  type: KnowledgeObject['type'];
  scopeKey: string;
  businessStatus: BusinessStatus;
  reviewStatus: KnowledgeObject['reviewStatus'];
  payloadHash: string;
  reviewSubjectHash: string;
  /** 高风险 claim 键（空数组 = 无高风险断言） */
  highRiskClaims: string[];
  /** 存在绑定当前 reviewSubjectHash 的 passed 人工复核 */
  humanReviewed: boolean;
  effectiveDecision: {
    decisionId: string;
    businessStatus: BusinessStatus;
    createdAt: string;
    /** 决定绑定载荷与当前对象不一致（需在新载荷上重新决定） */
    payloadMismatch: boolean;
  } | null;
  /** 当前状态下合法的决定目标（diting S-F05：按服务有效决定链状态计算，
 * 与 recordDecision 判定同源；无有效决定回退 release 对象状态） */
  allowedDecisionTargets: BusinessStatus[];
}

export interface GovernancePendingView {
  releaseId: string | null;
  /** 高风险 claim 且无绑定当前载荷的人工复核 */
  highRisk: KbGovernancePendingObject[];
  /** candidate 对象（待业务决定） */
  candidates: KbGovernancePendingObject[];
  /** 有效决定已过期（payloadMismatch）的对象 */
  staleDecisions: KbGovernancePendingObject[];
  /** diting S-F04（A 案 §4.2/§4.3 治理对象生命周期入口）：当前 release
   * 全部活跃对象（含 unknown/approved/deprecated——待裁定提示之外的
   * 「可操作对象」分区数据源；列表来自 release knowledge.json，不改变
   * 「模型不能自报状态」纪律——businessStatus 仍由决定通道产生）。 */
  governable: KbGovernancePendingObject[];
}

/**
 * diting S-F03（A 案 §4.2「任一 rejected 则 rejected」）：同
 *（objectId, reviewSubjectHash）的有效人工复核 = 日志序最新一条记录；
 * 无匹配记录返回 null。历史任意一次通过不得覆盖最新拒绝；subjectHash
 * 变化（正文/证据/关系变化）后旧凭据（通过或拒绝）整体失效。
 * validator 门禁与 pendingGovernanceWork 联查共用本聚合。
 */
export function effectiveHumanReviewOf(
  records: readonly HumanReviewRecord[],
  objectId: string,
  reviewSubjectHash: string,
): HumanReviewRecord | null {
  let latest: HumanReviewRecord | null = null;
  for (const record of records) {
    if (record.objectId !== objectId || record.reviewSubjectHash !== reviewSubjectHash) continue;
    latest = record; // 数组顺序 = JSONL 追加顺序（日志序），后登记者胜出
  }
  return latest;
}

// ============================================================================
// 状态转移表（A 案 §4.3）
// ============================================================================

/**
 * 人工决定可达的目标状态（按对象当前 businessStatus）：
 * - unknown/candidate/disputed → approved（有效人工决定绑定当前载荷与范围）；
 * - approved → deprecated（停用决定）；approved → approved 仅限 supersede
 *   修订既有决定（重申不产生新决定）；
 * - deprecated → approved（恢复使用需新决定）。
 * disputed 由冲突检测派生（A 案 §4.3「当前对象标 disputed 并关联决策问题」），
 * 不经人工决定通道写入；candidate 由候选表述+内容审查产生，同为非决定通道。
 */
export const DECISION_TARGETS_BY_STATUS: Readonly<Record<BusinessStatus, readonly BusinessStatus[]>> = {
  unknown: ['approved'],
  candidate: ['approved'],
  disputed: ['approved'],
  approved: ['deprecated', 'approved'],
  deprecated: ['approved'],
};

export function allowedDecisionTargets(current: BusinessStatus): BusinessStatus[] {
  return [...DECISION_TARGETS_BY_STATUS[current]];
}

// ============================================================================
// 服务
// ============================================================================

export interface KnowledgeGovernanceDeps {
  outputRoot: string;
  /** 当前 release 知识清单读取（缺省读 CURRENT → knowledge.json；测试可注入） */
  readCurrentKnowledge?: () => KnowledgeManifest | null;
}

export class KnowledgeGovernanceService {
  readonly outputRoot: string;
  private readonly readCurrentKnowledgeImpl: () => KnowledgeManifest | null;

  constructor(deps: KnowledgeGovernanceDeps) {
    this.outputRoot = deps.outputRoot;
    this.readCurrentKnowledgeImpl = deps.readCurrentKnowledge ?? (() => {
      const pointer = new StandardKbStore(this.outputRoot).readCurrent();
      if (!pointer) return null;
      return new KbVersionStore(this.outputRoot).readKnowledgeManifest(pointer.releaseId);
    });
  }

  private governanceDir(): string {
    return path.join(this.outputRoot, '.governance');
  }

  /** 0700 目录 / 0600 文件（对齐 cli-endpoint 的敏感文件模式）。 */
  private ensureDir(): void {
    fs.mkdirSync(this.governanceDir(), { recursive: true });
    fs.chmodSync(this.governanceDir(), 0o700);
  }

  private appendRecord(file: string, record: unknown): void {
    this.ensureDir();
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 读取 JSONL；损坏行显式失败（fail closed：治理日志损坏不得静默跳过）。 */
  private readJsonl<T>(file: string): T[] {
    if (!fs.existsSync(file)) return [];
    const out: T[] = [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch (error) {
        throw new ToolError('kb_governance_log_corrupt',
          `治理记录损坏（${path.basename(file)} 第 ${index + 1} 行）：${error instanceof Error ? error.message : String(error)}`,
          500);
      }
    }
    return out;
  }

  private decisionsFile(): string {
    return path.join(this.governanceDir(), 'decisions.jsonl');
  }

  private humanReviewsFile(): string {
    return path.join(this.governanceDir(), 'human-reviews.jsonl');
  }

  // ---- 决定读取 -----------------------------------------------------------

  allDecisionRecords(): GovernanceDecisionRecord[] {
    return this.readJsonl<GovernanceDecisionRecord>(this.decisionsFile());
  }

  /** 每对象当前有效决定（被取代记录不出现；后登记者胜出）。 */
  effectiveDecisions(): Map<string, GovernanceDecisionRecord> {
    const records = this.allDecisionRecords();
    const superseded = new Set<string>();
    for (const record of records) {
      if (record.supersedesDecisionId) superseded.add(record.supersedesDecisionId);
    }
    const effective = new Map<string, GovernanceDecisionRecord>();
    for (const record of records) {
      if (superseded.has(record.decisionId)) continue;
      effective.set(record.objectId, record); // 后登记者取代同对象更早的独立记录
    }
    return effective;
  }

  listDecisions(objectId?: string): DecisionListView {
    const all = this.allDecisionRecords();
    const records = all.filter((record) => !objectId || record.objectId === objectId);
    const effectiveAll = this.effectiveDecisions();
    const effective = [...effectiveAll.values()]
      .filter((record) => !objectId || record.objectId === objectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.objectId < b.objectId ? -1 : 1));
    // diting S-F02：revision 是全局日志序（全部记录数），不随 objectId 过滤
    // 缩水——OCC 比对值必须在任何视图下一致。
    return { records, effective, revision: all.length };
  }

  humanReviews(objectId?: string): HumanReviewRecord[] {
    return this.readJsonl<HumanReviewRecord>(this.humanReviewsFile())
      .filter((record) => !objectId || record.objectId === objectId);
  }

  // ---- 决定登记（A 案 §4.2 契约） ----------------------------------------

  recordDecision(input: {
    actor?: string;
    objectId: string;
    payloadHash: string;
    scopeKey: string;
    businessStatus: BusinessStatus;
    rationale: string;
    evidenceIds?: string[];
    supersedesDecisionId?: string;
    /** 并发防护：调用方读到的当前有效决定集 revision */
    expectedRevision: number;
  }): { decision: GovernanceDecisionRecord; revision: number } {
    const rationale = (input.rationale ?? '').trim();
    if (!input.objectId || !input.payloadHash || !input.scopeKey) {
      throw new ToolError('invalid_request', '决定必须绑定 objectId、payloadHash 与 scopeKey', 400);
    }
    if (!rationale) {
      throw new ToolError('kb_decision_invalid', '裁定必须有实质理由（rationale 不能为空，A 案 §4.2）', 400);
    }
    // diting S-F02：OCC 比对值 = 决定日志追加序号（全部记录数）——修改
    // 既有对象的决定同样 append 并推进 revision，两个同 expectedRevision
    // 的更新只接受一个（409）；GET 返回同一真相，旧 revision 必能检出变化。
    const revision = this.allDecisionRecords().length;
    if (input.expectedRevision !== revision) {
      throw new ToolError('kb_decision_revision_conflict',
        `决定集已变化（期望 revision ${input.expectedRevision} ≠ 当前 ${revision}），请刷新后重试`, 409);
    }
    const effective = this.effectiveDecisions();
    if (input.supersedesDecisionId) {
      const current = effective.get(input.objectId);
      if (!current || current.decisionId !== input.supersedesDecisionId) {
        throw new ToolError('kb_decision_invalid',
          `supersedesDecisionId 必须指向该对象当前有效决定（${current ? current.decisionId : '无有效决定'}）`, 400);
      }
    }
    // 决定语义校验：对象必须可解析；转移的「当前状态」取治理真相——
    // 有效决定链的业务状态优先，无决定时回退当前 release 对象状态
    //（决定生效点是下一次发布，release 状态滞后是常态，A 案 §4.2/§4.3）。
    const object = this.findCurrentObject(input.objectId);
    if (!object) {
      throw new ToolError('kb_decision_invalid',
        `对象不在当前发布中，无法登记决定：${input.objectId}（决定绑定当前发布的对象状态）`, 400);
    }
    const chain = effective.get(input.objectId) ?? null;
    const currentStatus = chain?.businessStatus ?? object.businessStatus;
    const targets = DECISION_TARGETS_BY_STATUS[currentStatus];
    if (!targets.includes(input.businessStatus)) {
      throw new ToolError('kb_decision_invalid',
        `非法状态转移：${currentStatus} → ${input.businessStatus}（合法目标：${targets.join('/')}；A 案 §4.3）`, 400);
    }
    if (currentStatus === 'approved' && input.businessStatus === 'approved' && !input.supersedesDecisionId) {
      throw new ToolError('kb_decision_invalid',
        '对象已 approved：重申不产生新决定，修订既有决定须携带 supersedesDecisionId', 400);
    }
    if (input.scopeKey !== object.scopeKey) {
      throw new ToolError('kb_decision_invalid',
        `决定绑定 scopeKey 与当前对象不一致（决定 ${input.scopeKey} ≠ 对象 ${object.scopeKey}），请刷新对象状态后重试`, 400);
    }
    const decision: GovernanceDecisionRecord = {
      decisionId: `kbd_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      actor: (input.actor ?? '').trim() || 'desktop-human',
      objectId: input.objectId,
      payloadHash: input.payloadHash,
      scopeKey: input.scopeKey,
      businessStatus: input.businessStatus,
      rationale,
      ...(input.evidenceIds && input.evidenceIds.length > 0 ? { evidenceIds: input.evidenceIds } : {}),
      ...(input.supersedesDecisionId ? { supersedesDecisionId: input.supersedesDecisionId } : {}),
      ...(input.payloadHash !== object.payloadHash ? { payloadMismatch: true } : {}),
    };
    this.appendRecord(this.decisionsFile(), decision);
    return { decision, revision: revision + 1 };
  }
  // ---- 人工复核登记（A 案 §5.1） ------------------------------------------

  recordHumanReview(input: {
    actor?: string;
    objectId: string;
    reviewSubjectHash: string;
    reviewerId?: string;
    passed: boolean;
    note?: string;
  }): HumanReviewRecord {
    if (!input.objectId || !input.reviewSubjectHash) {
      throw new ToolError('invalid_request', '人工复核必须绑定 objectId 与 reviewSubjectHash', 400);
    }
    if (typeof input.passed !== 'boolean') {
      throw new ToolError('invalid_request', 'passed 必须为 boolean', 400);
    }
    const record: HumanReviewRecord = {
      reviewId: `kbr_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      actor: (input.actor ?? '').trim() || 'desktop-human',
      objectId: input.objectId,
      reviewSubjectHash: input.reviewSubjectHash,
      ...(input.reviewerId && input.reviewerId.trim() ? { reviewerId: input.reviewerId.trim() } : {}),
      passed: input.passed,
      ...(input.note && input.note.trim() ? { note: input.note.trim() } : {}),
    };
    this.appendRecord(this.humanReviewsFile(), record);
    return record;
  }

  // ---- 构建冻结快照（A 案 §4.2；D5 接线 kb-build-service） ----------------

  snapshotForBuild(): GovernanceSnapshotForBuild {
    const decisionRecords = this.allDecisionRecords();
    const humanReviews = this.humanReviews();
    const effective = [...this.effectiveDecisions().values()]
      .sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0));
    return {
      takenAt: new Date().toISOString(),
      revision: decisionRecords.length, // diting S-F02：与 listDecisions 同一日志序真相
      snapshotHash: canonicalJsonSha256({ decisionRecords, humanReviews, revision: decisionRecords.length }),
      decisionRecords,
      effectiveDecisions: effective,
      humanReviews,
    };
  }

  // ---- 待治理对象联查（前端面板数据源） -----------------------------------

  pendingGovernanceWork(): GovernancePendingView {
    const manifest = this.readCurrentKnowledgeImpl();
    const effective = this.effectiveDecisions();
    const reviews = this.humanReviews();
    const view: GovernancePendingView = { releaseId: manifest?.releaseId ?? null, highRisk: [], candidates: [], staleDecisions: [], governable: [] };
    if (!manifest) return view;
    for (const object of manifest.objects) {
      if (object.tombstone) continue;
      const decision = effective.get(object.objectId) ?? null;
      // diting S-F03：有效人审结论 = 日志序最新一条（最新拒绝撤销历史通过；
      // 无匹配运行期记录时回退 release 对象自持的 human 凭据——S-F06 发布
      // 投影），pendingGovernanceWork 与 validator 门禁共用同一聚合。
      const latestReview = effectiveHumanReviewOf(reviews, object.objectId, object.reviewSubjectHash);
      const humanReviewed = latestReview ? latestReview.passed : object.reviewActorKind === 'human';
      const entry: KbGovernancePendingObject = {
        objectId: object.objectId,
        title: object.title,
        type: object.type,
        scopeKey: object.scopeKey,
        businessStatus: object.businessStatus,
        reviewStatus: object.reviewStatus,
        payloadHash: object.payloadHash,
        reviewSubjectHash: object.reviewSubjectHash,
        highRiskClaims: (object.claims ?? []).filter((claim) => claim.riskCategory === 'high').map((claim) => claim.claimKey),
        humanReviewed,
        effectiveDecision: decision ? {
          decisionId: decision.decisionId,
          businessStatus: decision.businessStatus,
          createdAt: decision.createdAt,
          payloadMismatch: decision.payloadHash !== object.payloadHash,
        } : null,
        // diting S-F05：按服务有效决定链状态计算（与 recordDecision 的
        // currentStatus 同源）——消灭「targets=approved 但服务要求
        // supersede」的两端不一致；无有效决定回退 release 对象状态。
        allowedDecisionTargets: allowedDecisionTargets(decision?.businessStatus ?? object.businessStatus),
      };
      if (entry.highRiskClaims.length > 0 && !humanReviewed) view.highRisk.push(entry);
      if (object.businessStatus === 'candidate') view.candidates.push(entry);
      if (decision && decision.payloadHash !== object.payloadHash) view.staleDecisions.push(entry);
      view.governable.push(entry); // diting S-F04：全部活跃对象可操作（含 unknown/approved/deprecated）
    }
    return view;
  }

  private findCurrentObject(objectId: string): KnowledgeObject | null {
    const manifest = this.readCurrentKnowledgeImpl();
    if (!manifest) return null;
    return manifest.objects.find((object) => object.objectId === objectId && !object.tombstone) ?? null;
  }
}
