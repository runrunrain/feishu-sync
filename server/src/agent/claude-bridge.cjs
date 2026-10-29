/** Minimal stdio MCP bridge: all authority remains in the application tool service. */
'use strict';
const crypto = require('node:crypto');
const { createInterface } = require('node:readline');
const base = process.env.FEISHU_SYNC_AGENT_URL || '';
const token = process.env.FEISHU_SYNC_AGENT_RUN_TOKEN || '';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || !token) throw new Error('Agent bridge configuration missing');
const headers = { 'X-Agent-Run-Token': token, 'Content-Type': 'application/json' };
async function request(route, init = {}) {
  const res = await fetch(`${base}${route}`, { ...init, headers });
  const body = await res.json();
  if (!res.ok) throw new Error(`${body.error || 'tool_error'}: ${body.message || '工具请求失败'}`);
  return body;
}
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
async function handle(message) {
  if (message.id === undefined) return;
  try {
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'feishu-sync', version: '1.0.0' } };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') {
      const specs = await request('/api/agent-internal/tools');
      if (!Array.isArray(specs)) throw new Error('工具清单无效');
      result = { tools: specs.map((s) => ({ name: s.name, description: s.description, inputSchema: s.parameters })) };
    } else if (message.method === 'tools/call') {
      const name = message.params?.name;
      if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('工具名称无效');
      try {
        result = await request(`/api/agent-internal/tools/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify({ toolCallId: `cc_${crypto.randomUUID()}`, args: message.params?.arguments ?? {} }) });
      } catch (error) { result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    } else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); }
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  try { void handle(JSON.parse(line)); } catch { /* Invalid frames never reach the tool service. */ }
});
