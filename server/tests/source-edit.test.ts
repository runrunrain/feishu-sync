/**
 * S11 源库受控编辑测试（设计 §7.2–§7.4 / §9.1 不变量 1a、1b）。
 *
 * 覆盖任务书验收点：
 *   - header 字节不变 + parseMetadata 往返
 *   - baseHash 冲突 409
 *   - dirty 文档同步出 local_edit_pending blocker：文件不被覆盖、基线不推进、不触发云端拉取
 *   - pushed 行在回拉同步成功后清除 + 备份目录清理
 *   - revert 恢复原文并清 dirty
 *   - 构建活跃拒绝（edit / revert）
 *   - 审计行写入、备份落盘（base.md + <seq>.md）
 *   - str_replace 唯一性、类型/历史头拒绝、round-trip 失败恢复（故障注入）
 *   - 生命周期守卫：prepareSourceCleanup 对 dirty 源拒绝（409 local_edit_pending）
 *   - SourceWriteLock 串行化
 *   - API 层契约（sourcesRoutes：edit-status/edit/revert/edits + 错误体）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { SyncEngine } from '../src/modules/sync-engine.js';
import { IndexScanner } from '../src/modules/index-scanner.js';
import { prepareSourceCleanup } from '../src/kb/source-cleanup.js';
import { ToolError } from '../src/agent/agent-tool-service.js';
import { SourceWriteLock } from '../src/sources/source-write-lock.js';
import {
  SourceEditService,
  SourceEditError,
  applyOp,
  pendingLocalEditTokens,
} from '../src/sources/source-edit-service.js';
import { sourcesRoutes } from '../src/routes/sources.js';
import { resolveDataRoot } from '../src/modules/data-root.js';

const scanner = new IndexScanner({} as never);

function sha(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

const OBJ = 'doxcnEdit001';
const WIKI = 'wikicnEdit001';

function yamlHeader(objToken = OBJ): string {
  return [
    '<!--',
    'feishu_sync:',
    `  obj_token: "${objToken}"`,
    `  wiki_node_token: "${WIKI}"`,
    '  space_id: "spaceEdit001"',
    '  obj_type: "docx"',
    `  original_link: "https://x.feishu.cn/wiki/${WIKI}"`,
    '  fetch_date: "2026-10-27T00:00:00.000Z"',
    '  last_synced_modify_time: "2026-10-27T00:00:00.000Z"',
    '-->',
    '',
    '',
  ].join('\n');
}

const BODY = '# 测试文档\n\n正文第一段，包含锚点 ALPHA 与锚点 ALPHA 重复出现。\n';

interface Fixture {
  kbRoot: string;
  dataRoot: string;
  store: LocalMapStore;
  service: SourceEditService;
  absPath: string;
  relPath: string;
  objToken: string;
  cleanup: () => void;
}

function makeFixture(opts: {
  objToken?: string;
  objType?: 'docx' | 'sheet';
  cloudDeleted?: boolean;
  header?: 'yaml' | 'legacy';
  skipFile?: boolean;
  syncedObjEditTime?: number | null;
} = {}): Fixture {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srcedit-kb-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srcedit-data-'));
  const store = new LocalMapStore(path.join(dataRoot, 'test.db'));
  store.initialize();
  const objToken = opts.objToken ?? OBJ;
  const relPath = objToken === OBJ ? '策划/测试文档.md' : `策划/${objToken}.md`;
  const absPath = path.join(kbRoot, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  if (!opts.skipFile) {
    const header = opts.header === 'legacy'
      ? `<!--\n来源: 飞书知识库\nobj_token: ${objToken} (docx)\n-->\n\n`
      : yamlHeader(objToken);
    fs.writeFileSync(absPath, header + BODY);
  }
  store.upsertDocument({
    objToken,
    wikiNodeToken: WIKI,
    objType: opts.objType ?? 'docx',
    title: '测试文档',
    localMdPath: absPath,
    lastSyncedModifyTime: '2026-10-27T00:00:00.000Z',
    lastSyncedAt: '2026-10-27T00:00:00.000Z',
    status: 'synced',
    localRelPath: relPath,
  } as never);
  if (opts.syncedObjEditTime !== null) {
    store.markDocumentSynced({
      objToken,
      syncedObjEditTime: opts.syncedObjEditTime ?? 1759000000,
      localMdPath: absPath,
      lastSyncedModifyTime: '2026-10-27T00:00:00.000Z',
      lastSyncedAt: '2026-10-27T00:00:00.000Z',
    });
  }
  if (opts.cloudDeleted) store.markCloudDeleted(objToken, '2026-10-27T00:00:00.000Z');
  const service = new SourceEditService({
    config: { getConfig: () => ({ knowledgeBaseRoot: kbRoot }) } as never,
    store,
    kbBuild: { isActive: () => false },
    dataRoot,
  });
  return {
    kbRoot, dataRoot, store, service, absPath, relPath, objToken,
    cleanup: () => {
      fs.rmSync(kbRoot, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

function readBody(fx: Fixture): string {
  const content = fs.readFileSync(fx.absPath, 'utf-8');
  let end = content.indexOf('-->') + 3;
  if (content.slice(end, end + 2) === '\n\n') end += 2;
  return content.slice(end);
}

function readHeader(fx: Fixture): string {
  const content = fs.readFileSync(fx.absPath, 'utf-8');
  let end = content.indexOf('-->') + 3;
  if (content.slice(end, end + 2) === '\n\n') end += 2;
  return content.slice(0, end);
}

async function expectError(promise: Promise<unknown>): Promise<SourceEditError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SourceEditError);
    return error as SourceEditError;
  }
  throw new Error('expected SourceEditError, got success');
}

// ===========================================================================
// SourceEditService.edit — 核心安全语义
// ===========================================================================
describe('SourceEditService — edit', () => {
  it('header 字节不变 + parseMetadata 往返 + dirty 状态 + 备份 + 审计', async () => {
    const fx = makeFixture();
    try {
      const headerBefore = readHeader(fx);
      const metaBefore = scanner.parseMetadata(fs.readFileSync(fx.absPath, 'utf-8'));
      const newBody = '# 测试文档\n\n编辑后的正文。\n';
      const result = await fx.service.edit(fx.objToken, { mode: 'replace_body', body: newBody }, { baseHash: sha(BODY), actor: 'ui' });

      // 文件 = 原 header 字节 + 新正文
      expect(readHeader(fx)).toBe(headerBefore);
      expect(readBody(fx)).toBe(newBody);
      // round-trip：元数据逐字段一致
      const metaAfter = scanner.parseMetadata(fs.readFileSync(fx.absPath, 'utf-8'));
      expect(metaAfter).toEqual(metaBefore);
      // 返回契约
      expect(result.bodyHash).toBe(sha(newBody));
      expect(result.state.state).toBe('dirty');
      expect(result.state.editCount).toBe(1);
      // source_edits 行
      const row = fx.store.getSourceEdit(fx.objToken);
      expect(row).not.toBeNull();
      expect(row!.state).toBe('dirty');
      expect(row!.baseBodyHash).toBe(sha(BODY));
      expect(row!.currentBodyHash).toBe(sha(newBody));
      expect(row!.baseObjEditTime).toBe('1759000000');
      expect(row!.localRelPath).toBe(fx.relPath);
      expect(row!.lastActor).toBe('ui');
      // 备份落盘：base.md = 首次编辑前正文；<seq>.md = 每次编辑前正文
      const backupDir = path.join(fx.dataRoot, 'source-edits', fx.objToken);
      expect(fs.readFileSync(path.join(backupDir, 'base.md'), 'utf-8')).toBe(BODY);
      expect(fs.readFileSync(path.join(backupDir, '000001.md'), 'utf-8')).toBe(BODY);
      // 审计行
      const audit = fs.readFileSync(path.join(fx.dataRoot, 'agent', 'audit', 'source-edits.jsonl'), 'utf-8').trim().split('\n');
      expect(audit.length).toBe(1);
      const entry = JSON.parse(audit[0]);
      expect(entry.objToken).toBe(fx.objToken);
      expect(entry.actor).toBe('ui');
      expect(entry.result).toBe('edited');
      expect(entry.op).toBe('replace_body');
      expect(entry.beforeHash).toBe(sha(BODY));
      expect(entry.afterHash).toBe(sha(newBody));
      expect(typeof entry.bytes).toBe('number');
      expect(typeof entry.time).toBe('string');
    } finally {
      fx.cleanup();
    }
  });

  it('baseHash 过期 → 409 source_edit_conflict，文件不动', async () => {
    const fx = makeFixture();
    try {
      const before = fs.readFileSync(fx.absPath, 'utf-8');
      const error = await expectError(
        fx.service.edit(fx.objToken, { mode: 'replace_body', body: 'X' }, { baseHash: 'deadbeef', actor: 'ui' }),
      );
      expect(error.status).toBe(409);
      expect(error.code).toBe('source_edit_conflict');
      expect(error.details).toEqual({ currentBodyHash: sha(BODY) });
      expect(fs.readFileSync(fx.absPath, 'utf-8')).toBe(before);
      expect(fx.store.getSourceEdit(fx.objToken)).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  it('str_replace：唯一替换成功；多处默认拒绝；replaceAll 全换；未找到拒绝', async () => {
    const fx = makeFixture();
    try {
      // 唯一
      const first = await fx.service.edit(
        fx.objToken,
        { mode: 'str_replace', old: '正文第一段', new: '正文改写段' },
        { baseHash: sha(BODY), actor: 'cli' },
      );
      expect(readBody(fx)).toContain('正文改写段');
      expect(first.state.editCount).toBe(1);

      // 多处且未开 replaceAll → 400
      const errMulti = await expectError(
        fx.service.edit(
          fx.objToken,
          { mode: 'str_replace', old: 'ALPHA', new: 'BETA' },
          { baseHash: first.bodyHash, actor: 'ui' },
        ),
      );
      expect(errMulti.status).toBe(400);
      expect(errMulti.code).toBe('invalid_edit_op');
      // 文件与计数不动
      expect(fx.store.getSourceEdit(fx.objToken)!.editCount).toBe(1);

      // replaceAll → 两处都换，计数推进
      const second = await fx.service.edit(
        fx.objToken,
        { mode: 'str_replace', old: 'ALPHA', new: 'BETA', replaceAll: true },
        { baseHash: first.bodyHash, actor: 'ui' },
      );
      const body = readBody(fx);
      expect(body.includes('ALPHA')).toBe(false);
      expect(body.match(/BETA/g)!.length).toBe(2);
      expect(second.state.editCount).toBe(2);

      // 未找到 → 400
      const errMissing = await expectError(
        fx.service.edit(fx.objToken, { mode: 'str_replace', old: '不存在的锚点', new: 'Y' }, { baseHash: second.bodyHash, actor: 'ui' }),
      );
      expect(errMissing.code).toBe('invalid_edit_op');
    } finally {
      fx.cleanup();
    }
  });

  it('第二次编辑：base.md 不变，<seq>.md 记录前版正文，计数+1', async () => {
    const fx = makeFixture();
    try {
      const bodyV1 = '# V1\n';
      const bodyV2 = '# V2\n';
      const r1 = await fx.service.edit(fx.objToken, { mode: 'replace_body', body: bodyV1 }, { baseHash: sha(BODY), actor: 'ui' });
      const r2 = await fx.service.edit(fx.objToken, { mode: 'replace_body', body: bodyV2 }, { baseHash: r1.bodyHash, actor: 'ui' });
      const backupDir = path.join(fx.dataRoot, 'source-edits', fx.objToken);
      expect(fs.readFileSync(path.join(backupDir, 'base.md'), 'utf-8')).toBe(BODY);
      expect(fs.readFileSync(path.join(backupDir, '000001.md'), 'utf-8')).toBe(BODY);
      expect(fs.readFileSync(path.join(backupDir, '000002.md'), 'utf-8')).toBe(bodyV1);
      expect(r2.state.editCount).toBe(2);
      expect(r2.state.baseBodyHash).toBe(sha(BODY));
      expect(r2.state.bodyHash).toBe(sha(bodyV2));
    } finally {
      fx.cleanup();
    }
  });

  it('pushing 状态拒绝编辑（409 source_push_in_progress，S12 写回链占用）', async () => {
    const fx = makeFixture();
    try {
      // 直接用替身 store 模拟 pushing 行（写状态由 S12 写回链写入）。
      const service = new SourceEditService({
        config: { getConfig: () => ({ knowledgeBaseRoot: fx.kbRoot }) } as never,
        store: {
          getDocumentByObjToken: () => fx.store.getDocumentByObjToken(fx.objToken),
          getSourceEdit: () => ({ objToken: fx.objToken, state: 'pushing' }),
        },
        kbBuild: { isActive: () => false },
        dataRoot: fx.dataRoot,
      });
      const error = await expectError(
        service.edit(fx.objToken, { mode: 'replace_body', body: 'X' }, { baseHash: sha(BODY), actor: 'ui' }),
      );
      expect(error.code).toBe('source_push_in_progress');
      expect(error.status).toBe(409);
      expect(fs.readFileSync(fx.absPath, 'utf-8')).toBe(yamlHeader() + BODY);
    } finally {
      fx.cleanup();
    }
  });

  it('_custom/ 归档文档同样可编辑（设计 §7.1：结构树与归档均可）', async () => {
    const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srcedit-custom-kb-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srcedit-custom-data-'));
    const store = new LocalMapStore(path.join(dataRoot, 'test.db'));
    store.initialize();
    const objToken = 'doxcnCustom001';
    const relPath = '_custom/归档夹/归档文档.md';
    const absPath = path.join(kbRoot, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, yamlHeader(objToken) + BODY);
    store.upsertDocument({
      objToken, wikiNodeToken: WIKI, objType: 'docx', title: '归档文档',
      localMdPath: absPath, lastSyncedModifyTime: '2026-10-27T00:00:00.000Z',
      lastSyncedAt: '2026-10-27T00:00:00.000Z', status: 'synced', localRelPath: relPath,
    } as never);
    const service = new SourceEditService({
      config: { getConfig: () => ({ knowledgeBaseRoot: kbRoot }) } as never,
      store,
      kbBuild: { isActive: () => false },
      dataRoot,
    });
    try {
      const result = await service.edit(objToken, { mode: 'replace_body', body: '# 归档编辑后\n' }, { baseHash: sha(BODY), actor: 'ui' });
      expect(result.state.state).toBe('dirty');
      expect(store.getSourceEdit(objToken)!.localRelPath).toBe(relPath);
      const content = fs.readFileSync(absPath, 'utf-8');
      expect(content.startsWith(yamlHeader(objToken))).toBe(true);
      expect(content.endsWith('# 归档编辑后\n')).toBe(true);
    } finally {
      fs.rmSync(kbRoot, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('构建活跃 → 409 kb_build_active（edit 与 revert 都拒绝）', async () => {
    const fx = makeFixture();
    const activeService = new SourceEditService({
      config: { getConfig: () => ({ knowledgeBaseRoot: fx.kbRoot }) } as never,
      store: fx.store,
      kbBuild: { isActive: () => true },
      dataRoot: fx.dataRoot,
    });
    try {
      const errEdit = await expectError(
        activeService.edit(fx.objToken, { mode: 'replace_body', body: 'X' }, { baseHash: sha(BODY), actor: 'ui' }),
      );
      expect(errEdit.code).toBe('kb_build_active');
      expect(errEdit.status).toBe(409);
      // revert 同样被构建活跃拒绝
      const errRevert = await expectError(activeService.revert(fx.objToken, 'ui'));
      expect(errRevert.code).toBe('kb_build_active');
      expect(fs.readFileSync(fx.absPath, 'utf-8')).toBe(yamlHeader() + BODY);
    } finally {
      fx.cleanup();
    }
  });

  it('非 docx 类型 → 422 source_edit_unsupported_type；历史头 → 422；回收站/屏蔽 → 409 source_not_editable', async () => {
    const sheet = makeFixture({ objToken: 'shtcnSheet001', objType: 'sheet' });
    const legacy = makeFixture({ objToken: 'doxcnLegacy001', header: 'legacy' });
    const trashed = makeFixture({ objToken: 'doxcnTrash001', cloudDeleted: true });
    try {
      const errSheet = await expectError(sheet.service.read(sheet.objToken));
      expect(errSheet.code).toBe('source_edit_unsupported_type');
      expect(errSheet.status).toBe(422);

      const errLegacy = await expectError(
        legacy.service.edit(legacy.objToken, { mode: 'replace_body', body: 'X' }, { baseHash: sha(BODY), actor: 'ui' }),
      );
      expect(errLegacy.code).toBe('source_header_unsupported');
      expect(errLegacy.status).toBe(422);

      const errTrash = await expectError(trashed.service.read(trashed.objToken));
      expect(errTrash.code).toBe('source_not_editable');
      expect(errTrash.status).toBe(409);
    } finally {
      sheet.cleanup();
      legacy.cleanup();
      trashed.cleanup();
    }
  });

  it('round-trip 失败（故障注入）→ 500 source_header_roundtrip_failed 且文件恢复原样', async () => {
    const fx = makeFixture();
    try {
      const original = fs.readFileSync(fx.absPath, 'utf-8');
      const correct = scanner.parseMetadata(original);
      let calls = 0;
      (fx.service as unknown as { scanner: { parseMetadata: (c: string) => unknown } }).scanner = {
        parseMetadata: () => {
          calls += 1;
          // 第一次（写前身份校验）正确，第二次（写后复核）返回被污染的元数据。
          return calls <= 1 ? correct : { ...correct, obj_token: 'TAMPERED' };
        },
      };
      const error = await expectError(
        fx.service.edit(fx.objToken, { mode: 'replace_body', body: '篡改正文' }, { baseHash: sha(BODY), actor: 'ui' }),
      );
      expect(error.code).toBe('source_header_roundtrip_failed');
      expect(error.status).toBe(500);
      expect(fs.readFileSync(fx.absPath, 'utf-8')).toBe(original);
      // 状态行未推进（编辑失败不产生 dirty 行）
      expect(fx.store.getSourceEdit(fx.objToken)).toBeNull();
      // 审计记录了失败
      const audit = fs.readFileSync(path.join(fx.dataRoot, 'agent', 'audit', 'source-edits.jsonl'), 'utf-8');
      expect(audit).toContain('source_header_roundtrip_failed');
    } finally {
      fx.cleanup();
    }
  });
});

// ===========================================================================
// revert
// ===========================================================================
describe('SourceEditService — revert', () => {
  it('恢复 base.md 正文并清 dirty；备份目录保留；审计 reverted', async () => {
    const fx = makeFixture();
    try {
      await fx.service.edit(fx.objToken, { mode: 'replace_body', body: '# 被编辑\n' }, { baseHash: sha(BODY), actor: 'agent' });
      await fx.service.revert(fx.objToken, 'ui');
      expect(fs.readFileSync(fx.absPath, 'utf-8')).toBe(yamlHeader() + BODY);
      expect(fx.store.getSourceEdit(fx.objToken)).toBeNull();
      // 备份目录保留（设计 §13：回拉成功前保留本地备份）
      expect(fs.existsSync(path.join(fx.dataRoot, 'source-edits', fx.objToken, 'base.md'))).toBe(true);
      const audit = fs.readFileSync(path.join(fx.dataRoot, 'agent', 'audit', 'source-edits.jsonl'), 'utf-8');
      expect(audit).toContain('"result":"reverted"');
      // 无行时再次 revert → 404
      const err = await expectError(fx.service.revert(fx.objToken, 'ui'));
      expect(err.code).toBe('source_edit_not_found');
      expect(err.status).toBe(404);
    } finally {
      fx.cleanup();
    }
  });
});

// ===========================================================================
// SyncEngine 防覆盖 blocker（§7.3 / 不变量 1a、1b）
// ===========================================================================
describe('SyncEngine — local_edit_pending blocker', () => {
  function blockerEngine(opts: { state?: string | null }) {
    const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srcedit-sync-kb-'));
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srcedit-sync-ops-'));
    const absPath = path.join(kbRoot, '测试文档.md');
    fs.writeFileSync(absPath, yamlHeader() + BODY);
    const calls = { markSynced: 0, clearSourceEdit: 0, fetch: 0 };
    const store = {
      getSourceEdit: (token: string) => (opts.state ? { objToken: token, state: opts.state } : null),
      clearSourceEdit: (token: string) => { calls.clearSourceEdit += 1; void token; },
      upsertDocument: () => undefined,
      markDocumentSynced: () => { calls.markSynced += 1; },
      logSync: () => undefined,
    };
    const larkCliClient = {
      fetchDocumentMarkdown: () => { calls.fetch += 1; throw new Error('dirty 文档绝不能触发云端拉取'); },
    };
    const engine = new SyncEngine({
      larkCliClient,
      localMapStore: store,
      config: { knowledgeBaseRoot: kbRoot, operationManifestDir: opDir, watchedRoots: [], watchedRootUrls: [] },
    } as never);
    const doc = {
      objToken: OBJ,
      objType: 'docx' as const,
      title: '测试文档',
      changeType: 'modified' as const,
      cloudModifiedTime: '2026-10-27T00:00:00.000Z',
      localSyncedTime: null,
      localMdPath: absPath,
      observedObjEditTime: 1759000001,
    };
    return { engine, doc, absPath, calls, cleanup: () => { fs.rmSync(kbRoot, { recursive: true, force: true }); fs.rmSync(opDir, { recursive: true, force: true }); } };
  }

  it('apply：dirty 文档 → blocker，文件不被覆盖、基线不推进、不触发云端拉取', async () => {
    const ctx = blockerEngine({ state: 'dirty' });
    try {
      const result = await ctx.engine.syncDocuments([ctx.doc], { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' });
      expect(result.success).toBe(false);
      expect(result.syncedDocuments.length).toBe(0);
      expect(result.failedDocuments.length).toBe(1);
      const failure = result.failedDocuments[0];
      expect(failure.reasonCode).toBe('local_edit_pending');
      expect(failure.objToken).toBe(OBJ);
      expect(failure.error).toContain('本地有未写回的修改');
      expect(failure.repairAction).toBe('manual_review');
      // 不变量 1a：本地文件原样
      expect(fs.readFileSync(ctx.absPath, 'utf-8')).toBe(yamlHeader() + BODY);
      // 不变量 1b： synced 基线未推进、云端未拉取
      expect(ctx.calls.markSynced).toBe(0);
      expect(ctx.calls.fetch).toBe(0);
    } finally {
      ctx.cleanup();
    }
  });

  it('apply：conflict/pushing 同样阻断；dry-run 也预告 blocker', async () => {
    for (const state of ['conflict', 'pushing']) {
      const ctx = blockerEngine({ state });
      try {
        const result = await ctx.engine.syncDocuments([ctx.doc], { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' });
        expect(result.failedDocuments[0].reasonCode).toBe('local_edit_pending');
        expect(fs.readFileSync(ctx.absPath, 'utf-8')).toBe(yamlHeader() + BODY);
      } finally {
        ctx.cleanup();
      }
    }
    const dry = blockerEngine({ state: 'dirty' });
    try {
      const result = await dry.engine.syncDocuments([dry.doc], { enableLLM: false, fullSync: false, apply: false });
      expect(result.failedDocuments[0].reasonCode).toBe('local_edit_pending');
      expect(dry.calls.fetch).toBe(0);
    } finally {
      dry.cleanup();
    }
  });
});

// ===========================================================================
// pushed 行清理（回拉同步成功后，设计 §7.3）
// ===========================================================================
describe('SyncEngine — pushed 行清理', () => {
  it('state=pushed 不阻断；同步成功后 clearSourceEdit + 备份目录清理', async () => {
    const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srcedit-push-kb-'));
    const opDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srcedit-push-ops-'));
    const backupDir = path.join(resolveDataRoot(), 'source-edits', 'bas3cnPushed1');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'base.md'), 'old');
    try {
      const calls = { clear: 0 };
      const store = {
        getSourceEdit: (token: string) => (token === 'bas3cnPushed1' ? { objToken: token, state: 'pushed' } : null),
        clearSourceEdit: () => { calls.clear += 1; },
        upsertDocument: () => undefined,
        markDocumentSynced: () => undefined,
        logSync: () => undefined,
        getSheetSheets: () => [],
        getAllDocuments: () => [],
        getDocumentByObjToken: () => ({ wikiNodeToken: 'wikicnPushed1', spaceId: 'spacePushed1', originalLink: null }),
      };
      const larkCliClient = {
        fetchDocumentMarkdown: async () => ({
          data: { document: { content: '# pushed 回拉正文' } },
        }),
      };
      const engine = new SyncEngine({
        larkCliClient,
        localMapStore: store,
        config: { knowledgeBaseRoot: kbRoot, operationManifestDir: opDir, watchedRoots: [], watchedRootUrls: [] },
      } as never);
      const doc = {
        objToken: 'bas3cnPushed1',
        objType: 'docx' as const,
        title: '推送回拉文档',
        changeType: 'modified' as const,
        cloudModifiedTime: '2026-10-27T00:00:00.000Z',
        localSyncedTime: null,
        localMdPath: path.join(kbRoot, '推送回拉文档.md'),
        observedObjEditTime: 1759000002,
      };
      const result = await engine.syncDocuments([doc], { enableLLM: false, fullSync: false, apply: true, confirmation: 'APPLY' });
      expect(result.failedDocuments).toEqual([]);
      expect(result.syncedDocuments.length).toBe(1);
      expect(calls.clear).toBe(1);
      expect(fs.existsSync(backupDir)).toBe(false);
    } finally {
      fs.rmSync(kbRoot, { recursive: true, force: true });
      fs.rmSync(opDir, { recursive: true, force: true });
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 生命周期守卫
// ===========================================================================
describe('生命周期守卫 — prepareSourceCleanup', () => {
  it('dirty 源拒绝清理（409 local_edit_pending）；pushed 不拒绝；无行不拒绝', async () => {
    const dirty = makeFixture();
    const pushed = makeFixture({ objToken: 'doxcnPushed002' });
    try {
      await dirty.service.edit(dirty.objToken, { mode: 'replace_body', body: '# 编辑中\n' }, { baseHash: sha(BODY), actor: 'ui' });
      expect(() => prepareSourceCleanup(dirty.store as never, dirty.kbRoot, [{ objToken: dirty.objToken, relPath: dirty.relPath }]))
        .toThrowError(ToolError);
      try {
        prepareSourceCleanup(dirty.store as never, dirty.kbRoot, [{ objToken: dirty.objToken, relPath: dirty.relPath }]);
      } catch (error) {
        expect((error as ToolError).code).toBe('local_edit_pending');
        expect((error as ToolError).status).toBe(409);
      }

      // pushed 行：模拟 S12 置位
      await pushed.service.edit(pushed.objToken, { mode: 'replace_body', body: '# P\n' }, { baseHash: sha(BODY), actor: 'ui' });
      pushed.store.markSourceEditPushed(pushed.objToken, { pushMode: 'append' });
      expect(() => prepareSourceCleanup(pushed.store as never, pushed.kbRoot, [{ objToken: pushed.objToken, relPath: pushed.relPath }]))
        .not.toThrow();
      expect(pendingLocalEditTokens(pushed.store, [pushed.objToken])).toEqual([]);
      expect(pendingLocalEditTokens(dirty.store, [dirty.objToken])).toEqual([dirty.objToken]);
    } finally {
      dirty.cleanup();
      pushed.cleanup();
    }
  });
});

// ===========================================================================
// SourceWriteLock
// ===========================================================================
describe('SourceWriteLock', () => {
  it('同 token 串行化（FIFO），不同 token 并行，异常不卡队列', async () => {
    const lock = new SourceWriteLock();
    const order: number[] = [];
    const release: (() => void)[] = [];
    let enterFirst!: () => void;
    const enteredFirst = new Promise<void>((resolve) => { enterFirst = resolve; });
    let enterSecond!: () => void;
    const enteredSecond = new Promise<void>((resolve) => { enterSecond = resolve; });
    const p1 = lock.withLock('A', () => new Promise<void>((resolve) => {
      enterFirst();
      release.push(() => { order.push(1); resolve(); });
    }));
    void p1;
    const p2 = lock.withLock('A', () => new Promise<void>((resolve) => {
      enterSecond();
      release.push(() => { order.push(2); resolve(); });
    }));
    await enteredFirst;
    expect(lock.isLocked('A')).toBe(true);
    release[0]();
    await enteredSecond;
    release[1]();
    await p2;
    expect(order).toEqual([1, 2]);
    // 异常传播 + 队列不卡
    await expect(lock.withLock('B', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const after = await lock.withLock('B', () => 'ok');
    expect(after).toBe('ok');
    expect(lock.isLocked('A')).toBe(false);
    expect(lock.isLocked('B')).toBe(false);
  });
});

// ===========================================================================
// applyOp 纯函数
// ===========================================================================
describe('applyOp', () => {
  it('replace_body 校验 body 类型', () => {
    expect(applyOp('x', { mode: 'replace_body', body: 'y' })).toBe('y');
    expect(() => applyOp('x', { mode: 'replace_body' } as never)).toThrow(SourceEditError);
  });
  it('str_replace 空串/未知 mode 拒绝', () => {
    expect(() => applyOp('x', { mode: 'str_replace', old: '', new: 'y' })).toThrow(SourceEditError);
    expect(() => applyOp('x', { mode: 'nope' } as never)).toThrow(/未知编辑操作/);
  });
});

// ===========================================================================
// API 层（sourcesRoutes）
// ===========================================================================
describe('sourcesRoutes — API 契约', () => {
  function makeApp(fx: Fixture, opts: { active?: boolean } = {}) {
    const app = new Hono();
    app.route('/', sourcesRoutes({
      configManager: { getConfig: () => ({ knowledgeBaseRoot: fx.kbRoot }) },
      localMapStore: fx.store,
      kbBuild: { isActive: () => opts.active === true },
      dataRoot: fx.dataRoot,
    } as never));
    return app;
  }

  it('edit-status：无编辑行 → editState null + bodyHash；未知 token → 404 source_not_found', async () => {
    const fx = makeFixture();
    try {
      const app = makeApp(fx);
      const res = await app.request(`/api/sources/${fx.objToken}/edit-status`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.objToken).toBe(fx.objToken);
      expect(body.editState).toBeNull();
      expect(body.bodyHash).toBe(sha(BODY));

      const missing = await app.request('/api/sources/doxcnMissing999/edit-status');
      expect(missing.status).toBe(404);
      expect((await missing.json()).error).toBe('source_not_found');
    } finally {
      fx.cleanup();
    }
  });

  it('edit：HTTP 契约（confirm 门 / op / newText 别名 / 409 conflict 形状）→ edits 列表 → edits/:objToken', async () => {
    const fx = makeFixture();
    try {
      const app = makeApp(fx);

      // 缺 confirm → 400
      const noConfirm = await app.request(`/api/sources/${fx.objToken}/edit`, {
        method: 'POST',
        body: JSON.stringify({ op: { mode: 'replace_body', body: 'X' }, baseHash: sha(BODY) }),
      });
      expect(noConfirm.status).toBe(400);
      expect((await noConfirm.json()).error).toBe('confirmation_required');

      // 设计原生 op 形态
      const editRes = await app.request(`/api/sources/${fx.objToken}/edit`, {
        method: 'POST',
        body: JSON.stringify({ op: { mode: 'replace_body', body: '# HTTP 编辑\n' }, baseHash: sha(BODY), confirm: 'EDIT' }),
      });
      expect(editRes.status).toBe(200);
      const editBody = await editRes.json();
      expect(editBody.state.state).toBe('dirty');
      expect(editBody.bodyHash).toBe(sha('# HTTP 编辑\n'));

      // 过期 baseHash → 409 source_edit_conflict + details.currentBodyHash
      const conflict = await app.request(`/api/sources/${fx.objToken}/edit`, {
        method: 'POST',
        body: JSON.stringify({ newText: 'stale', baseHash: sha(BODY), confirm: 'EDIT' }),
      });
      expect(conflict.status).toBe(409);
      const conflictBody = await conflict.json();
      expect(conflictBody.error).toBe('source_edit_conflict');
      expect(conflictBody.details.currentBodyHash).toBe(sha('# HTTP 编辑\n'));

      // 列表
      const list = await app.request('/api/sources/edits');
      expect(list.status).toBe(200);
      const listBody = await list.json();
      expect(listBody.edits.length).toBe(1);
      expect(listBody.edits[0].objToken).toBe(fx.objToken);
      expect(listBody.edits[0].relPath).toBe(fx.relPath);
      expect(listBody.edits[0].title).toBe('测试文档');

      // 详情（含 body）；未知文档 token → 404 source_not_found；
      // 存在文档但无编辑行 → 404 source_edit_not_found。
      const detail = await app.request(`/api/sources/edits/${fx.objToken}`);
      expect(detail.status).toBe(200);
      expect((await detail.json()).body).toBe('# HTTP 编辑\n');
      const missingDoc = await app.request('/api/sources/edits/doxcnNoRow888');
      expect(missingDoc.status).toBe(404);
      expect((await missingDoc.json()).error).toBe('source_not_found');
      await app.request(`/api/sources/${fx.objToken}/revert`, {
        method: 'POST', body: JSON.stringify({ confirm: 'REVERT' }),
      });
      const noRow = await app.request(`/api/sources/edits/${fx.objToken}`);
      expect(noRow.status).toBe(404);
      expect((await noRow.json()).error).toBe('source_edit_not_found');
    } finally {
      fx.cleanup();
    }
  });

  it('revert：confirm 门 + 恢复 + 清 dirty；构建活跃 409', async () => {
    const fx = makeFixture();
    const activeApp = makeApp(fx, { active: true });
    const app = makeApp(fx);
    try {
      await app.request(`/api/sources/${fx.objToken}/edit`, {
        method: 'POST',
        body: JSON.stringify({ newText: '# 临时\n', baseHash: sha(BODY), confirm: 'EDIT' }),
      });

      // 构建活跃期间 revert 被拒
      const activeRevert = await activeApp.request(`/api/sources/${fx.objToken}/revert`, {
        method: 'POST', body: JSON.stringify({ confirm: 'REVERT' }),
      });
      expect(activeRevert.status).toBe(409);
      expect((await activeRevert.json()).error).toBe('kb_build_active');

      // 缺 confirm → 400
      const bad = await app.request(`/api/sources/${fx.objToken}/revert`, { method: 'POST', body: JSON.stringify({}) });
      expect(bad.status).toBe(400);

      const ok = await app.request(`/api/sources/${fx.objToken}/revert`, {
        method: 'POST', body: JSON.stringify({ confirm: 'REVERT' }),
      });
      expect(ok.status).toBe(200);
      expect((await ok.json()).ok).toBe(true);
      expect(fs.readFileSync(fx.absPath, 'utf-8')).toBe(yamlHeader() + BODY);
      expect(fx.store.getSourceEdit(fx.objToken)).toBeNull();
    } finally {
      fx.cleanup();
    }
  });
});
