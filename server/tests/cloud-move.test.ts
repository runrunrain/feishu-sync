/**
 * CloudMoveService 测试（P2-S6，lark-cli-newcaps-P2 §3.1–§3.6）。
 *
 * 覆盖任务书验收行：
 *  - CLI 方法：moveWikiNodeToDrive / getDriveTaskResult 的 argv（有/无
 *    --folder-token）与通用异步模式双读解析（【待 S5 实测校正】真实输出
 *    字段以 S5 实测为准，本组按 probe help 契约 mock）。
 *  - 门控各分支：非叶子拒 / 编辑中拒 / 回滚互斥 / 归档文档拒 / 构建活跃
 *    拒 / 移出进行中拒 / confirm 值必须含 node token（CLI 基值通道）。
 *  - 状态机迁移：同步 moved / 异步 moving / 业务错 failed / 子进程超时
 *    unknown；轮询 done/failed/超 10 分钟→unknown；状态查询失败续查。
 *  - 重启对账三种情形（pending→unknown；moving+task_id 续查；moving 无
 *    task_id→unknown）。
 *  - moved 后本地不动：documents 行与本地文件字节不变、不推进 synced
 *    字段、仅触发一次变更检测（只推进观测字段的既有入口）。
 *  - 互斥门消费方：SourceEditService / FeishuWriteService /
 *    CloudHistoryService 对 cloud_move_running / source_moved_out 的拒绝。
 *  - 迁移双登记：initialize() 建表段 + getCreateTablesDDL() 同源 DDL。
 *  - 已移除的移出路由与 CLI 命令始终拒绝执行，历史记录查询仍可用。
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { LarkCliClient, LarkCliError } from '../src/modules/lark-cli-client.js';
import { CloudMoveService, CloudMoveError, deriveMoveOutConfirmValue } from '../src/sources/cloud-move-service.js';
import { SourceEditService } from '../src/sources/source-edit-service.js';
import { FeishuWriteService } from '../src/sources/feishu-write-service.js';
import { CloudHistoryService } from '../src/sources/cloud-history-service.js';
import { feishuRoutes } from '../src/routes/feishu.js';
import { findOpsCommand, opsCommandMetadata } from '../src/ops/command-table.js';
import { cliRoutes } from '../src/routes/cli.js';
import { CliEndpoint } from '../src/cli-endpoint.js';

const OBJ = 'doxcnP2S6CloudMove';
const NODE = 'wikinP2S6';
const ROOT_ID = 'wr-p2s6';
const FOLDER = 'fldP2S6Target';
const TASK = 'task-p2s6-1';

interface LarkStub {
  calls: Array<{ op: string; args: unknown[] }>;
  [key: string]: unknown;
}

function makeLarkStub(opts: {
  nodeHasChild?: boolean;
  nodeMissing?: boolean;
  moveResult?: { state: 'done' | 'running'; taskId: string | null; pollAfterMs?: number };
  moveError?: unknown;
  taskResult?: { state: 'done' | 'running' | 'failed'; message?: string | null };
  taskError?: unknown;
} = {}): LarkStub {
  const calls: LarkStub['calls'] = [];
  return {
    calls,
    checkAuthReady: async () => ({
      ready: true, verified: true, identity: 'user',
      currentScopes: ['docx:document:write_only'], missingScopes: [],
    }),
    getNode: async (nodeToken: string) => {
      calls.push({ op: 'getNode', args: [nodeToken] });
      if (opts.nodeMissing) throw new LarkCliError('node not found', 'upstream', false, '131005');
      return {
        node_token: nodeToken,
        obj_token: OBJ,
        obj_type: 'docx',
        title: 'P2-S6 测试文档',
        space_id: 'sp1',
        obj_edit_time: 1_774_627_200,
        has_child: opts.nodeHasChild === true,
      };
    },
    moveWikiNodeToDrive: async (nodeToken: string, o?: { folderToken?: string | null }) => {
      calls.push({ op: 'move', args: [nodeToken, o?.folderToken ?? null] });
      if (opts.moveError) throw opts.moveError;
      return {
        state: opts.moveResult?.state ?? 'running',
        taskId: opts.moveResult?.taskId ?? TASK,
        pollAfterMs: opts.moveResult?.pollAfterMs ?? 10_000,
        raw: {},
      };
    },
    getDriveTaskResult: async (taskId: string) => {
      calls.push({ op: 'taskResult', args: [taskId] });
      if (opts.taskError) throw opts.taskError;
      return { state: opts.taskResult?.state ?? 'running', message: opts.taskResult?.message ?? null, raw: {} };
    },
  };
}

interface Fixture {
  dataRoot: string;
  store: LocalMapStore;
  lark: LarkStub;
  clock: { value: number };
  detects: string[];
  service: CloudMoveService;
  /** 本地源文件绝对路径 + 落盘正文。 */
  absPath: string;
  cleanup: () => void;
}

function makeFixture(
  larkOpts: Parameters<typeof makeLarkStub>[0] = {},
  docOpts: { watchedRootId?: string | null; wikiNodeToken?: string | null } = {},
): Fixture {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudmove-'));
  const store = new LocalMapStore(path.join(dataRoot, 'test.db'));
  store.initialize();
  const relPath = '策划/P2-S6 测试文档.md';
  const absPath = path.join(dataRoot, 'kb', ...relPath.split('/'));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `<!--\nfeishu_sync:\n  obj_token: "${OBJ}"\n  wiki_node_token: "${NODE}"\n  obj_type: "docx"\n-->\n\n# 正文\n`);
  store.upsertDocument({
    objToken: OBJ,
    wikiNodeToken: docOpts.wikiNodeToken === undefined ? NODE : docOpts.wikiNodeToken,
    objType: 'docx',
    title: 'P2-S6 测试文档',
    localMdPath: absPath,
    lastSyncedModifyTime: '2026-10-27T00:00:00.000Z',
    lastSyncedAt: '2026-10-27T00:00:00.000Z',
    status: 'synced',
    localRelPath: relPath,
    watchedRootId: docOpts.watchedRootId === undefined ? ROOT_ID : docOpts.watchedRootId,
  } as never);
  store.markDocumentSynced({ objToken: OBJ, syncedObjEditTime: 1_774_627_200 } as never);
  const lark = makeLarkStub(larkOpts);
  const detects: string[] = [];
  const clock = { value: 1_000_000 };
  const service = new CloudMoveService({
    config: { getConfig: () => ({ watchedRoots: [{ id: ROOT_ID, url: 'https://x.feishu.cn/wiki/root', localDir: '策划库', enabled: true }] }) },
    store,
    larkCliClient: lark,
    kbBuild: { isActive: () => false },
    dataRoot,
    detectRoot: async (rootId: string) => {
      detects.push(rootId);
      return { ok: true };
    },
    poller: { tickMs: 3_600_000, defaultIntervalMs: 5_000, deadlineMs: 600_000, now: () => clock.value },
  });
  return {
    dataRoot, store, lark, clock, detects, service, absPath,
    cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }),
  };
}

const fixtures: Fixture[] = [];
afterEach(() => {
  while (fixtures.length) {
    const fx = fixtures.pop()!;
    fx.service.stopPoller();
    fx.cleanup();
  }
});

function fixture(
  larkOpts: Parameters<typeof makeLarkStub>[0] = {},
  docOpts: { watchedRootId?: string | null; wikiNodeToken?: string | null } = {},
): Fixture {
  const fx = makeFixture(larkOpts, docOpts);
  fixtures.push(fx);
  return fx;
}

async function expectMoveError(promise: Promise<unknown>): Promise<CloudMoveError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CloudMoveError);
    return error as CloudMoveError;
  }
  throw new Error('expected CloudMoveError, got success');
}

function auditEvents(fx: Fixture): string[] {
  const file = path.join(fx.dataRoot, 'agent', 'audit', 'source-pushes.jsonl');
  return fs.readFileSync(file, 'utf-8').trim().split('\n')
    .map((line) => (JSON.parse(line) as Record<string, unknown>).event as string);
}

/** 起一次成功移出（异步起步），返回 moveId。 */
async function startMoving(fx: Fixture): Promise<string> {
  const result = await fx.service.moveToDrive(OBJ, {
    confirmValue: deriveMoveOutConfirmValue(NODE),
    actor: 'ui',
  });
  expect(result.state).toBe('moving');
  return result.moveId;
}

// ===========================================================================
// A. CLI 方法（lark-cli-client；【待 S5 实测校正】输出形态按通用异步模式）
// ===========================================================================

describe('CLI 方法 moveWikiNodeToDrive / getDriveTaskResult', () => {
  it('按 CLI 1.0.98 数值协议处理成功、处理中与失败，并给予内置轮询足够时间', async () => {
    const client = new LarkCliClient();
    const execute = vi.fn(async () => ({ data: { status: 0, ready: true, failed: false, task_id: 'full-task-id' } }));
    (client as any).execute = execute;
    expect(await client.moveWikiNodeToDrive(NODE)).toMatchObject({ state: 'done', taskId: 'full-task-id' });
    expect(execute.mock.calls[0][2]).toEqual({ timeoutMs: 80_000 });
    execute.mockResolvedValueOnce({ data: { status: 1, ready: false, failed: false, task_id: 'full-task-id' } });
    expect(await client.moveWikiNodeToDrive(NODE)).toMatchObject({ state: 'running', taskId: 'full-task-id' });
    execute.mockResolvedValueOnce({ data: { status: -1, ready: false, failed: true, task_id: 'full-task-id', status_msg: 'denied' } } as never);
    await expect(client.moveWikiNodeToDrive(NODE)).rejects.toMatchObject({ code: 'upstream' });
    execute.mockResolvedValueOnce({ data: { status: 0, ready: true, failed: false, task_id: 'full-task-id' } });
    expect(await client.getDriveTaskResult('full-task-id')).toMatchObject({ state: 'done' });
    execute.mockResolvedValueOnce({ data: { status: -1, ready: false, failed: true, task_id: 'full-task-id', status_msg: 'denied' } } as never);
    expect(await client.getDriveTaskResult('full-task-id')).toMatchObject({ state: 'failed', message: 'denied' });
    execute.mockResolvedValueOnce({ data: { status: 1, ready: false, failed: false, task_id: 'full-task-id' } });
    expect(await client.getDriveTaskResult('full-task-id')).toMatchObject({ state: 'running' });
  });
  function stubbedClient(): { client: LarkCliClient; calls: Array<{ args: string[]; apiType: string }> } {
    const client = new LarkCliClient();
    const calls: Array<{ args: string[]; apiType: string }> = [];
    (client as any).execute = async (args: string[], apiType: string) => {
      calls.push({ args, apiType });
      return { ok: true, data: { state: 'running', task_id: TASK, poll_after_ms: 10000 } };
    };
    return { client, calls };
  }

  it('argv：wiki +move-to-drive --node-token <n> [--folder-token <f>] --format json（probe §9 help 契约）', async () => {
    const { client, calls } = stubbedClient();
    await client.moveWikiNodeToDrive(NODE);
    await client.moveWikiNodeToDrive(NODE, { folderToken: FOLDER });
    await client.moveWikiNodeToDrive(NODE, { folderToken: '' }); // 空 = 个人空间根
    expect(calls.map((call) => call.apiType)).toEqual(['wiki', 'wiki', 'wiki']);
    expect(calls[0].args).toEqual(['wiki', '+move-to-drive', '--node-token', NODE, '--format', 'json']);
    expect(calls[1].args).toEqual(['wiki', '+move-to-drive', '--node-token', NODE, '--folder-token', FOLDER, '--format', 'json']);
    expect(calls[2].args).toEqual(['wiki', '+move-to-drive', '--node-token', NODE, '--format', 'json']);
  });

  it('双读解析：state/status/task_status + task_id/taskId + camel 兜底（待 S5 实测校正点）；T4b-06：异步缺 task_id → incomplete_response（未知信号，非明确失败）', async () => {
    const client = new LarkCliClient();
    (client as any).execute = async () => ({ data: { status: 'done', taskId: 'taskCamel' } });
    const done = await client.moveWikiNodeToDrive(NODE);
    expect(done).toMatchObject({ state: 'done', taskId: 'taskCamel' });
    (client as any).execute = async () => ({ data: { task_status: 'weird', task_id: 't1' } });
    const weird = await client.moveWikiNodeToDrive(NODE);
    expect(weird.state).toBe('running'); // 未知取值归一 running（通用异步模式）
    expect(weird.taskId).toBe('t1');
    // T4b-06：命令已发出但异步响应缺 task_id（无法轮询收敛）或整体缺
    // state 键 → 结果未知信号（incomplete_response，不可重试），不再归一
    // running/null 静默交给上层。
    (client as any).execute = async () => ({ data: { task_status: 'weird' } });
    await expect(client.moveWikiNodeToDrive(NODE)).rejects.toMatchObject({
      code: 'incomplete_response', retryable: false,
    });
    (client as any).execute = async () => ({ data: { task_id: 't2' } });
    await expect(client.moveWikiNodeToDrive(NODE)).rejects.toMatchObject({
      code: 'incomplete_response', retryable: false,
    });
  });

  it('getDriveTaskResult：明确指定 wiki_move_to_drive 场景；三态归一', async () => {
    const client = new LarkCliClient();
    const calls: Array<{ args: string[]; apiType: string }> = [];
    (client as any).execute = async (args: string[], apiType: string) => {
      calls.push({ args, apiType });
      return { data: { state: 'success' } };
    };
    const ok = await client.getDriveTaskResult(TASK);
    expect(ok.state).toBe('done'); // success 归一 done（待 S5 校正）
    expect(calls[0]).toEqual({
      args: ['drive', '+task_result', '--scenario', 'wiki_move_to_drive', '--task-id', TASK, '--format', 'json'],
      apiType: 'drive',
    });
    (client as any).execute = async () => ({ data: { status: 'failed', error: 'boom' } });
    const failed = await client.getDriveTaskResult(TASK);
    expect(failed).toMatchObject({ state: 'failed', message: 'boom' });
  });

  it('空参抛错（调用方永不重试契约的前置）', async () => {
    const client = new LarkCliClient();
    await expect(client.moveWikiNodeToDrive('')).rejects.toThrow(/non-empty nodeToken/);
    await expect(client.getDriveTaskResult(' ')).rejects.toThrow(/non-empty taskId/);
  });
});

// ===========================================================================
// B. LMS 迁移双登记 + 访问器
// ===========================================================================

describe('cloud_moves 迁移双登记与访问器', () => {
  it('双登记：initialize() 建表段与 getCreateTablesDDL() 同含 cloud_moves 表与索引', () => {
    const fx = fixture();
    const ddl = fx.store.getCreateTablesDDL();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS cloud_moves');
    expect(ddl).toContain("CHECK(state IN ('pending','moving','moved','failed','unknown'))");
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS idx_cloud_moves_token');
    const tables = (fx.store as any).db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_moves'").all();
    expect(tables).toHaveLength(1);
    const indexes = (fx.store as any).db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cloud_moves_token'").all();
    expect(indexes).toHaveLength(1);
  });

  it('访问器：insert pending → update 状态机字段 → active/latest/list 查询', () => {
    const fx = fixture();
    const id = fx.store.insertCloudMove({
      objToken: OBJ, wikiNodeToken: NODE, watchedRootId: ROOT_ID,
      title: 'T', targetFolderToken: null, actor: 'ui',
    });
    expect(id).toMatch(/^mv_\d{14}_[0-9a-f]{6}$/);
    expect(fx.store.getCloudMove(id)).toMatchObject({ state: 'pending', objToken: OBJ, actor: 'ui' });
    expect(fx.store.getActiveCloudMove(OBJ)?.id).toBe(id); // pending 也算进行中（互斥门）
    fx.store.updateCloudMove(id, { state: 'moving', taskId: TASK });
    expect(fx.store.getCloudMove(id)).toMatchObject({ state: 'moving', taskId: TASK });
    expect(fx.store.listMovingCloudMoves().map((row: any) => row.id)).toEqual([id]);
    fx.store.updateCloudMove(id, { state: 'moved' });
    expect(fx.store.getActiveCloudMove(OBJ)).toBeNull(); // 终态不再互斥进行中
    expect(fx.store.getLatestCloudMove(OBJ)?.state).toBe('moved'); // moved 门状态源
    expect(fx.store.listCloudMoves(OBJ, 10)).toHaveLength(1);
    expect(fx.store.listCloudMoves(undefined, 10)).toHaveLength(1);
  });

  it('CHECK 约束：非法 state 写入被拒（状态机封闭集合）', () => {
    const fx = fixture();
    const id = fx.store.insertCloudMove({ objToken: OBJ, wikiNodeToken: NODE, actor: 'ui' });
    expect(() => (fx.store as any).db.prepare('UPDATE cloud_moves SET state = ? WHERE id = ?').run('started', id))
      .toThrow(); // 设计 §3.3 命名不在任务书状态机集合内
  });
});

// ===========================================================================
// C. 门控各分支（preview blockedReason + 执行同判定）
// ===========================================================================

describe('门控分支', () => {
  it('归档文档（无 watched_root / 无 wiki 身份）→ not_watched_root 422', async () => {
    const fx = fixture({}, { watchedRootId: null });
    const err = await expectMoveError(fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }));
    expect(err.code).toBe('not_watched_root');
    expect(err.status).toBe(422);
    expect(fx.lark.calls).toHaveLength(0); // 结构缺失不起子进程
    const fx2 = fixture({}, { wikiNodeToken: null });
    const err2 = await expectMoveError(fx2.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }));
    expect(err2.code).toBe('not_watched_root');
  });

  it('非叶子（getNode has_child=true）→ preview blocked has_children + 执行拒', async () => {
    const fx = fixture({ nodeHasChild: true });
    const plan = await fx.service.buildMoveOutPreview(OBJ);
    expect(plan.blockedReason).toBe('has_children');
    expect(plan.hasChildren).toBe(true);
    const err = await expectMoveError(fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }));
    expect(err.code).toBe('has_children');
    expect(fx.lark.calls.filter((call) => call.op === 'move')).toHaveLength(0); // 不发起移出
  });

  it('编辑中（dirty source_edits）→ local_edit_pending 409', async () => {
    const fx = fixture();
    fx.store.createSourceEdit({
      objToken: OBJ, localRelPath: '策划/P2-S6 测试文档.md',
      baseObjEditTime: 1_774_627_200, baseBodyHash: 'b'.repeat(64), currentBodyHash: 'c'.repeat(64), lastActor: 'ui',
    } as never);
    const plan = await fx.service.buildMoveOutPreview(OBJ);
    expect(plan.blockedReason).toBe('local_edit_pending');
    const err = await expectMoveError(fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }));
    expect(err).toMatchObject({ code: 'local_edit_pending', status: 409 });
  });

  it('云端回滚进行中 → cloud_revert_running 409（互斥对称）', async () => {
    const fx = fixture();
    const pushLogId = fx.store.insertSourcePushLog({
      objToken: OBJ, localRelPath: '策划/P2-S6 测试文档.md', mode: 'revert', actor: 'ui',
    } as never);
    fx.store.updateSourcePushLog(pushLogId, { outcome: 'pushed' });
    fx.store.updateSourcePushLogRevert(pushLogId, { revertState: 'running' });
    const err = await expectMoveError(fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }));
    expect(err).toMatchObject({ code: 'cloud_revert_running', status: 409 });
  });

  it('移出进行中（pending/moving 行）→ cloud_move_running 409（新发起是新行的前提被阻断）', async () => {
    const fx = fixture();
    await startMoving(fx);
    const err = await expectMoveError(fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }));
    expect(err).toMatchObject({ code: 'cloud_move_running', status: 409 });
  });

  it('confirm 门：确认值必须含 node token；CLI 基值仅 actor=cli 通道接受', async () => {
    const fx = fixture();
    const bad = await expectMoveError(fx.service.moveToDrive(OBJ, { confirmValue: 'MOVE_OUT' }));
    expect(bad).toMatchObject({ code: 'confirmation_required', status: 400 });
    expect(bad.details).toEqual({ expected: `MOVE_OUT:${NODE}` });
    // 完整值（UI/直调）✓
    const ok = await fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) });
    expect(ok.state).toBe('moving');
    // CLI 基值 + actor=cli ✓（服务端按 documents 行权威升级）
    const fx2 = fixture();
    const cliOk = await fx2.service.moveToDrive(OBJ, { confirmValue: 'MOVE_OUT', actor: 'cli' });
    expect(cliOk.state).toBe('moving');
    // CLI 基值伪装 ui ✗
    const fx3 = fixture();
    const spoof = await expectMoveError(fx3.service.moveToDrive(OBJ, { confirmValue: 'MOVE_OUT', actor: 'ui' }));
    expect(spoof.code).toBe('confirmation_required');
  });

  it('preview DTO：consequences 固定文案 + target label（§3.4）', async () => {
    const fx = fixture();
    const plan = await fx.service.buildMoveOutPreview(OBJ, { folderToken: FOLDER });
    expect(plan.blockedReason).toBeNull();
    expect(plan.nodeToken).toBe(NODE);
    expect(plan.watchedRootLabel).toBe('策划库');
    expect(plan.target).toEqual({ folderToken: FOLDER, label: FOLDER });
    expect(plan.consequences).toEqual([
      '文档将离开知识库「策划库」',
      '知识库成员将不再通过知识库权限访问它',
      '本应用将停止同步该文档，本地文件与标准库内容保持不变',
      '本应用不提供移回',
    ]);
    const rootPlan = await fx.service.buildMoveOutPreview(OBJ);
    expect(rootPlan.target).toEqual({ folderToken: null, label: '个人空间根' });
  });

  it('节点不存在（getNode 抛错）→ node_not_found 422', async () => {
    const fx = fixture({ nodeMissing: true });
    const plan = await fx.service.buildMoveOutPreview(OBJ);
    expect(plan.blockedReason).toBe('node_not_found');
    const err = await expectMoveError(fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }));
    expect(err.code).toBe('node_not_found');
  });

  it('确认后节点身份发生变化时拒绝移出旧节点', async () => {
    const fx = fixture();
    const originalGetNode = fx.lark.getNode;
    let calls = 0;
    fx.lark.getNode = async (token: string) => {
      const node = await originalGetNode(token);
      if (++calls === 1) {
        const doc = fx.store.getDocumentByObjToken(OBJ)!;
        fx.store.upsertDocument({ ...doc, wikiNodeToken: 'replacementNode000001' });
      }
      return node;
    };
    const err = await expectMoveError(fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }));
    expect(err).toMatchObject({ code: 'source_identity_changed', status: 409 });
    expect(fx.lark.calls.filter((call) => call.op === 'move')).toEqual([]);
    expect(fx.store.listCloudMoves()).toEqual([]);
  });

  it('云端节点指向其他文档时不允许移出', async () => {
    const fx = fixture();
    fx.lark.getNode = async () => ({ obj_token: 'differentDocument', has_child: false });
    const err = await expectMoveError(fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }));
    expect(err.code).toBe('node_not_found');
    expect(fx.lark.calls.filter((call) => call.op === 'move')).toEqual([]);
  });

  it('云端未返回子节点状态时拒绝移出', async () => {
    const fx = fixture();
    fx.lark.getNode = async () => ({ obj_token: OBJ });
    const err = await expectMoveError(fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }));
    expect(err.code).toBe('node_not_found');
    expect(fx.lark.calls.filter((call) => call.op === 'move')).toEqual([]);
  });
});

// ===========================================================================
// D. 状态机迁移 + 轮询 + 重启对账
// ===========================================================================

describe('状态机与轮询', () => {
  it('真实客户端归一化的数值任务响应进入服务状态机并收敛', async () => {
    const fx = fixture();
    const client = new LarkCliClient();
    (client as any).execute = async (args: string[]) => args[1] === '+move-to-drive'
      ? { data: { status: 1, ready: false, failed: false, task_id: 'signed-full-task-id' } }
      : { data: { status: 0, ready: true, failed: false, task_id: 'signed-full-task-id' } };
    fx.lark.moveWikiNodeToDrive = client.moveWikiNodeToDrive.bind(client);
    fx.lark.getDriveTaskResult = client.getDriveTaskResult.bind(client);
    const result = await fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) });
    expect(result).toMatchObject({ state: 'moving', taskId: 'signed-full-task-id' });
    fx.clock.value += 5_000;
    await fx.service.pollOnce();
    expect(fx.store.getCloudMove(result.moveId)).toMatchObject({ state: 'moved', taskId: 'signed-full-task-id' });
  });
  it('前一轮任务查询尚未完成时不会发起重叠轮询', async () => {
    const fx = fixture();
    let release!: (value: { state: 'done'; message: null }) => void;
    const pending = new Promise<{ state: 'done'; message: null }>((resolve) => { release = resolve; });
    let calls = 0;
    fx.lark.getDriveTaskResult = async () => { calls++; return pending; };
    const id = await startMoving(fx);
    fx.clock.value += 10_000;
    const first = fx.service.pollOnce();
    await fx.service.pollOnce();
    expect(calls).toBe(1);
    release({ state: 'done', message: null });
    await first;
    expect(fx.store.getCloudMove(id)?.state).toBe('moved');
  });
  it('同步 done → moved + 审计 + 触发一次检测；本地 documents 行与文件字节不动（§3.5）', async () => {
    const fx = fixture({ moveResult: { state: 'done', taskId: TASK } });
    const beforeDoc = { ...fx.store.getDocumentByObjToken(OBJ) };
    const beforeBytes = fs.readFileSync(fx.absPath);
    const result = await fx.service.moveToDrive(OBJ, {
      folderToken: FOLDER,
      confirmValue: deriveMoveOutConfirmValue(NODE),
      actor: 'ui',
    });
    expect(result.state).toBe('moved');
    expect(fx.store.getCloudMove(result.moveId)).toMatchObject({
      state: 'moved', targetFolderToken: FOLDER, watchedRootId: ROOT_ID,
    });
    expect(fx.detects).toEqual([ROOT_ID]); // 一次变更检测（只推进观测字段的既有入口）
    expect(auditEvents(fx)).toEqual(['move_to_drive_started', 'move_to_drive_moved']);
    // 本地语义：行与文件字节不变、synced 基线不推进。
    expect(fx.store.getDocumentByObjToken(OBJ)).toEqual(beforeDoc);
    expect(fs.readFileSync(fx.absPath).equals(beforeBytes)).toBe(true);
    expect(fx.store.getDocumentByObjToken(OBJ)?.syncedObjEditTime).toBe(beforeDoc.syncedObjEditTime);
  });

  it('异步 running → moving + taskId + 轮询 done 收敛 → moved + 检测', async () => {
    const fx = fixture({ moveResult: { state: 'running', taskId: TASK, pollAfterMs: 5_000 }, taskResult: { state: 'done' } });
    const moveId = await startMoving(fx);
    expect(fx.store.getCloudMove(moveId)).toMatchObject({ state: 'moving', taskId: TASK });
    expect(fx.detects).toEqual([]); // 未完成不触发
    fx.clock.value += 5_000; // 到期
    await fx.service.pollOnce();
    expect(fx.store.getCloudMove(moveId)).toMatchObject({ state: 'moved' });
    expect(fx.detects).toEqual([ROOT_ID]);
    expect(auditEvents(fx)).toEqual(['move_to_drive_started', 'move_to_drive_moving', 'move_to_drive_moved']);
  });

  it('轮询 failed → failed + error 上抛审计；failed 可重新发起（新行）', async () => {
    const fx = fixture({ taskResult: { state: 'failed', message: 'cloud rejected' } });
    const moveId = await startMoving(fx); // pollAfterMs 缺省 10000
    fx.clock.value += 10_000; // 到期
    await fx.service.pollOnce();
    expect(fx.store.getCloudMove(moveId)).toMatchObject({ state: 'failed', error: 'cloud rejected' });
    expect(fx.detects).toEqual([]);
    // failed 可重新发起（新行）——互斥门已放行（getActiveCloudMove 无行）
    const retry = await fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) });
    expect(fx.store.getCloudMove(retry.moveId)!.id).not.toBe(moveId);
  });

  it('轮询超 10 分钟 → unknown（poll_deadline_exceeded）；状态查询失败先续查不判终态', async () => {
    const fx = fixture({ taskResult: { state: 'running' } });
    const moveId = await startMoving(fx);
    // 第 1 轮：running → 续查
    fx.clock.value += 5_000;
    await fx.service.pollOnce();
    expect(fx.store.getCloudMove(moveId)?.state).toBe('moving');
    // 第 2 轮起：查询失败（只读调用失败不判终态）
    const fx2calls = fx.lark;
    fx2calls.getDriveTaskResult = async () => { throw new Error('poll io error'); };
    fx.clock.value += 5_000;
    await fx.service.pollOnce();
    expect(fx.store.getCloudMove(moveId)?.state).toBe('moving');
    // 越过 10 分钟总上限 → unknown
    fx.clock.value += 600_000;
    await fx.service.pollOnce();
    expect(fx.store.getCloudMove(moveId)).toMatchObject({ state: 'unknown', error: 'poll_deadline_exceeded' });
    expect(auditEvents(fx)).toContain('move_to_drive_unknown');
  });

  it('业务错误 → failed + 502；子进程超时 → unknown（绝不重试）', async () => {
    const fxBiz = fixture({ moveError: new LarkCliError('no permission', 'upstream', false, '99991672') });
    const biz = await expectMoveError(fxBiz.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }));
    expect(biz).toMatchObject({ code: 'cloud_move_failed', status: 502 });
    expect(biz.details).toMatchObject({ moveId: expect.stringMatching(/^mv_/) });
    const failedRow = fxBiz.store.getCloudMove(biz.details!.moveId as string);
    expect(failedRow).toMatchObject({ state: 'failed', error: '99991672' });
    expect(fxBiz.lark.calls.filter((call) => call.op === 'move')).toHaveLength(1); // 单次，不重试

    const fxTimeout = fixture({ moveError: new LarkCliError('lark-cli 执行超时', 'timeout', true) });
    const unknown = await expectMoveError(fxTimeout.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }));
    expect(unknown).toMatchObject({ code: 'cloud_move_outcome_unknown', status: 502 });
    expect(fxTimeout.store.getCloudMove(unknown.details!.moveId as string)?.state).toBe('unknown');
  });

  it('重启对账三情形：pending→unknown；moving+task_id 续查；moving 无 task_id→unknown', async () => {
    const fx = fixture();
    // ② moving + task_id（轮询器续查后收敛 done；makeLarkStub 的闭包配置
    // 不可事后改，用方法替换注入收敛结果）
    const movingId = await startMoving(fx);
    // ① pending 残留（startMoving 之后插：pending/moving 同 objToken 互斥门
    // 会让先插的 pending 行阻断服务发起）
    const pendingId = fx.store.insertCloudMove({
      objToken: OBJ, wikiNodeToken: NODE, watchedRootId: ROOT_ID, actor: 'ui',
    });
    fx.service.stopPoller();
    (fx.service as any).tracked.clear(); // 模拟进程重启（内存态丢失）
    fx.lark.getDriveTaskResult = async () => ({ state: 'done', message: null, raw: {} });
    // ③ moving 无 task_id
    const orphanId = fx.store.insertCloudMove({
      objToken: 'doxcnOther', wikiNodeToken: 'wikinOther', watchedRootId: ROOT_ID, actor: 'ui',
    });
    fx.store.updateCloudMove(orphanId, { state: 'moving' }); // 无 task_id

    const reconcile = fx.service.resumeRunningMoves();
    expect(reconcile).toEqual({ resumed: 1, markedUnknown: 2 });
    expect(fx.store.getCloudMove(pendingId)).toMatchObject({ state: 'unknown', error: 'pending_unresolved_after_restart' });
    expect(fx.store.getCloudMove(orphanId)).toMatchObject({ state: 'unknown', error: 'task_id_missing_after_restart' });
    // 续查行收敛（resume 间隔 5s）
    fx.clock.value += 5_000;
    await fx.service.pollOnce();
    expect(fx.store.getCloudMove(movingId)?.state).toBe('moved');
  });
});

// ===========================================================================
// E. 互斥门消费方（编辑 / 写回 / 回滚）
// ===========================================================================

describe('互斥门消费方（cloud_move_running / source_moved_out）', () => {
  function editService(fx: Fixture): SourceEditService {
    return new SourceEditService({
      config: { getConfig: () => ({ knowledgeBaseRoot: path.join(fx.dataRoot, 'kb') }), load: async () => ({ knowledgeBaseRoot: path.join(fx.dataRoot, 'kb') }) },
      store: fx.store,
      kbBuild: { isActive: () => false },
      dataRoot: fx.dataRoot,
    });
  }

  it('移出进行中：编辑 / 放弃修改 / 写回 / 回滚全部拒绝 cloud_move_running', async () => {
    const fx = fixture();
    // 手工落 moving 行（不经服务发起：dirty 行与 moving 行并存才能逐一测
    // 消费方门——服务发起会被 local_edit_pending 先拒）。
    const moveId = fx.store.insertCloudMove({
      objToken: OBJ, wikiNodeToken: NODE, watchedRootId: ROOT_ID, actor: 'ui',
    });
    fx.store.updateCloudMove(moveId, { state: 'moving', taskId: TASK });
    // dirty 行（revert 的 404 前置门需要已有编辑行）
    fs.mkdirSync(path.join(fx.dataRoot, 'source-edits', OBJ), { recursive: true });
    fs.writeFileSync(path.join(fx.dataRoot, 'source-edits', OBJ, 'base.md'), '# 基线\n');
    fx.store.createSourceEdit({
      objToken: OBJ, localRelPath: '策划/P2-S6 测试文档.md',
      baseObjEditTime: 1_774_627_200, baseBodyHash: 'b'.repeat(64), currentBodyHash: 'c'.repeat(64), lastActor: 'ui',
    } as never);
    const edit = editService(fx);
    await expect(edit.edit(OBJ, { mode: 'replace_body', body: 'x' }, { baseHash: 'a'.repeat(64), actor: 'ui' }))
      .rejects.toMatchObject({ code: 'cloud_move_running' });
    await expect(edit.revert(OBJ, 'ui')).rejects.toMatchObject({ code: 'cloud_move_running' });

    const write = new FeishuWriteService({
      config: { getConfig: () => ({ feishuWrite: { enabled: true } }) },
      store: fx.store,
      larkCliClient: fx.lark,
      kbBuild: { isActive: () => false },
      dataRoot: fx.dataRoot,
    });
    await expect(write.push(OBJ, { appendMarkdown: 'x', allowOverwrite: false, confirmValue: 'PUSH', actor: 'ui' } as never))
      .rejects.toMatchObject({ code: 'cloud_move_running' });

    const history = new CloudHistoryService({
      config: { getConfig: () => ({ feishuWrite: { enabled: true } }) },
      store: fx.store,
      larkCliClient: fx.lark,
      kbBuild: { isActive: () => false },
      dataRoot: fx.dataRoot,
      pullSync: async () => ({ ok: true, status: 'synced' }),
    });
    // 本用例 dirty 行与 moving 行并存：回滚门先命中 local_edit_pending
    //（CloudHistoryService 门序：写权限 → 构建 → 脏编辑 → 回滚互斥 → 移出互斥）。
    const plan = await history.buildRevertPlan(OBJ, { historyVersionId: '2048' });
    expect(plan.blockedReason).toBe('local_edit_pending');
    // 无脏编辑时移出互斥独立可见：独立 fixture 只落 moving 行。
    const fxMoveOnly = fixture();
    const onlyId = fxMoveOnly.store.insertCloudMove({
      objToken: OBJ, wikiNodeToken: NODE, watchedRootId: ROOT_ID, actor: 'ui',
    });
    fxMoveOnly.store.updateCloudMove(onlyId, { state: 'moving', taskId: TASK });
    const history2 = new CloudHistoryService({
      config: { getConfig: () => ({ feishuWrite: { enabled: true } }) },
      store: fxMoveOnly.store,
      larkCliClient: fxMoveOnly.lark,
      kbBuild: { isActive: () => false },
      dataRoot: fxMoveOnly.dataRoot,
      pullSync: async () => ({ ok: true, status: 'synced' }),
    });
    const plan2 = await history2.buildRevertPlan(OBJ, { historyVersionId: '2048' });
    expect(plan2.blockedReason).toBe('cloud_move_running');
  });

  it('移出完成（moved）：编辑与写回拒绝 source_moved_out（§3.5）', async () => {
    const fx = fixture({ moveResult: { state: 'done', taskId: TASK } });
    await fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) });
    const edit = editService(fx);
    await expect(edit.edit(OBJ, { mode: 'replace_body', body: 'x' }, { baseHash: 'a'.repeat(64), actor: 'ui' }))
      .rejects.toMatchObject({ code: 'source_moved_out' });
    const write = new FeishuWriteService({
      config: { getConfig: () => ({ feishuWrite: { enabled: true } }) },
      store: fx.store,
      larkCliClient: fx.lark,
      kbBuild: { isActive: () => false },
      dataRoot: fx.dataRoot,
    });
    await expect(write.push(OBJ, { appendMarkdown: 'x', allowOverwrite: false, confirmValue: 'PUSH', actor: 'ui' } as never))
      .rejects.toMatchObject({ code: 'source_moved_out' });
  });
});

// ===========================================================================
// F. 已移除的操作入口与历史记录查询
// ===========================================================================

function makeApp(fx: Fixture): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).localMapStore = fx.store;
    (c as any).larkCliClient = fx.lark;
    (c as any).configManager = { getConfig: () => ({}), load: async () => ({}) };
    (c as any).kbBuildService = { activeBuild: () => null };
    (c as any).cloudMoveService = fx.service;
    await next();
  });
  app.route('/', feishuRoutes);
  return app;
}

describe('routes/feishu — 已移除的移出操作和历史查询', () => {
  it.each([
    { suffix: '/preview', body: {} },
    { suffix: '', body: {} },
    { suffix: '', body: { confirm: deriveMoveOutConfirmValue(NODE), actor: 'ui' } },
  ])('移出操作 $suffix 始终返回 410，且不触及云端或本地记录', async ({ suffix, body }) => {
    const fx = fixture();
    const res = await makeApp(fx).request(`/api/sources/${OBJ}/move-to-drive${suffix}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: 'feature_removed' });
    expect(fx.lark.calls).toHaveLength(0);
    expect(fx.store.listCloudMoves(OBJ, 10)).toHaveLength(0);
  });

  it('GET moves/:moveId → 行 / 404；GET moves 列表与 objToken 过滤', async () => {
    const fx = fixture();
    const app = makeApp(fx);
    const moveId = await startMoving(fx);
    const row = await app.request(`/api/sources/moves/${moveId}`);
    expect(row.status).toBe(200);
    expect(await row.json()).toMatchObject({ id: moveId, state: 'moving' });
    const missing = await app.request('/api/sources/moves/mv_nope');
    expect(missing.status).toBe(404);

    const listAll = await app.request('/api/sources/moves');
    expect(await listAll.json()).toMatchObject({ moves: [expect.objectContaining({ id: moveId })] });
    const filtered = await app.request(`/api/sources/moves?objToken=${OBJ}`);
    expect((await filtered.json()).moves).toHaveLength(1);
    const empty = await app.request('/api/sources/moves?objToken=doxcnNothing');
    expect((await empty.json()).moves).toHaveLength(0);
  });
});

describe('命令表：移出操作已删除，历史查询保留', () => {
  it('移出命令不在注册表和命令列表中', () => {
    expect(findOpsCommand('cloud.move_to_drive')).toBeUndefined();
    expect(opsCommandMetadata().some((command) => command.name === 'cloud.move_to_drive')).toBe(false);
  });

  it('历史状态与列表仍是只读命令', () => {
    const status = findOpsCommand('cloud.move_status')!;
    expect(status).toMatchObject({ risk: 'read', agentExposed: false });
    expect(status.request!({ moveId: 'mv_1' })[0]).toMatchObject({
      method: 'GET', path: '/api/sources/moves/mv_1',
    });
    const list = findOpsCommand('cloud.moves')!;
    expect(list).toMatchObject({ risk: 'read', agentExposed: false });
    expect(list.request!({ objToken: OBJ, limit: 5 })[0]).toEqual({
      method: 'GET', path: '/api/sources/moves', query: { objToken: OBJ, limit: '5' },
    });
    expect(list.request!({})[0]).toEqual({ method: 'GET', path: '/api/sources/moves', query: {} });
  });

  it('历史查询也不对 app_command 暴露', () => {
    for (const name of ['cloud.move_status', 'cloud.moves']) {
      expect(findOpsCommand(name)?.agentExposed).toBe(false);
    }
  });
});

describe('CLI 域：移出命令已删除', () => {
  function makeCliApp(fx: Fixture): { cliApp: Hono; token: string } {
    const endpoint = new CliEndpoint(fx.dataRoot, { enabledProvider: () => true });
    endpoint.publish('http://127.0.0.1:9');
    const token = (JSON.parse(
      fs.readFileSync(path.join(fx.dataRoot, 'run', 'endpoint.json'), 'utf-8'),
    ) as { cliToken: string }).cliToken;
    const bizApp = makeApp(fx);
    const cliApp = new Hono();
    cliApp.route('/', cliRoutes({
      cliEndpoint: endpoint,
      desktopToken: 'desktop-token-test',
      configManager: { getConfig: () => ({ cli: { enabled: true } }) } as never,
      getApp: () => bizApp,
      dataRoot: fx.dataRoot,
    }));
    return { cliApp, token };
  }

  function cliRequest(cliApp: Hono, token: string, body: unknown): Promise<Response> {
    return cliApp.request('/api/cli/cloud.move_to_drive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: '127.0.0.1', 'X-Cli-Token': token },
      body: JSON.stringify(body),
    });
  }

  it.each([
    { args: { objToken: OBJ } },
    { args: { objToken: OBJ }, confirm: 'MOVE_OUT' },
  ])('即使提供确认，CLI 移出命令仍不可执行：%j', async (body) => {
    const fx = fixture();
    const { cliApp, token } = makeCliApp(fx);
    const res = await cliRequest(cliApp, token, body);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('unknown_command');
    expect(fx.lark.calls).toHaveLength(0);
    expect(fx.store.listCloudMoves(OBJ, 10)).toHaveLength(0);
  });

  it('CLI 令牌缺失 → 401（不进入命令执行）', async () => {
    const fx = fixture();
    const { cliApp } = makeCliApp(fx);
    const res = await cliApp.request('/api/cli/cloud.move_to_drive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: '127.0.0.1' },
      body: JSON.stringify({ args: { objToken: OBJ }, confirm: 'MOVE_OUT' }),
    });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// G. T4b 修复批 B（审核 T4b-diting-final-review）：05 unknown 围栏 /
//    06 写后未知 / 10 关键状态持久化 fail-closed
// ===========================================================================

describe('T4b-05 unknown 移出持续围栏 + 权威核对解除', () => {
  it('unknown（timeout 反例）：二次移出拒 409（单次 fulfilled），围栏行可见', async () => {
    const fx = fixture({ moveError: new LarkCliError('timeout', 'timeout', false) });
    const err = await expectMoveError(
      fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }),
    );
    expect(err).toMatchObject({ code: 'cloud_move_outcome_unknown', status: 502 });
    expect(fx.store.getLatestCloudMove(OBJ)?.state).toBe('unknown');
    // T4b-05 核心：unknown 仍命中互斥门（不因 active=null 释放）。
    expect(fx.store.getActiveCloudMove(OBJ)?.state).toBe('unknown');
    // 二次移出被拒（审核反例：原实现会再次发起 move）。
    const second = await expectMoveError(
      fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }),
    );
    expect(second).toMatchObject({ code: 'cloud_move_running', status: 409 });
    expect(fx.lark.calls.filter((call) => call.op === 'move')).toHaveLength(1);
    // preview 同判定（批准前暴露）。
    const preview = await fx.service.buildMoveOutPreview(OBJ);
    expect(preview.blockedReason).toBe('cloud_move_running');
  });

  it('unknown 期间三消费方 409：编辑 / 放弃修改 / 写回 / 回滚预览与执行全部拒绝', async () => {
    const fx = fixture();
    // 手工落 unknown 行（权威核对前围栏态）。
    const moveId = fx.store.insertCloudMove({
      objToken: OBJ, wikiNodeToken: NODE, watchedRootId: ROOT_ID, actor: 'ui',
    });
    fx.store.updateCloudMove(moveId, { state: 'unknown', error: 'poll_deadline_exceeded' });
    expect(fx.store.getActiveCloudMove(OBJ)?.state).toBe('unknown');

    const edit = new SourceEditService({
      config: { getConfig: () => ({ knowledgeBaseRoot: path.join(fx.dataRoot, 'kb') }), load: async () => ({ knowledgeBaseRoot: path.join(fx.dataRoot, 'kb') }) },
      store: fx.store,
      kbBuild: { isActive: () => false },
      dataRoot: fx.dataRoot,
    });
    // dirty 行（放弃修改 revert 的 404 前置门需要已有编辑行，与既有消费方
    // 用例同法）。
    fs.mkdirSync(path.join(fx.dataRoot, 'source-edits', OBJ), { recursive: true });
    fs.writeFileSync(path.join(fx.dataRoot, 'source-edits', OBJ, 'base.md'), '# 基线\n');
    fx.store.createSourceEdit({
      objToken: OBJ, localRelPath: '策划/P2-S6 测试文档.md',
      baseObjEditTime: 1_774_627_200, baseBodyHash: 'b'.repeat(64), currentBodyHash: 'c'.repeat(64), lastActor: 'ui',
    } as never);
    await expect(edit.edit(OBJ, { mode: 'replace_body', body: 'x' }, { baseHash: 'a'.repeat(64), actor: 'ui' } as never))
      .rejects.toMatchObject({ code: 'cloud_move_running' });
    // 放弃修改同样被移出门拒。
    await expect(edit.revert(OBJ, 'ui')).rejects.toMatchObject({ code: 'cloud_move_running' });

    const write = new FeishuWriteService({
      config: { getConfig: () => ({ feishuWrite: { enabled: true } }) },
      store: fx.store,
      larkCliClient: fx.lark,
      kbBuild: { isActive: () => false },
      dataRoot: fx.dataRoot,
    });
    await expect(write.push(OBJ, { appendMarkdown: 'x', allowOverwrite: false, confirmValue: 'PUSH', actor: 'ui' } as never))
      .rejects.toMatchObject({ code: 'cloud_move_running' });

    const history = new CloudHistoryService({
      config: { getConfig: () => ({ feishuWrite: { enabled: true } }) },
      store: fx.store,
      larkCliClient: fx.lark,
      kbBuild: { isActive: () => false },
      dataRoot: fx.dataRoot,
      pullSync: async () => ({ ok: true, status: 'synced' }),
    });
    // 本用例 dirty 行与 unknown 行并存：回滚门先命中 local_edit_pending
    //（CloudHistoryService 门序：脏编辑 → 回滚互斥 → 移出互斥）。
    const plan = await history.buildRevertPlan(OBJ, { historyVersionId: '2048' });
    expect(plan.blockedReason).toBe('local_edit_pending');
    // 无脏编辑时移出围栏独立可见：独立 fixture 只落 unknown 行（预览与执行同判）。
    const fxMoveOnly = fixture();
    const onlyId = fxMoveOnly.store.insertCloudMove({
      objToken: OBJ, wikiNodeToken: NODE, watchedRootId: ROOT_ID, actor: 'ui',
    });
    fxMoveOnly.store.updateCloudMove(onlyId, { state: 'unknown', error: 'x' });
    const history2 = new CloudHistoryService({
      config: { getConfig: () => ({ feishuWrite: { enabled: true } }) },
      store: fxMoveOnly.store,
      larkCliClient: fxMoveOnly.lark,
      kbBuild: { isActive: () => false },
      dataRoot: fxMoveOnly.dataRoot,
      pullSync: async () => ({ ok: true, status: 'synced' }),
    });
    const plan2 = await history2.buildRevertPlan(OBJ, { historyVersionId: '2048' });
    expect(plan2.blockedReason).toBe('cloud_move_running');
    await expect(
      history2.revertToAnchor(OBJ, { historyVersionId: '2048' }, { confirmValue: 'REVERT_CLOUD:2048' }),
    ).rejects.toMatchObject({ code: 'cloud_move_running', status: 409 });
  });

  it('权威核对（taskId）：任务 done → moved；failed → failed 释放围栏；running/查询失败 → 保持 unknown', async () => {
    // done → moved：转 source_moved_out 语义。
    const fxDone = fixture({ moveResult: { state: 'running', taskId: TASK, pollAfterMs: 5_000 }, taskResult: { state: 'done' } });
    const moveIdDone = await startMoving(fxDone);
    fxDone.store.updateCloudMove(moveIdDone, { state: 'unknown', error: 'poll_deadline_exceeded' });
    const reconciledDone = await fxDone.service.reconcileUnknownMove(moveIdDone);
    expect(reconciledDone).toMatchObject({ state: 'moved', taskId: TASK, reason: null });
    expect(fxDone.store.getCloudMove(moveIdDone)?.state).toBe('moved');
    expect(fxDone.detects).toEqual([ROOT_ID]); // 与 finalizeMoved 同收尾：触发一次检测
    expect(fxDone.store.getActiveCloudMove(OBJ)).toBeNull(); // moved 不在 active 集（转 latest moved 门）

    // failed → 释放围栏（可重新编辑/移出）。
    const fxFailed = fixture({ taskResult: { state: 'failed', message: 'cloud rejected' } });
    const moveIdFailed = await startMoving(fxFailed);
    fxFailed.store.updateCloudMove(moveIdFailed, { state: 'unknown', error: 'poll_deadline_exceeded' });
    const reconciled = await fxFailed.service.reconcileUnknownMove(moveIdFailed);
    expect(reconciled).toMatchObject({ state: 'failed', reason: null });
    expect(fxFailed.store.getCloudMove(moveIdFailed)).toMatchObject({ state: 'failed', error: 'cloud rejected' });
    expect(fxFailed.store.getActiveCloudMove(OBJ)).toBeNull();
    // 围栏解除后可重新发起移出（新行）。
    const retry = await fxFailed.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) });
    expect(retry.state).toBe('moving');

    // running → 无法证明，围栏保持。
    const fxRunning = fixture({ taskResult: { state: 'running' } });
    const moveIdRunning = await startMoving(fxRunning);
    fxRunning.store.updateCloudMove(moveIdRunning, { state: 'unknown', error: 'poll_deadline_exceeded' });
    const kept = await fxRunning.service.reconcileUnknownMove(moveIdRunning);
    expect(kept).toMatchObject({ state: 'unknown', reason: 'task_still_running' });
    expect(await fxRunning.service.reconcileUnknownMove(moveIdRunning, `MOVE_SETTLED_NOT_MOVED:${moveIdRunning}`)).toMatchObject({ state: 'unknown', reason: 'task_still_running' });
    expect(fxRunning.store.getCloudMove(moveIdRunning)?.state).toBe('unknown');
    expect(fxRunning.store.getActiveCloudMove(OBJ)?.state).toBe('unknown');

    // 任务查询失败 → 无法证明，围栏保持。
    const fxQueryErr = fixture({ taskError: new Error('poll io error') });
    const moveIdQueryErr = await startMoving(fxQueryErr);
    fxQueryErr.store.updateCloudMove(moveIdQueryErr, { state: 'unknown', error: 'x' });
    const unreadable = await fxQueryErr.service.reconcileUnknownMove(moveIdQueryErr);
    expect(unreadable).toMatchObject({ state: 'unknown', reason: 'task_result_unreadable' });
  });

  it('无 taskId 时必须人工确认任务已结束，并验证节点；非 unknown 行拒 409', async () => {
    const fxStill = fixture();
    const moveId = fxStill.store.insertCloudMove({
      objToken: OBJ, wikiNodeToken: NODE, watchedRootId: ROOT_ID, actor: 'ui',
    });
    fxStill.store.updateCloudMove(moveId, { state: 'unknown', error: 'pending_unresolved_after_restart' });
    expect(await fxStill.service.reconcileUnknownMove(moveId)).toMatchObject({ state: 'unknown', reason: 'task_id_missing' });
    expect(fxStill.store.getActiveCloudMove(OBJ)?.state).toBe('unknown');
    const reconciled = await fxStill.service.reconcileUnknownMove(moveId, `MOVE_SETTLED_NOT_MOVED:${moveId}`);
    expect(reconciled).toMatchObject({ state: 'failed', reason: null });
    expect(fxStill.store.getCloudMove(moveId)).toMatchObject({
      state: 'failed', error: 'manual_confirmed_not_moved',
    });
    expect(fxStill.store.getActiveCloudMove(OBJ)).toBeNull(); // 围栏解除
    expect(fxStill.lark.calls.map((call) => call.op)).toEqual(['getNode']);

    // 节点查不到（可能已移出/已删除，无法区分）→ 围栏保持。
    const fxMissing = fixture({ nodeMissing: true });
    const moveIdMissing = fxMissing.store.insertCloudMove({
      objToken: OBJ, wikiNodeToken: NODE, watchedRootId: ROOT_ID, actor: 'ui',
    });
    fxMissing.store.updateCloudMove(moveIdMissing, { state: 'unknown', error: 'x' });
    const kept = await fxMissing.service.reconcileUnknownMove(moveIdMissing, `MOVE_SETTLED_NOT_MOVED:${moveIdMissing}`);
    expect(kept).toMatchObject({ state: 'unknown', reason: 'node_lookup_inconclusive' });
    expect(fxMissing.store.getActiveCloudMove(OBJ)?.state).toBe('unknown');
    const moved = await fxMissing.service.reconcileUnknownMove(moveIdMissing, `MOVE_SETTLED_MOVED:${moveIdMissing}`);
    expect(moved).toMatchObject({ state: 'moved', reason: null });
    expect(fxMissing.store.getLatestCloudMove(OBJ)?.state).toBe('moved');

    // 非 unknown 行拒绝核对（409）；不存在 404。
    const fxDone = fixture({ moveResult: { state: 'done', taskId: TASK } });
    const done = await fxDone.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) });
    await expect(fxDone.service.reconcileUnknownMove(done.moveId)).rejects.toMatchObject({
      code: 'cloud_move_not_unknown', status: 409,
    });
    await expect(fxDone.service.reconcileUnknownMove('mv_nonexistent')).rejects.toMatchObject({
      code: 'cloud_move_not_found', status: 404,
    });
  });

  it('并发核对只能有一次终态落盘', async () => {
    const fx = fixture({ taskResult: { state: 'done' } });
    const id = await startMoving(fx);
    fx.store.updateCloudMove(id, { state: 'unknown' });
    const results = await Promise.allSettled([fx.service.reconcileUnknownMove(id), fx.service.reconcileUnknownMove(id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(fx.store.getCloudMove(id)?.state).toBe('moved');
  });

  it('路由 POST /api/sources/moves/:moveId/reconcile：解除 → 200；无法证明 → 202 保持 unknown', async () => {
    const fx = fixture({ taskResult: { state: 'failed', message: 'cloud rejected' } });
    const moveId = await startMoving(fx);
    fx.store.updateCloudMove(moveId, { state: 'unknown', error: 'x' });
    const ok = await makeApp(fx).request(`/api/sources/moves/${moveId}/reconcile`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ moveId, state: 'failed' });

    const fxRunning = fixture({ taskResult: { state: 'running' } });
    const moveIdRunning = await startMoving(fxRunning);
    fxRunning.store.updateCloudMove(moveIdRunning, { state: 'unknown', error: 'x' });
    const pending = await makeApp(fxRunning).request(`/api/sources/moves/${moveIdRunning}/reconcile`, { method: 'POST' });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ state: 'unknown', reason: 'task_still_running' });

    const fxManual = fixture();
    const manualId = fxManual.store.insertCloudMove({ objToken: OBJ, wikiNodeToken: NODE, watchedRootId: ROOT_ID, actor: 'ui' });
    fxManual.store.updateCloudMove(manualId, { state: 'unknown' });
    const app = makeApp(fxManual);
    const first = await app.request(`/api/sources/moves/${manualId}/reconcile`, { method: 'POST' });
    expect(first.status).toBe(202);
    const confirmed = await app.request(`/api/sources/moves/${manualId}/reconcile`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: `MOVE_SETTLED_NOT_MOVED:${manualId}` }),
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ state: 'failed' });
  });
});

describe('T4b-06 / T4b-10 — 写后未知与关键状态持久化', () => {
  it('T4b-06 move 命令发出后输出不可解析（parse）→ unknown（非 failed；不重发）', async () => {
    const fx = fixture({ moveError: new LarkCliError('bad json', 'parse', false) });
    const err = await expectMoveError(
      fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }),
    );
    expect(err).toMatchObject({ code: 'cloud_move_outcome_unknown', status: 502 });
    expect(fx.store.getLatestCloudMove(OBJ)).toMatchObject({ state: 'unknown' });
    // unknown 持续围栏：普通重发被拒（不得以「明确失败可重试」冒充）。
    const second = await expectMoveError(
      fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }),
    );
    expect(second).toMatchObject({ code: 'cloud_move_running', status: 409 });
    expect(fx.lark.calls.filter((call) => call.op === 'move')).toHaveLength(1);
  });

  it('T4b-06 权威业务拒绝（permission）仍 → failed（与未知信号区分，failed 可重新发起）', async () => {
    const fx = fixture({ moveError: new LarkCliError('permission denied', 'permission', false) });
    await expectMoveError(fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }));
    expect(fx.store.getLatestCloudMove(OBJ)?.state).toBe('failed');
    expect(fx.store.getActiveCloudMove(OBJ)).toBeNull();
    // 权威拒绝后环境恢复（stub 换为正常受理）：failed 可重新发起（新行）。
    fx.lark.moveWikiNodeToDrive = async (nodeToken: string, o?: { folderToken?: string | null }) => {
      fx.lark.calls.push({ op: 'move', args: [nodeToken, o?.folderToken ?? null] });
      return { state: 'running', taskId: TASK, pollAfterMs: 10_000, raw: {} };
    };
    const retry = await fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) });
    expect(retry.state).toBe('moving');
  });

  it('T4b-10 moving/taskId 持久化注入异常：行保持 pending 围栏不丢，二次移出拒；persistWarning 显式上报；恢复后轮询收敛 moved', async () => {
    const fx = fixture({
      moveResult: { state: 'running', taskId: TASK, pollAfterMs: 5_000 },
      taskResult: { state: 'done' },
    });
    const original = fx.store.updateCloudMove.bind(fx.store);
    let injected = true;
    (fx.store as any).updateCloudMove = ((id: string, patch: Record<string, unknown>) => {
      if (injected) throw new Error('INJECTED transient SQLite write failure');
      return original(id, patch as never);
    }) as never;
    const result = await fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) });
    // 命令已受理：结果仍是 moving（202 语义），但持久化降级显式上报。
    expect(result.state).toBe('moving');
    expect(result.persistWarning).toBeTruthy();
    expect(result.persistWarning).toContain('task_id 落盘失败');
    // 行保持 pending（起步围栏行）——不丢围栏。
    expect(fx.store.getCloudMove(result.moveId)).toMatchObject({ state: 'pending', taskId: null });
    expect(fx.store.getActiveCloudMove(OBJ)).not.toBeNull();
    // 二次移出在围栏内被拒。
    const second = await expectMoveError(
      fx.service.moveToDrive(OBJ, { confirmValue: deriveMoveOutConfirmValue(NODE) }),
    );
    expect(second).toMatchObject({ code: 'cloud_move_running', status: 409 });
    // DB 写恢复后：进程内轮询收敛（pending→moved 直迁）+ 检测触发。
    injected = false;
    fx.clock.value += 5_000;
    await fx.service.pollOnce();
    expect(fx.store.getCloudMove(result.moveId)).toMatchObject({ state: 'moved', taskId: TASK });
    expect(fx.detects).toEqual([ROOT_ID]);
    expect(fx.store.getActiveCloudMove(OBJ)).toBeNull();
  });

  it('T4b-10 轮询终态落盘失败：tracked 保留重试，恢复后收敛（不静默丢行）', async () => {
    const fx = fixture({ taskResult: { state: 'done' } });
    const moveId = await startMoving(fx); // pollAfterMs 缺省 10s
    const original = fx.store.updateCloudMove.bind(fx.store);
    let injected = true;
    (fx.store as any).updateCloudMove = ((id: string, patch: Record<string, unknown>) => {
      if (injected && (patch as { state?: string }).state === 'moved') {
        throw new Error('INJECTED');
      }
      return original(id, patch as never);
    }) as never;
    fx.clock.value += 10_000;
    await fx.service.pollOnce();
    // 第一次 finalize 落盘失败：行保持 moving（围栏），未触发检测。
    expect(fx.store.getCloudMove(moveId)?.state).toBe('moving');
    expect(fx.detects).toEqual([]);
    // 写恢复后下轮收敛。
    injected = false;
    fx.clock.value += 10_000;
    await fx.service.pollOnce();
    expect(fx.store.getCloudMove(moveId)?.state).toBe('moved');
    expect(fx.detects).toEqual([ROOT_ID]);
  });
});
