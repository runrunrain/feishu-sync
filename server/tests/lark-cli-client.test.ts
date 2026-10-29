import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLarkCliEnvironment,
  LarkCliClient,
  LarkCliError,
  quoteWindowsShellArguments,
  resolveLarkCliExecutable,
  resolveMediaOutputTarget,
} from '../src/modules/lark-cli-client.js';

type ClientInternals = {
  parseJsonOutput(stdout: string): any;
  extractJsonValues(stdout: string): string[];
  classifyError(message: string, upstreamCode?: string): import('../src/modules/lark-cli-client.js').LarkCliError;
};

function createClient(): LarkCliClient {
  return new LarkCliClient({
    requiredScopes: [],
    timeout: 1_000,
    larkCliPath: 'lark-cli-not-invoked-by-these-tests',
  });
}

function internals(client: LarkCliClient): ClientInternals {
  return client as unknown as ClientInternals;
}

describe('LarkCliClient output parsing and classification', () => {
  it.each([
    { status: 'verify_failed', available: false, verified: false },
    { status: 'missing', available: false, verified: false },
    { status: 'ready', available: true, verified: undefined },
  ])('rejects stale grants when user diagnostics are $status / verified=$verified', async (diagnostics) => {
    const client = new LarkCliClient({ requiredScopes: ['wiki:node:retrieve'], timeout: 1_000, larkCliPath: 'lark-cli-not-invoked-by-these-tests' });
    const calls: string[][] = [];
    (client as any).execute = async (args: string[]) => {
      calls.push(args);
      return args[0] === '--version' ? { ok: true, data: { version: '1.0.97' } } : {
        ok: true, data: { identity: 'user', verified: true, identities: {
          user: { ...diagnostics, scope: 'wiki:node:retrieve', openId: 'ou-revoked', userName: '旧账号' },
        } },
      };
    };
    const result = await client.checkAuthReady();
    expect(calls[1]).toEqual(['auth', 'status', '--json', '--verify']);
    expect(result.ready).toBe(false);
    expect(result.account).toEqual({ id: 'ou-revoked', name: '旧账号' });
  });

  it('accepts a refreshed and server-verified user, independent of bot verification', async () => {
    const client = new LarkCliClient({ requiredScopes: ['wiki:node:retrieve'], timeout: 1_000, larkCliPath: 'lark-cli-not-invoked-by-these-tests' });
    (client as any).execute = async (args: string[]) => args[0] === '--version'
      ? { ok: true, data: { version: '1.0.97' } }
      : { ok: true, data: { identity: 'user', identities: {
        bot: { verified: false },
        user: { status: 'needs_refresh', available: true, verified: true, openId: 'ou-new', scope: 'wiki:node:retrieve' },
      } } };
    expect(await client.checkAuthReady()).toMatchObject({ ready: true, verified: true, account: { id: 'ou-new' } });
    expect(await client.checkAuthReady({ verify: false })).toMatchObject({ ready: false, account: { id: 'ou-new' } });
  });

  it('discovers the common local Node installation and preserves its bin directory for script shims', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-lark-cli-'));
    try {
      const binDir = path.join(homeDir, '.local', 'node', 'bin');
      const executable = path.join(binDir, 'lark-cli');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o755 });

      const resolved = resolveLarkCliExecutable(undefined, {
        homeDir,
        platform: 'darwin',
        env: { PATH: '/usr/bin:/bin' },
      });

      expect(resolved).toBe(executable);
      expect(buildLarkCliEnvironment(resolved, { PATH: '/usr/bin:/bin' }).PATH)
        .toBe(`${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('merges log-prefixed ANSI NDJSON pages without losing nodes', () => {
    const client = createClient();
    const result = internals(client).parseJsonOutput(
      '\u001b[32mINFO fetching page 1\u001b[0m\n' +
      '{"data":{"nodes":[{"node_token":"A"}],"has_more":true}}\n' +
      'progress: 50%\n' +
      '{"data":{"nodes":[{"node_token":"B"}],"has_more":false}}\n',
    );

    expect(result).toEqual({
      ok: true,
      data: {
        nodes: [{ node_token: 'A' }, { node_token: 'B' }],
        has_more: false,
      },
    });
  });

  it('aggregates lark-cli >=1.0.89 bare-entity ndjson streams into data.records', () => {
    // 2026-09 real incident shape: `wiki +node-list --format ndjson --page-all`
    // on lark-cli 1.0.89 emits `Found N node(s)` plus one bare node object per
    // line (no ok/data wrapper). Without bare-stream aggregation the page
    // merger collapsed the stream into the LAST node's scalars, so BFS saw an
    // empty tree with complete=true and 146 synced documents were mass-marked
    // missing_candidate.
    const client = createClient();
    const result = internals(client).parseJsonOutput(
      'Found 2 node(s)\n' +
      '{"node_token":"A","obj_token":"oa","obj_type":"docx","has_child":true,"title":"甲"}\n' +
      '{"node_token":"B","obj_token":"ob","obj_type":"sheet","has_child":false,"title":"乙"}\n',
    );

    expect(result).toEqual({
      ok: true,
      data: {
        records: [
          { node_token: 'A', obj_token: 'oa', obj_type: 'docx', has_child: true, title: '甲' },
          { node_token: 'B', obj_token: 'ob', obj_type: 'sheet', has_child: false, title: '乙' },
        ],
      },
    });
  });

  it.each([0, 1, 2])('lists %i bare NDJSON wiki nodes without dropping a singleton', async (count) => {
    const client = createClient();
    const nodes = Array.from({ length: count }, (_, index) => ({
      node_token: `node-${index}`,
      obj_token: `obj-${index}`,
      obj_type: 'sheet',
      title: `子文档 ${index}`,
      has_child: true,
      parent_node_token: 'parent',
      space_id: 'space',
    }));
    (client as any).execute = async (args: string[]) => {
      expect(args).toEqual([
        'wiki', '+node-list', '--format', 'ndjson', '--page-all', '--page-limit', '0',
        '--space-id', 'space', '--parent-node-token', 'parent',
      ]);
      return internals(client).parseJsonOutput(nodes.map((node) => JSON.stringify(node)).join('\n'));
    };

    expect(await client.listWikiNodes({ spaceId: 'space', parentNodeToken: 'parent' })).toEqual(nodes);
  });

  it.each(['win32', 'darwin'])('preserves large metadata JSON through the %s CLI boundary', async (platform) => {
    const client = createClient();
    const requests = Array.from({ length: 135 }, (_, index) => ({
      docToken: `document-${index.toString().padStart(19, '0')}`,
      docType: 'docx',
    }));
    const batchSizes: number[] = [];
    const requestFiles: string[] = [];
    (client as any).execute = async (args: string[]) => {
      const dataArgument = args[args.indexOf('--data') + 1];
      if (platform === 'win32') {
        expect(dataArgument.startsWith('@')).toBe(true);
        requestFiles.push(dataArgument.slice(1));
      }
      const batch = JSON.parse(dataArgument.startsWith('@')
        ? fs.readFileSync(dataArgument.slice(1), 'utf8') : dataArgument).request_docs;
      batchSizes.push(batch.length);
      if (platform === 'win32') expect(args.join(' ').length).toBeLessThan(7000);
      return { ok: true, data: {
        metas: batch.slice(0, -1).map((node: { doc_token: string; doc_type: string }) => ({
          ...node, latest_modify_time: '1000', title: node.doc_token,
        })),
        failed_list: [{ token: batch.at(-1).doc_token, code: 970003 }],
      } };
    };
    vi.stubGlobal('process', { ...process, platform });
    try {
      const result = await client.getDocumentMetas(requests);
      expect(batchSizes).toEqual([135]);
      expect(result.metas.length + result.failed.length).toBe(requests.length);
      expect(new Set([...result.metas.map((node) => node.docToken), ...result.failed.map((node) => node.docToken)]).size)
        .toBe(requests.length);
      for (const requestFile of requestFiles) {
        expect(fs.existsSync(requestFile)).toBe(false);
        expect(fs.existsSync(path.dirname(requestFile))).toBe(false);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('removes the Windows metadata request file after a failed CLI call', async () => {
    const client = createClient();
    let requestFile = '';
    (client as any).execute = async (args: string[]) => {
      requestFile = args[args.indexOf('--data') + 1].slice(1);
      expect(fs.existsSync(requestFile)).toBe(true);
      throw new Error('metadata request failed');
    };
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    try {
      await expect(client.getDocumentMetas([{ docToken: 'document', docType: 'docx' }]))
        .rejects.toThrow('metadata request failed');
      expect(fs.existsSync(requestFile)).toBe(false);
      expect(fs.existsSync(path.dirname(requestFile))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('handles braces inside JSON strings while extracting a log-prefixed value', () => {
    const client = createClient();
    const values = internals(client).extractJsonValues(
      'debug before {not-json}\n{"data":{"title":"literal } and { braces"}}\n',
    );
    expect(values).toContain('{"data":{"title":"literal } and { braces"}}');
    expect(internals(client).parseJsonOutput('debug {not-json}\n{"data":{"title":"literal } and { braces"}}'))
      .toEqual({ ok: true, data: { title: 'literal } and { braces' } });
  });

  it('classifies JSON permission errors as non-retryable structured errors', () => {
    const client = createClient();
    try {
      internals(client).parseJsonOutput('{"ok":false,"code":40403,"msg":"forbidden"}');
      throw new Error('expected parseJsonOutput to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LarkCliError);
      expect(error).toMatchObject({ code: 'permission', retryable: false, upstreamCode: '40403' });
    }
  });

  it('classifies a deleted document page as non-retryable', () => {
    const client = createClient();
    try {
      internals(client).parseJsonOutput(
        '{"ok":false,"code":3380003,"message":"Document page has been deleted. This page can no longer be edited"}',
      );
      throw new Error('expected parseJsonOutput to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LarkCliError);
      expect(error).toMatchObject({ code: 'deleted', retryable: false, upstreamCode: '3380003' });
    }
  });

  it('scope alias equivalence: docs:document:read satisfied by legacy docx:document:readonly grant', async () => {
    // 2026-09 实测事故：旧授权只持有旧名 docx:document:readonly，新 DEFAULT
    // 要求 docs:document:read 时被误报「缺少权限」阻断认证。别名组内任一
    // 命中即视为满足。
    const client = new LarkCliClient({
      requiredScopes: [
        'wiki:node:retrieve',
        'docx:document:readonly',
        'docs:document:read',
        'offline_access',
      ],
      timeout: 1_000,
      larkCliPath: 'unused',
    });
    let call = 0;
    (client as any).execute = async () => {
      call += 1;
      if (call === 1) return { ok: true, data: { version: 'lark-cli 1.0.89' } };
      return {
        ok: true,
        data: {
          identity: 'user',
          identities: {
            user: {
              status: 'ready', available: true, verified: true, openId: 'ou-test',
              scope: 'wiki:node:retrieve docx:document:readonly offline_access',
            },
          },
        },
      };
    };

    const readiness = await client.checkAuthReady();
    expect(readiness.ready).toBe(true);
    expect(readiness.missingScopes).toEqual([]);
  });

  it('still reports genuinely missing scopes beyond the alias groups', async () => {
    const client = new LarkCliClient({
      requiredScopes: ['docs:document:read', 'slides:presentation:read'],
      timeout: 1_000,
      larkCliPath: 'unused',
    });
    let call = 0;
    (client as any).execute = async () => {
      call += 1;
      if (call === 1) return { ok: true, data: { version: 'lark-cli 1.0.89' } };
      return {
        ok: true,
        data: {
          identity: 'user',
          identities: { user: { status: 'ready', available: true, verified: true, openId: 'ou-test', scope: 'docx:document:readonly' } },
        },
      };
    };

    const readiness = await client.checkAuthReady();
    expect(readiness.ready).toBe(false);
    expect(readiness.missingScopes).toEqual(['slides:presentation:read']);
    expect(readiness.error).toContain('开始飞书认证');
  });

  it('retains parent_node_token from wiki node detail', async () => {
    const client = createClient();
    (client as any).execute = async () => ({
      data: {
        node_token: 'child',
        obj_token: 'obj-child',
        obj_type: 'docx',
        title: '子节点',
        space_id: 'space-1',
        obj_edit_time: '1710000000',
        has_child: false,
        parent_node_token: 'parent',
      },
    });

    await expect(client.getNode('child')).resolves.toMatchObject({
      node_token: 'child',
      parent_node_token: 'parent',
      obj_edit_time: 1710000000,
    });
  });

  it('does not treat ordinary text as malformed JSON (version output)', () => {
    const client = createClient();
    expect(internals(client).parseJsonOutput('lark-cli 1.0.53\n')).toEqual({
      ok: true,
      data: { version: 'lark-cli 1.0.53' },
    });
  });

  it('normalizes a Drive metadata batch without fetching document content', async () => {
    const client = createClient();
    const calls: Array<{ args: string[]; apiType: string }> = [];
    (client as any).execute = async (args: string[], apiType: string) => {
      calls.push({ args, apiType });
      return {
        data: {
          metas: [{
            doc_token: 'docx-A',
            doc_type: 'docx',
            latest_modify_time: '1710000000',
            title: 'A',
          }],
          failed_list: [{ token: 'docx-B', code: 970005 }],
        },
      };
    };

    await expect(client.getDocumentMetas([
      { docToken: 'docx-A', docType: 'docx' },
      { docToken: 'docx-B', docType: 'docx' },
    ])).resolves.toEqual({
      metas: [{
        docToken: 'docx-A',
        docType: 'docx',
        latestModifyTime: 1710000000,
        title: 'A',
      }],
      failed: [{ docToken: 'docx-B', code: 970005 }],
    });
    expect(calls).toEqual([{
      apiType: 'drive',
      args: [
        'drive', 'metas', 'batch_query', '--format', 'json', '--data',
        JSON.stringify({
          request_docs: [
            { doc_token: 'docx-A', doc_type: 'docx' },
            { doc_token: 'docx-B', doc_type: 'docx' },
          ],
        }),
      ],
    }]);
  });

  it('turns an absolute staging path into relative media output with a controlled cwd', async () => {
    const client = createClient();
    const stagingDirectory = path.join('/tmp', 'feishu-sync-media-test');
    const requested = path.join(stagingDirectory, 'image-stem');
    const calls: Array<{ args: string[]; options: unknown }> = [];
    (client as any).execute = async (args: string[], _apiType: string, options: unknown) => {
      calls.push({ args, options });
      return { data: { saved_path: path.join(stagingDirectory, 'image-stem.jpg') } };
    };

    await expect(client.downloadMedia('MediaToken1234567890', requested, 'whiteboard'))
      .resolves.toBe(path.join(stagingDirectory, 'image-stem.jpg'));
    expect(calls).toEqual([
      {
        args: [
          'docs', '+media-download', '--token', 'MediaToken1234567890',
          '--output', 'image-stem', '--type', 'whiteboard',
        ],
        options: { cwd: stagingDirectory },
      },
    ]);
  });

  it('rejects a media shortcut path that escapes its staging directory', async () => {
    const client = createClient();
    (client as any).execute = async () => ({ data: { saved_path: '/tmp/outside.jpg' } });

    await expect(
      client.previewMedia('MediaToken1234567890', '/tmp/inside/preview-stem'),
    ).rejects.toThrow('输出目录外');
    expect(resolveMediaOutputTarget('/tmp/inside/preview-stem')).toEqual({
      directory: '/tmp/inside',
      outputName: 'preview-stem',
      requestedPath: '/tmp/inside/preview-stem',
    });
  });
});

describe('quoteWindowsShellArguments — Win cmd 元字符参数引号包裹', () => {
  it('wraps args containing cmd metacharacters (&, spaces, parens, unicode) and leaves plain/JSON args intact', () => {
    const q = (args: string[]) => quoteWindowsShellArguments(args, 'win32');
    // 2026-09 实测事故样本：浮动图片文件名含 & 与中文/① → cmd 拆命令
    expect(
      q(['docs', '+media-preview', '--token', 'GvF6b', '--output', '①idea-点子&印象_A1_tF4t6mwsfd']),
    ).toEqual(['docs', '+media-preview', '--token', 'GvF6b', '--output', '"①idea-点子&印象_A1_tF4t6mwsfd"']);
    // 空格/括号/管道等元字符同样包裹
    expect(q(['--output', '策划 (草案) v2.md'])).toEqual(['--output', '"策划 (草案) v2.md"']);
    // 纯净参数不动
    expect(q(['wiki', '+node-list', '--format', 'json'])).toEqual(['wiki', '+node-list', '--format', 'json']);
    // 含双引号的 JSON 参数维持现状（cmd /s 下已验证可工作）
    const json = '{"request_docs":[{"doc_token":"x"}]}';
    expect(q(['--data', json])).toEqual(['--data', json]);
    // 已包裹的不重复包
    expect(q(['"a b"'])).toEqual(['"a b"']);
  });

  it('is a no-op on non-win32 platforms', () => {
    expect(
      quoteWindowsShellArguments(['--output', 'a b&c'], 'darwin'),
    ).toEqual(['--output', 'a b&c']);
  });
});

describe('LarkCliClient.listBaseRecords — ndjson artifact 通道（v0.3.34 真机修复）', () => {
  it('converts ndjson rows to {record_id, fields} and hoists manifest has_more', async () => {
    const client = createClient();
    let writtenFile = '';
    const capturedArgs: string[] = [];
    (client as any).execute = async (args: string[], apiType: string) => {
      capturedArgs.push(...args);
      expect(apiType).toBe('base');
      const outputIdx = args.indexOf('--output');
      writtenFile = args[outputIdx + 1];
      // 模拟 lark-cli：写 ndjson artifact，stdout 返回 manifest（顶层 has_more）
      fs.writeFileSync(writtenFile, [
        JSON.stringify({ record_id: 'rec1', 名称: '甲', is_enabled: true }),
        JSON.stringify({ record_id: 'rec2', 名称: '乙', is_enabled: false }),
        '',
      ].join('\n'), 'utf-8');
      return { ok: true, data: {}, has_more: true, records_count: 2 };
    };

    const result = await client.listBaseRecords({
      baseToken: 'basX', tableId: 'tblX', offset: 0, limit: 1000,
    });

    // 命令构造：ndjson + output，limit 钳在 2000 内
    expect(capturedArgs).toContain('--format');
    expect(capturedArgs[capturedArgs.indexOf('--format') + 1]).toBe('ndjson');
    expect(capturedArgs).toContain(String(Math.min(1000, 2000)));
    // 结构转换：record_id 剥离，其余作为 fields（原始值保留）
    expect(result.items).toEqual([
      { record_id: 'rec1', fields: { 名称: '甲', is_enabled: true } },
      { record_id: 'rec2', fields: { 名称: '乙', is_enabled: false } },
    ]);
    expect(result.has_more).toBe(true);
    // 临时 artifact 已清理
    expect(fs.existsSync(writtenFile)).toBe(false);
  });

  it('hard-fails on unreadable or corrupt ndjson artifact, accepts legal empty file (diting Major)', async () => {
    const client = createClient();
    // 场景 1：lark-cli 声称成功但未落盘 artifact（版本 drift）→ 读取失败硬抛
    (client as any).execute = async () => ({ ok: true, data: {}, has_more: false });
    await expect(client.listBaseRecords({
      baseToken: 'basX', tableId: 'tblX', offset: 0, limit: 100,
    })).rejects.toThrow(/ndjson artifact 读取失败/);

    // 场景 2：artifact 半截写入（行级 JSON 损坏）→ 硬抛，不静默空页
    (client as any).execute = async (args: string[]) => {
      const outputIdx = args.indexOf('--output');
      fs.writeFileSync(args[outputIdx + 1],
        JSON.stringify({ record_id: 'rec1', v: 1 }) + '\n{broken json\n', 'utf-8');
      return { ok: true, data: {}, has_more: false };
    };
    await expect(client.listBaseRecords({
      baseToken: 'basX', tableId: 'tblX', offset: 0, limit: 100,
    })).rejects.toThrow(/行解析失败/);

    // 场景 3：合法空文件（0 字节）→ 空页而非报错（兼容服务端怪异态）
    (client as any).execute = async (args: string[]) => {
      const outputIdx = args.indexOf('--output');
      fs.writeFileSync(args[outputIdx + 1], '', 'utf-8');
      return { ok: true, data: {}, has_more: false };
    };
    const empty = await client.listBaseRecords({
      baseToken: 'basX', tableId: 'tblX', offset: 0, limit: 100,
    });
    expect(empty.items).toEqual([]);
    expect(empty.has_more).toBe(false);
  });

  it('falls back to items>=limit when manifest omits has_more, and caps limit at 2000', async () => {
    const client = createClient();
    let writtenFile = '';
    (client as any).execute = async (args: string[]) => {
      const outputIdx = args.indexOf('--output');
      writtenFile = args[outputIdx + 1];
      const limitIdx = args.indexOf('--limit');
      const limit = Number(args[limitIdx + 1]);
      fs.writeFileSync(
        writtenFile,
        Array.from({ length: Math.min(limit, 5) }, (_, i) =>
          JSON.stringify({ record_id: `rec${i}`, v: i })).join('\n'),
        'utf-8',
      );
      return { ok: true, data: {} }; // 无 has_more（旧版 lark-cli）
    };

    // limit 超额被钳制为 2000
    const full = await client.listBaseRecords({
      baseToken: 'basX', tableId: 'tblX', offset: 0, limit: 99999,
    });
    expect(full.items.length).toBe(5);
    expect(full.has_more).toBe(false); // 5 < 2000

    // 满页（manifest 无 has_more）→ 保守认为还有更多
    const page = await client.listBaseRecords({
      baseToken: 'basX', tableId: 'tblX', offset: 0, limit: 3,
    });
    expect(page.items.length).toBe(3);
    expect(page.has_more).toBe(true);
    expect(fs.existsSync(writtenFile)).toBe(false);
  });
});

describe('classifyError: not-in-wiki classification (lark-cli ≥1.0.95 drift, audit D1)', () => {
  it.each([
    { code: '131014', label: 'new code (node_by_token migration, ≥1.0.95)' },
    { code: '131005', label: 'legacy code (≤1.0.94)' },
  ])('classifies $label as not_in_wiki and non-retryable', ({ code }) => {
    const client = createClient();
    const err = internals(client).classifyError(
      'document is not in wiki',
      code,
    );
    expect(err.code).toBe('not_in_wiki');
    expect(err.retryable).toBe(false);
    expect(err.upstreamCode).toBe(code);
  });

  it('classifies the textual form without upstream code as 131014 not_in_wiki', () => {
    const client = createClient();
    const err = internals(client).classifyError(
      'wiki +node-get failed: {"code":131014,"message":"document is not in wiki"}',
    );
    expect(err.code).toBe('not_in_wiki');
    expect(err.retryable).toBe(false);
    expect(err.upstreamCode).toBe('131014');
  });
});

// ---------------------------------------------------------------------------
// P0-S2：新能力五方法（fixture 驱动；真实输出样本见
// tests/fixtures/p0s1-lark-cli/，P0-S1 探针 2026-10-28，lark-cli 1.0.98）。
// argv 断言对照 fixture README 记录的真实命令形态（已与本地
// `lark-cli docs +history-list/+history-revert/+history-revert-status、
// whiteboard +export、drive +update-title --help` 核对）。
// ---------------------------------------------------------------------------

const p0s1FixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'p0s1-lark-cli',
);

function loadP0s1Fixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(p0s1FixtureRoot, name), 'utf-8'));
}

describe('P0-S2 listDocumentHistory — docs +history-list 封装', () => {
  it('builds the probed argv (page-size clamp 1..20, optional page-token) on the docx bucket', async () => {
    const client = createClient();
    const calls: Array<{ args: string[]; apiType: string }> = [];
    (client as any).execute = async (args: string[], apiType: string) => {
      calls.push({ args, apiType });
      return { ok: true, data: { entries: [], has_more: false, page_token: '' } };
    };

    await client.listDocumentHistory('DOCXTOKEN1');
    await client.listDocumentHistory('DOCXTOKEN1', { pageToken: 'NEXT', pageSize: 5 });
    await client.listDocumentHistory('DOCXTOKEN1', { pageSize: 99 });
    await client.listDocumentHistory('DOCXTOKEN1', { pageSize: 0 });

    expect(calls.map((call) => call.apiType)).toEqual(['docx', 'docx', 'docx', 'docx']);
    // P0-S1 真实命令形态：docs +history-list --doc <t> --page-size <n> [--page-token <p>] --format json
    expect(calls[0].args).toEqual([
      'docs', '+history-list', '--doc', 'DOCXTOKEN1', '--page-size', '20', '--format', 'json',
    ]);
    expect(calls[1].args).toEqual([
      'docs', '+history-list', '--doc', 'DOCXTOKEN1', '--page-size', '5',
      '--page-token', 'NEXT', '--format', 'json',
    ]);
    expect(calls[2].args[calls[2].args.indexOf('--page-size') + 1]).toBe('20'); // 钳制上限
    expect(calls[3].args[calls[3].args.indexOf('--page-size') + 1]).toBe('1'); // 钳制下限
  });

  it('parses the multi-entry fixture: string history_version_id, numeric revision_id, editor_ids, type 1/2/3', async () => {
    const client = createClient();
    const fixture = loadP0s1Fixture('history-list-multi-entry.json');
    (client as any).execute = async () => fixture;

    const page = await client.listDocumentHistory('DOCXTOKEN1', { pageSize: 20 });

    expect(page.entries).toHaveLength(4);
    expect(page.entries[0]).toEqual({
      historyVersionId: '4096',
      revisionId: 4,
      editTime: '2026-10-28T09:07:26Z',
      editorIds: ['ou_EDITOR_PROBE'],
      type: 3, // revert 产生的历史
      raw: fixture.data.entries[0],
    });
    expect(page.entries.map((entry) => entry.type)).toEqual([3, 2, 2, 1]);
    expect(page.entries.map((entry) => entry.historyVersionId)).toEqual(['4096', '3072', '2048', '1024']);
    expect(page.hasMore).toBe(false);
    expect(page.nextPageToken).toBe(null);
  });

  it('parses the fresh-doc single-entry fixture and tolerates an empty page', async () => {
    const client = createClient();
    (client as any).execute = async () => loadP0s1Fixture('history-list-fresh-doc.json');
    const fresh = await client.listDocumentHistory('DOCXTOKEN1');
    expect(fresh.entries).toHaveLength(1);
    expect(fresh.entries[0]).toMatchObject({ historyVersionId: '1024', revisionId: 1, type: 1 });

    (client as any).execute = async () => ({ ok: true, data: { entries: [], has_more: false, page_token: '' } });
    const empty = await client.listDocumentHistory('DOCXTOKEN1');
    expect(empty).toEqual({ entries: [], hasMore: false, nextPageToken: null });
  });

  it('derives nextPageToken from has_more + page_token（驼峰键双读兜底；末页不产令牌）', async () => {
    const client = createClient();
    (client as any).execute = async () => ({
      ok: true, data: { entries: [{ history_version_id: '2048' }], has_more: true, page_token: 'NEXT' },
    });
    expect(await client.listDocumentHistory('DOCXTOKEN1')).toMatchObject({ hasMore: true, nextPageToken: 'NEXT' });

    (client as any).execute = async () => ({
      ok: true, data: { entries: [], hasMore: true, pageToken: 'CAMEL' },
    });
    expect(await client.listDocumentHistory('DOCXTOKEN1')).toMatchObject({ hasMore: true, nextPageToken: 'CAMEL' });

    // has_more=false 时 page_token 即使非空也不产下一页令牌
    (client as any).execute = async () => ({
      ok: true, data: { entries: [], has_more: false, page_token: 'STALE' },
    });
    expect(await client.listDocumentHistory('DOCXTOKEN1')).toMatchObject({ hasMore: false, nextPageToken: null });
  });
});

describe('P0-S2 revertDocumentHistory / revertDocumentHistoryStatus — revert 与状态轮询', () => {
  it('builds the probed argv with wait-timeout-ms clamped to 0..30000 and a subprocess budget above it', async () => {
    const client = createClient();
    const calls: Array<{ args: string[]; apiType: string; options: any }> = [];
    (client as any).execute = async (args: string[], apiType: string, options: any) => {
      calls.push({ args, apiType, options });
      return loadP0s1Fixture('history-revert-done.json');
    };

    await client.revertDocumentHistory('DOCXTOKEN1', '2048');
    await client.revertDocumentHistory('DOCXTOKEN1', '2048', { waitTimeoutMs: 0 });
    await client.revertDocumentHistory('DOCXTOKEN1', '2048', { waitTimeoutMs: 99999 });

    expect(calls.map((call) => call.apiType)).toEqual(['docx', 'docx', 'docx']);
    // P0-S1 真实命令形态：docs +history-revert --doc <t> --history-version-id <id> --wait-timeout-ms <ms> --format json
    expect(calls[0].args).toEqual([
      'docs', '+history-revert', '--doc', 'DOCXTOKEN1', '--history-version-id', '2048',
      '--wait-timeout-ms', '30000', '--format', 'json',
    ]);
    expect(calls[1].args[calls[1].args.indexOf('--wait-timeout-ms') + 1]).toBe('0'); // 异步形态合法
    expect(calls[2].args[calls[2].args.indexOf('--wait-timeout-ms') + 1]).toBe('30000'); // 钳制上限
    // 子进程预算 > 服务端等待预算（waitTimeoutMs + 15s）
    expect(calls.map((call) => call.options.timeoutMs)).toEqual([45_000, 15_000, 45_000]);
  });

  it('parses the done and running fixtures; done still carries task_id', async () => {
    const client = createClient();
    (client as any).execute = async () => loadP0s1Fixture('history-revert-done.json');
    expect(await client.revertDocumentHistory('DOCXTOKEN1', '2048')).toEqual({
      status: 'done', taskId: 'task-uuid-probe-1', pollAfterMs: 0, failedBlockTokens: null,
    });

    (client as any).execute = async () => loadP0s1Fixture('history-revert-running.json');
    expect(await client.revertDocumentHistory('DOCXTOKEN1', '3072', { waitTimeoutMs: 0 })).toEqual({
      status: 'running', taskId: 'task-uuid-probe-3', pollAfterMs: 10000, failedBlockTokens: null,
    });
  });

  it('normalizes an unknown revert status to running（task_status 双读兜底）', async () => {
    const client = createClient();
    (client as any).execute = async () => ({ ok: true, data: { task_status: 'pending', task_id: 't' } });
    expect(await client.revertDocumentHistory('DOCXTOKEN1', '1024', { waitTimeoutMs: 0 }))
      .toMatchObject({ status: 'running', taskId: 't' });
  });

  it('rejects empty tokens/ids at the boundary before spawning a subprocess', async () => {
    const client = createClient();
    (client as any).execute = async () => { throw new Error('execute must not be called'); };
    await expect(client.revertDocumentHistory('', '2048')).rejects.toThrow(/non-empty objToken/);
    await expect(client.revertDocumentHistory('DOCXTOKEN1', '')).rejects.toThrow(/non-empty historyVersionId/);
    await expect(client.revertDocumentHistoryStatus('DOCXTOKEN1', ' ')).rejects.toThrow(/non-empty taskId/);
  });

  it('revertDocumentHistoryStatus parses the done fixture and reads failed_block_tokens', async () => {
    const client = createClient();
    const calls: string[][] = [];
    (client as any).execute = async (args: string[]) => {
      calls.push(args);
      return loadP0s1Fixture('history-revert-status-done.json');
    };

    const done = await client.revertDocumentHistoryStatus('DOCXTOKEN1', 'task-uuid-probe-1');
    // P0-S1 真实命令形态：docs +history-revert-status --doc <t> --task-id <id> --format json
    expect(calls[0]).toEqual([
      'docs', '+history-revert-status', '--doc', 'DOCXTOKEN1',
      '--task-id', 'task-uuid-probe-1', '--format', 'json',
    ]);
    expect(done).toEqual({ status: 'done', failedBlockTokens: [] });

    (client as any).execute = async () => ({
      ok: true, data: { status: 'failed', failed_block_tokens: ['blkA', 'blkB', 42] },
    });
    expect(await client.revertDocumentHistoryStatus('DOCXTOKEN1', 't2')).toEqual({
      status: 'failed', failedBlockTokens: ['blkA', 'blkB'], // 非字符串元素被过滤
    });

    (client as any).execute = async () => ({ ok: true, data: { status: 'weird' } });
    expect(await client.revertDocumentHistoryStatus('DOCXTOKEN1', 't3'))
      .toEqual({ status: 'running', failedBlockTokens: null });
  });

  it('partial_failed 是明确终态，即时响应与状态查询均保留失败块', async () => {
    const client = createClient();
    (client as any).execute = async () => ({ data: { status: 'partial_failed', failed_block_tokens: ['blk1'] } });
    expect(await client.revertDocumentHistory('DOCXTOKEN1', '2048')).toMatchObject({ status: 'partial_failed', failedBlockTokens: ['blk1'] });
    expect(await client.revertDocumentHistoryStatus('DOCXTOKEN1', 'task')).toEqual({ status: 'partial_failed', failedBlockTokens: ['blk1'] });
  });
});

describe('P0-S2 exportWhiteboard — whiteboard +export 双形态旁路导出', () => {
  it('builds the probed argv (svg/raw) with cwd fencing and a caller-supplied svg timeout budget', async () => {
    const client = createClient();
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-wb-export-'));
    try {
      const calls: Array<{ args: string[]; apiType: string; options: any }> = [];
      (client as any).execute = async (args: string[], apiType: string, options: any) => {
        calls.push({ args, apiType, options });
        const outputName = args[args.indexOf('--output') + 1];
        fs.writeFileSync(path.join(staging, outputName), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf-8');
        return { ok: true, data: { svg_path: `./${outputName}`, size_bytes: 48 } };
      };

      await client.exportWhiteboard('WBTOKENPROBE1', {
        outputType: 'svg', outputPath: path.join(staging, 'probe.wb.svg'), timeoutMs: 30_000,
      });
      await client.exportWhiteboard('WBTOKENPROBE1', {
        outputType: 'raw', outputPath: path.join(staging, 'probe.wb.raw.json'),
      });

      // P0-S1 真实命令形态：whiteboard +export --whiteboard-token <t> --output-type <type> --output <name> --overwrite --format json
      expect(calls[0]).toMatchObject({ apiType: 'docx', options: { cwd: staging, timeoutMs: 30_000 } });
      expect(calls[0].args).toEqual([
        'whiteboard', '+export', '--whiteboard-token', 'WBTOKENPROBE1',
        '--output-type', 'svg', '--output', 'probe.wb.svg', '--overwrite', '--format', 'json',
      ]);
      expect(calls[1].args).toEqual([
        'whiteboard', '+export', '--whiteboard-token', 'WBTOKENPROBE1',
        '--output-type', 'raw', '--output', 'probe.wb.raw.json', '--overwrite', '--format', 'json',
      ]);
      expect(calls[1].options).toEqual({ cwd: staging }); // 未传预算 → execute 缺省
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('resolves data.svg_path (svg) and data.output_path (raw) against cwd and returns the fenced path', async () => {
    const client = createClient();
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-wb-export-'));
    try {
      const svgFixture = loadP0s1Fixture('whiteboard-export-svg-success.json');
      (client as any).execute = async () => {
        fs.writeFileSync(path.join(staging, 'probe-min.wb.svg'), '<svg/>', 'utf-8');
        return svgFixture; // data.svg_path = "./probe-min.wb.svg"（P0-S1 实测键名，非 output_path）
      };
      const svgPath = await client.exportWhiteboard('WBTOKENPROBE1', {
        outputType: 'svg', outputPath: path.join(staging, 'probe-min.wb.svg'),
      });
      expect(svgPath).toBe(path.join(staging, 'probe-min.wb.svg'));

      const rawNodes = loadP0s1Fixture('whiteboard-export-raw-nodes.json');
      (client as any).execute = async () => {
        fs.writeFileSync(path.join(staging, 'probe.wb.raw.json'), JSON.stringify(rawNodes), 'utf-8');
        return { ok: true, data: { output_path: './probe.wb.raw.json' } };
      };
      const rawPath = await client.exportWhiteboard('WBTOKENPROBE1', {
        outputType: 'raw', outputPath: path.join(staging, 'probe.wb.raw.json'),
      });
      expect(rawPath).toBe(path.join(staging, 'probe.wb.raw.json'));
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('rejects an escaping svg_path and an empty/missing artifact despite a successful exit', async () => {
    const client = createClient();
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-wb-export-'));
    const outside = path.join(os.tmpdir(), `feishu-sync-wb-escape-${Date.now()}.wb.svg`);
    try {
      // 场景 1：上报绝对路径指向 staging 外的已存在文件 → 围栏拒绝
      fs.writeFileSync(outside, '<svg/>', 'utf-8');
      (client as any).execute = async () => ({ ok: true, data: { svg_path: outside } });
      await expect(client.exportWhiteboard('WBTOKENPROBE1', {
        outputType: 'svg', outputPath: path.join(staging, 'probe.wb.svg'),
      })).rejects.toThrow('输出目录外');

      // 场景 2：成功退出但未落盘 → 完整性拒绝（非误导性的围栏文案）
      (client as any).execute = async () => ({ ok: true, data: { svg_path: './probe.wb.svg' } });
      await expect(client.exportWhiteboard('WBTOKENPROBE1', {
        outputType: 'svg', outputPath: path.join(staging, 'probe.wb.svg'),
      })).rejects.toThrow('白板导出尚未完成');

      // 场景 3：落盘但空文件（0 字节）→ 同完整性拒绝
      fs.writeFileSync(path.join(staging, 'probe.wb.svg'), '', 'utf-8');
      await expect(client.exportWhiteboard('WBTOKENPROBE1', {
        outputType: 'svg', outputPath: path.join(staging, 'probe.wb.svg'),
      })).rejects.toThrow('白板导出尚未完成');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    }
  });
});

describe('P0-S2 updateDocumentTitle — drive +update-title 封装', () => {
  it('builds the probed argv with default docx type, explicit wiki type, and never --on-extension-mismatch', async () => {
    const client = createClient();
    const calls: string[][] = [];
    (client as any).execute = async (args: string[], apiType: string) => {
      calls.push(args);
      expect(apiType).toBe('drive');
      return loadP0s1Fixture('update-title-success.json');
    };

    await client.updateDocumentTitle('DOCXTOKENPROBE1', 'feishu-sync-p0s1-probe 改名测试');
    await client.updateDocumentTitle('wikcnodetoken', '节点标题', { type: 'wiki' });

    // P0-S1 真实命令形态：drive +update-title --token <t> --type <type> --title <title> --format json
    expect(calls[0]).toEqual([
      'drive', '+update-title', '--token', 'DOCXTOKENPROBE1', '--type', 'docx',
      '--title', 'feishu-sync-p0s1-probe 改名测试', '--format', 'json',
    ]);
    expect(calls[1]).toEqual([
      'drive', '+update-title', '--token', 'wikcnodetoken', '--type', 'wiki',
      '--title', '节点标题', '--format', 'json',
    ]);
    expect(calls.flat().join(' ')).not.toContain('--on-extension-mismatch');
    expect(calls.flat().join(' ')).not.toContain('--type file');
  });

  it('normalizes the success fixture payload', async () => {
    const client = createClient();
    const fixture = loadP0s1Fixture('update-title-success.json');
    (client as any).execute = async () => fixture;

    await expect(client.updateDocumentTitle('DOCXTOKENPROBE1', 'feishu-sync-p0s1-probe 改名测试'))
      .resolves.toEqual({
        fileToken: 'DOCXTOKENPROBE1',
        title: 'feishu-sync-p0s1-probe 改名测试',
        type: 'docx',
        updated: true,
        url: 'https://www.feishu.cn/docx/DOCXTOKENPROBE1',
        raw: fixture,
      });
  });

  it('rejects empty tokens and empty titles at the boundary（空标题 CLI 也本地拦截）', async () => {
    const client = createClient();
    (client as any).execute = async () => { throw new Error('execute must not be called'); };
    await expect(client.updateDocumentTitle('', 't')).rejects.toThrow(/non-empty fileToken/);
    await expect(client.updateDocumentTitle('DOCXTOKENPROBE1', '  ')).rejects.toThrow(/non-empty title/);
  });
});

describe('P0-S2 classifyError：P0-S1 实测新错误码（fixture 驱动）', () => {
  it('classifies the concurrent-revert fixture (10020) as retryable conflict（含 stderr 文本兜底）', () => {
    const client = createClient();
    // 真实路径：进程 exit 1 + stderr JSON 体 → extractUpstreamCode 结构化路径
    // 恢复 code 后进 classifyError；这里以 fixture 体直接驱动分类。
    const fixture = loadP0s1Fixture('history-revert-error-10020.json');
    let error: any;
    try {
      internals(client).parseJsonOutput(JSON.stringify(fixture));
      throw new Error('expected parseJsonOutput to throw');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LarkCliError);
    expect(error).toMatchObject({ code: 'conflict', retryable: true, upstreamCode: '10020' });

    // execFile 失败路径：stderr 非 JSON 文本，靠已知码集文本兜底
    const textual = internals(client).classifyError(
      'lark-cli failed: 10020 Another history revert task is already in progress',
    );
    expect(textual).toMatchObject({ code: 'conflict', retryable: true, upstreamCode: '10020' });
  });

  it('classifies both 3380002 fixtures (notfound / newest-entry) as non-retryable invalid_target, distinct from deleted 3380003', () => {
    const client = createClient();
    for (const name of ['history-revert-error-3380002-notfound.json', 'history-revert-error-3380002-newest-entry.json']) {
      try {
        internals(client).parseJsonOutput(JSON.stringify(loadP0s1Fixture(name)));
        throw new Error('expected parseJsonOutput to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(LarkCliError);
        expect(error).toMatchObject({ code: 'invalid_target', retryable: false, upstreamCode: '3380002' });
      }
    }
    // 3380003（已删除）分支不受新码影响——两码语义区分（任务书点名）
    const deleted = internals(client).classifyError('fetch on deleted doc 3380003', '3380003');
    expect(deleted).toMatchObject({ code: 'deleted', retryable: false, upstreamCode: '3380003' });
    const invalidTarget = internals(client).classifyError('history revert 3380002 INVALID ARGUMENT', '3380002');
    expect(invalidTarget).toMatchObject({ code: 'invalid_target', retryable: false, upstreamCode: '3380002' });
  });

  it('classifies the update-title type-mismatch fixture (981003) as non-retryable type_mismatch', () => {
    const client = createClient();
    const fixture = loadP0s1Fixture('update-title-error-981003.json');
    try {
      internals(client).parseJsonOutput(JSON.stringify(fixture));
      throw new Error('expected parseJsonOutput to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LarkCliError);
      expect(error).toMatchObject({ code: 'type_mismatch', retryable: false, upstreamCode: '981003' });
    }
  });

  it('classifies the svg server-timeout fixture as retryable timeout（S6 降级 raw 的判定输入）', () => {
    const client = createClient();
    const fixture = loadP0s1Fixture('whiteboard-export-svg-timeout.json');
    // "server time out error"（带空格）此前落 upstream；归 timeout 供 S6 判降级
    try {
      internals(client).parseJsonOutput(JSON.stringify(fixture));
      throw new Error('expected parseJsonOutput to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LarkCliError);
      expect(error).toMatchObject({ code: 'timeout', retryable: true });
    }
  });
});

describe('T4b-06 incomplete_response — 非幂等写响应缺必要字段 → 未知信号（非明确失败，不可重试）', () => {
  it('revertDocumentHistory：缺 status/task_status → incomplete_response；异步缺 task_id → incomplete_response（均 retryable=false）', async () => {
    const client = createClient();
    (client as any).execute = async () => ({ ok: true, data: { task_id: 't1' } });
    await expect(client.revertDocumentHistory('DOCXTOKEN1', '2048', { waitTimeoutMs: 0 })).rejects.toMatchObject({
      code: 'incomplete_response', retryable: false,
    });
    (client as any).execute = async () => ({ ok: true, data: { status: 'running' } });
    await expect(client.revertDocumentHistory('DOCXTOKEN1', '2048', { waitTimeoutMs: 0 })).rejects.toMatchObject({
      code: 'incomplete_response', retryable: false,
    });
    // 同步 done / 异步 running+task_id 不受影响（既有合法形态）。
    (client as any).execute = async () => ({ ok: true, data: { status: 'done' } });
    await expect(client.revertDocumentHistory('DOCXTOKEN1', '2048')).resolves.toMatchObject({ status: 'done' });
    (client as any).execute = async () => ({ ok: true, data: { status: 'running', task_id: 't2' } });
    await expect(client.revertDocumentHistory('DOCXTOKEN1', '2048', { waitTimeoutMs: 0 })).resolves.toMatchObject({
      status: 'running', taskId: 't2',
    });
  });

  it('moveWikiNodeToDrive：缺 state/status → incomplete_response；异步缺 task_id → incomplete_response', async () => {
    const client = createClient();
    (client as any).execute = async () => ({ ok: true, data: { task_id: 't1' } });
    await expect(client.moveWikiNodeToDrive('wikinT4b')).rejects.toMatchObject({
      code: 'incomplete_response', retryable: false,
    });
    (client as any).execute = async () => ({ ok: true, data: { state: 'running' } });
    await expect(client.moveWikiNodeToDrive('wikinT4b')).rejects.toMatchObject({
      code: 'incomplete_response', retryable: false,
    });
    // done 形态（同步完成）不受影响。
    (client as any).execute = async () => ({ ok: true, data: { state: 'done' } });
    await expect(client.moveWikiNodeToDrive('wikinT4b')).resolves.toMatchObject({ state: 'done' });
  });

  it('createDocumentMarkdown：响应缺 document_id → incomplete_response（不再抛普通 Error 冒充明确失败）', async () => {
    const client = createClient();
    (client as any).execute = async () => ({ ok: true, data: { document: { url: 'https://x' } } });
    let caught: unknown;
    try {
      await client.createDocumentMarkdown({ title: 't', markdown: '# x', parentToken: 'fld1' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LarkCliError);
    expect(caught).toMatchObject({ code: 'incomplete_response', retryable: false });
    expect((caught as Error).message).toContain('document_id');
    expect((caught as Error).message).toContain('请勿按失败重发');
  });
});
