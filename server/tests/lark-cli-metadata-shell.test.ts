import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LarkCliClient } from '../src/modules/lark-cli-client.js';

describe('metadata subprocess argument boundary', () => {
  it('passes a large JSON batch through a real CLI shim without losing quotes or hitting the Windows command limit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu metadata shell '));
    const shim = path.join(root, 'lark-cli.cmd');
    const script = path.join(root, 'fake-cli.cjs');
    const requests = Array.from({ length: 135 }, (_, index) => ({
      docToken: `document-${index.toString().padStart(19, '0')}`,
      docType: 'docx',
    }));
    try {
      fs.writeFileSync(script, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 6), ['drive', 'metas', 'batch_query', '--format', 'json', '--data']);
const input = args[6];
if (process.platform === 'win32') assert.ok(input.startsWith('@'));
const payload = JSON.parse(input.startsWith('@') ? fs.readFileSync(input.slice(1), 'utf8') : input);
assert.deepEqual(payload.request_docs, ${JSON.stringify(requests.map((request) => ({ doc_token: request.docToken, doc_type: request.docType })))});
console.log(JSON.stringify({ ok: true, data: { metas: payload.request_docs.map((node) => ({ ...node, latest_modify_time: '1000', title: node.doc_token })) } }));
`);
      fs.writeFileSync(shim, process.platform === 'win32'
        ? `@"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      { mode: 0o755 });
      const client = new LarkCliClient({ requiredScopes: [], larkCliPath: shim, timeout: 3000 });

      const result = await client.getDocumentMetas(requests);

      expect(result.metas).toHaveLength(requests.length);
      expect(result.failed).toEqual([]);
      expect(result.metas.map((node) => node.docToken)).toEqual(requests.map((request) => request.docToken));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
