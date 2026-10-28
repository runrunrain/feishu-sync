/**
 * SourceTitleService 测试（P0-S9，lark-cli-newcaps-P0 §6）
 *
 * 覆盖任务书验收行：
 *  - 改名成功（wiki/drive type 派生 + 审计 + 锁外回拉；本地零写入）
 *  - 回滚互斥 409（cloud_revert_running 同源消费 S4 门）
 *  - 981003 分类透传（type_mismatch，不自动换 type 重试）/ 981004 →
 *    no_edit_permission
 *  - buildRenamePlan 门控矩阵（not_found/title_invalid/write_disabled/
 *    scope_missing/kb_build_active/local_edit_pending/unsupported_type/
 *    title_unchanged）
 *  - title_change_not_pushed 警告触发与消除（title 回拉一致路径）+
 *    基线本就分叉不警告（§6.1 判定边界）
 *  - routes/feishu title 端点（preview/execute；confirm 语义）
 *  - 命令表登记（cloud.rename_title）+ confirmPlan 派生/planKey + CLI 位置参数
 *  - app_command cloud.rename_title 批准流端到端（remote_write 逐次批准）
 */

import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { LarkCliError } from '../src/modules/lark-cli-client.js';
import { SourceEditService } from '../src/sources/source-edit-service.js';
import {
  FeishuWriteService,
  TITLE_CHANGE_NOT_PUSHED_CODE,
  computeTitleChangeNotPushed,
  firstH1Title,
} from '../src/sources/feishu-write-service.js';
import {
  SourceTitleService,
  SourceTitleError,
  RENAME_CONFIRM_VALUE,
  TITLE_MAX_BYTES,
  isInvalidRenameTitle,
} from '../src/sources/source-title-service.js';
import { feishuRoutes } from '../src/routes/feishu.js';
import { createOpsToolFamily } from '../src/agent/tools/app-command-family.js';
import { ApprovalService } from '../src/agent/approvals/approval-service.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { findOpsCommand, OpsArgumentError } from '../src/ops/command-table.js';
import { buildCommandArgs } from '../src/cli/args.js';
import type { SourcePushLogRecord } from '../src/types/index.js';

const OBJ = 'doxcnS9Title001';
const WIKI = 'wikinS9Title01';
const BASE_EDIT_TIME = 1759000000;
const DOC_TITLE = '旧标题';

function yamlHeader(objToken = OBJ): string {
  return [
    '<!--',
    'feishu_sync:',
    `  obj_token: "${objToken}"`,
    `  wiki_node_token: "${WIKI}"`,
    '  space_id: "spaceS9Title"',
    '  obj_type: "docx"',
    `  original_link: "https://x.feishu.cn/wiki/${WIKI}"`,
    '  fetch_date: "2026-10-27T00:00:00.000Z"',
    '  last_synced_modify_time: "2026-10-27T00:00:00.000Z"',
    '-->',
    '',
    '',
  ].join('\n');
}

const BASE_BODY = `# ${DOC_TITLE}\n\n正文基线 ALPHA。\n`;

interface LarkStub {
  calls: Array<{ op: string; args: unknown[] }>;
  [key: string]: unknown;
}

function makeLarkStub(opts: {
  titleError?: unknown;
  scopes?: string[];
} = {}): LarkStub {
  const calls: LarkStub['calls'] = [];
  return {
    calls,
    checkAuthReady: async () => ({
      ready: true,
      verified: true,
      identity: 'user',
      currentScopes: opts.scopes ?? ['docx:document:write_only'],
      missingScopes: [],
    }),
    getDocumentMetas: async (reqs: Array<{ docToken: string; docType: string }>) => ({
      metas: reqs.map((r) => ({ docToken: r.docToken, docType: r.docType, latestModifyTime: BASE_EDIT_TIME, title: '' })),
      failed: [],
    }),
    fetchDocumentRevision: async () => ({ revisionId: 12 }),
    fetchDocumentMarkdown: async () => ({ data: { document: { content: '' } } }),
    listDocumentHistory: async () => ({
      entries: [{
        historyVersionId: '3072',
        revisionId: 3,
        editTime: '2026-10-28T02:00:00Z',
        editorIds: ['ou-editor'],
        type: 2,
        raw: {},
      }],
      hasMore: false,
      nextPageToken: null,
    }),
    updateDocumentTitle: async (token: string, title: string, o?: { type?: string }) => {
      calls.push({ op: 'updateTitle', args: [token, title, o?.type ?? 'docx'] });
      if (opts.titleError) throw opts.titleError;
      return { fileToken: token, title, type: o?.type ?? 'docx', updated: true, url: `https://x.feishu.cn/wiki/${token}`, raw: {} };
    },
  };
}

interface Fixture {
  kbRoot: string;
  dataRoot: string;
  store: LocalMapStore;
  lark: LarkStub;
  editService: SourceEditService;
  titleService: SourceTitleService;
  writeService: FeishuWriteService;
  pulls: string[];
  kbActive: { value: boolean };
  absPath: string;
  cleanup: () => void;
}

function makeFixture(opts: {
  wikiNodeToken?: string | null;
  objType?: string;
  docTitle?: string;
  baseBody?: string;
  feishuWriteEnabled?: boolean;
  larkOpts?: { titleError?: unknown; scopes?: string[] };
} = {}): Fixture {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srctitle-kb-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srctitle-data-'));
  const store = new LocalMapStore(path.join(dataRoot, 'test.db'));
  store.initialize();
  const relPath = '策划/标题文档.md';
  const absPath = path.join(kbRoot, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, yamlHeader() + (opts.baseBody ?? BASE_BODY));
  store.upsertDocument({
    objToken: OBJ,
    wikiNodeToken: opts.wikiNodeToken !== undefined ? opts.wikiNodeToken : WIKI,
    objType: (opts.objType ?? 'docx') as never,
    title: opts.docTitle ?? DOC_TITLE,
    localMdPath: absPath,
    lastSyncedModifyTime: '2026-10-27T00:00:00.000Z',
    lastSyncedAt: '2026-10-27T00:00:00.000Z',
    status: 'synced',
    localRelPath: relPath,
  } as never);
  store.markDocumentSynced({
    objToken: OBJ,
    syncedObjEditTime: BASE_EDIT_TIME,
    localMdPath: absPath,
    lastSyncedModifyTime: '2026-10-27T00:00:00.000Z',
    lastSyncedAt: '2026-10-27T00:00:00.000Z',
  });
  const lark = makeLarkStub(opts.larkOpts ?? {});
  const pulls: string[] = [];
  const kbActive = { value: false };
  const config = {
    getConfig: () => ({
      knowledgeBaseRoot: kbRoot,
      feishuWrite: { enabled: opts.feishuWriteEnabled !== false },
    }),
  };
  const editService = new SourceEditService({
    config: config as never,
    store,
    kbBuild: { isActive: () => kbActive.value },
    dataRoot,
  });
  const titleService = new SourceTitleService({
    config,
    store,
    larkCliClient: lark,
    kbBuild: { isActive: () => kbActive.value },
    dataRoot,
    pullSync: async (token: string) => {
      pulls.push(token);
      return { ok: true, status: 'synced' };
    },
  });
  const writeService = new FeishuWriteService({
    config: config as never,
    store,
    larkCliClient: lark,
    kbBuild: { isActive: () => kbActive.value },
    dataRoot,
    readEditView: (token: string) => editService.read(token),
    pullSync: async (token: string) => {
      pulls.push(token);
      return { ok: true, status: 'synced' };
    },
  });
  return {
    kbRoot, dataRoot, store, lark, editService, titleService, writeService, pulls, kbActive, absPath,
    cleanup: () => {
      fs.rmSync(kbRoot, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/** 落一行 revert_state='running' 的 push_log（cloud_revert_running 互斥共享状态）。 */
function seedRunningRevert(fx: Fixture): SourcePushLogRecord {
  const id = fx.store.insertSourcePushLog({
    objToken: OBJ,
    localRelPath: '策划/标题文档.md',
    mode: 'revert',
    actor: 'ui',
    anchorHistoryId: '3072',
    anchorHistoryTime: '2026-10-28T02:00:00Z',
    anchorExact: true,
  });
  fx.store.updateSourcePushLog(id, { outcome: 'pushed' });
  fx.store.updateSourcePushLogRevert(id, { revertState: 'running', revertHistoryId: '2048', revertTaskId: 'task-x' });
  return fx.store.getSourcePushLog(id)!;
}

/** 经真实 SourceEditService 链路落一个 dirty 编辑（base.md 就位）。 */
async function editBody(fx: Fixture, newBody: string): Promise<void> {
  const view = await fx.editService.read(OBJ);
  await fx.editService.edit(OBJ, { mode: 'replace_body', body: newBody }, {
    baseHash: view.bodyHash,
    actor: 'ui',
  });
}

async function expectTitleError(promise: Promise<unknown>): Promise<SourceTitleError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SourceTitleError);
    return error as SourceTitleError;
  }
  throw new Error('expected SourceTitleError, got success');
}

function auditLines(fx: Fixture): Array<Record<string, unknown>> {
  const file = path.join(fx.dataRoot, 'agent', 'audit', 'source-pushes.jsonl');
  return fs.readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

const fixtures: Fixture[] = [];
afterEach(() => {
  while (fixtures.length) fixtures.pop()?.cleanup();
});

function fixture(opts: Parameters<typeof makeFixture>[0] = {}): Fixture {
  const fx = makeFixture(opts);
  fixtures.push(fx);
  return fx;
}

// ===========================================================================
// A. 纯函数：标题合法性 / 首个 H1 / 警告判定
// ===========================================================================

describe('isInvalidRenameTitle — §3 标题合法性', () => {
  it('非字符串 / 空 / 纯空白 / 换行 / CR / NUL / 超 800 字节 → 非法', () => {
    expect(isInvalidRenameTitle(undefined)).toBe(true);
    expect(isInvalidRenameTitle('')).toBe(true);
    expect(isInvalidRenameTitle('   ')).toBe(true);
    expect(isInvalidRenameTitle('a\nb')).toBe(true);
    expect(isInvalidRenameTitle('a\rb')).toBe(true);
    expect(isInvalidRenameTitle('a\u0000b')).toBe(true);
    expect(isInvalidRenameTitle('标'.repeat(Math.ceil(TITLE_MAX_BYTES / 3) + 1))).toBe(true);
    expect(isInvalidRenameTitle('正常标题')).toBe(false);
    expect(isInvalidRenameTitle('Title with spaces')).toBe(false);
  });
});

describe('firstH1Title / computeTitleChangeNotPushed — §6.1 警告判定', () => {
  it('firstH1Title：首个 # 标题；## 不算；无 H1 → null', () => {
    expect(firstH1Title('# 标题\n\n正文')).toBe('标题');
    expect(firstH1Title('前置文字\n## 二级\n# 一级')).toBe('一级');
    expect(firstH1Title('## 只有二级\n正文')).toBeNull();
    expect(firstH1Title('')).toBeNull();
  });

  it('本地编辑引入分叉（基线一致 + 当前不一致）→ 触发', () => {
    expect(computeTitleChangeNotPushed({
      syncedTitle: '旧标题',
      currentBody: '# 新标题\n\n正文',
      baseBody: '# 旧标题\n\n正文',
    })).toEqual({ localTitle: '新标题', syncedTitle: '旧标题' });
  });

  it('基线本就分叉（同步态如此）→ 不触发（非本地编辑引入）', () => {
    expect(computeTitleChangeNotPushed({
      syncedTitle: '旧标题',
      currentBody: '# 又一个标题\n\n正文',
      baseBody: '# 本来就不同\n\n正文',
    })).toBeNull();
  });

  it('当前 H1 与标题一致 / 当前无 H1 → 不触发', () => {
    expect(computeTitleChangeNotPushed({
      syncedTitle: '旧标题', currentBody: '# 旧标题\n正文', baseBody: '# 旧标题\n正文',
    })).toBeNull();
    expect(computeTitleChangeNotPushed({
      syncedTitle: '旧标题', currentBody: '无标题正文', baseBody: '# 旧标题\n正文',
    })).toBeNull();
  });
});

// ===========================================================================
// B. buildRenamePlan — 门控与 target 派生矩阵
// ===========================================================================

describe('buildRenamePlan — 门控矩阵', () => {
  it('wiki 成员：target = node token + type wiki（P0-S2 --type wiki 语义）', async () => {
    const fx = fixture();
    const plan = await fx.titleService.buildRenamePlan(OBJ, '新标题');
    expect(plan).toMatchObject({
      objToken: OBJ,
      target: { token: WIKI, type: 'wiki' },
      from: DOC_TITLE,
      to: '新标题',
      blockedReason: null,
      warnings: [],
    });
  });

  it('drive 文档（无 wiki_node_token）：target = objToken + 实际 objType', async () => {
    const fx = fixture({ wikiNodeToken: null });
    const plan = await fx.titleService.buildRenamePlan(OBJ, '新标题');
    expect(plan.target).toEqual({ token: OBJ, type: 'docx' });
    expect(plan.blockedReason).toBeNull();
  });

  it('objType unknown 且非 wiki 成员 → unsupported_type', async () => {
    const fx = fixture({ wikiNodeToken: null, objType: 'unknown' });
    const plan = await fx.titleService.buildRenamePlan(OBJ, '新标题');
    expect(plan.blockedReason).toBe('unsupported_type');
    expect(plan.target).toBeNull();
  });

  it('文档未登记 → not_found', async () => {
    const fx = fixture();
    const plan = await fx.titleService.buildRenamePlan('doxcnNotRegist', '新标题');
    expect(plan.blockedReason).toBe('not_found');
  });

  it('标题非法（空/换行/超长）→ title_invalid；与当前相同 → title_unchanged', async () => {
    const fx = fixture();
    expect((await fx.titleService.buildRenamePlan(OBJ, '')).blockedReason).toBe('title_invalid');
    expect((await fx.titleService.buildRenamePlan(OBJ, 'a\nb')).blockedReason).toBe('title_invalid');
    expect((await fx.titleService.buildRenamePlan(OBJ, DOC_TITLE)).blockedReason).toBe('title_unchanged');
  });

  it('写开关关闭 → write_disabled；缺 scope → scope_missing；构建活跃 → kb_build_active', async () => {
    const fx = fixture({ feishuWriteEnabled: false });
    expect((await fx.titleService.buildRenamePlan(OBJ, '新标题')).blockedReason).toBe('write_disabled');
    const fx2 = fixture({ larkOpts: { scopes: [] } });
    expect((await fx2.titleService.buildRenamePlan(OBJ, '新标题')).blockedReason).toBe('scope_missing');
    const fx3 = fixture();
    fx3.kbActive.value = true;
    expect((await fx3.titleService.buildRenamePlan(OBJ, '新标题')).blockedReason).toBe('kb_build_active');
  });

  it('未写回本地修改 → local_edit_pending；云端回滚进行中 → cloud_revert_running', async () => {
    const fx = fixture();
    await editBody(fx, `# ${DOC_TITLE}\n\n正文基线 ALPHA。追加内容。\n`);
    expect((await fx.titleService.buildRenamePlan(OBJ, '新标题')).blockedReason).toBe('local_edit_pending');
    const fx2 = fixture();
    seedRunningRevert(fx2);
    expect((await fx2.titleService.buildRenamePlan(OBJ, '新标题')).blockedReason).toBe('cloud_revert_running');
  });
});

// ===========================================================================
// C. renameCloudTitle — 执行
// ===========================================================================

describe('renameCloudTitle — 执行', () => {
  it('confirm 门：非 RENAME → 400 confirmation_required（早于任何远端调用）', async () => {
    const fx = fixture();
    const error = await expectTitleError(
      fx.titleService.renameCloudTitle(OBJ, '新标题', { confirmValue: 'RENAME_CLOUD' }),
    );
    expect(error.code).toBe('confirmation_required');
    expect(error.status).toBe(400);
    expect(fx.lark.calls).toHaveLength(0);
  });

  it('wiki 成员成功：updateTitle(node token, --type wiki)；审计 source_rename；锁外回拉；本地零写入', async () => {
    const fx = fixture();
    const before = fs.readFileSync(fx.absPath, 'utf-8');
    const result = await fx.titleService.renameCloudTitle(OBJ, '新标题', {
      confirmValue: RENAME_CONFIRM_VALUE,
      actor: 'cli',
      approvalId: 'appr-1',
    });
    expect(result).toMatchObject({
      objToken: OBJ,
      target: { token: WIKI, type: 'wiki' },
      from: DOC_TITLE,
      to: '新标题',
      pull: { ok: true, status: 'synced' },
    });
    expect(fx.lark.calls).toEqual([{ op: 'updateTitle', args: [WIKI, '新标题', 'wiki'] }]);
    // 本地零写入：文件字节不变、无 source_edits 行、documents 标题仍为旧值
    expect(fs.readFileSync(fx.absPath, 'utf-8')).toBe(before);
    expect(fx.store.getSourceEdit(OBJ)).toBeNull();
    expect(fx.store.getDocumentByObjToken(OBJ)?.title).toBe(DOC_TITLE);
    expect(fx.pulls).toEqual([OBJ]);
    const [audit] = auditLines(fx);
    expect(audit).toMatchObject({
      event: 'source_rename',
      objToken: OBJ,
      from: DOC_TITLE,
      to: '新标题',
      actor: 'cli',
      approvalId: 'appr-1',
      target: { token: WIKI, type: 'wiki' },
    });
  });

  it('drive 文档成功：updateTitle(objToken, --type docx)', async () => {
    const fx = fixture({ wikiNodeToken: null });
    await fx.titleService.renameCloudTitle(OBJ, '新标题', { confirmValue: RENAME_CONFIRM_VALUE });
    expect(fx.lark.calls).toEqual([{ op: 'updateTitle', args: [OBJ, '新标题', 'docx'] }]);
  });

  it('981003 → 422 type_mismatch 透传；不自动换 type 重试（单次调用）', async () => {
    const fx = fixture({ larkOpts: { titleError: new LarkCliError('标题更新类型错配：token 与传入类型不符', 'type_mismatch', false, '981003') } });
    const error = await expectTitleError(
      fx.titleService.renameCloudTitle(OBJ, '新标题', { confirmValue: RENAME_CONFIRM_VALUE }),
    );
    expect(error.code).toBe('type_mismatch');
    expect(error.status).toBe(422);
    expect(error.details).toMatchObject({ larkCode: '981003' });
    expect(fx.lark.calls.filter((call) => call.op === 'updateTitle')).toHaveLength(1);
    // 失败不回拉、无审计成功行
    expect(fx.pulls).toEqual([]);
  });

  it('981004 → 403 no_edit_permission（upstreamCode 服务层映射）', async () => {
    const fx = fixture({ larkOpts: { titleError: new LarkCliError('no edit permission', 'upstream', true, '981004') } });
    const error = await expectTitleError(
      fx.titleService.renameCloudTitle(OBJ, '新标题', { confirmValue: RENAME_CONFIRM_VALUE }),
    );
    expect(error.code).toBe('no_edit_permission');
    expect(error.status).toBe(403);
    expect(error.details).toMatchObject({ larkCode: '981004' });
  });

  it('其余 LarkCliError → 502 feishu_rename_failed（保留 larkCode）', async () => {
    const fx = fixture({ larkOpts: { titleError: new LarkCliError('lark-cli 执行失败：boom', 'upstream', true, '99991400') } });
    const error = await expectTitleError(
      fx.titleService.renameCloudTitle(OBJ, '新标题', { confirmValue: RENAME_CONFIRM_VALUE }),
    );
    expect(error.code).toBe('feishu_rename_failed');
    expect(error.status).toBe(502);
    expect(error.details).toMatchObject({ larkCode: '99991400' });
  });

  it('回滚互斥：revert running → 409 cloud_revert_running，零远端调用', async () => {
    const fx = fixture();
    seedRunningRevert(fx);
    const error = await expectTitleError(
      fx.titleService.renameCloudTitle(OBJ, '新标题', { confirmValue: RENAME_CONFIRM_VALUE }),
    );
    expect(error.code).toBe('cloud_revert_running');
    expect(error.status).toBe(409);
    expect(fx.lark.calls).toHaveLength(0);
  });

  it('门控行为透传：write_disabled → 403；not_found → 404；unsupported_type → 422', async () => {
    const fx = fixture({ feishuWriteEnabled: false });
    expect((await expectTitleError(
      fx.titleService.renameCloudTitle(OBJ, '新标题', { confirmValue: RENAME_CONFIRM_VALUE }),
    )).status).toBe(403);
    const fx2 = fixture();
    expect((await expectTitleError(
      fx2.titleService.renameCloudTitle('doxcnNotRegist', '新标题', { confirmValue: RENAME_CONFIRM_VALUE }),
    )).status).toBe(404);
    const fx3 = fixture({ wikiNodeToken: null, objType: 'unknown' });
    expect((await expectTitleError(
      fx3.titleService.renameCloudTitle(OBJ, '新标题', { confirmValue: RENAME_CONFIRM_VALUE }),
    )).status).toBe(422);
  });
});

// ===========================================================================
// D. routes/feishu — title 端点
// ===========================================================================

function makeApp(fx: Fixture): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).localMapStore = fx.store;
    (c as any).larkCliClient = fx.lark;
    (c as any).configManager = {
      getConfig: () => ({ knowledgeBaseRoot: fx.kbRoot, feishuWrite: { enabled: true } }),
      load: async () => ({}),
    };
    (c as any).kbBuildService = { activeBuild: () => null };
    await next();
  });
  app.route('/', feishuRoutes);
  return app;
}

describe('routes/feishu — title/preview + title', () => {
  it('POST title/preview：返回计划 DTO（target/from/to/blockedReason）', async () => {
    const fx = fixture();
    const response = await makeApp(fx).request(`/api/sources/${OBJ}/title/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '新标题' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      objToken: OBJ,
      target: { token: WIKI, type: 'wiki' },
      from: DOC_TITLE,
      to: '新标题',
      blockedReason: null,
    });
  });

  it('POST title：错误 confirm → 400；正确 confirm → 200 + 回拉结果', async () => {
    const fx = fixture();
    const app = makeApp(fx);
    const bad = await app.request(`/api/sources/${OBJ}/title`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '新标题', confirm: 'PUSH' }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'confirmation_required' });

    const ok = await app.request(`/api/sources/${OBJ}/title`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '新标题', confirm: 'RENAME', actor: 'cli' }),
    });
    expect(ok.status).toBe(200);
    const bodyJson = await ok.json();
    expect(bodyJson).toMatchObject({
      objToken: OBJ,
      to: '新标题',
      target: { token: WIKI, type: 'wiki' },
    });
    // 回拉 best-effort：路由构造的 pullSync 走真实 SyncEngine（stub 云端
    // 正文不足以完整同步），失败只记 pull 字段——改名请求本身成功。
    expect(typeof bodyJson.pull).toBe('object');
    expect(fx.lark.calls).toEqual([{ op: 'updateTitle', args: [WIKI, '新标题', 'wiki'] }]);
  });

  it('互斥经路由暴露：回滚进行中 → preview blocked + execute 409', async () => {
    const fx = fixture();
    seedRunningRevert(fx);
    const app = makeApp(fx);
    const preview = await app.request(`/api/sources/${OBJ}/title/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '新标题' }),
    });
    expect(await preview.json()).toMatchObject({ blockedReason: 'cloud_revert_running' });
    const execute = await app.request(`/api/sources/${OBJ}/title`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '新标题', confirm: 'RENAME' }),
    });
    expect(execute.status).toBe(409);
    expect(await execute.json()).toMatchObject({ error: 'cloud_revert_running' });
  });
});

// ===========================================================================
// E. push preview — title_change_not_pushed 警告（§6.1）
// ===========================================================================

describe('FeishuWriteService.preview — title_change_not_pushed', () => {
  it('本地编辑改首个 H1 → warnings 带码 + 结构化字段（localTitle/syncedTitle）', async () => {
    const fx = fixture();
    await editBody(fx, '# 新标题\n\n正文基线 ALPHA。\n');
    const plan = await fx.writeService.preview(OBJ);
    expect(plan.titleChangeNotPushed).toEqual({ localTitle: '新标题', syncedTitle: DOC_TITLE });
    expect(plan.warnings.some((w) => w.startsWith(TITLE_CHANGE_NOT_PUSHED_CODE))).toBe(true);
  });

  it('警告消除（title 回拉一致路径）：改名回拉后 documents.title 一致 → 无警告', async () => {
    const fx = fixture();
    await editBody(fx, '# 新标题\n\n正文基线 ALPHA。\n');
    expect((await fx.writeService.preview(OBJ)).titleChangeNotPushed).not.toBeNull();
    // 改名成功后单文档回拉：SyncEngine 会用云端新标题更新 documents 行——
    // 此处以同一 upsert 通道模拟回拉效果（title 一致是消除条件）。
    fx.store.upsertDocument({
      objToken: OBJ,
      wikiNodeToken: WIKI,
      objType: 'docx',
      title: '新标题',
      localMdPath: fx.absPath,
      lastSyncedModifyTime: '2026-10-27T00:00:00.000Z',
      lastSyncedAt: '2026-10-27T00:00:00.000Z',
      status: 'synced',
      localRelPath: '策划/标题文档.md',
    } as never);
    const plan = await fx.writeService.preview(OBJ);
    expect(plan.titleChangeNotPushed).toBeNull();
    expect(plan.warnings.some((w) => w.startsWith(TITLE_CHANGE_NOT_PUSHED_CODE))).toBe(false);
  });

  it('未改 H1 / 基线本就分叉 → 无警告（不误报）', async () => {
    const fx = fixture();
    await editBody(fx, `# ${DOC_TITLE}\n\n正文基线 ALPHA。追加。\n`);
    expect((await fx.writeService.preview(OBJ)).titleChangeNotPushed).toBeNull();

    const fx2 = fixture({ baseBody: '# 本来就不同\n\n正文基线 ALPHA。\n' });
    await editBody(fx2, '# 又一个标题\n\n正文基线 ALPHA。\n');
    expect((await fx2.writeService.preview(OBJ)).titleChangeNotPushed).toBeNull();
  });
});

// ===========================================================================
// F. app_command cloud.rename_title — 批准流端到端
// ===========================================================================

const SESSION_ID = 's_s9_title';

describe('app_command cloud.rename_title — 批准流端到端', () => {
  let approvalsToClose: ApprovalService[] = [];
  const homeOverrides: Array<string | undefined> = [];

  afterEach(() => {
    for (const service of approvalsToClose) service.close();
    approvalsToClose = [];
    while (homeOverrides.length) {
      const prev = homeOverrides.pop();
      if (prev === undefined) delete process.env.FEISHU_SYNC_HOME;
      else process.env.FEISHU_SYNC_HOME = prev;
    }
  });

  function appCommandEnv(fx: Fixture) {
    const hono = makeApp(fx);
    // 路由内 createSourceTitleService 经 resolveDataRoot() 取数据根（审计
    // 落点）——指到 fixture，断言可读且与真实 ~/.feishu-sync 隔离。
    const prevHome = process.env.FEISHU_SYNC_HOME;
    process.env.FEISHU_SYNC_HOME = fx.dataRoot;
    homeOverrides.push(prevHome);
    const approvals = new ApprovalService({ dataRoot: fx.dataRoot, timeoutMs: 8_000 });
    approvalsToClose.push(approvals);
    const toolService = new AgentToolService({ dataRoot: fx.dataRoot, documentsProvider: () => [] });
    toolService.registerToolFamily(createOpsToolFamily({
      approvals,
      getApp: () => hono,
      desktopToken: 'stub-desktop-token',
      configProvider: () => null,
    }));
    const token = toolService.createRunContext({
      runKind: 'work', sessionId: SESSION_ID, outputRoot: os.tmpdir(), knowledgeBaseRoot: fx.kbRoot,
    }).token;
    return {
      approvals,
      runRename: (args: Record<string, unknown>) =>
        toolService.executeTool(token, 'app_command', { command: 'cloud.rename_title', args }),
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

  it('批准 → 执行：确认值 RENAME 由 preview 派生；模型传 confirm 被剔除；真实改名被调', async () => {
    const fx = fixture();
    const env = appCommandEnv(fx);
    const pending = env.runRename({ objToken: OBJ, title: '新标题', confirm: 'RENAME' });
    const dto = await waitPending(env.approvals);
    expect(dto.risk).toBe('remote_write');
    expect((dto.preview as { confirmValue?: string }).confirmValue).toBe('RENAME');
    // 模型传入的 confirm 字段被剔除，不进 argsSummary
    expect(JSON.parse(dto.argsSummary)).toEqual({ objToken: OBJ, title: '新标题' });
    env.approvals.decide(SESSION_ID, dto.id, 'approve');
    const result = await pending;
    expect(result.details).toMatchObject({ command: 'cloud.rename_title', risk: 'remote_write' });
    expect(result.content[0]?.text).toContain('"to": "新标题"');
    expect(fx.lark.calls).toEqual([{ op: 'updateTitle', args: [WIKI, '新标题', 'wiki'] }]);
    expect(auditLines(fx).some((line) => line.event === 'source_rename' && line.actor === 'cli')).toBe(true);
  });

  it('blocked preview → rename_blocked 400，零批准请求零远端调用', async () => {
    const fx = fixture();
    seedRunningRevert(fx);
    const env = appCommandEnv(fx);
    await expect(env.runRename({ objToken: OBJ, title: '新标题' }))
      .rejects.toMatchObject({ code: 'rename_blocked', status: 400 });
    expect(env.approvals.pendingCount()).toBe(0);
    expect(fx.lark.calls.filter((call) => call.op === 'updateTitle')).toHaveLength(0);
  });
});

// ===========================================================================
// G. 命令表 + CLI 位置参数 — cloud.rename_title 登记
// ===========================================================================

describe('ops command-table — cloud.rename_title 登记', () => {
  it('登记面：remote_write + agentExposed + confirm 必须（destructive/remote_write 门）', () => {
    const def = findOpsCommand('cloud.rename_title');
    expect(def).toBeDefined();
    expect(def!.risk).toBe('remote_write');
    expect(def!.agentExposed).toBe(true);
    expect(def!.confirm).toEqual({ field: 'confirm', value: 'RENAME' });
  });

  it('request()：POST /api/sources/:objToken/title + body {title, confirm, actor:cli}', () => {
    const def = findOpsCommand('cloud.rename_title')!;
    const specs = def.request({ objToken: OBJ, title: '新标题' });
    expect(specs).toEqual([{
      method: 'POST',
      path: `/api/sources/${OBJ}/title`,
      body: { title: '新标题', confirm: 'RENAME', actor: 'cli' },
    }]);
  });

  it('confirmPlan：previewSpecs 打到 title/preview；blocked → rename_blocked；派生 RENAME', () => {
    const def = findOpsCommand('cloud.rename_title')!;
    const plan = def.confirmPlan!;
    expect(plan.previewSpecs({ objToken: OBJ, title: '新标题' })).toEqual([{
      method: 'POST',
      path: `/api/sources/${OBJ}/title/preview`,
      body: { title: '新标题' },
    }]);
    expect(() => plan.deriveConfirm({ blockedReason: 'cloud_revert_running' }, {}))
      .toThrowError(OpsArgumentError);
    try {
      plan.deriveConfirm({ blockedReason: 'title_invalid' }, {});
      expect.unreachable('blocked preview must reject');
    } catch (error) {
      expect((error as OpsArgumentError).code).toBe('rename_blocked');
    }
    expect(plan.deriveConfirm({ blockedReason: null, target: { token: WIKI, type: 'wiki' }, from: DOC_TITLE, to: '新标题' }, {}))
      .toBe('RENAME');
  });

  it('planKey = target.type|to（§6.3）：换标题/换类型 → 计划过期', () => {
    const def = findOpsCommand('cloud.rename_title')!;
    const planKey = def.confirmPlan!.planKey;
    const a = planKey({ blockedReason: null, target: { token: WIKI, type: 'wiki' }, from: DOC_TITLE, to: '新标题' });
    expect(a).toBe('wiki|新标题');
    expect(planKey({ blockedReason: null, target: { token: OBJ, type: 'docx' }, from: DOC_TITLE, to: '新标题' }))
      .toBe('docx|新标题');
    expect(planKey({ blockedReason: null, target: { token: WIKI, type: 'wiki' }, from: DOC_TITLE, to: '另一个' }))
      .not.toBe(a);
  });

  it('CLI 位置参数：objToken + title 绑定与必填校验', () => {
    const def = findOpsCommand('cloud.rename_title')!;
    expect(buildCommandArgs(def, [OBJ, '新标题'])).toEqual({ objToken: OBJ, title: '新标题' });
    expect(buildCommandArgs(def, [OBJ, '--title', '新标题'])).toEqual({ objToken: OBJ, title: '新标题' });
  });
});
