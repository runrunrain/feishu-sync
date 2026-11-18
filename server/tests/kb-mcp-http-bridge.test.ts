import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHttpGateway } from '../src/kb-lan/http-gateway.js';
import { tokenDigest } from '../src/kb-lan/token-store.js';
import { startHttpStdioBridge } from '../src/mcp/kb-mcp-http-bridge.js';

const token = 'fskb_' + 'a'.repeat(43);
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of close.splice(0).reverse()) await stop(); });

async function fixture(bridgeToken = token) {
  const gateway = createHttpGateway({
    host: '127.0.0.1', port: 0, maxSessions: 4, allowCidrs: ['127.0.0.1/32'], digests: [tokenDigest(token)],
    register: (server) => {
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'fixture_lookup', description: '测试知识库', inputSchema: { type: 'object', properties: {} } }] }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => ({
        content: [{ type: 'text', text: `真实 HTTP 返回：${request.params.name}` }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
        structuredContent: { source: 'http-fixture' },
      }));
    },
  });
  await gateway.listen();
  close.push(() => gateway.close());
  const address = gateway.server.address();
  if (!address || typeof address === 'string') throw new Error('missing gateway address');
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
  const bridge = await startHttpStdioBridge({ url: new URL(`http://127.0.0.1:${address.port}/mcp`), token: bridgeToken, input, output });
  close.push(() => bridge.close());
  const send = (message: unknown) => input.write(JSON.stringify(message) + '\n');
  const waitFor = async (id: number) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === id) return message;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`missing JSON-RPC response ${id}`);
  };
  return { gateway, send, waitFor, text: () => text, input, bridge };
}

describe('WSL 本机 HTTP MCP 桥接', () => {
  it('转发握手、工具发现和真实工具结果，并在断开后释放 HTTP 会话', async () => {
    const f = await fixture();
    f.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
    const initialized = await f.waitFor(1);
    expect(initialized.result.serverInfo.name).toBe('feishu-sync-kb');
    f.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    f.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect((await f.waitFor(2)).result.tools[0].name).toBe('fixture_lookup');
    f.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fixture_lookup', arguments: {} } });
    const result = await f.waitFor(3);
    expect(result.result.isError).not.toBe(true);
    expect(result.result.content[0].text).toMatch(/真实 HTTP 返回：fixture_lookup/);
    expect(result.result.content[1]).toMatchObject({ type: 'image', data: 'aGVsbG8=' });
    expect(result.result.structuredContent.source).toBe('http-fixture');
    expect(f.text()).not.toContain(token);
    expect(f.gateway.metrics().sessions).toBe(1);
    await f.bridge.close();
    expect(f.gateway.metrics().sessions).toBe(0);
  });

  it('令牌无效时返回明确错误，不泄露令牌', async () => {
    const wrong = 'fskb_' + 'b'.repeat(43);
    const f = await fixture(wrong);
    f.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
    const result = await f.waitFor(1);
    expect(result.error.message).toMatch(/本机 HTTP MCP 连接失败/);
    expect(f.text()).not.toContain(wrong);
    expect(f.gateway.metrics().sessions).toBe(0);
  });
});
