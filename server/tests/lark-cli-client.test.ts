import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLarkCliEnvironment,
  LarkCliClient,
  LarkCliError,
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
