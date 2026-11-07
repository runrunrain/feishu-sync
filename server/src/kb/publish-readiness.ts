/**
 * publish-readiness — 发布门「早发现」预览（kb-build-speedup R3.1/R3.3）
 *
 * 发布校验（kb-build-service.validateStagingDocs 的 source_not_covered）与
 * 构建中途预览（build_manifest 工作集首页 / build_checkpoint(status) /
 * build_request_publish 拒绝随附）共用同一份覆盖判定纯函数
 * （uncoveredWorksetTokens），不复制逻辑、不放宽门禁——预览只把发布时
 * 才暴露的「工作集未覆盖源」提前、只读、结构化地交给 Leader。
 *
 * 草稿未写完时「未覆盖」是正常中间态：classifyUncoveredSources 区分
 * - 真遗漏：已有覆盖项处置却无 sources 引用（processed_not_referenced，
 *   须补来源声明或 skipped，不会自愈），或构建已无任何在途写作分配
 *   （unassigned）；
 * - 在途（不提示，只计数）：仍存在活跃写作分配（已确认写者、未交接）
 *   且该源尚无覆盖项处置。
 *
 * 本模块只依赖 kb 层（类型经结构化接口，不 import agent 层——与
 * build-actors 同款约束）；对 state 只读，不推进任何基线。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BuildActorStore } from './build-actors.js';
import type { RawSourceSnapshot } from './raw-source-snapshot.js';
import { isPermissionDeniedSourcePlaceholder, isUnresolvedSyncedReferencePlaceholder } from './source-availability.js';
import { isBlankWorkbookPlaceholder } from './blank-csv-coverage.js';
import { parseStdHeader } from './standard-kb-store.js';
import { MAX_STANDARD_DOC_BYTES } from './standard-doc-limits.js';

/** 覆盖判定所需的最小 state 面（BuildRunState 的结构化子集；只读）。 */
export interface CoverageBuildStateLike {
  knowledgeBaseRoot: string;
  snapshot: RawSourceSnapshot;
  mode: 'full' | 'incremental';
  workset: Map<string, unknown>;
  stagingRoot: string;
  finishInfo: { skipped: Array<{ objToken: string; reason: string }> } | null;
  unitDone?: Map<string, { skipped: Array<{ objToken: string; reason: string }> }>;
}

/** 覆盖判定的输入集合：发布门与预览都以同一形态喂给同一纯函数。 */
export interface WorksetCoverageSets {
  /** 工作集 token（迭代顺序即发布门 issue 顺序） */
  worksetTokens: Iterable<string>;
  /** 被 staging 草稿头 sources 引用（在快照内且非占位）的 token */
  referenced: ReadonlySet<string>;
  /** 已登记跳过（unitDone ∪ finishInfo ∪ 权限占位自动跳过） */
  skipped: ReadonlySet<string>;
  /** 空白工作簿占位 */
  blankWorkbooks: ReadonlySet<string>;
  /** 未展开同步引用占位 */
  unresolvedReferences: ReadonlySet<string>;
}

/**
 * 工作集未覆盖源判定（发布门 source_not_covered 的唯一真相）：
 * 既未被引用、也不在 skipped/空白/未展开引用中的工作集 token。
 * validateStagingDocs 与预览共用本函数，保证「预览=发布时拒绝」。
 */
export function uncoveredWorksetTokens(sets: WorksetCoverageSets): string[] {
  const uncovered: string[] = [];
  for (const token of sets.worksetTokens) {
    if (sets.referenced.has(token) || sets.skipped.has(token)
      || sets.blankWorkbooks.has(token) || sets.unresolvedReferences.has(token)) continue;
    uncovered.push(token);
  }
  return uncovered;
}

/**
 * 只读收集覆盖判定事实（构建中途可随时调用）：
 * - 占位扫描口径与 validateStagingDocs 相同（权限 40403 / 空白工作簿 /
 *   未展开引用；权限占位按发布时自动登记跳过等价排除，不落盘）；
 * - staging docs 头扫描口径与发布门一致（跳过符号链接/非 md/路径非法/
 *   超限/无头文件的来源贡献）；
 * - 源核验失败（构建期间被改等）按普通源降级，不让预览抛错——
 *   发布门另有 source_changed_during_build 独立拦截。
 */
export function gatherWorksetCoverageFacts(
  state: CoverageBuildStateLike,
  validatePath?: (docPath: string) => void,
): WorksetCoverageSets {
  const permissionDenied = new Set<string>();
  const blankWorkbooks = new Set<string>();
  const unresolvedReferences = new Set<string>();
  for (const [token] of state.workset) {
    if (!state.snapshot.has(token)) continue;
    try {
      const source = state.snapshot.readVerified(state.knowledgeBaseRoot, token);
      const denied = isPermissionDeniedSourcePlaceholder(source.content);
      const blank = !denied && source.entry.objType === 'sheet' && isBlankWorkbookPlaceholder(source);
      const referenceOnly = !denied && source.entry.objType === 'docx'
        && isUnresolvedSyncedReferencePlaceholder(source.content);
      if (denied) permissionDenied.add(token);
      if (blank) blankWorkbooks.add(token);
      if (referenceOnly) unresolvedReferences.add(token);
    } catch { /* 只读预览：源无法核验时不作占位处理，发布门另行拦截 */ }
  }
  const referenced = new Set<string>();
  const docsDir = path.join(state.stagingRoot, 'docs');
  const walk = (dir: string, prefix: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name);
      const lstat = fs.lstatSync(child);
      if (lstat.isSymbolicLink()) continue;
      if (lstat.isDirectory()) {
        walk(child, `${prefix}${name}/`);
        continue;
      }
      const file = `${prefix}${name}`;
      if (!file.endsWith('.md')) continue;
      if (validatePath) {
        try { validatePath(file); } catch { continue; }
      }
      try {
        if (fs.statSync(child).size > MAX_STANDARD_DOC_BYTES) continue;
        const header = parseStdHeader(fs.readFileSync(child, 'utf-8'));
        if (!header) continue;
        for (const token of header.sources) {
          if (state.snapshot.has(token) && !permissionDenied.has(token)
            && !blankWorkbooks.has(token) && !unresolvedReferences.has(token)) {
            referenced.add(token);
          }
        }
      } catch { /* 单文件读取失败不拖垮整体预览 */ }
    }
  };
  walk(docsDir, '');
  const skipped = new Set<string>();
  for (const report of state.unitDone?.values() ?? []) {
    for (const item of report.skipped) skipped.add(item.objToken);
  }
  for (const item of state.finishInfo?.skipped ?? []) skipped.add(item.objToken);
  for (const token of permissionDenied) skipped.add(token);
  return { worksetTokens: [...state.workset.keys()], referenced, skipped, blankWorkbooks, unresolvedReferences };
}

/** 真遗漏条目：objToken + 标题 + 缺口成因。 */
export interface UncoveredWorksetSource {
  objToken: string;
  title: string;
  /** processed_not_referenced：覆盖项已处置但无 sources 引用（补来源或 skipped）；
   * unassigned：无任何在途写作分配负责该源。 */
  reason: 'processed_not_referenced' | 'unassigned';
}

/**
 * 未覆盖源分类：真遗漏 vs 在途写作。
 * 在途判定：存在「活跃分配 + 已确认写者 + 未提交交接」的写作任务——
 * 交接回执（build_handoff_submit）是子任务的收尾动作，已交接的持有者
 * 视为已完成，其残留分配不再抑制预览（实测 b_20261105233621：已接受
 * 任务的分配长期保持 active，Leader 需显式收回）。
 */
export function classifyUncoveredSources(input: {
  uncovered: readonly string[];
  snapshot: RawSourceSnapshot;
  actorStore: BuildActorStore | null;
  coverageSourceIds: ReadonlySet<string>;
}): { trueGaps: UncoveredWorksetSource[]; inFlightCount: number } {
  let liveWriterPresent = false;
  if (input.actorStore) {
    const handoffAuthors = new Set(input.actorStore.listReceipts()
      .filter((receipt) => receipt.kind === 'handoff').map((receipt) => receipt.authorTaskId));
    for (const assignment of input.actorStore.listAssignments()) {
      if (assignment.status !== 'active' || handoffAuthors.has(assignment.ownerTaskId)) continue;
      const actor = input.actorStore.lookupActor(assignment.ownerTaskId);
      if (actor && actor.status === 'confirmed'
        && input.actorStore.roleToolset(actor.role)?.canWriteDocs) {
        liveWriterPresent = true;
        break;
      }
    }
  }
  const trueGaps: UncoveredWorksetSource[] = [];
  let inFlightCount = 0;
  for (const token of input.uncovered) {
    const title = input.snapshot.get(token)?.title ?? token;
    if (input.coverageSourceIds.has(token)) {
      trueGaps.push({ objToken: token, title, reason: 'processed_not_referenced' });
      continue;
    }
    if (liveWriterPresent) {
      inFlightCount += 1;
      continue;
    }
    trueGaps.push({ objToken: token, title, reason: 'unassigned' });
  }
  return { trueGaps, inFlightCount };
}

/** knowledge-draft.json 的覆盖项 → 已处置源集合（processed 判定输入）。 */
export function coverageSourceIdsOf(
  draft: { coverage?: ReadonlyArray<{ sourceRef?: { sourceId?: unknown } }> } | null,
): Set<string> {
  return new Set((draft?.coverage ?? []).flatMap((item) =>
    typeof item.sourceRef?.sourceId === 'string' ? [item.sourceRef.sourceId] : []));
}

/** 发布就绪预览（manifest/checkpoint/拒绝随附同形）。计数项缺省不出现。 */
export interface PublishReadinessPreview {
  uncoveredWorksetSources: UncoveredWorksetSource[];
  inFlightWorksetSourceCount: number;
  openBlockingIssues?: number;
  identityGapCount?: number;
  pendingIndependentReviewPaths?: number;
  stageBlockedPaths?: number;
  note: string;
}

/** 组合入口：事实收集 → 共用判定 → 真遗漏/在途分类 → 计数。只读。 */
export function computePublishReadiness(input: {
  state: CoverageBuildStateLike;
  actorStore: BuildActorStore | null;
  coverageSourceIds: ReadonlySet<string>;
  validatePath?: (docPath: string) => void;
  counts?: { openBlockingIssues?: number; identityGapCount?: number; pendingIndependentReviewPaths?: number; stageBlockedPaths?: number };
}): PublishReadinessPreview {
  const facts = gatherWorksetCoverageFacts(input.state, input.validatePath);
  const uncovered = uncoveredWorksetTokens(facts);
  const { trueGaps, inFlightCount } = classifyUncoveredSources({
    uncovered,
    snapshot: input.state.snapshot,
    actorStore: input.actorStore,
    coverageSourceIds: input.coverageSourceIds,
  });
  return {
    uncoveredWorksetSources: trueGaps,
    inFlightWorksetSourceCount: inFlightCount,
    ...(input.counts?.openBlockingIssues !== undefined ? { openBlockingIssues: input.counts.openBlockingIssues } : {}),
    ...(input.counts?.identityGapCount !== undefined ? { identityGapCount: input.counts.identityGapCount } : {}),
    ...(input.counts?.pendingIndependentReviewPaths !== undefined ? { pendingIndependentReviewPaths: input.counts.pendingIndependentReviewPaths } : {}),
    ...(input.counts?.stageBlockedPaths !== undefined ? { stageBlockedPaths: input.counts.stageBlockedPaths } : {}),
    note: 'uncoveredWorksetSources 是当前确认的缺口（已剔除仍在写作中的来源：覆盖项已处置却无 sources 引用，或无任何在途写作分配）；inFlightWorksetSourceCount 是仍在写作中的未覆盖源。发布以 build_request_publish 实时校验为准。',
  };
}
