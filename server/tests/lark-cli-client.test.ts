import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    const client = new LarkCliClient({ requiredScopes: ['wiki:node:retrieve'] });
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
    const client = new LarkCliClient({ requiredScopes: ['wiki:node:retrieve'] });
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
        'wiki', '+node-list', '--format', 'ndjson', '--page-all',
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
