/**
 * CloudHistoryService 测试（P0-S4，lark-cli-newcaps-P0 §4.3/§4.4/§4.6）
 *
 * 覆盖任务书验收行：
 *  - listCloudHistory 分页聚合（page_token 续页 / has_more 驱动 / 上限保护）
 *  - buildRevertPlan 门控与 U23 警告矩阵
 *  - revertToAnchor 四分支状态迁移（done/running/failed/unknown）+
 *    confirm 派生值门（锚点 historyVersionId 必须出现在确认值中）+
 *    最新条目本地拒（3380002 语义）+ 回滚后只触发回拉不改基线
 *  - cloud_revert_running 互斥：新回滚拒 / push 写回拒（S3 报告约束下的
 *    最小追加门）
 *  - 轮询器四分支收敛（poll_after_ms 节奏 / 10 分钟上限→unknown / 状态
 *    查询失败续查 / 启动对账 resume）
 *  - routes/feishu 四端点契约（含 202 异步语义）
 *  - app_command cloud.revert 批准流端到端（批准→执行；停止取消；
 *    blocked 拒绝）
 */

import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { LarkCliError } from '../src/modules/lark-cli-client.js';
import {
  CloudHistoryService,
  CloudHistoryError,
  deriveRevertConfirmValue,
} from '../src/sources/cloud-history-service.js';
import { FeishuWriteService, FeishuWriteError } from '../src/sources/feishu-write-service.js';
import { feishuRoutes } from '../src/routes/feishu.js';
import { createOpsToolFamily } from '../src/agent/tools/app-command-family.js';
import { ApprovalService } from '../src/agent/approvals/approval-service.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import type { SourcePushLogRecord } from '../src/types/index.js';

const OBJ = 'doxcnS4CloudHistory';
/** 云端 obj_edit_time（秒级数值；getDocumentMetas latestModifyTime 形态）。 */
const CLOUD_TIME = 1_774_627_200; // 2026-10-28T00:00:00Z

interface LarkStub {
  calls: Array<{ op: string; args: unknown[] }>;
  [key: string]: unknown;
}

function historyEntry(historyVersionId: string, editTime: string, type = 2) {
  return {
    historyVersionId,
    revisionId: Number(historyVersionId) / 1024,
    editTime,
    editorIds: ['ou-editor'],
    type,
    raw: {},
  };
}

/** 默认单页三条历史（新→旧）：3072 最新 / 2048 / 1024(type=3 回滚快照)。 */
function defaultEntries() {
  return [
    historyEntry('3072', '2026-10-28T02:00:00Z'),
    historyEntry('2048', '2026-10-28T01:00:00Z'),
    historyEntry('1024', '2026-10-28T00:00:00Z', 3),
  ];
}

function makeLarkStub(opts: {
  historyPages?: Array<{ entries: ReturnType<typeof defaultEntries>; hasMore: boolean; nextPageToken: string | null }>;
  revertResult?: { status: 'done' | 'running'; taskId: string | null; pollAfterMs?: number; failedBlockTokens?: string[] | null };
  revertError?: unknown;
  revertStatus?: { status: 'done' | 'running' | 'failed'; failedBlockTokens?: string[] | null };
  statusError?: unknown;
  cloudTime?: number | null;
  scopes?: string[];
  /** Leader 补：fetchDocumentMarkdown stub（fetchCloudRevision 消费；缺省返回固定正文）。 */
  fetchMarkdown?: (objToken: string, opts?: { revisionId?: number }) => Promise<unknown>;
} = {}): LarkStub {
  const calls: LarkStub['calls'] = [];
  const pages = opts.historyPages ?? [{
    entries: defaultEntries(),
    hasMore: false,
    nextPageToken: null,
  }];
  const stub: LarkStub = {
    calls,
    checkAuthReady: async () => ({
      ready: true,
      verified: true,
      identity: 'user',
      currentScopes: opts.scopes ?? ['docx:document:write_only'],
      missingScopes: [],
    }),
    getDocumentMetas: async (reqs: Array<{ docToken: string; docType: string }>) => ({
      metas: reqs.map((r) => ({
        docToken: r.docToken,
        docType: r.docType,
        latestModifyTime: opts.cloudTime === undefined ? CLOUD_TIME : opts.cloudTime,
        title: '',
      })),
      failed: [],
    }),
    listDocumentHistory: async (token: string, o?: { pageToken?: string; pageSize?: number }) => {
      calls.push({ op: 'historyList', args: [token, o?.pageToken ?? null, o?.pageSize] });
      if (!o?.pageToken) return pages[0];
      const index = pages.findIndex((page) => page.nextPageToken === o.pageToken);
      return index >= 0 && index + 1 < pages.length
        ? pages[index + 1]
        : { entries: [], hasMore: false, nextPageToken: null };
    },
    revertDocumentHistory: async (token: string, id: string, o?: { waitTimeoutMs?: number }) => {
      calls.push({ op: 'revert', args: [token, id, o?.waitTimeoutMs] });
      if (opts.revertError) throw opts.revertError;
      return {
        status: opts.revertResult?.status ?? 'running',
        taskId: opts.revertResult?.taskId ?? 'task-1',
        pollAfterMs: opts.revertResult?.pollAfterMs ?? 10_000,
        failedBlockTokens: opts.revertResult?.failedBlockTokens ?? null,
      };
    },
    revertDocumentHistoryStatus: async (token: string, taskId: string) => {
      calls.push({ op: 'revertStatus', args: [token, taskId] });
      if (opts.statusError) throw opts.statusError;
      return {
        status: opts.revertStatus?.status ?? 'running',
        failedBlockTokens: opts.revertStatus?.failedBlockTokens ?? null,
      };
    },
    fetchDocumentMarkdown: opts.fetchMarkdown
      ?? (async (objToken: string, o?: { revisionId?: number }) => {
        calls.push({ op: 'fetchMarkdown', args: [objToken, o?.revisionId ?? null] });
        return { data: { document: { content: '# 默认云端正文' } } };
      }),
  };
  return stub;
}

interface Fixture {
  dataRoot: string;
  store: LocalMapStore;
  lark: LarkStub;
  pulls: string[];
  clock: { value: number };
  service: CloudHistoryService;
  cleanup: () => void;
}

function makeFixture(larkOpts: Parameters<typeof makeLarkStub>[0] = {}, configOpts: { feishuWriteEnabled?: boolean } = {}): Fixture {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudhist-'));
  const store = new LocalMapStore(path.join(dataRoot, 'test.db'));
  store.initialize();
  store.upsertDocument({
    objToken: OBJ,
    wikiNodeToken: 'wikinS4',
    objType: 'docx',
    title: 'S4 测试文档',
    localMdPath: path.join(dataRoot, 'kb', '策划', 'S4 测试文档.md'),
    lastSyncedModifyTime: '2026-10-27T00:00:00.000Z',
    lastSyncedAt: '2026-10-27T00:00:00.000Z',
    status: 'synced',
    localRelPath: '策划/S4 测试文档.md',
  } as never);
  const lark = makeLarkStub(larkOpts);
  const pulls: string[] = [];
  const clock = { value: 1_000_000 };
  const service = new CloudHistoryService({
    config: {
      getConfig: () => ({
        feishuWrite: { enabled: configOpts.feishuWriteEnabled !== false },
      }),
    },
    store,
    larkCliClient: lark,
    kbBuild: { isActive: () => false },
    dataRoot,
    pullSync: async (token: string) => {
      pulls.push(token);
      return { ok: true, status: 'synced' };
    },
    poller: { tickMs: 3_600_000, defaultIntervalMs: 5_000, deadlineMs: 600_000, now: () => clock.value },
  });
  return {
    dataRoot, store, lark, pulls, clock, service,
    cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }),
  };
}

/** 落一个 dirty source_edits 行 + base.md（local_edit_pending / push 预览用）。 */
function seedDirtyEdit(fx: Fixture): void {
  fs.mkdirSync(path.join(fx.dataRoot, 'source-edits', OBJ), { recursive: true });
  fs.writeFileSync(path.join(fx.dataRoot, 'source-edits', OBJ, 'base.md'), '# 基线\n');
  fx.store.createSourceEdit({
    objToken: OBJ,
    localRelPath: '策划/S4 测试文档.md',
    baseObjEditTime: CLOUD_TIME,
    baseBodyHash: 'b'.repeat(64),
    currentBodyHash: 'c'.repeat(64),
    lastActor: 'ui',
  });
}

/** 落一行 revert_state='running' 的 push_log（互斥门共享状态）。 */
function seedRunningRevert(fx: Fixture, opts: { taskId?: string | null } = {}): SourcePushLogRecord {
  const id = fx.store.insertSourcePushLog({
    objToken: OBJ,
    localRelPath: '策划/S4 测试文档.md',
    mode: 'revert',
    actor: 'ui',
    anchorHistoryId: '3072',
    anchorHistoryTime: '2026-10-28T02:00:00Z',
    anchorExact: true,
  });
  fx.store.updateSourcePushLog(id, { outcome: 'pushed' });
  fx.store.updateSourcePushLogRevert(id, {
    revertState: 'running',
    revertHistoryId: '2048',
    ...(opts.taskId !== null ? { revertTaskId: opts.taskId ?? 'task-old' } : {}),
  });
  return fx.store.getSourcePushLog(id)!;
}

async function expectCloudError(promise: Promise<unknown>): Promise<CloudHistoryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CloudHistoryError);
    return error as CloudHistoryError;
  }
  throw new Error('expected CloudHistoryError, got success');
}

function auditLines(fx: Fixture): Array<Record<string, unknown>> {
  const file = path.join(fx.dataRoot, 'agent', 'audit', 'source-pushes.jsonl');
  return fs.readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

const fixtures: Fixture[] = [];
afterEach(() => {
  while (fixtures.length) fixtures.pop()?.cleanup();
});

function fixture(larkOpts: Parameters<typeof makeLarkStub>[0] = {}, configOpts: { feishuWriteEnabled?: boolean } = {}): Fixture {
  const fx = makeFixture(larkOpts, configOpts);
  fixtures.push(fx);
  return fx;
}

// ===========================================================================
// A. listCloudHistory — 分页聚合
// ===========================================================================

describe('listCloudHistory — 分页聚合', () => {
  it('多页聚合：page_token 续页至耗尽，顺序保持，truncated=false', async () => {
    const fx = fixture({
      historyPages: [
        { entries: [historyEntry('3072', '2026-10-28T02:00:00Z')], hasMore: true, nextPageToken: 't2' },
        { entries: [historyEntry('2048', '2026-10-28T01:00:00Z')], hasMore: true, nextPageToken: 't3' },
        { entries: [historyEntry('1024', '2026-10-28T00:00:00Z', 3)], hasMore: false, nextPageToken: null },
      ],
    });
    const result = await fx.service.listCloudHistory(OBJ);
    expect(result.entries.map((entry) => entry.historyVersionId)).toEqual(['3072', '2048', '1024']);
    expect(result.hasMore).toBe(false);
    expect(result.nextPageToken).toBeNull();
    expect(result.truncated).toBe(false);
    // 三次调用：首页无 token → t2 → t3
    expect(fx.lark.calls.map((call) => call.args[1])).toEqual([null, 't2', 't3']);
  });

  it('缺省 3 页上限：truncated=true 且 nextPageToken 指向下一页', async () => {
    const fx = fixture({
      historyPages: [1, 2, 3, 4, 5].map((n) => ({
        entries: [historyEntry(String(n * 1024), `2026-10-2${n}T00:00:00Z`)],
        hasMore: n < 5,
        nextPageToken: n < 5 ? `t${n + 1}` : null,
      })),
    });
    const result = await fx.service.listCloudHistory(OBJ);
    expect(result.entries).toHaveLength(3);
    expect(result.hasMore).toBe(true);
    expect(result.nextPageToken).toBe('t4');
    expect(result.truncated).toBe(true);
    expect(fx.lark.calls).toHaveLength(3);
  });

  it('has_more=true 而 page_token 缺失：终止防死循环（单页结果）', async () => {
    const fx = fixture({
      historyPages: [{ entries: [historyEntry('3072', '2026-10-28T02:00:00Z')], hasMore: true, nextPageToken: null }],
    });
    const result = await fx.service.listCloudHistory(OBJ);
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(fx.lark.calls).toHaveLength(1);
  });

  it('显式 pageToken：单页透传不聚合', async () => {
    const fx = fixture();
    const result = await fx.service.listCloudHistory(OBJ, { pageToken: 't2' });
    expect(fx.lark.calls).toHaveLength(1);
    expect(fx.lark.calls[0].args[1]).toBe('t2');
    expect(result.truncated).toBe(false);
  });

  it('maxPages 硬上限 10：传 50 钳到 10 页', async () => {
    const fx = fixture({
      historyPages: Array.from({ length: 12 }, (_, i) => ({
        entries: [historyEntry(String((i + 1) * 1024), `2026-10-28T0${i}:00:00Z`)],
        hasMore: i < 11,
        nextPageToken: i < 11 ? `t${i + 2}` : null,
      })),
    });
    const result = await fx.service.listCloudHistory(OBJ, { maxPages: 50 });
    expect(result.entries).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(fx.lark.calls).toHaveLength(10);
  });
});

// ===========================================================================
// B. buildRevertPlan — 回滚计划
// ===========================================================================

describe('buildRevertPlan — 门控与警告', () => {
  it('history 源：无阻断无警告，target 命中指定版本（含时间与编辑者 id）', async () => {
    const fx = fixture();
    const plan = await fx.service.buildRevertPlan(OBJ, { historyVersionId: '2048' });
    expect(plan.blockedReason).toBeNull();
    expect(plan.source).toBe('history');
    expect(plan.anchorExact).toBeNull();
    expect(plan.warnings).toEqual([]);
    expect(plan.target).toMatchObject({ historyVersionId: '2048', createdAt: '2026-10-28T01:00:00Z', editorName: null });
    expect(plan.target.editorIds).toEqual(['ou-editor']);
  });

  it('push_log 源：anchor_inexact + cloud_changed_since_push 警告', async () => {
    const fx = fixture();
    const id = fx.store.insertSourcePushLog({
      objToken: OBJ,
      localRelPath: '策划/S4 测试文档.md',
      mode: 'append',
      actor: 'ui',
      preObjEditTime: CLOUD_TIME,
      anchorHistoryId: '1024',
      anchorHistoryTime: '2026-10-27T23:00:00Z',
      anchorExact: false,
    });
    fx.store.updateSourcePushLog(id, { outcome: 'pushed', postObjEditTime: String(CLOUD_TIME - 100) });
    const plan = await fx.service.buildRevertPlan(OBJ, { pushLogId: id });
    expect(plan.source).toBe('push_log');
    expect(plan.anchorExact).toBe(false);
    expect(plan.warnings).toEqual(['anchor_inexact', 'cloud_changed_since_push']);
    expect(plan.target.historyVersionId).toBe('1024');
  });

  it('push_log 源：锚点精确且云端未变 → 无警告；post 缺失回落 pre 基线比对', async () => {
    const fx = fixture();
    const id = fx.store.insertSourcePushLog({
      objToken: OBJ,
      localRelPath: '策划/S4 测试文档.md',
      mode: 'append',
      actor: 'ui',
      preObjEditTime: CLOUD_TIME,
      anchorHistoryId: '2048',
      anchorHistoryTime: '2026-10-28T01:00:00Z',
      anchorExact: true,
    });
    fx.store.updateSourcePushLog(id, { outcome: 'pushed' });
    // post_obj_edit_time 未抄录 → 回落 pre_obj_edit_time；云端时间相等 → 无警告。
    const plan = await fx.service.buildRevertPlan(OBJ, { pushLogId: id });
    expect(plan.blockedReason).toBeNull();
    expect(plan.warnings).toEqual([]);
    expect(plan.target.historyVersionId).toBe('2048');
  });

  it('目标=最新条目 → invalid_target（3380002 本地预校验）', async () => {
    const fx = fixture();
    const plan = await fx.service.buildRevertPlan(OBJ, { historyVersionId: '3072' });
    expect(plan.blockedReason).toBe('invalid_target');
  });

  it('目标不在前 3 页 → history_not_found', async () => {
    const fx = fixture();
    const plan = await fx.service.buildRevertPlan(OBJ, { historyVersionId: '9999' });
    expect(plan.blockedReason).toBe('history_not_found');
  });

  it('本地脏编辑 → local_edit_pending', async () => {
    const fx = fixture();
    seedDirtyEdit(fx);
    const plan = await fx.service.buildRevertPlan(OBJ, { historyVersionId: '2048' });
    expect(plan.blockedReason).toBe('local_edit_pending');
  });

  it('回滚进行中 → cloud_revert_running', async () => {
    const fx = fixture();
    seedRunningRevert(fx);
    const plan = await fx.service.buildRevertPlan(OBJ, { historyVersionId: '2048' });
    expect(plan.blockedReason).toBe('cloud_revert_running');
  });

  it('写开关关闭 → write_disabled；缺 scope → scope_missing', async () => {
    const fx = fixture({}, { feishuWriteEnabled: false });
    expect((await fx.service.buildRevertPlan(OBJ, { historyVersionId: '2048' })).blockedReason).toBe('write_disabled');
    const fx2 = fixture({ scopes: [] });
    expect((await fx2.service.buildRevertPlan(OBJ, { historyVersionId: '2048' })).blockedReason).toBe('scope_missing');
  });

  it('push_log 行无锚点 → anchor_missing；目标二选一校验 → invalid_body；不属该文档 → push_log_not_found', async () => {
    const fx = fixture();
    const id = fx.store.insertSourcePushLog({
      objToken: OBJ, localRelPath: 'x.md', mode: 'append', actor: 'ui', anchorError: 'history_list_empty',
    });
    expect((await fx.service.buildRevertPlan(OBJ, { pushLogId: id })).blockedReason).toBe('anchor_missing');
    await expect(fx.service.buildRevertPlan(OBJ, {})).rejects.toMatchObject({ code: 'invalid_body', status: 400 });
    await expect(fx.service.buildRevertPlan(OBJ, { pushLogId: 'sp_nope', historyVersionId: '2048' }))
      .rejects.toMatchObject({ code: 'invalid_body', status: 400 });
    await expect(fx.service.buildRevertPlan(OBJ, { pushLogId: 'sp_nope' }))
      .rejects.toMatchObject({ code: 'push_log_not_found', status: 404 });
  });
});

// ===========================================================================
// C. revertToAnchor — 执行四分支与门控
// ===========================================================================

describe('revertToAnchor — 执行与状态迁移', () => {
  it('confirm 门：裸 REVERT_CLOUD / 错误 id / 缺省 → 400 confirmation_required', async () => {
    const fx = fixture();
    await expect(fx.service.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: 'REVERT_CLOUD' }))
      .rejects.toMatchObject({ code: 'confirmation_required', status: 400 });
    await expect(fx.service.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: 'REVERT_CLOUD:3072' }))
      .rejects.toMatchObject({ code: 'confirmation_required', status: 400 });
    await expect(fx.service.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: undefined }))
      .rejects.toMatchObject({ code: 'confirmation_required', status: 400 });
    expect(fx.lark.calls.filter((call) => call.op === 'revert')).toHaveLength(0);
    expect(fx.store.listSourcePushLogs(OBJ)).toHaveLength(0);
  });

  it('done 分支：行 outcome=pushed / revert_state=done / 回滚前锚点=最新历史；锁外回拉；审计 started→done', async () => {
    const fx = fixture({ revertResult: { status: 'done', taskId: 't-done', pollAfterMs: 0 } });
    const result = await fx.service.revertToAnchor(
      OBJ,
      { historyVersionId: '2048' },
      { confirmValue: deriveRevertConfirmValue('2048'), actor: 'ui' },
    );
    expect(result.state).toBe('done');
    expect(result.pull).toMatchObject({ ok: true, status: 'synced' });
    expect(fx.pulls).toEqual([OBJ]); // 回滚后只触发回拉（不改基线：本服务零 synced 写入）
    const row = fx.store.getSourcePushLog(result.pushLogId)!;
    expect(row).toMatchObject({
      mode: 'revert',
      actor: 'ui',
      outcome: 'pushed',
      revertState: 'done',
      revertHistoryId: '2048',
      anchorHistoryId: '3072', // 回滚前最新历史作为本行的回退点
    });
    expect(row.revertedAt).toBeTruthy();
    const events = auditLines(fx).map((line) => line.event);
    expect(events).toEqual(['history_revert_started', 'history_revert_done']);
  });

  it('running 分支：--wait-timeout-ms 0 异步起步；行 running + task_id；不回拉', async () => {
    const fx = fixture({ revertResult: { status: 'running', taskId: 'task-1', pollAfterMs: 10_000 } });
    const result = await fx.service.revertToAnchor(
      OBJ,
      { historyVersionId: '2048' },
      { confirmValue: deriveRevertConfirmValue('2048'), actor: 'cli' },
    );
    expect(result.state).toBe('running');
    expect(result.taskId).toBe('task-1');
    expect(result.pull).toBeNull();
    expect(fx.pulls).toEqual([]);
    // 异步起步：子进程等待预算 0（任务书定值）
    expect(fx.lark.calls.find((call) => call.op === 'revert')?.args[2]).toBe(0);
    const row = fx.store.getSourcePushLog(result.pushLogId)!;
    expect(row).toMatchObject({ mode: 'revert', outcome: 'pushed', revertState: 'running', revertTaskId: 'task-1' });
  });

  it('failed 分支：3380002 → 行 failed + 422 invalid_target；审计 started→failed', async () => {
    const fx = fixture({
      revertError: new LarkCliError('回滚目标无效', 'invalid_target', false, '3380002'),
    });
    const error = await expectCloudError(fx.service.revertToAnchor(
      OBJ,
      { historyVersionId: '2048' },
      { confirmValue: deriveRevertConfirmValue('2048') },
    ));
    expect(error.code).toBe('invalid_target');
    expect(error.status).toBe(422);
    const [row] = fx.store.listSourcePushLogs(OBJ);
    expect(row).toMatchObject({ outcome: 'failed', revertState: 'failed', revertError: '3380002' });
    expect(auditLines(fx).map((line) => line.event)).toEqual(['history_revert_started', 'history_revert_failed']);
  });

  it('10020 冲突 → 409 cloud_revert_conflict；行 failed', async () => {
    const fx = fixture({
      revertError: new LarkCliError('并发单飞', 'conflict', true, '10020'),
    });
    const error = await expectCloudError(fx.service.revertToAnchor(
      OBJ,
      { historyVersionId: '2048' },
      { confirmValue: deriveRevertConfirmValue('2048') },
    ));
    expect(error.code).toBe('cloud_revert_conflict');
    expect(error.status).toBe(409);
    expect(fx.store.listSourcePushLogs(OBJ)[0]).toMatchObject({ revertState: 'failed' });
  });

  it('unknown 分支：timeout → 行 unknown + 502 revert_outcome_unknown（不自动重试）', async () => {
    const fx = fixture({ revertError: new LarkCliError('子进程超时', 'timeout', true) });
    const error = await expectCloudError(fx.service.revertToAnchor(
      OBJ,
      { historyVersionId: '2048' },
      { confirmValue: deriveRevertConfirmValue('2048') },
    ));
    expect(error.code).toBe('revert_outcome_unknown');
    expect(error.status).toBe(502);
    expect(fx.store.listSourcePushLogs(OBJ)[0]).toMatchObject({ outcome: 'unknown', revertState: 'unknown' });
    expect(auditLines(fx).map((line) => line.event)).toEqual(['history_revert_started', 'history_revert_unknown']);
  });

  it('最新条目作目标：本地预校验直接拒（3380002 语义），零 revert 调用零锚点行', async () => {
    const fx = fixture();
    const error = await expectCloudError(fx.service.revertToAnchor(
      OBJ,
      { historyVersionId: '3072' },
      { confirmValue: deriveRevertConfirmValue('3072') },
    ));
    expect(error.code).toBe('invalid_target');
    expect(error.status).toBe(422);
    expect(fx.lark.calls.filter((call) => call.op === 'revert')).toHaveLength(0);
    expect(fx.store.listSourcePushLogs(OBJ)).toHaveLength(0);
  });

  it('目标不在前 3 页 → 422 history_not_found（翻满 3 页即止，不翻全量）', async () => {
    const fx = fixture({
      historyPages: [1, 2, 3].map((n) => ({
        entries: [historyEntry(String(n * 1024), `2026-10-28T0${n}:00:00Z`)],
        hasMore: n < 3,
        nextPageToken: n < 3 ? `t${n + 1}` : null,
      })),
    });
    const error = await expectCloudError(fx.service.revertToAnchor(
      OBJ,
      { historyVersionId: '9999' },
      { confirmValue: deriveRevertConfirmValue('9999') },
    ));
    expect(error.code).toBe('history_not_found');
    expect(fx.lark.calls.filter((call) => call.op === 'historyList')).toHaveLength(3);
  });

  it('互斥：回滚进行中 → 新回滚 409 cloud_revert_running', async () => {
    const fx = fixture();
    seedRunningRevert(fx);
    const error = await expectCloudError(fx.service.revertToAnchor(
      OBJ,
      { historyVersionId: '2048' },
      { confirmValue: deriveRevertConfirmValue('2048') },
    ));
    expect(error.code).toBe('cloud_revert_running');
    expect(error.status).toBe(409);
    expect(fx.lark.calls.filter((call) => call.op === 'revert')).toHaveLength(0);
  });

  it('门控：write_disabled → 403；local_edit_pending → 409（执行路径复核）', async () => {
    const fx = fixture({}, { feishuWriteEnabled: false });
    await expect(fx.service.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: deriveRevertConfirmValue('2048') }))
      .rejects.toMatchObject({ code: 'write_disabled', status: 403 });
    const fx2 = fixture();
    seedDirtyEdit(fx2);
    await expect(fx2.service.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: deriveRevertConfirmValue('2048') }))
      .rejects.toMatchObject({ code: 'local_edit_pending', status: 409 });
  });

  it('push_log 目标：按锚点解析并校验（confirm 值须含解析后的锚点 id）', async () => {
    const fx = fixture({ revertResult: { status: 'done', taskId: 't-done', pollAfterMs: 0 } });
    const id = fx.store.insertSourcePushLog({
      objToken: OBJ,
      localRelPath: '策划/S4 测试文档.md',
      mode: 'overwrite',
      actor: 'ui',
      anchorHistoryId: '2048',
      anchorHistoryTime: '2026-10-28T01:00:00Z',
      anchorExact: true,
    });
    // 锚点是 2048：调用方拿 3072 的确认值 → 拒
    await expect(fx.service.revertToAnchor(OBJ, { pushLogId: id }, { confirmValue: deriveRevertConfirmValue('3072') }))
      .rejects.toMatchObject({ code: 'confirmation_required' });
    const result = await fx.service.revertToAnchor(
      OBJ,
      { pushLogId: id },
      { confirmValue: deriveRevertConfirmValue('2048') },
    );
    expect(result.state).toBe('done');
    expect(result.targetHistoryVersionId).toBe('2048');
  });
});

// ===========================================================================
// D. cloud_revert_running 互斥 — push 面（FeishuWriteService 最小追加门）
// ===========================================================================

describe('cloud_revert_running 互斥 — push 写回路径', () => {
  function makeWriteService(fx: Fixture): FeishuWriteService {
    return new FeishuWriteService({
      config: { getConfig: () => ({ feishuWrite: { enabled: true } }) },
      store: fx.store,
      larkCliClient: fx.lark,
      kbBuild: { isActive: () => false },
      dataRoot: fx.dataRoot,
      readEditView: async () => ({
        relPath: '策划/S4 测试文档.md', title: 'S4 测试文档', header: '', body: '# 基线\n',
        bodyHash: 'b'.repeat(64), state: null,
      }),
      pullSync: async () => ({ ok: true, status: 'synced' }),
    });
  }

  it('回滚进行中 → push 409 cloud_revert_running（早于基线缺失检查）', async () => {
    const fx = fixture();
    seedRunningRevert(fx);
    const service = makeWriteService(fx);
    try {
      await service.push(OBJ, { confirm: 'PUSH' });
      expect.unreachable('push 应被互斥门拒绝');
    } catch (error) {
      expect(error).toBeInstanceOf(FeishuWriteError);
      expect((error as FeishuWriteError).code).toBe('cloud_revert_running');
      expect((error as FeishuWriteError).status).toBe(409);
    }
    expect(fx.lark.calls.filter((call) => call.op === 'append' || call.op === 'overwrite')).toHaveLength(0);
  });

  it('无回滚行 → 互斥门不改变既有行为（继续走既有链路：无编辑行 → 404 source_edit_not_found）', async () => {
    const fx = fixture();
    const service = makeWriteService(fx);
    await expect(service.push(OBJ, { confirm: 'PUSH' }))
      .rejects.toMatchObject({ code: 'source_edit_not_found', status: 404 });
  });

  it('preview：回滚进行中 → blocked(cloud_revert_running)', async () => {
    const fx = fixture();
    seedDirtyEdit(fx);
    seedRunningRevert(fx);
    const plan = await makeWriteService(fx).preview(OBJ);
    expect(plan.mode).toBe('blocked');
    expect(plan.blockedReason).toBe('cloud_revert_running');
  });
});

// ===========================================================================
// E. 轮询器 — 四分支收敛 / poll_after_ms 节奏 / 启动对账
// ===========================================================================

describe('轮询器 — 收敛与节奏', () => {
  it('done 收敛：pollOnce → 行 done + reverted_at + 锁外回拉 + 审计', async () => {
    const fx = fixture({
      revertResult: { status: 'running', taskId: 'task-1', pollAfterMs: 10_000 },
      revertStatus: { status: 'done' },
    });
    const result = await fx.service.revertToAnchor(
      OBJ, { historyVersionId: '2048' }, { confirmValue: deriveRevertConfirmValue('2048') },
    );
    expect(result.state).toBe('running');
    fx.clock.value += 10_000; // 到达首次轮询点
    await fx.service.pollOnce();
    const row = fx.store.getSourcePushLog(result.pushLogId)!;
    expect(row.revertState).toBe('done');
    expect(row.revertedAt).toBeTruthy();
    expect(fx.pulls).toEqual([OBJ]);
    expect(auditLines(fx).map((line) => line.event))
      .toEqual(['history_revert_started', 'history_revert_moving', 'history_revert_done']);
    // 收敛后不再轮询
    const statusCalls = () => fx.lark.calls.filter((call) => call.op === 'revertStatus').length;
    const after = statusCalls();
    fx.clock.value += 60_000;
    await fx.service.pollOnce();
    expect(statusCalls()).toBe(after);
  });

  it('failed 收敛：部分块失败（failedBlockTokens）上抛到 revert_error', async () => {
    const fx = fixture({
      revertResult: { status: 'running', taskId: 'task-1', pollAfterMs: 5_000 },
      revertStatus: { status: 'failed', failedBlockTokens: ['blk_a', 'blk_b'] },
    });
    const result = await fx.service.revertToAnchor(
      OBJ, { historyVersionId: '2048' }, { confirmValue: deriveRevertConfirmValue('2048') },
    );
    fx.clock.value += 5_000;
    await fx.service.pollOnce();
    const row = fx.store.getSourcePushLog(result.pushLogId)!;
    expect(row.revertState).toBe('failed');
    expect(row.outcome).toBe('failed');
    expect(row.revertError).toContain('partial_blocks_failed:blk_a,blk_b');
    expect(fx.pulls).toEqual([]); // failed 不触发回拉
  });

  it('done 但部分块失败：状态 done + revert_error 记录部分失败（HP-2 上抛）', async () => {
    const fx = fixture({
      revertResult: { status: 'running', taskId: 'task-1', pollAfterMs: 5_000 },
      revertStatus: { status: 'done', failedBlockTokens: ['blk_x'] },
    });
    const result = await fx.service.revertToAnchor(
      OBJ, { historyVersionId: '2048' }, { confirmValue: deriveRevertConfirmValue('2048') },
    );
    fx.clock.value += 5_000;
    await fx.service.pollOnce();
    const row = fx.store.getSourcePushLog(result.pushLogId)!;
    expect(row.revertState).toBe('done');
    expect(row.revertError).toContain('partial_blocks_failed:blk_x');
  });

  it('running 分支：poll_after_ms 节奏（间隔未到不轮询，到点轮询）', async () => {
    const fx = fixture({
      revertResult: { status: 'running', taskId: 'task-1', pollAfterMs: 10_000 },
      revertStatus: { status: 'running' },
    });
    await fx.service.revertToAnchor(
      OBJ, { historyVersionId: '2048' }, { confirmValue: deriveRevertConfirmValue('2048') },
    );
    fx.clock.value += 5_000; // 间隔 10s 未到
    await fx.service.pollOnce();
    expect(fx.lark.calls.filter((call) => call.op === 'revertStatus')).toHaveLength(0);
    fx.clock.value += 5_000; // 到点
    await fx.service.pollOnce();
    expect(fx.lark.calls.filter((call) => call.op === 'revertStatus')).toHaveLength(1);
    fx.clock.value += 5_000; // 又到下一轮（上次轮询后 +10s）
    await fx.service.pollOnce();
    expect(fx.lark.calls.filter((call) => call.op === 'revertStatus')).toHaveLength(1);
    fx.clock.value += 5_000;
    await fx.service.pollOnce();
    expect(fx.lark.calls.filter((call) => call.op === 'revertStatus')).toHaveLength(2);
  });

  it('超时分支：单行 10 分钟上限 → unknown（不自动重试）', async () => {
    const fx = fixture({
      revertResult: { status: 'running', taskId: 'task-1', pollAfterMs: 5_000 },
      revertStatus: { status: 'running' },
    });
    const result = await fx.service.revertToAnchor(
      OBJ, { historyVersionId: '2048' }, { confirmValue: deriveRevertConfirmValue('2048') },
    );
    fx.clock.value += 600_001; // 越过 10 分钟总上限
    await fx.service.pollOnce();
    const row = fx.store.getSourcePushLog(result.pushLogId)!;
    expect(row.revertState).toBe('unknown');
    expect(row.outcome).toBe('unknown');
    expect(row.revertError).toBe('poll_deadline_exceeded');
    expect(auditLines(fx).map((line) => line.event))
      .toEqual(['history_revert_started', 'history_revert_moving', 'history_revert_unknown']);
  });

  it('状态查询抛错：不判终态，续查直至上限 → unknown', async () => {
    const fx = fixture({
      revertResult: { status: 'running', taskId: 'task-1', pollAfterMs: 5_000 },
      statusError: new Error('lark-cli 执行失败'),
    });
    const result = await fx.service.revertToAnchor(
      OBJ, { historyVersionId: '2048' }, { confirmValue: deriveRevertConfirmValue('2048') },
    );
    fx.clock.value += 5_000;
    await fx.service.pollOnce();
    expect(fx.store.getSourcePushLog(result.pushLogId)!.revertState).toBe('running');
    fx.clock.value += 600_000;
    await fx.service.pollOnce();
    expect(fx.store.getSourcePushLog(result.pushLogId)!.revertState).toBe('unknown');
  });

  it('启动对账：有 task_id 续查（resume）；无 task_id → unknown', async () => {
    const fx = fixture({ revertStatus: { status: 'done' } });
    const resumed = seedRunningRevert(fx, { taskId: 'task-resume' });
    const noTaskId = fx.store.insertSourcePushLog({
      objToken: OBJ, localRelPath: 'x.md', mode: 'revert', actor: 'ui', anchorHistoryId: '1024',
    });
    fx.store.updateSourcePushLog(noTaskId, { outcome: 'pushed' });
    fx.store.updateSourcePushLogRevert(noTaskId, { revertState: 'running', revertHistoryId: '1024' });
    const outcome = fx.service.resumeRunningReverts();
    expect(outcome).toEqual({ resumed: 1, markedUnknown: 1 });
    expect(fx.store.getSourcePushLog(noTaskId)).toMatchObject({ revertState: 'unknown', outcome: 'unknown' });
    fx.clock.value += 5_000; // defaultIntervalMs
    await fx.service.pollOnce();
    expect(fx.store.getSourcePushLog(resumed.id)!.revertState).toBe('done');
    expect(fx.pulls).toEqual([OBJ]);
  });
});

// ===========================================================================
// F. routes/feishu — 四端点契约
// ===========================================================================

function makeApp(fx: Fixture): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).localMapStore = fx.store;
    (c as any).larkCliClient = fx.lark;
    (c as any).configManager = { getConfig: () => ({ feishuWrite: { enabled: true } }), load: async () => ({}) };
    (c as any).kbBuildService = { activeBuild: () => null };
    (c as any).cloudHistoryService = fx.service;
    await next();
  });
  app.route('/', feishuRoutes);
  return app;
}

describe('routes/feishu — push-log / history / history-revert', () => {
  it('GET push-log：写回记录倒序（含回滚状态字段）', async () => {
    const fx = fixture();
    seedRunningRevert(fx);
    const response = await makeApp(fx).request(`/api/sources/${OBJ}/push-log`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]).toMatchObject({ mode: 'revert', revertState: 'running', revertTaskId: 'task-old' });
  });

  it('GET history：分页聚合透出（entries + truncated）', async () => {
    const fx = fixture();
    const response = await makeApp(fx).request(`/api/sources/${OBJ}/history`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries.map((entry: { historyVersionId: string }) => entry.historyVersionId))
      .toEqual(['3072', '2048', '1024']);
    expect(body.truncated).toBe(false);
  });

  it('POST history-revert/preview：返回计划 DTO', async () => {
    const fx = fixture();
    const response = await makeApp(fx).request(`/api/sources/${OBJ}/history-revert/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ historyVersionId: '2048' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      objToken: OBJ,
      source: 'history',
      blockedReason: null,
      target: { historyVersionId: '2048' },
    });
  });

  it('POST history-revert：错误 confirm → 400；正确 confirm → 202 running + 行落库', async () => {
    const fx = fixture({ revertResult: { status: 'running', taskId: 'task-1', pollAfterMs: 10_000 } });
    const app = makeApp(fx);
    const bad = await app.request(`/api/sources/${OBJ}/history-revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ historyVersionId: '2048', confirm: 'REVERT_CLOUD' }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'confirmation_required' });

    const ok = await app.request(`/api/sources/${OBJ}/history-revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ historyVersionId: '2048', confirm: deriveRevertConfirmValue('2048'), actor: 'cli' }),
    });
    expect(ok.status).toBe(202);
    const body = await ok.json();
    expect(body).toMatchObject({ state: 'running', taskId: 'task-1', targetHistoryVersionId: '2048' });
    expect(fx.store.getSourcePushLog(body.pushLogId)).toMatchObject({ revertState: 'running', actor: 'cli' });
  });

  it('互斥经路由暴露：回滚进行中 → preview blocked + execute 409', async () => {
    const fx = fixture();
    seedRunningRevert(fx);
    const app = makeApp(fx);
    const preview = await app.request(`/api/sources/${OBJ}/history-revert/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ historyVersionId: '2048' }),
    });
    expect(await preview.json()).toMatchObject({ blockedReason: 'cloud_revert_running' });
    const execute = await app.request(`/api/sources/${OBJ}/history-revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ historyVersionId: '2048', confirm: deriveRevertConfirmValue('2048') }),
    });
    expect(execute.status).toBe(409);
    expect(await execute.json()).toMatchObject({ error: 'cloud_revert_running' });
  });
});

// ===========================================================================
// G. app_command cloud.revert — 批准流端到端（批准→执行；停止取消；blocked 拒绝）
// ===========================================================================

const SESSION_ID = 's_s4_cloud';

describe('app_command cloud.revert — 批准流端到端', () => {
  let approvalsToClose: ApprovalService[] = [];

  afterEach(() => {
    for (const service of approvalsToClose) service.close();
    approvalsToClose = [];
  });

  function appCommandEnv(fx: Fixture, opts: { sessionRunState?: () => string } = {}) {
    const hono = makeApp(fx);
    const approvals = new ApprovalService({ dataRoot: fx.dataRoot, timeoutMs: 8_000 });
    approvalsToClose.push(approvals);
    const toolService = new AgentToolService({ dataRoot: fx.dataRoot, documentsProvider: () => [] });
    toolService.registerToolFamily(createOpsToolFamily({
      approvals,
      getApp: () => hono,
      desktopToken: 'stub-desktop-token',
      configProvider: () => null,
      ...(opts.sessionRunState ? { sessionRunState: opts.sessionRunState } : {}),
    }));
    const token = toolService.createRunContext({
      runKind: 'work', sessionId: SESSION_ID, outputRoot: os.tmpdir(), knowledgeBaseRoot: fx.dataRoot,
    }).token;
    return {
      approvals,
      runRevert: (args: Record<string, unknown>) =>
        toolService.executeTool(token, 'app_command', { command: 'cloud.revert', args }),
      runCommand: (command: string, args: Record<string, unknown>) =>
        toolService.executeTool(token, 'app_command', { command, args }),
    };
  }

  async function waitPending(approvals: ApprovalService) {
    for (let i = 0; i < 100; i += 1) {
      if (approvals.listPending(SESSION_ID).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [dto] = approvals.listPending(SESSION_ID);
    expect(dto).toBeDefined();
    return dto!;
  }

  it('批准 → 执行：确认值由 preview 派生（REVERT_CLOUD:<id>）；真实 revert 被调；202 结果返回模型', async () => {
    const fx = fixture({ revertResult: { status: 'running', taskId: 'task-agent', pollAfterMs: 10_000 } });
    const env = appCommandEnv(fx);
    const pending = env.runRevert({ objToken: OBJ, historyVersionId: '2048' });
    const dto = await waitPending(env.approvals);
    expect(dto.risk).toBe('destructive');
    // 确认值派生：锚点 historyVersionId 必须出现在确认值中
    expect((dto.preview as { confirmValue?: string }).confirmValue).toBe('REVERT_CLOUD:2048');
    // 模型传入的 confirm 被剔除，不进 argsSummary
    expect(JSON.parse(dto.argsSummary)).toEqual({ objToken: OBJ, historyVersionId: '2048' });
    env.approvals.decide(SESSION_ID, dto.id, 'approve');
    const result = await pending;
    expect(result.details).toMatchObject({ command: 'cloud.revert', risk: 'destructive' });
    expect(result.content[0]?.text).toContain('"state": "running"');
    expect(fx.lark.calls.some((call) => call.op === 'revert')).toBe(true);
    const [row] = fx.store.listSourcePushLogs(OBJ);
    expect(row).toMatchObject({ mode: 'revert', actor: 'cli', revertState: 'running', revertTaskId: 'task-agent' });
  });

  it('blocked preview → history_revert_blocked 400，零批准请求零 revert 调用', async () => {
    const fx = fixture();
    seedRunningRevert(fx);
    const env = appCommandEnv(fx);
    await expect(env.runRevert({ objToken: OBJ, historyVersionId: '2048' }))
      .rejects.toMatchObject({ code: 'history_revert_blocked', status: 400 });
    expect(env.approvals.pendingCount()).toBe(0);
    expect(fx.lark.calls.filter((call) => call.op === 'revert')).toHaveLength(0);
  });

  it('停止取消：aborting 后批准 → approval_cancelled，revert 零调用', async () => {
    const fx = fixture({ revertResult: { status: 'running', taskId: 'task-x', pollAfterMs: 10_000 } });
    let state: 'running' | 'aborting' | 'idle' = 'running';
    const env = appCommandEnv(fx, { sessionRunState: () => state });
    const pending = env.runRevert({ objToken: OBJ, historyVersionId: '2048' });
    const dto = await waitPending(env.approvals);
    state = 'aborting'; // 停止请求已进入
    env.approvals.decide(SESSION_ID, dto.id, 'approve');
    await expect(pending).rejects.toMatchObject({ code: 'approval_cancelled', status: 409 });
    expect(fx.lark.calls.filter((call) => call.op === 'revert')).toHaveLength(0);
    expect(fx.store.listSourcePushLogs(OBJ).filter((row) => row.mode === 'revert' && row.revertState === 'running')).toHaveLength(0);
  });

  it('Discuss 会话不见 destructive 命令：403 且无批准请求', async () => {
    const fx = fixture();
    const hono = makeApp(fx);
    const approvals = new ApprovalService({ dataRoot: fx.dataRoot, timeoutMs: 8_000 });
    approvalsToClose.push(approvals);
    const toolService = new AgentToolService({ dataRoot: fx.dataRoot, documentsProvider: () => [] });
    toolService.registerToolFamily(createOpsToolFamily({
      approvals, getApp: () => hono, desktopToken: 'stub-desktop-token', configProvider: () => null,
    }));
    const token = toolService.createRunContext({
      runKind: 'discuss', sessionId: 's_s4_discuss', outputRoot: os.tmpdir(), knowledgeBaseRoot: fx.dataRoot,
    }).token;
    await expect(toolService.executeTool(token, 'app_command', {
      command: 'cloud.revert', args: { objToken: OBJ, historyVersionId: '2048' },
    })).rejects.toMatchObject({ code: 'command_not_allowed', status: 403 });
    expect(approvals.pendingCount()).toBe(0);
  });

  it('cloud.history_list：read 级直通（不产生批准）', async () => {
    const fx = fixture();
    const env = appCommandEnv(fx);
    const result = await env.runCommand('cloud.history_list', { objToken: OBJ });
    expect(result.details).toMatchObject({ command: 'cloud.history_list', risk: 'read', httpStatus: 200 });
    expect(result.content[0]?.text).toContain('"3072"');
    expect(env.approvals.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Leader 补：fetchCloudRevision 只读云端历史正文（P0-S5 对比弹窗契约缺口）
// ---------------------------------------------------------------------------
describe('fetchCloudRevision（只读云端历史正文）— Leader 补 P0-S5 契约缺口', () => {
  function makeFetchFixture(content: string | null, rev = 2048): { fx: Fixture; fetchCalls: Array<{ objToken: string; opts?: { revisionId?: number } }> } {
    const fetchCalls: Array<{ objToken: string; opts?: { revisionId?: number } }> = [];
    const fx = makeFixture({
      fetchMarkdown: async (objToken: string, opts?: { revisionId?: number }) => {
        fetchCalls.push({ objToken, opts });
        return content === null
          ? { data: {} }
          : { data: { document: { content } } };
      },
    });
    void rev;
    return { fx, fetchCalls };
  }

  it('argv 语义：--revision-id 数值透传；解析 data.document.content', async () => {
    const { fx, fetchCalls } = makeFetchFixture('# 旧版正文');
    const result = await fx.service.fetchCloudRevision('doctokenA', 2048);
    expect(result).toEqual({ revisionId: 2048, content: '# 旧版正文' });
    expect(fetchCalls).toEqual([{ objToken: 'doctokenA', opts: { revisionId: 2048 } }]);
  });

  it('响应无 content → history_content_unavailable 502', async () => {
    const { fx } = makeFetchFixture(null);
    await expect(fx.service.fetchCloudRevision('doctokenA', 2048)).rejects.toMatchObject({
      code: 'history_content_unavailable',
      status: 502,
    });
  });

  it('非法 objToken/revisionId → invalid_body 400', async () => {
    const { fx } = makeFetchFixture('# x');
    await expect(fx.service.fetchCloudRevision('', 2048)).rejects.toMatchObject({
      code: 'invalid_body',
      status: 400,
    });
    await expect(fx.service.fetchCloudRevision('doctokenA', Number.NaN)).rejects.toMatchObject({
      code: 'invalid_body',
      status: 400,
    });
  });

  it('上游异常包装为 history_content_unavailable（原文保留）', async () => {
    const fx = makeFixture({
      fetchMarkdown: async () => {
        throw new Error('boom: revision not found');
      },
    });
    await expect(fx.service.fetchCloudRevision('doctokenA', 404)).rejects.toMatchObject({
      code: 'history_content_unavailable',
      status: 502,
      message: expect.stringContaining('revision not found'),
    });
  });

  it('路由 GET history-content：合法 revisionId 返回正文；非数值 400', async () => {
    const fx = makeFixture({ fetchMarkdown: async () => ({ data: { document: { content: '云端正文' } } }) });
    const app = makeApp(fx);
    const ok = await app.request('/api/sources/doctokenA/history-content?revisionId=2048');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ revisionId: 2048, content: '云端正文' });
    const bad = await app.request('/api/sources/doctokenA/history-content?revisionId=abc');
    expect(bad.status).toBe(400);
  });});

// ===========================================================================
// H. T4b 修复批 B（审核 T4b-diting-final-review）：06 写后未知 / 08 当前
//    正文消费链（server 面）/ 09 anchorExact 秒级口径 / 10 关键状态持久化
// ===========================================================================

describe('T4b-09 anchorExact 秒级口径（与写回链共用判定）', () => {
  // 默认 entries[0]（锚点=3072）editTime=2026-10-28T02:00:00Z；
  // latestModifyTime 通道本就是秒——审核反例：锚点早 1 秒曾被误判精确。
  const ANCHOR_SEC = Math.floor(Date.parse('2026-10-28T02:00:00Z') / 1000);

  it('锚点早 1 秒 → false（审核反例：原实现除以 1000 误判 true）', async () => {
    const fx = fixture({ cloudTime: ANCHOR_SEC + 1 });
    const result = await fx.service.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: 'REVERT_CLOUD:2048' });
    expect(fx.store.getSourcePushLog(result.pushLogId)?.anchorExact).toBe(false);
  });

  it('锚点与云端时间相等（秒级取整）→ true', async () => {
    const fx = fixture({ cloudTime: ANCHOR_SEC });
    const result = await fx.service.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: 'REVERT_CLOUD:2048' });
    expect(fx.store.getSourcePushLog(result.pushLogId)?.anchorExact).toBe(true);
  });

  it('云端时间不可读 → false（保守）', async () => {
    const fx = fixture({ cloudTime: null });
    const result = await fx.service.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: 'REVERT_CLOUD:2048' });
    expect(fx.store.getSourcePushLog(result.pushLogId)?.anchorExact).toBe(false);
  });
});

describe('T4b-06 revert 写后未知分类', () => {
  it('命令发出后输出不可解析（parse）→ 行 unknown + 502 revert_outcome_unknown（单次执行不重发）', async () => {
    const fx = fixture({ revertError: new LarkCliError('bad json', 'parse', false) });
    const err = await expectCloudError(
      fx.service.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: 'REVERT_CLOUD:2048' }),
    );
    expect(err).toMatchObject({ code: 'revert_outcome_unknown', status: 502 });
    const row = fx.store.getSourcePushLog(err.details!.pushLogId as string)!;
    expect(row.revertState).toBe('unknown');
    expect(row.outcome).toBe('unknown');
    // 单次执行零重发（revert 非幂等；unknown ≠ 可自动重试的「明确失败」）。
    // 注：revert 互斥只围栏 running（与移出 unknown 持续围栏不同——设计
    // §4.4 允许 unknown 后由用户核对再手动重试），这里锚定的是本次执行
    // 内不重发。
    expect(fx.lark.calls.filter((call) => call.op === 'revert')).toHaveLength(1);
  });

  it('权威业务拒绝（3380002 invalid_target）仍 → failed（与未知信号区分）', async () => {
    const fx = fixture({
      revertError: new LarkCliError('回滚目标无效', 'invalid_target', false, '3380002'),
    });
    const err = await expectCloudError(
      fx.service.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: 'REVERT_CLOUD:2048' }),
    );
    expect(err).toMatchObject({ code: 'invalid_target', status: 422 });
    const row = fx.store.listSourcePushLogs(OBJ)[0];
    expect(row?.revertState).toBe('failed');
  });
});

describe('T4b-10 revert 关键状态持久化 fail-closed', () => {
  it('running/taskId 写入注入异常：围栏不丢（行起步即 running），新回滚/写回仍拒；恢复后轮询收敛 done + task_id', async () => {
    const fx = fixture({
      revertResult: { status: 'running', taskId: 'task-1', pollAfterMs: 10_000 },
      revertStatus: { status: 'done' },
    });
    const original = fx.store.updateSourcePushLogRevert.bind(fx.store);
    let injected = true;
    (fx.store as any).updateSourcePushLogRevert = ((id: string, patch: Record<string, unknown>) => {
      // 只注入 taskId 持久化（无 revertState 的补写）；insert 落的 running 围栏不受影响。
      if (injected && patch.revertState === undefined) throw new Error('INJECTED transient SQLite write failure');
      return original(id, patch as never);
    }) as never;
    const result = await fx.service.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: 'REVERT_CLOUD:2048' });
    // 命令已受理：结果 running（202 语义），但持久化降级显式上报。
    expect(result.state).toBe('running');
    expect(result.persistWarning).toBeTruthy();
    // 围栏不丢：行保持 revert_state='running'（审核反例：原实现 gate=null）。
    const gate = fx.store.getRunningRevertPushLog(OBJ);
    expect(gate).not.toBeNull();
    expect(gate).toMatchObject({ revertState: 'running', revertTaskId: null });
    // 新回滚被拒。
    const second = await expectCloudError(
      fx.service.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: 'REVERT_CLOUD:2048' }),
    );
    expect(second).toMatchObject({ code: 'cloud_revert_running', status: 409 });
    // 写回同门（共享状态源）。
    const write = new FeishuWriteService({
      config: { getConfig: () => ({ feishuWrite: { enabled: true } }) },
      store: fx.store,
      larkCliClient: fx.lark,
      kbBuild: { isActive: () => false },
      dataRoot: fx.dataRoot,
      readEditView: async () => ({
        relPath: '策划/S4 测试文档.md', title: 'S4 测试文档', header: '', body: '# 基线\n',
        bodyHash: 'b'.repeat(64), state: null,
      }),
      pullSync: async () => ({ ok: true, status: 'synced' }),
    });
    await expect(write.push(OBJ, { confirm: 'PUSH' })).rejects.toMatchObject({ code: 'cloud_revert_running' });
    // DB 写恢复后：进程内轮询收敛（done + task_id 回填，不丢 taskId）。
    injected = false;
    fx.clock.value += 10_000;
    await fx.service.pollOnce();
    expect(fx.store.getSourcePushLog(result.pushLogId)).toMatchObject({
      revertState: 'done', revertTaskId: 'task-1',
    });
    expect(fx.store.getRunningRevertPushLog(OBJ)).toBeNull();
    expect(fx.pulls).toEqual([OBJ]); // done 收敛后锁外回拉
  });

  it('轮询终态落盘失败：tracked 保留重试，恢复后收敛（不静默丢行）', async () => {
    const fx = fixture({
      revertResult: { status: 'running', taskId: 'task-1', pollAfterMs: 10_000 },
      revertStatus: { status: 'failed' },
    });
    const id = await (async () => {
      const r = await fx.service.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: 'REVERT_CLOUD:2048' });
      return r.pushLogId;
    })();
    const original = fx.store.updateSourcePushLogRevert.bind(fx.store);
    let injected = true;
    (fx.store as any).updateSourcePushLogRevert = ((rowId: string, patch: Record<string, unknown>) => {
      if (injected && patch.revertState === 'failed') throw new Error('INJECTED');
      return original(rowId, patch as never);
    }) as never;
    fx.clock.value += 10_000;
    await fx.service.pollOnce();
    // 第一次 finalize 落盘失败：行保持 running 围栏。
    expect(fx.store.getSourcePushLog(id)?.revertState).toBe('running');
    // 写恢复后下轮收敛。
    injected = false;
    fx.clock.value += 10_000;
    await fx.service.pollOnce();
    expect(fx.store.getSourcePushLog(id)?.revertState).toBe('failed');
  });
});

describe('T4b-08 云端当前正文（缺省 revisionId）— service 与路由', () => {
  function makeFetchFixture(content: string | null): {
    fx: Fixture;
    fetchCalls: Array<{ objToken: string; opts?: { revisionId?: number } }>;
  } {
    const fetchCalls: Array<{ objToken: string; opts?: { revisionId?: number } }> = [];
    const fx = fixture({
      fetchMarkdown: async (objToken: string, opts?: { revisionId?: number }) => {
        fetchCalls.push({ objToken, opts });
        return content === null ? { data: {} } : { data: { document: { content } } };
      },
    });
    return { fx, fetchCalls };
  }

  it('service：revisionId=null → 云端当前正文（fetchDocumentMarkdown 不带 revisionId），响应 revisionId=null', async () => {
    const { fx, fetchCalls } = makeFetchFixture('# 云端当前');
    const result = await fx.service.fetchCloudRevision('doctokenA', null);
    expect(result).toEqual({ revisionId: null, content: '# 云端当前' });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toMatchObject({ objToken: 'doctokenA' });
    expect(fetchCalls[0].opts ?? {}).not.toHaveProperty('revisionId');
  });

  it('路由：缺省 revisionId → 当前正文（200，revisionId=null）；显式 revisionId 行为不变', async () => {
    const { fx } = makeFetchFixture('云端正文');
    const app = makeApp(fx);
    const current = await app.request('/api/sources/doctokenA/history-content');
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ revisionId: null, content: '云端正文' });
    const revision = await app.request('/api/sources/doctokenA/history-content?revisionId=2048');
    expect(revision.status).toBe(200);
    expect(await revision.json()).toEqual({ revisionId: 2048, content: '云端正文' });
    const bad = await app.request('/api/sources/doctokenA/history-content?revisionId=abc');
    expect(bad.status).toBe(400);
  });
});
