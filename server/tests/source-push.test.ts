/**
 * S12 飞书写回测试（设计 §7.5–§7.6；S0-write-probe 实测定值）。
 *
 * 覆盖任务书验收点：
 *   - planPush 全分支（no_changes/append/images_in_append/overwrite/
 *     images_in_overwrite/overwrite_required/overwrite_unsupported）
 *   - 转义归一化 S0 D3/D4 实测样例往返（`\|`/`\[` 失真、分隔行规范化、
 *     `<title>` 剥离、末尾换行）；XML 标签写面 `\<` 转义
 *   - LarkCliClient 写方法 argv 断言（--command/--revision-id/
 *     --doc-format/@file cwd 相对路径 + 临时文件内容 + 清理）
 *   - 三段式 overwrite 各段失败路径（fetch 失败→dirty / 写失败→dirty /
 *     回读失配→conflict 不重试）；revision 未来值 4000002→conflict
 *   - obj_edit_time 前进→409（force+OVERWRITE_CLOUD 越过）
 *   - append 超时结果未知→conflict(push_outcome_unknown)
 *   - 成功→pushed→回拉→行删除；pushing 并发→409
 *   - 写门：feishuWrite.enabled / write scopes（403）
 *   - scope 授权流：read/write 两次 device start 的 scope 集断言
 *   - 启动对账：pushing→conflict（push_interrupted）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { LarkCliClient, LarkCliError } from '../src/modules/lark-cli-client.js';
import { LarkCliManager } from '../src/modules/lark-cli-manager.js';
import { SourceEditService } from '../src/sources/source-edit-service.js';
import { FeishuWriteService, FeishuWriteError } from '../src/sources/feishu-write-service.js';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { ApprovalService } from '../src/agent/approvals/approval-service.js';
import { SessionService } from '../src/agent/session-service.js';
import type { SessionStoreApi } from '../src/agent/session-service.js';
import { AgentProcessPool } from '../src/agent/agent-process-pool.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { modelRevision } from '../src/agent/model-revision.js';
import type { PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import type { Config } from '../src/types/index.js';
import { createOpsToolFamily } from '../src/agent/tools/app-command-family.js';
import {
  normalizeForCompare,
  escapeLiteralAngleBracketsForWrite,
  containsLocalMediaReference,
  planPush,
} from '../src/sources/push-planner.js';
import { feishuRoutes } from '../src/routes/feishu.js';

// ---------------------------------------------------------------------------
// child_process mock（scope 授权流断言用；handler 逐用例注入）
// ---------------------------------------------------------------------------
const { execFileMock, setExecHandler } = vi.hoisted(() => {
  type Handler = (file: string, args: string[]) =>
    | { error?: Error | null; stdout?: string; stderr?: string }
    | Promise<{ error?: Error | null; stdout?: string; stderr?: string }>;
  let handler: Handler = () => ({ stdout: '' });
  return {
    execFileMock: vi.fn(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
      ) => {
        Promise.resolve()
          .then(() => handler(_file, _args))
          .then((result) => {
            callback(result?.error ?? null, { stdout: result?.stdout ?? '', stderr: result?.stderr ?? '' });
          })
          .catch((error) => callback(error as Error));
      },
    ),
    setExecHandler: (next: Handler) => {
      handler = next;
    },
  };
});
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: execFileMock,
}));

// 本文件不需要 IndexScanner/哈希助手（编辑链路由真实 SourceEditService 驱动）。
const OBJ = 'doxcnPush0001';
const WIKI = 'wikicnPush0001';
const BASE_EDIT_TIME = 1759000000;

function yamlHeader(objToken = OBJ): string {
  return [
    '<!--',
    'feishu_sync:',
    `  obj_token: "${objToken}"`,
    `  wiki_node_token: "${WIKI}"`,
    '  space_id: "spacePush01"',
    '  obj_type: "docx"',
    `  original_link: "https://x.feishu.cn/wiki/${WIKI}"`,
    '  fetch_date: "2026-10-27T00:00:00.000Z"',
    '  last_synced_modify_time: "2026-10-27T00:00:00.000Z"',
    '-->',
    '',
    '',
  ].join('\n');
}

// ===========================================================================
// A. 纯函数：转义归一化 / 写面转义 / 本地媒体检测 / planPush
// ===========================================================================

describe('normalizeForCompare — S0 D3/D4 实测样例往返', () => {
  it('段落内 \\| / \\[ / \\] 写入导出字节失真归一（D3：a\\|b→a|b、\\[x\\]→[x]）', () => {
    const written = '段落 a\\|b 与 \\[非链接\\] 以及 3 \\* 5\n';
    const exported = '段落 a|b 与 [非链接] 以及 3 \\* 5\n';
    expect(normalizeForCompare(written)).toBe(normalizeForCompare(exported));
    // \\* 属无条件转义类、导出字节保留（D3），不参与反转义——两边原样即等。
  });

  it('表格分隔行固定规范化（D3：|---|---| 导出 |-|-|）', () => {
    const written = '| A | B |\n|---|---|\n| 1 | 2 |';
    const exported = '| A | B |\n|-|-|\n| 1 | 2 |';
    expect(normalizeForCompare(written)).toBe(normalizeForCompare(exported));
    expect(normalizeForCompare('| --- | :---: |')).toBe('|-|:-:|');
  });

  it('表格 cell 内 \\| 字节保留（D3）但归一化后两侧等价', () => {
    const written = '| x \\| y |\n|---|\n| z |';
    const exported = '| x \\| y |\n|---|\n| z |';
    expect(normalizeForCompare(written)).toBe(normalizeForCompare(exported));
  });

  it('<title> 导出附加行剥离（连同其后一个空行）+ 文档末尾换行去除（D3）', () => {
    const titleExport = '<title>feishu-sync-s0-probe-164439</title>\n\n# 标题\n\n正文';
    expect(normalizeForCompare(titleExport)).toBe('# 标题\n\n正文');
    expect(normalizeForCompare('# 标题\n\n正文\n')).toBe('# 标题\n\n正文');
  });

  it('完整 D4 overwrite 往返样例：写入正文 vs 导出正文（分隔行+转义括号+末尾换行）', () => {
    const written = [
      '# 标题',
      '',
      '| 列1 | 列2 |',
      '|---|---|',
      '| a | \\[转义括号\\] |',
      '',
      '结尾段落',
      '',
    ].join('\n');
    const exported = [
      '# 标题',
      '',
      '| 列1 | 列2 |',
      '|-|-|',
      '| a | [转义括号] |',
      '',
      '结尾段落',
    ].join('\n');
    expect(normalizeForCompare(written)).toBe(normalizeForCompare(exported));
  });
});

describe('escapeLiteralAngleBracketsForWrite — XML 标签转义（S0 §②-S2）', () => {
  it('sync-engine 产物标签 <img>/<whiteboard>/<sheet> 一律 \\< 转义（含闭合标签）', () => {
    const body = '前文\n\n<img src="images/01-x.png"/>\n\n<whiteboard token="doxcnWhiteboardToken001"/>\n\n<sheet sheet-id="s1" token="sheetcnToken0000001"></sheet>\n';
    const escaped = escapeLiteralAngleBracketsForWrite(body);
    expect(escaped).toContain('\\<img src="images/01-x.png"/>');
    expect(escaped).toContain('\\<whiteboard token="doxcnWhiteboardToken001"/>');
    expect(escaped).toContain('\\<sheet sheet-id="s1" token="sheetcnToken0000001">\\</sheet>');
    expect(escaped).not.toMatch(/(?<!\\)</);
    // 转义后与导出形态（云端存字面 <，导出再转义 \<）归一化等价——回读
    // 校验的比较基线。
    const exported = escaped.replace(/\\</g, '<').replace(/</g, '\\<');
    expect(normalizeForCompare(body)).toBe(normalizeForCompare(exported));
  });

  it('已转义的 \\< 不重复转义', () => {
    expect(escapeLiteralAngleBracketsForWrite('a \\< b < c')).toBe('a \\< b \\< c');
  });
});

describe('containsLocalMediaReference — 本地媒体引用检测', () => {
  it('本地相对路径与 @./ 形态判定为本地引用', () => {
    expect(containsLocalMediaReference('![](images/01-x.png)')).toBe(true);
    expect(containsLocalMediaReference('![](@./rel.png)')).toBe(true);
    expect(containsLocalMediaReference('<img src="images/01-x.png"/>')).toBe(true);
    expect(containsLocalMediaReference('<image token="attachments/doc.pdf"/>')).toBe(true);
  });

  it('云端 token 与 feishu.cn/file 回拉形态不算本地引用', () => {
    expect(containsLocalMediaReference('![](https://feishu.cn/file/K7J7b2iH0oGv7Rx8V3bcsRO1n4c)')).toBe(false);
    expect(containsLocalMediaReference('<image token="K7J7b2iH0oGv7Rx8V3bcsRO1n4c"/>')).toBe(false);
    expect(containsLocalMediaReference('<sheet sheet-id="s" token="sheetcnToken0000001"></sheet>')).toBe(false);
    expect(containsLocalMediaReference('纯文本与 [链接](https://a.b/c)')).toBe(false);
  });
});

describe('planPush — 全分支', () => {
  const base = '# 标题\n\n正文基线 ALPHA。\n';

  it('no_changes：归一化等价（仅末尾换行差）→ blocked', () => {
    expect(planPush({ baseBody: base, currentBody: `${base}\n`, allowOverwrite: true, overwriteSupported: true }))
      .toEqual({ mode: 'blocked', blockedReason: 'no_changes' });
  });

  it('append：原文前缀 → 后缀', () => {
    const plan = planPush({ baseBody: base, currentBody: `${base}追加段。`, allowOverwrite: false, overwriteSupported: true });
    expect(plan).toEqual({ mode: 'append', appendMarkdown: '追加段。' });
  });

  it('append：归一化前缀（基线分隔行被改写为等价形式）→ 行对齐切分', () => {
    const baseBody = '| A | B |\n|---|---|\n| 1 | 2 |\n';
    const currentBody = '| A | B |\n|-|-|\n| 1 | 2 |\n新增行。\n';
    const plan = planPush({ baseBody, currentBody, allowOverwrite: false, overwriteSupported: true });
    expect(plan.mode).toBe('append');
    expect(plan.appendMarkdown).toBe('新增行。\n');
  });

  it('images_in_append：后缀含本地图片引用 → blocked', () => {
    const plan = planPush({
      baseBody: base,
      currentBody: `${base}\n![](images/02-y.png)\n`,
      allowOverwrite: true,
      overwriteSupported: true,
    });
    expect(plan).toEqual({ mode: 'blocked', blockedReason: 'images_in_append' });
  });

  it('overwrite：非前缀修改 + allowOverwrite → overwrite；含本地图片 → images_in_overwrite', () => {
    const modified = '# 改标题\n\n正文基线 ALPHA。\n';
    expect(planPush({ baseBody: base, currentBody: modified, allowOverwrite: true, overwriteSupported: true }))
      .toEqual({ mode: 'overwrite' });
    expect(planPush({
      baseBody: base,
      currentBody: `${modified}\n<img src="images/01.png"/>\n`,
      allowOverwrite: true,
      overwriteSupported: true,
    })).toEqual({ mode: 'blocked', blockedReason: 'images_in_overwrite' });
  });

  it('overwrite_required / overwrite_unsupported', () => {
    const modified = '# 改标题\n\n正文基线 ALPHA。\n';
    expect(planPush({ baseBody: base, currentBody: modified, allowOverwrite: false, overwriteSupported: true }))
      .toEqual({ mode: 'blocked', blockedReason: 'overwrite_required' });
    expect(planPush({ baseBody: base, currentBody: modified, allowOverwrite: true, overwriteSupported: false }))
      .toEqual({ mode: 'blocked', blockedReason: 'overwrite_unsupported' });
    expect(planPush({ baseBody: base, currentBody: modified, allowOverwrite: false, overwriteSupported: false }))
      .toEqual({ mode: 'blocked', blockedReason: 'overwrite_required' });
  });
});

// ===========================================================================
// B. LarkCliClient 写方法 argv（stub execute；@file cwd 相对路径）
// ===========================================================================

describe('LarkCliClient 写方法 — S0 命令形态 argv 断言', () => {
  interface Captured {
    args: string[];
    options: { cwd?: string; timeoutMs?: number } | undefined;
  }

  function makeClient(): { client: LarkCliClient; captured: Captured[] } {
    const client = new LarkCliClient({ requiredScopes: [], timeout: 1_000, larkCliPath: 'unused' });
    const captured: Captured[] = [];
    (client as any).execute = async (args: string[], _api: string, options?: any) => {
      captured.push({ args, options });
      return { ok: true, result: 'success', warnings: [], revision_id: 7 };
    };
    return { client, captured };
  }

  it('updateDocumentAppend：argv + @file 为子进程 cwd 相对纯文件名 + 正文落临时文件', async () => {
    const client = new LarkCliClient({ requiredScopes: [], timeout: 1_000, larkCliPath: 'unused' });
    const captured: Array<{ args: string[]; options?: { cwd?: string; timeoutMs?: number }; fileContent?: string }> = [];
    (client as any).execute = async (args: string[], _api: string, options?: any) => {
      // execute 执行期间（临时目录仍存在）快照 argv、cwd 与临时文件内容。
      const fileContent = fs.readFileSync(path.join(options.cwd, 'content.md'), 'utf-8');
      captured.push({ args, options, fileContent });
      return { ok: true, result: 'success', warnings: [], revision_id: 7 };
    };
    const markdown = '# 追加\n\n含字面 \\<img/> 与表格\n\n| a | b |\n|---|---|\n';
    const result = await client.updateDocumentAppend('doxcnTarget000001', markdown);
    expect(result.revisionId).toBe(7);
    expect(result.warnings).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(captured[0].args).toEqual([
      'docs', '+update',
      '--doc', 'doxcnTarget000001',
      '--command', 'append',
      '--doc-format', 'markdown',
      '--content', '@content.md',
      '--json',
    ]);
    const cwd = captured[0].options?.cwd;
    expect(typeof cwd).toBe('string');
    expect(captured[0].options?.timeoutMs).toBe(120_000);
    // 正文经临时文件传递（设计 §9.1 不变量 5），且不在 argv 中出现。
    expect(captured[0].args.join(' ')).not.toContain('# 追加');
    expect(captured[0].fileContent).toBe(markdown);
    // 执行结束后临时目录清理。
    expect(fs.existsSync(cwd!)).toBe(false);
  });

  it('overwriteDocument：--revision-id 紧跟 --command overwrite', async () => {
    const { client, captured } = makeClient();
    await client.overwriteDocument('doxcnTarget000001', '# 全文', 5);
    expect(captured[0].args).toEqual([
      'docs', '+update',
      '--doc', 'doxcnTarget000001',
      '--command', 'overwrite',
      '--doc-format', 'markdown',
      '--content', '@content.md',
      '--revision-id', '5',
      '--json',
    ]);
  });

  it('fetchDocumentRevision：docx v1 documents API（S0 D6）', async () => {
    const client = new LarkCliClient({ requiredScopes: [], timeout: 1_000, larkCliPath: 'unused' });
    const argsSeen: string[][] = [];
    (client as any).execute = async (args: string[]) => {
      argsSeen.push(args);
      return { data: { document: { revision_id: 10, title: 'T' } } };
    };
    const result = await client.fetchDocumentRevision('doxcnTarget000001');
    expect(result).toEqual({ revisionId: 10, title: 'T' });
    expect(argsSeen[0]).toEqual([
      'api', 'GET', '/open-apis/docx/v1/documents/doxcnTarget000001', '--format', 'json',
    ]);
  });

  it('空 token / 非 markdown 输入快速失败，不 spawn', async () => {
    const { client, captured } = makeClient();
    await expect(client.updateDocumentAppend('', 'x')).rejects.toThrow(/non-empty objToken/);
    await expect(client.updateDocumentAppend('t', 42 as never)).rejects.toThrow(/markdown to be a string/);
    expect(captured).toHaveLength(0);
  });
});

// ===========================================================================
// C. FeishuWriteService — 三段式 / 状态机 / 失败路径
// ===========================================================================

interface LarkStub {
  calls: Array<{ op: string; args: unknown[] }>;
  [key: string]: unknown;
}

function makeLarkStub(overrides: Record<string, unknown> = {}): LarkStub {
  const calls: LarkStub['calls'] = [];
  const stub: LarkStub = {
    calls,
    checkAuthReady: async () => ({
      ready: true,
      verified: true,
      identity: 'user',
      account: { id: 'ou-test' },
      currentScopes: ['docx:document:write_only', 'wiki:node:retrieve'],
      missingScopes: [],
    }),
    getDocumentMetas: async (reqs: Array<{ docToken: string; docType: string }>) => ({
      metas: reqs.map((r) => ({ docToken: r.docToken, docType: r.docType, latestModifyTime: BASE_EDIT_TIME, title: '' })),
      failed: [],
    }),
    fetchDocumentRevision: async (token: string) => {
      calls.push({ op: 'fetchRevision', args: [token] });
      return { revisionId: 5, title: '测试文档' };
    },
    fetchDocumentMarkdown: async (token: string) => {
      calls.push({ op: 'fetchBody', args: [token] });
      return { data: { document: { content: (stub.__bodyProvider as (t: string) => string)?.(token) ?? '' } } };
    },
    updateDocumentAppend: async (token: string, markdown: string) => {
      calls.push({ op: 'append', args: [token, markdown] });
      return { revisionId: 6, warnings: [], raw: {} };
    },
    overwriteDocument: async (token: string, markdown: string, revisionId: number) => {
      calls.push({ op: 'overwrite', args: [token, markdown, revisionId] });
      return { revisionId: 7, warnings: [], raw: {} };
    },
    __bodyProvider: null,
    ...overrides,
  };
  return stub;
}

interface Fixture {
  kbRoot: string;
  dataRoot: string;
  store: LocalMapStore;
  editService: SourceEditService;
  absPath: string;
  objToken: string;
  lark: LarkStub;
  pulls: Array<{ objToken: string }>;
  pullResult: { ok: boolean; status: string; message?: string };
  service: FeishuWriteService;
  cleanup: () => void;
}

function makeFixture(opts: {
  baseBody?: string;
  feishuWriteEnabled?: boolean;
  larkOverrides?: Record<string, unknown>;
} = {}): Fixture {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srcpush-kb-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srcpush-data-'));
  const store = new LocalMapStore(path.join(dataRoot, 'test.db'));
  store.initialize();
  const baseBody = opts.baseBody ?? '# 测试文档\n\n正文基线 ALPHA。\n';
  const relPath = '策划/测试文档.md';
  const absPath = path.join(kbRoot, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, yamlHeader() + baseBody);
  store.upsertDocument({
    objToken: OBJ,
    wikiNodeToken: WIKI,
    objType: 'docx',
    title: '测试文档',
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
  const editService = new SourceEditService({
    config: { getConfig: () => ({ knowledgeBaseRoot: kbRoot }) } as never,
    store,
    kbBuild: { isActive: () => false },
    dataRoot,
  });
  const lark = makeLarkStub(opts.larkOverrides ?? {});
  const pulls: Array<{ objToken: string }> = [];
  const fx: Fixture = {
    kbRoot, dataRoot, store, editService, absPath, objToken: OBJ, lark, pulls,
    pullResult: { ok: true, status: 'synced' },
    get service() {
      return new FeishuWriteService({
        config: { getConfig: () => ({ knowledgeBaseRoot: kbRoot, feishuWrite: { enabled: opts.feishuWriteEnabled !== false } }) },
        store,
        larkCliClient: lark,
        kbBuild: { isActive: () => false },
        dataRoot,
        readEditView: (token) => editService.read(token),
        pullSync: async (token) => {
          pulls.push({ objToken: token });
          if (fx.pullResult.ok && !store.getSourceEdit(token)) {
            return fx.pullResult;
          }
          // 模拟 S11 SyncEngine.finalizePushedSourceEdit：回拉成功清行删备份。
          if (fx.pullResult.ok) {
            store.clearSourceEdit(token);
            fs.rmSync(path.join(dataRoot, 'source-edits', token), { recursive: true, force: true });
          }
          return fx.pullResult;
        },
      });
    },
    cleanup: () => {
      fs.rmSync(kbRoot, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
  return fx;
}

/** 经 SourceEditService 真实编辑链路落一个 dirty 行（base.md 就位）。 */
async function editBody(fx: Fixture, newBody: string): Promise<void> {
  const view = await fx.editService.read(fx.objToken);
  await fx.editService.edit(fx.objToken, { mode: 'replace_body', body: newBody }, {
    baseHash: view.bodyHash,
    actor: 'ui',
  });
}

async function expectPushError(promise: Promise<unknown>): Promise<FeishuWriteError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FeishuWriteError);
    return error as FeishuWriteError;
  }
  throw new Error('expected FeishuWriteError, got success');
}

describe('FeishuWriteService.push — append 成功链路', () => {
  it('成功 → append 转义后缀 → pushed → 回拉 → 行删除 + 审计', async () => {
    const fx = makeFixture();
    try {
      // 后缀含非本地媒体的字面 <（云端 token 的 <sheet> 标签 + 数学比较）
      // → 允许 append，写面统一 \< 转义（本地媒体引用则 blocked，另测）。
      const suffix = '\n追加段 <sheet sheet-id="s1" token="sheetcnToken0000001"></sheet> 与 a < b 与 a\\|b\n';
      await editBody(fx, `# 测试文档\n\n正文基线 ALPHA。\n${suffix}`);
      const result = await fx.service.push(fx.objToken, { confirm: 'PUSH', actor: 'ui' });

      expect(result.mode).toBe('append');
      expect(result.revisionId).toBe(6);
      expect(result.pull).toEqual({ ok: true, status: 'synced' });
      expect(fx.pulls).toEqual([{ objToken: fx.objToken }]);
      // append 收到的是写面转义后的后缀（字面 < → \<）。
      const appendCall = fx.lark.calls.find((call) => call.op === 'append')!;
      expect(appendCall.args[1]).toBe(escapeLiteralAngleBracketsForWrite(suffix));
      // 行已由回拉清除。
      expect(fx.store.getSourceEdit(fx.objToken)).toBeNull();
      // 审计。
      const audit = fs.readFileSync(path.join(fx.dataRoot, 'agent', 'audit', 'source-pushes.jsonl'), 'utf-8').trim().split('\n');
      const entry = JSON.parse(audit.at(-1)!);
      expect(entry).toMatchObject({ objToken: fx.objToken, mode: 'append', result: 'pushed', actor: 'ui' });
      expect(entry.revisionId).toBe(6);
    } finally {
      fx.cleanup();
    }
  });

  it('回拉失败 → 行保留 pushed（下次同步/手动同步收敛）', async () => {
    const fx = makeFixture();
    fx.pullResult = { ok: false, status: 'local_edit_pending', message: 'x' };
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加\n');
      const result = await fx.service.push(fx.objToken, { confirm: 'PUSH' });
      expect(result.pull.ok).toBe(false);
      expect(result.state).toBe('pushed');
      expect(fx.store.getSourceEdit(fx.objToken)?.state).toBe('pushed');
    } finally {
      fx.cleanup();
    }
  });
});

describe('FeishuWriteService.push — overwrite 三段式', () => {
  const OVERWRITE_BODY = '# 标题改\n\n| 列1 | 列2 |\n|---|---|\n| a | \\[转义括号\\] |\n';

  /** 导出形态：S0 D4 实测规范化（分隔行 + 转义括号 + 末尾换行）。 */
  const EXPORTED_BODY = '# 标题改\n\n| 列1 | 列2 |\n|-|-|\n| a | [转义括号] |';

  function overwriteFixture(): Fixture {
    const fx = makeFixture();
    (fx.lark as Record<string, unknown>).__bodyProvider = () => EXPORTED_BODY;
    return fx;
  }

  it('三段式成功：fetch revision → 立即 overwrite（rev=fetch 值）→ 回读归一化比对 → pushed', async () => {
    const fx = overwriteFixture();
    try {
      await editBody(fx, OVERWRITE_BODY);
      const result = await fx.service.push(fx.objToken, {
        allowOverwrite: true,
        confirm: 'OVERWRITE_CLOUD',
      });
      expect(result.mode).toBe('overwrite');
      expect(result.revisionId).toBe(7);
      const ops = fx.lark.calls.map((call) => call.op);
      expect(ops).toEqual(['fetchRevision', 'overwrite', 'fetchBody']);
      const overwriteCall = fx.lark.calls.find((call) => call.op === 'overwrite')!;
      // 写面转义 + revision 使用 fetch 值（仅防未来值）。
      expect(overwriteCall.args[2]).toBe(5);
      expect(overwriteCall.args[1]).toBe(escapeLiteralAngleBracketsForWrite(OVERWRITE_BODY));
      expect(fx.store.getSourceEdit(fx.objToken)).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  it('回读失配 → conflict（push_readback_mismatch），绝不重试旧 revision', async () => {
    const fx = overwriteFixture();
    (fx.lark as Record<string, unknown>).__bodyProvider = () => '# 别人的并发内容\n';
    try {
      await editBody(fx, OVERWRITE_BODY);
      const error = await expectPushError(fx.service.push(fx.objToken, {
        allowOverwrite: true,
        confirm: 'OVERWRITE_CLOUD',
      }));
      expect(error.code).toBe('source_push_conflict');
      expect(error.status).toBe(409);
      expect(error.details).toMatchObject({ lastErrorCode: 'push_readback_mismatch' });
      // overwrite 只发生一次；没有第二次 fetchRevision/overwrite（不重试）。
      expect(fx.lark.calls.filter((call) => call.op === 'overwrite')).toHaveLength(1);
      expect(fx.lark.calls.filter((call) => call.op === 'fetchRevision')).toHaveLength(1);
      const row = fx.store.getSourceEdit(fx.objToken);
      expect(row?.state).toBe('conflict');
      expect(row?.lastErrorCode).toBe('push_readback_mismatch');
      // 回拉不执行（推送未成功）。
      expect(fx.pulls).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('revision 未来值 4000002 → conflict（push_revision_conflict），不重试', async () => {
    let overwriteAttempts = 0;
    const fx = makeFixture({
      larkOverrides: {
        overwriteDocument: async () => {
          overwriteAttempts += 1;
          throw new LarkCliError('999 "document version may be stale"', 'upstream', true, '4000002');
        },
      },
    });
    try {
      await editBody(fx, OVERWRITE_BODY);
      const error = await expectPushError(fx.service.push(fx.objToken, {
        allowOverwrite: true,
        confirm: 'OVERWRITE_CLOUD',
      }));
      expect(error.code).toBe('source_push_conflict');
      expect(error.details).toMatchObject({ lastErrorCode: 'push_revision_conflict' });
      expect(overwriteAttempts).toBe(1);
      expect(fx.store.getSourceEdit(fx.objToken)).toMatchObject({
        state: 'conflict',
        lastErrorCode: 'push_revision_conflict',
      });
    } finally {
      fx.cleanup();
    }
  });

  it('①段 fetch 失败 → 未写入，回 dirty（502 feishu_write_failed），零 overwrite', async () => {
    const fx = makeFixture({
      larkOverrides: {
        fetchDocumentRevision: async () => {
          throw new LarkCliError('lark-cli 执行失败：网络异常', 'upstream', true);
        },
      },
    });
    try {
      await editBody(fx, OVERWRITE_BODY);
      const error = await expectPushError(fx.service.push(fx.objToken, {
        allowOverwrite: true,
        confirm: 'OVERWRITE_CLOUD',
      }));
      expect(error.code).toBe('feishu_write_failed');
      expect(error.status).toBe(502);
      expect(fx.lark.calls.filter((call) => call.op === 'overwrite')).toHaveLength(0);
      expect(fx.store.getSourceEdit(fx.objToken)).toMatchObject({ state: 'dirty' });
      expect(fx.pulls).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('②段写失败（其他错误）→ 回 dirty，保留原始错误码', async () => {
    const fx = makeFixture({
      larkOverrides: {
        overwriteDocument: async () => {
          throw new LarkCliError('lark-cli 执行失败：403 forbidden', 'permission', false, '40403');
        },
        __bodyProvider: () => EXPORTED_BODY,
      },
    });
    try {
      await editBody(fx, OVERWRITE_BODY);
      const error = await expectPushError(fx.service.push(fx.objToken, {
        allowOverwrite: true,
        confirm: 'OVERWRITE_CLOUD',
      }));
      expect(error.code).toBe('feishu_write_failed');
      expect(error.details).toMatchObject({ larkCode: '40403' });
      const row = fx.store.getSourceEdit(fx.objToken);
      expect(row?.state).toBe('dirty');
      expect(row?.lastErrorCode).toBe('lark_40403');
    } finally {
      fx.cleanup();
    }
  });

  it('③段回读 fetch 失败 → 写已发生结果未知 → conflict(push_outcome_unknown)', async () => {
    const fx = makeFixture({
      larkOverrides: {
        fetchDocumentMarkdown: async () => {
          throw new LarkCliError('lark-cli 执行超时', 'timeout', true);
        },
      },
    });
    try {
      await editBody(fx, OVERWRITE_BODY);
      const error = await expectPushError(fx.service.push(fx.objToken, {
        allowOverwrite: true,
        confirm: 'OVERWRITE_CLOUD',
      }));
      expect(error.details).toMatchObject({ lastErrorCode: 'push_outcome_unknown', revisionId: 7 });
      expect(fx.store.getSourceEdit(fx.objToken)).toMatchObject({
        state: 'conflict',
        lastErrorCode: 'push_outcome_unknown',
      });
    } finally {
      fx.cleanup();
    }
  });
});

describe('FeishuWriteService.push — 前置门与状态机', () => {
  it('obj_edit_time 前进 → 409 source_push_conflict + 状态 conflict；force+OVERWRITE_CLOUD 越过', async () => {
    const fx = makeFixture({
      larkOverrides: {
        getDocumentMetas: async (reqs: Array<{ docToken: string }>) => ({
          metas: reqs.map((r) => ({ docToken: r.docToken, docType: 'docx', latestModifyTime: BASE_EDIT_TIME + 1, title: '' })),
          failed: [],
        }),
      },
    });
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加\n');
      const error = await expectPushError(fx.service.push(fx.objToken, { confirm: 'PUSH' }));
      expect(error.code).toBe('source_push_conflict');
      expect(error.status).toBe(409);
      expect(error.details).toMatchObject({ cloudObjEditTime: BASE_EDIT_TIME + 1 });
      expect(fx.lark.calls.filter((call) => call.op === 'append')).toHaveLength(0);
      expect(fx.store.getSourceEdit(fx.objToken)).toMatchObject({ state: 'conflict' });

      // force 越过（append + force → confirm 必须是 OVERWRITE_CLOUD）。
      const result = await fx.service.push(fx.objToken, { force: true, confirm: 'OVERWRITE_CLOUD' });
      expect(result.mode).toBe('append');
      expect(result.pull.ok).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('append 超时结果未知 → conflict(push_outcome_unknown)，不重试', async () => {
    const fx = makeFixture({
      larkOverrides: {
        updateDocumentAppend: async () => {
          throw new LarkCliError('lark-cli 执行超时', 'timeout', true);
        },
      },
    });
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加\n');
      const error = await expectPushError(fx.service.push(fx.objToken, { confirm: 'PUSH' }));
      expect(error.code).toBe('source_push_conflict');
      expect(error.details).toMatchObject({ lastErrorCode: 'push_outcome_unknown' });
      expect(fx.store.getSourceEdit(fx.objToken)).toMatchObject({
        state: 'conflict',
        lastErrorCode: 'push_outcome_unknown',
      });
    } finally {
      fx.cleanup();
    }
  });

  it('T3b-03：metas 读取失败但 revision/write 可达 → 拒写（cloud_time_unreadable，零写入，保留 dirty，不回拉）', async () => {
    const fx = makeFixture({
      larkOverrides: {
        getDocumentMetas: async () => {
          throw new Error('drive metas 网络故障');
        },
      },
    });
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加\n');
      const error = await expectPushError(fx.service.push(fx.objToken, { confirm: 'PUSH' }));
      expect(error.code).toBe('cloud_time_unreadable');
      expect(error.status).toBe(502);
      // 唯一前置防线失效：不写、不回拉、保留 dirty
      expect(fx.lark.calls.filter((call) => call.op === 'append' || call.op === 'overwrite')).toHaveLength(0);
      expect(fx.pulls).toHaveLength(0);
      expect(fx.store.getSourceEdit(fx.objToken)).toMatchObject({
        state: 'dirty',
        lastErrorCode: 'cloud_time_unreadable',
      });
      // 审计记录 fail-closed 拒绝
      const audit = fs.readFileSync(path.join(fx.dataRoot, 'agent', 'audit', 'source-pushes.jsonl'), 'utf-8').trim().split('\n');
      expect(audit.some((line) => {
        const entry = JSON.parse(line) as Record<string, unknown>;
        return entry.result === 'error' && entry.errorCode === 'cloud_time_unreadable';
      })).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('T3b-03：metas 返回空/failed → 同样拒写；force + OVERWRITE_CLOUD 越过（显式用户决策）', async () => {
    const fx = makeFixture({
      larkOverrides: {
        getDocumentMetas: async () => ({ metas: [], failed: [{ docToken: 'doxcnPush0001', reason: 'forbidden' }] }),
      },
    });
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加\n');
      const error = await expectPushError(fx.service.push(fx.objToken, { confirm: 'PUSH' }));
      expect(error.code).toBe('cloud_time_unreadable');
      expect(fx.lark.calls.filter((call) => call.op === 'append')).toHaveLength(0);
      expect(fx.store.getSourceEdit(fx.objToken)).toMatchObject({ state: 'dirty' });

      // force + OVERWRITE_CLOUD 仍可越过（不再读 metas，直接三段式/append）
      const result = await fx.service.push(fx.objToken, { force: true, confirm: 'OVERWRITE_CLOUD' });
      expect(result.mode).toBe('append');
      expect(result.pull.ok).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('confirm 门：append 用 OVERWRITE_CLOUD / overwrite 用 PUSH 均 400', async () => {
    const fx = makeFixture();
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加\n');
      const error = await expectPushError(fx.service.push(fx.objToken, { confirm: 'OVERWRITE_CLOUD' }));
      expect(error.code).toBe('confirmation_required');

      await editBody(fx, '# 改标题\n\n正文基线 ALPHA。\n');
      const error2 = await expectPushError(fx.service.push(fx.objToken, {
        allowOverwrite: true,
        confirm: 'PUSH',
      }));
      expect(error2.code).toBe('confirmation_required');
      expect(error2.message).toContain('OVERWRITE_CLOUD');
    } finally {
      fx.cleanup();
    }
  });

  it('写门：未开启 → 403 feishu_write_disabled；scope 缺失 → 403 feishu_write_scope_missing', async () => {
    const fx = makeFixture({ feishuWriteEnabled: false });
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加\n');
      const error = await expectPushError(fx.service.push(fx.objToken, { confirm: 'PUSH' }));
      expect(error.code).toBe('feishu_write_disabled');
    } finally {
      fx.cleanup();
    }

    const fx2 = makeFixture({
      larkOverrides: {
        checkAuthReady: async () => ({ ready: true, verified: true, currentScopes: ['wiki:node:retrieve'], missingScopes: [] }),
      },
    });
    try {
      await editBody(fx2, '# 测试文档\n\n正文基线 ALPHA。\n追加\n');
      const error = await expectPushError(fx2.service.push(fx2.objToken, { confirm: 'PUSH' }));
      expect(error.code).toBe('feishu_write_scope_missing');
      expect(error.details).toMatchObject({ missingScopes: ['docx:document:write_only'] });
      expect(fx2.store.getSourceEdit(fx2.objToken)?.state).toBe('dirty');
    } finally {
      fx2.cleanup();
    }
  });

  it('plan blocked → 422 source_push_blocked（details.reason）；pushing → 409 source_push_in_progress', async () => {
    const fx = makeFixture();
    try {
      // no_changes：正文与基线归一化等价（仅末尾空行差异）。
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n\n');
      const error = await expectPushError(fx.service.push(fx.objToken, { confirm: 'PUSH' }));
      expect(error.code).toBe('source_push_blocked');
      expect(error.details).toMatchObject({ reason: 'no_changes' });

      // images_in_append。
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n![](images/09-z.png)\n');
      const error2 = await expectPushError(fx.service.push(fx.objToken, { confirm: 'PUSH' }));
      expect(error2.details).toMatchObject({ reason: 'images_in_append' });

      // overwrite_required（未 allowOverwrite）。
      await editBody(fx, '# 改标题\n\n正文基线 ALPHA。\n');
      const error3 = await expectPushError(fx.service.push(fx.objToken, { confirm: 'PUSH' }));
      expect(error3.details).toMatchObject({ reason: 'overwrite_required' });

      // pushing 中拒绝二次推送。
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加\n');
      fx.store.markSourceEditPushing(fx.objToken);
      const error4 = await expectPushError(fx.service.push(fx.objToken, { confirm: 'PUSH' }));
      expect(error4.code).toBe('source_push_in_progress');
    } finally {
      fx.cleanup();
    }
  });

  it('无编辑行 / base.md 缺失：404 / 500', async () => {
    const fx = makeFixture();
    try {
      const error = await expectPushError(fx.service.push(fx.objToken, { confirm: 'PUSH' }));
      expect(error.code).toBe('source_edit_not_found');

      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加\n');
      fs.rmSync(path.join(fx.dataRoot, 'source-edits', fx.objToken, 'base.md'));
      const error2 = await expectPushError(fx.service.push(fx.objToken, { confirm: 'PUSH' }));
      expect(error2.code).toBe('push_base_missing');
      expect(error2.status).toBe(500);
    } finally {
      fx.cleanup();
    }
  });
});

describe('FeishuWriteService.preview — 计划态', () => {
  it('append 计划：bytes=后缀字节、cloud 信息、conflict 计算', async () => {
    const fx = makeFixture();
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加段\n');
      const plan = await fx.service.preview(fx.objToken);
      expect(plan.mode).toBe('append');
      expect(plan.appendMarkdown).toBe('追加段\n');
      expect(plan.bytes).toBe(Buffer.byteLength('追加段\n', 'utf-8'));
      expect(plan.conflict).toBe(false);
      expect(plan.cloud.revisionId).toBe(5);
      expect(plan.cloud.objEditTime).toBe(String(BASE_EDIT_TIME));
    } finally {
      fx.cleanup();
    }
  });

  it('未开启写回 → blocked(write_disabled)；scope 缺失 → blocked(write_scope_missing)', async () => {
    const fx = makeFixture({ feishuWriteEnabled: false });
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加段\n');
      const plan = await fx.service.preview(fx.objToken);
      expect(plan).toMatchObject({ mode: 'blocked', blockedReason: 'write_disabled' });
    } finally {
      fx.cleanup();
    }
    const fx2 = makeFixture({
      larkOverrides: {
        checkAuthReady: async () => ({ ready: true, verified: true, currentScopes: [], missingScopes: [] }),
      },
    });
    try {
      await editBody(fx2, '# 测试文档\n\n正文基线 ALPHA。\n追加段\n');
      const plan = await fx2.service.preview(fx2.objToken);
      expect(plan).toMatchObject({ mode: 'blocked', blockedReason: 'write_scope_missing' });
    } finally {
      fx2.cleanup();
    }
  });

  it('云端 obj_edit_time 越过基线 → conflict=true + overwrite 警告', async () => {
    const fx = makeFixture({
      larkOverrides: {
        getDocumentMetas: async (reqs: Array<{ docToken: string }>) => ({
          metas: reqs.map((r) => ({ docToken: r.docToken, docType: 'docx', latestModifyTime: BASE_EDIT_TIME + 5, title: '' })),
          failed: [],
        }),
      },
    });
    try {
      await editBody(fx, '# 改标题\n\n正文基线 ALPHA。\n');
      const plan = await fx.service.preview(fx.objToken);
      expect(plan.mode).toBe('overwrite');
      expect(plan.conflict).toBe(true);
      expect(plan.warnings.some((w) => w.includes('评论锚点'))).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('T3b-03：metas 不可读 → blocked(cloud_time_unreadable) + fail-closed 警告（不再按无前置冲突放行）', async () => {
    const fx = makeFixture({
      larkOverrides: {
        getDocumentMetas: async () => {
          throw new Error('drive metas 网络故障');
        },
      },
    });
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加\n');
      const plan = await fx.service.preview(fx.objToken);
      expect(plan.mode).toBe('blocked');
      expect(plan.blockedReason).toBe('cloud_time_unreadable');
      expect(plan.conflict).toBe(false);
      expect(plan.warnings.some((w) => w.includes('fail-closed'))).toBe(true);
      expect(plan.warnings.some((w) => w.includes('已按无前置冲突处理'))).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});

describe('LocalMapStore — S12 状态原语与启动对账', () => {
  it('markInterruptedSourceEditPushes：pushing → conflict(push_interrupted)', async () => {
    const fx = makeFixture();
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加\n');
      fx.store.markSourceEditPushing(fx.objToken);
      expect(fx.store.getSourceEdit(fx.objToken)?.state).toBe('pushing');
      const count = fx.store.markInterruptedSourceEditPushes();
      expect(count).toBe(1);
      expect(fx.store.getSourceEdit(fx.objToken)).toMatchObject({
        state: 'conflict',
        lastErrorCode: 'push_interrupted',
      });
      expect(fx.store.markInterruptedSourceEditPushes()).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  it('markSourceEditConflict / markSourceEditPushAborted 不推进 edit_count', async () => {
    const fx = makeFixture();
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n追加\n');
      fx.store.markSourceEditPushing(fx.objToken);
      fx.store.markSourceEditConflict(fx.objToken, { code: 'push_readback_mismatch', message: 'x'.repeat(900) });
      let row = fx.store.getSourceEdit(fx.objToken);
      expect(row).toMatchObject({ state: 'conflict', lastErrorCode: 'push_readback_mismatch' });
      expect(row!.lastErrorMessage!.length).toBeLessThanOrEqual(500);
      const countBefore = row!.editCount;

      fx.store.markSourceEditPushAborted(fx.objToken, { code: 'lark_40403', message: 'boom' });
      row = fx.store.getSourceEdit(fx.objToken);
      expect(row).toMatchObject({ state: 'dirty', lastErrorCode: 'lark_40403', editCount: countBefore });
    } finally {
      fx.cleanup();
    }
  });
});

// ===========================================================================
// D. 路由层（feishuRoutes push API + scopeSet + auth-status）
// ===========================================================================

function makeApp(deps: Record<string, unknown>): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    Object.assign(c, deps);
    await next();
  });
  app.route('/', feishuRoutes);
  return app;
}

describe('routes/feishu — push API 契约', () => {
  let fx: Fixture;
  let prevHome: string | undefined;

  beforeEach(async () => {
    fx = makeFixture();
    await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n路由追加段\n');
    // createFeishuWriteService 内部 resolveDataRoot() → 让其指向 fixture
    // 数据根（base.md/审计与 fixture 对齐）。
    prevHome = process.env.FEISHU_SYNC_HOME;
    process.env.FEISHU_SYNC_HOME = fx.dataRoot;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FEISHU_SYNC_HOME;
    else process.env.FEISHU_SYNC_HOME = prevHome;
    fx.cleanup();
  });

  function app(): Hono {
    return makeApp({
      larkCliClient: fx.lark,
      larkCliManager: {
        startDeviceAuth: async (mode: string, options: { scopeSet?: string }) => ({
          verificationUrl: 'https://example.com/v', deviceCode: 'dc-1', expiresIn: 600,
          requestedScopes: [], mode, scopeSet: options.scopeSet ?? 'read',
        }),
      },
      configManager: { getConfig: () => ({ knowledgeBaseRoot: fx.kbRoot, feishuWrite: { enabled: true } }), load: async () => ({}) },
      localMapStore: fx.store,
      kbBuildService: { activeBuild: () => null },
    });
  }

  it('push/preview 返回计划；push 执行成功并回拉清行', async () => {
    const response = await app().request(`/api/sources/${OBJ}/push/preview`, { method: 'POST' });
    expect(response.status).toBe(200);
    const plan = await response.json();
    expect(plan.mode).toBe('append');
    expect(plan.appendMarkdown).toBe('路由追加段\n');

    const pushResponse = await app().request(`/api/sources/${OBJ}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'PUSH' }),
    });
    expect(pushResponse.status).toBe(200);
    const result = await pushResponse.json();
    // 路由层契约：append 执行成功、状态离开 dirty。回拉的「成功→清行」
    // 语义在服务层测试锚定（这里 fake config 无法跑完真实 SyncEngine，
    // pull 结果如实上报即可）。
    expect(result.mode).toBe('append');
    expect(typeof result.pull.ok).toBe('boolean');
    const row = fx.store.getSourceEdit(OBJ);
    expect(row === null || row.state === 'pushed').toBe(true);
  });

  it('confirm 门：缺省/错误 confirm → 400；403/409 错误体形状', async () => {
    const bad = await app().request(`/api/sources/${OBJ}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'YES' }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'confirmation_required' });

    const conflictFx = fx;
    (conflictFx.lark as Record<string, unknown>).getDocumentMetas = async (reqs: Array<{ docToken: string }>) => ({
      metas: reqs.map((r) => ({ docToken: r.docToken, docType: 'docx', latestModifyTime: BASE_EDIT_TIME + 2, title: '' })),
      failed: [],
    });
    const conflict = await app().request(`/api/sources/${OBJ}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'PUSH' }),
    });
    expect(conflict.status).toBe(409);
    const body = await conflict.json();
    expect(body.error).toBe('source_push_conflict');
    expect(body.details).toMatchObject({ cloudObjEditTime: BASE_EDIT_TIME + 2 });
    expect(conflictFx.store.getSourceEdit(OBJ)?.state).toBe('conflict');
  });

  it('auth-status 增补 writeScopesGranted；device/start 校验 scopeSet', async () => {
    const status = await app().request('/api/feishu/auth-status');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ ready: true, writeScopesGranted: true });

    const invalid = await app().request('/api/feishu/auth/device/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopeSet: 'admin' }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'invalid_body' });

    const start = await app().request('/api/feishu/auth/device/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopeSet: 'write' }),
    });
    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({ scopeSet: 'write' });
  });
});

// ===========================================================================
// E. scope 授权流：read/write 两次 start 的 scope 集断言（真实 manager 链）
// ===========================================================================

describe('LarkCliManager.startDeviceAuth — scopeSet read/write', () => {
  const DEVICE_AUTH_JSON = JSON.stringify({
    ok: true,
    device_code: 'dc-123',
    verification_url: 'https://example.com/verify',
    expires_in: 600,
  });

  let tmpRoot: string;

  beforeEach(() => {
    execFileMock.mockClear();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srcpush-auth-'));
    const binDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'lark-cli'), '#!/usr/bin/env node\n', { mode: 0o755 });
    setExecHandler((_file, args) => (args.includes('--no-wait') ? { stdout: DEVICE_AUTH_JSON } : { stdout: '' }));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function manager() {
    const client = {
      checkAuthReady: vi.fn(async () => ({ ready: false, currentScopes: [], error: 'not authed' })),
    };
    const configManager = {
      getConfig: () => ({ requiredScopes: ['wiki:node:retrieve', 'offline_access'] }),
      load: async () => ({ requiredScopes: ['wiki:node:retrieve', 'offline_access'] }),
    };
    return new LarkCliManager(client as never, configManager as never, {
      platform: 'darwin',
      env: { PATH: path.join(tmpRoot, 'bin') },
      homeDir: tmpRoot,
    });
  }

  it('read（缺省）：请求集 = requiredScopes（写 scope 不出现）', async () => {
    const session = await manager().startDeviceAuth('reauthorize');
    expect(session.scopeSet).toBe('read');
    expect(session.requestedScopes).toEqual(['wiki:node:retrieve', 'offline_access']);
    const scopeArg = execFileMock.mock.calls[0][1].at(-1);
    expect(scopeArg).toBe('wiki:node:retrieve offline_access');
    expect(scopeArg).not.toContain('docx:document:write_only');
  });

  it('write：请求集 = requiredScopes ∪ WRITE_SCOPES', async () => {
    const session = await manager().startDeviceAuth('reauthorize', { scopeSet: 'write' });
    expect(session.scopeSet).toBe('write');
    expect(session.requestedScopes).toEqual(['wiki:node:retrieve', 'offline_access', 'docx:document:write_only']);
    const scopeArg = execFileMock.mock.calls[0][1].at(-1);
    expect(scopeArg).toBe('wiki:node:retrieve offline_access docx:document:write_only');
  });
});

// ===========================================================================
// F. T3d-05R：app_command source.push → 真实 feishu 路由 → FeishuWriteService
//    全链（append / overwrite / force / append+allowOverwrite 四态 + 计划过期）
// ===========================================================================

describe('T3d-05R：app_command source.push 确认值按真实计划派生（真实路由全链）', () => {
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.FEISHU_SYNC_HOME;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FEISHU_SYNC_HOME;
    else process.env.FEISHU_SYNC_HOME = prevHome;
  });

  /** 真实 feishuRoutes + 真实 ApprovalService + ops 工具族（进程内转发）。 */
  function appCommandEnv(fx: Fixture) {
    const hono = makeApp({
      larkCliClient: fx.lark,
      larkCliManager: {},
      configManager: { getConfig: () => ({ knowledgeBaseRoot: fx.kbRoot, feishuWrite: { enabled: true } }), load: async () => ({}) },
      localMapStore: fx.store,
      kbBuildService: { activeBuild: () => null },
    });
    process.env.FEISHU_SYNC_HOME = fx.dataRoot;
    const approvals = new ApprovalService({ dataRoot: fx.dataRoot, timeoutMs: 8_000 });
    const toolService = new AgentToolService({ dataRoot: fx.dataRoot, documentsProvider: () => [] });
    toolService.registerToolFamily(createOpsToolFamily({
      approvals,
      getApp: () => hono,
      desktopToken: 'stub-desktop-token',
      configProvider: () => null,
    }));
    const token = toolService.createRunContext({
      runKind: 'work', sessionId: 's_t3d05', outputRoot: os.tmpdir(), knowledgeBaseRoot: fx.kbRoot,
    }).token;
    return {
      approvals,
      token,
      runPush: (args: Record<string, unknown>) =>
        toolService.executeTool(token, 'app_command', { command: 'source.push', args }),
    };
  }

  /** 发起 push → 等待批准卡 → 断言派生确认值。 */
  async function pendingPush(env: ReturnType<typeof appCommandEnv>, args: Record<string, unknown>) {
    const pending = env.runPush(args);
    for (let i = 0; i < 50; i += 1) {
      if (env.approvals.listPending('s_t3d05').length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [dto] = env.approvals.listPending('s_t3d05');
    expect(dto).toBeDefined();
    return { pending, dto };
  }

  it('append：确认值 PUSH；批准 → 真实服务以 append 执行成功', async () => {
    const fx = makeFixture();
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n路由追加段\n');
      const env = appCommandEnv(fx);
      const { pending, dto } = await pendingPush(env, { objToken: OBJ });
      expect(dto.risk).toBe('remote_write');
      expect((dto.preview as { confirmValue?: string }).confirmValue).toBe('PUSH');
      env.approvals.decide('s_t3d05', dto.id, 'approve');
      const result = await pending;
      expect(result.details).toMatchObject({ command: 'source.push' });
      expect(fx.lark.calls.some((call) => call.op === 'append')).toBe(true);
      expect(fx.lark.calls.some((call) => call.op === 'overwrite')).toBe(false);
      const row = fx.store.getSourceEdit(OBJ);
      expect(row === null || row.state === 'pushed').toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('append + allowOverwrite=true（回归）：确认值仍按真实计划派生为 PUSH → 执行成功', async () => {
    const fx = makeFixture();
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n路由追加段\n');
      const env = appCommandEnv(fx);
      const { pending, dto } = await pendingPush(env, { objToken: OBJ, allowOverwrite: true });
      // diting T3b-05R：旧实现按参数猜 OVERWRITE_CLOUD，真实服务按 append
      // 要求 PUSH → confirmation_required 400。现按权威 preview 派生。
      expect((dto.preview as { confirmValue?: string }).confirmValue).toBe('PUSH');
      env.approvals.decide('s_t3d05', dto.id, 'approve');
      await pending;
      expect(fx.lark.calls.some((call) => call.op === 'append')).toBe(true);
      expect(fx.lark.calls.some((call) => call.op === 'overwrite')).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it('overwrite：确认值 OVERWRITE_CLOUD；批准 → 真实服务以 overwrite 执行', async () => {
    const fx = makeFixture();
    try {
      // 修改既有内容（非纯追加）→ 真实计划 = overwrite；回读校验返回预期正文
      const overwritten = '# 测试文档\n\n正文基线 BETA（已改写）。\n';
      await editBody(fx, overwritten);
      (fx.lark as unknown as { __bodyProvider: (() => string) | null }).__bodyProvider = () => overwritten;
      const env = appCommandEnv(fx);
      const { pending, dto } = await pendingPush(env, { objToken: OBJ, allowOverwrite: true });
      expect((dto.preview as { confirmValue?: string }).confirmValue).toBe('OVERWRITE_CLOUD');
      env.approvals.decide('s_t3d05', dto.id, 'approve');
      await pending;
      expect(fx.lark.calls.some((call) => call.op === 'overwrite')).toBe(true);
      expect(fx.lark.calls.some((call) => call.op === 'append')).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it('force=true（append 形态）：确认值 OVERWRITE_CLOUD（与真实服务同契约）→ 执行成功', async () => {
    const fx = makeFixture();
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n路由追加段\n');
      const env = appCommandEnv(fx);
      const { pending, dto } = await pendingPush(env, { objToken: OBJ, force: true });
      expect((dto.preview as { confirmValue?: string }).confirmValue).toBe('OVERWRITE_CLOUD');
      env.approvals.decide('s_t3d05', dto.id, 'approve');
      await pending;
      // force 不改变执行形态：append 计划仍以 append 执行
      expect(fx.lark.calls.some((call) => call.op === 'append')).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('计划过期：批准期间 append→overwrite → approval_plan_expired，零写入', async () => {
    const fx = makeFixture();
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n路由追加段\n');
      const env = appCommandEnv(fx);
      const { pending, dto } = await pendingPush(env, { objToken: OBJ });
      expect((dto.preview as { confirmValue?: string }).confirmValue).toBe('PUSH');
      // 批准前真实计划变化（用户把修改改成覆盖形态）
      await editBody(fx, '# 测试文档\n\n正文基线 BETA（已改写）。\n');
      env.approvals.decide('s_t3d05', dto.id, 'approve');
      await expect(pending).rejects.toMatchObject({ code: 'approval_plan_expired', status: 409 });
      // 零写入：lark 写方法未被调用，本地修改仍保留
      expect(fx.lark.calls.some((call) => call.op === 'append' || call.call === 'overwrite')).toBe(false);
      expect(fx.store.getSourceEdit(OBJ)?.state).toBe('dirty');
    } finally {
      fx.cleanup();
    }
  });

  it('R3-01：metas 不可读（时间门）——非 force：blocked 无批准卡；force：OVERWRITE_CLOUD 批准卡并可执行', async () => {
    const fx = makeFixture({
      larkOverrides: {
        getDocumentMetas: async () => { throw new Error('drive metas unavailable'); },
      },
    });
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n路由追加段\n');
      const env = appCommandEnv(fx);
      // 对照：非 force——preview 不带 force，fail-closed 时间门 → 计划
      // blocked(cloud_time_unreadable)，不产生批准卡，直接工具错误（零写入）
      await expect(env.runPush({ objToken: OBJ })).rejects.toMatchObject({
        code: 'source_push_blocked',
        status: 400,
      });
      expect(env.approvals.listPending('s_t3d05')).toHaveLength(0);
      expect(fx.lark.calls.some((call) => call.op === 'append' || call.op === 'overwrite')).toBe(false);
      // force：preview 与实际执行同参——时间门降为 warning，append 计划
      // 照常 → OVERWRITE_CLOUD 批准卡 → 批准 → 真实服务以 append 执行
      const { pending, dto } = await pendingPush(env, { objToken: OBJ, force: true });
      expect((dto.preview as { confirmValue?: string }).confirmValue).toBe('OVERWRITE_CLOUD');
      env.approvals.decide('s_t3d05', dto.id, 'approve');
      await pending;
      expect(fx.lark.calls.some((call) => call.op === 'append')).toBe(true);
      const row = fx.store.getSourceEdit(OBJ);
      expect(row === null || row.state === 'pushed').toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('R3-01 对照：权限类 blocker 不可被 force 越过（写 scope 缺失仍拒绝、零写入）', async () => {
    const fx = makeFixture({
      larkOverrides: {
        checkAuthReady: async () => ({
          ready: true, verified: true, identity: 'user',
          currentScopes: ['wiki:node:retrieve'], missingScopes: [],
        }),
      },
    });
    try {
      await editBody(fx, '# 测试文档\n\n正文基线 ALPHA。\n路由追加段\n');
      const env = appCommandEnv(fx);
      await expect(env.runPush({ objToken: OBJ, force: true })).rejects.toMatchObject({
        code: 'source_push_blocked',
        status: 400,
      });
      expect(env.approvals.listPending('s_t3d05')).toHaveLength(0);
      expect(fx.lark.calls.some((call) => call.op === 'append' || call.op === 'overwrite')).toBe(false);
      expect(fx.store.getSourceEdit(OBJ)?.state).toBe('dirty');
    } finally {
      fx.cleanup();
    }
  });
});

// ===========================================================================
// G. T3e-R3-02：批准后异步 plan 复核窗口（真实 SessionService + 真实路由）
//    批准后第二次 preview 挂起（metas 门控）→ 停止/换轮 → 释放 →
//    断言零写入（对照：不停止则正常执行）。
// ===========================================================================

/** 受控会话 RPC double（同 app-command-family.test 的 RoundFakeRpc 模式）。 */
class RecheckFakeRpc extends EventEmitter {
  prompts: string[] = [];
  exited = false;
  active = false;
  private resolvers: Array<(value: unknown) => void> = [];

  isExited(): boolean { return this.exited; }
  hasActiveRun(): boolean { return this.active; }
  async start(): Promise<void> {}
  async prompt(message: string): Promise<unknown> {
    this.prompts.push(message);
    this.active = true;
    return new Promise((resolve) => { this.resolvers.push(resolve); });
  }
  resolvePrompt(value: unknown): void {
    this.active = false;
    this.resolvers.shift()?.(value);
  }
  async sendCommand(type: string): Promise<unknown> {
    return type === 'get_state' ? { success: true, data: {} } : { success: true, data: {} };
  }
  async abort(): Promise<void> {}
  async terminate(): Promise<void> { this.exited = true; this.emit('exit'); }
}

function recheckStore(): SessionStoreApi {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    getAgentSession: (id) => (rows.get(id) ? { ...rows.get(id)! } : null),
    createAgentSession: (input) => {
      rows.set(input.id, {
        id: input.id, title: input.title, mode: input.mode, workspace_id: input.workspaceId,
        pi_session_file: null, last_error_code: null, last_error_message: null,
        created_at: input.createdAt, updated_at: input.updatedAt, deleted_at: null,
      });
    },
    listAgentSessions: () => [...rows.values()],
    updateAgentSession: (id, patch) => {
      const row = rows.get(id);
      if (!row) throw new Error(`agent_session 不存在: ${id}`);
      const mapped: Record<string, unknown> = {};
      if ('title' in patch) mapped.title = patch.title;
      if ('mode' in patch) mapped.mode = patch.mode;
      if ('workspaceId' in patch) mapped.workspace_id = patch.workspaceId;
      if ('piSessionFile' in patch) mapped.pi_session_file = patch.piSessionFile;
      if ('lastErrorCode' in patch) mapped.last_error_code = patch.lastErrorCode;
      if ('lastErrorMessage' in patch) mapped.last_error_message = patch.lastErrorMessage;
      if ('updatedAt' in patch) mapped.updated_at = patch.updatedAt;
      if ('deletedAt' in patch) mapped.deleted_at = patch.deletedAt;
      rows.set(id, { ...row, ...mapped });
    },
    listSessionsByWorkspace: () => [],
  } as SessionStoreApi;
}

function recheckConfig(): Config {
  return {
    llm: {
      openAiCompatBaseUrl: 'https://x/v1', apiKey: '', model: 'm', temperature: 0.2,
      primaryChannel: 'direct', fallbackOnFailure: false,
    },
    agent: {
      runtime: {}, model: { source: 'app-llm', thinkingLevel: 'off', contextWindow: 128000, maxTokens: 8192 },
      maxConcurrentProcesses: 2, idleTimeoutMinutes: 10, workspaces: [],
    },
    standardKb: {
      outputRoot: '/tmp/recheck-out', retainReleases: 3, buildBatchSize: 10,
      promptTimeoutMinutes: 15, buildTimeoutMinutes: 180, autoBuildAfterSync: false,
    },
  } as unknown as Config;
}

/**
 * 真实 feishu 路由 + 真实 ApprovalService + 真实 SessionService 全链：
 * getDocumentMetas 第 2 次调用（批准后复核 preview）挂起等 releaseRecheck。
 */
function makeRecheckEnv() {
  let metasCalls = 0;
  let releaseRecheck: (() => void) | null = null;
  const fx = makeFixture({
    larkOverrides: {
      getDocumentMetas: async (reqs: Array<{ docToken: string; docType: string }>) => {
        metasCalls += 1;
        if (metasCalls === 2) {
          await new Promise<void>((resolve) => { releaseRecheck = resolve; });
        }
        return {
          metas: reqs.map((r) => ({
            docToken: r.docToken, docType: r.docType, latestModifyTime: BASE_EDIT_TIME, title: '',
          })),
          failed: [],
        };
      },
    },
  });
  const prevHome = process.env.FEISHU_SYNC_HOME;
  process.env.FEISHU_SYNC_HOME = fx.dataRoot;
  const hono = makeApp({
    larkCliClient: fx.lark,
    larkCliManager: {},
    configManager: {
      getConfig: () => ({ knowledgeBaseRoot: fx.kbRoot, feishuWrite: { enabled: true } }),
      load: async () => ({}),
    },
    localMapStore: fx.store,
    kbBuildService: { activeBuild: () => null },
  });
  const pool = new AgentProcessPool({ maxConcurrentProcesses: 2 });
  const approvals = new ApprovalService({ dataRoot: fx.dataRoot, timeoutMs: 8_000 });
  const toolService = new AgentToolService({ dataRoot: fx.dataRoot, documentsProvider: () => [] });
  const config = recheckConfig();
  const store = recheckStore();
  const sessions = new SessionService({
    dataRoot: fx.dataRoot,
    pool,
    toolService,
    resolver: new PiRuntimeResolver(),
    configProvider: () => config,
    internalBaseUrl: () => 'http://127.0.0.1:39999',
    extensionPath: () => null,
    workspaceGuards: () => ({
      knowledgeBaseRoot: '/tmp/recheck-kb', outputRoot: config.standardKb.outputRoot, dataRoot: fx.dataRoot,
    }),
  });
  toolService.registerToolFamily(createOpsToolFamily({
    approvals,
    getApp: () => hono,
    desktopToken: 'stub-desktop-token',
    configProvider: () => null,
    sessionRunState: (sid) => sessions.runState(sid),
    toolCallRun: (sid, toolCallId) => sessions.runOfToolCall(sid, toolCallId),
    currentRunId: (sid) => sessions.currentRunId(sid),
    sessionAbortSignal: (sid) => sessions.abortSignal(sid),
  }));
  // 预注册 fake 进程并同步 modelRevisions（复用进程不触发真实 spawn）
  const register = pool.register.bind(pool);
  const registerSpy = vi.spyOn(pool, 'register').mockImplementation((...args) => {
    (sessions as unknown as { modelRevisions: WeakMap<PiRpcProcess, string> }).modelRevisions.set(
      args[1], modelRevision(config),
    );
    return register(...args);
  });
  const session = sessions.create(store, { title: '复核窗口' });
  const fake = new RecheckFakeRpc();
  pool.register(session.id, fake as unknown as PiRpcProcess, 'session');
  const token = toolService.createRunContext({
    runKind: 'work', sessionId: session.id, outputRoot: os.tmpdir(), knowledgeBaseRoot: fx.kbRoot,
  }).token;
  const writeCalls = () => fx.lark.calls.filter((call) => call.op === 'append' || call.op === 'overwrite');
  return {
    fx, sessions, store, session, fake, token, approvals, toolService, writeCalls,
    metasCalls: () => metasCalls,
    releaseRecheck: () => releaseRecheck?.(),
    cleanup: async () => {
      approvals.close();
      await pool.closeAll();
      registerSpy.mockRestore();
      if (prevHome === undefined) delete process.env.FEISHU_SYNC_HOME;
      else process.env.FEISHU_SYNC_HOME = prevHome;
      fx.cleanup();
    },
  };
}

describe('T3e-R3-02：批准后异步 plan 复核窗口（真实 SessionService + 真实路由）', () => {
  /** 发起 run + 登记 toolCall 归属 + 发起 source.push（挂起等批准）。 */
  async function startPush(env: ReturnType<typeof makeRecheckEnv>, toolCallId: string) {
    const run = await env.sessions.sendMessage(env.store, env.session.id, { text: `轮次-${toolCallId}` });
    await vi.waitFor(() => expect(env.sessions.currentRunId(env.session.id)).toBe(run.runId));
    env.fake.emit('tool_execution_start', { toolCallId, toolName: 'app_command' });
    const pending = env.toolService.executeTool(
      env.token,
      'app_command',
      { command: 'source.push', args: { objToken: OBJ } },
      { toolCallId },
    );
    await vi.waitFor(() => expect(env.approvals.listPending(env.session.id).length).toBe(1));
    const [dto] = env.approvals.listPending(env.session.id);
    expect(dto.runId).toBe(run.runId); // 批准卡绑定 server 权威轮次
    env.approvals.decide(env.session.id, dto.id, 'approve');
    // 批准后复核 preview 挂起（metas 第 2 次调用）
    await vi.waitFor(() => expect(env.metasCalls()).toBe(2));
    return { pending, run };
  }

  it('停止：批准后复核 preview 挂起 → abort 立即拒绝；释放挂起 preview 后仍零写入', async () => {
    const env = makeRecheckEnv();
    try {
      await editBody(env.fx, '# 测试文档\n\n正文基线 ALPHA。\n路由追加段\n');
      const { pending } = await startPush(env, 'tc_recheck_1');
      // 停止请求 → 停止信号立即取消复核链（不等挂起的 preview 返回）
      const rejection = expect(pending).rejects.toMatchObject({ code: 'approval_cancelled', status: 409 });
      await env.sessions.abort(env.store, env.session.id);
      await rejection;
      expect(env.writeCalls()).toHaveLength(0);
      // 释放挂起的复核 preview：被弃置的链路不得补发写入（本地仍 dirty）
      env.releaseRecheck();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(env.writeCalls()).toHaveLength(0);
      expect(env.fx.store.getSourceEdit(OBJ)?.state).toBe('dirty');
      // 收尾：结束挂起的 run prompt
      env.fake.resolvePrompt({ outcome: 'aborted', lastAssistantText: '' });
      await vi.waitFor(() => expect(env.sessions.currentRunId(env.session.id)).toBeNull());
    } finally {
      await env.cleanup();
    }
  });

  it('换轮：run1 结束 + run2 开始 → 释放复核 preview → approval_round_expired，零写入', async () => {
    const env = makeRecheckEnv();
    try {
      await editBody(env.fx, '# 测试文档\n\n正文基线 ALPHA。\n路由追加段\n');
      const { pending } = await startPush(env, 'tc_recheck_2');
      // 复核挂起期间：run1 结束（超时/异常）并开始 run2（旧批准不可跨轮执行）
      env.fake.resolvePrompt({ outcome: 'completed', lastAssistantText: '第一轮结束' });
      await vi.waitFor(() => expect(env.sessions.currentRunId(env.session.id)).toBeNull());
      const run2 = await env.sessions.sendMessage(env.store, env.session.id, { text: '第二轮' });
      await vi.waitFor(() => expect(env.sessions.currentRunId(env.session.id)).toBe(run2.runId));
      env.releaseRecheck();
      await expect(pending).rejects.toMatchObject({ code: 'approval_round_expired', status: 409 });
      expect(env.writeCalls()).toHaveLength(0);
      expect(env.fx.store.getSourceEdit(OBJ)?.state).toBe('dirty');
      env.fake.resolvePrompt({ outcome: 'completed', lastAssistantText: '第二轮结束' });
      await vi.waitFor(() => expect(env.sessions.currentRunId(env.session.id)).toBeNull());
    } finally {
      await env.cleanup();
    }
  });

  it('对照（不停止）：复核 preview 释放后计划未变 → 正常执行 append', async () => {
    const env = makeRecheckEnv();
    try {
      await editBody(env.fx, '# 测试文档\n\n正文基线 ALPHA。\n路由追加段\n');
      const { pending } = await startPush(env, 'tc_recheck_3');
      env.releaseRecheck();
      const result = await pending;
      expect(result.details).toMatchObject({ command: 'source.push' });
      expect(env.fx.lark.calls.some((call) => call.op === 'append')).toBe(true);
      env.fake.resolvePrompt({ outcome: 'completed', lastAssistantText: '完成' });
      await vi.waitFor(() => expect(env.sessions.currentRunId(env.session.id)).toBeNull());
    } finally {
      await env.cleanup();
    }
  });
});
