/** Minimal stdio MCP bridge: all authority remains in the application tool service.
 *
 * v2（设计 v2 §3.3/§4.1/§10）：桥接进程继承子进程 env——AMAGI_TASK_ID 与
 * AMAGI_AGENT 是 amagi 启动子进程时写入的受信身份，随每次调用经
 * X-Amagi-Task-Id / X-Amagi-Agent 头发给工具服务（模型无法经工具参数
 * 改变身份；子任务无 shell，无法以其他身份重启桥接）。
 * Claude Code 路径透传 _meta['claudecode/toolUseId'] 作为 toolCallId
 * （应用侧按消息链回溯子 agent 身份）；无 _meta 时保持旧 cc_ 随机回退。 */
'use strict';
const crypto = require('node:crypto');
const { createInterface } = require('node:readline');
// v2 构建子任务：mcp.json 引用 FEISHU_SYNC_BUILD_MCP_URL/TOKEN（运行时
// contracts.ts 定义）；普通 Claude 会话沿用 FEISHU_SYNC_AGENT_*。两者都在时
// 构建变量优先（同一桥接脚本服务两条链路）。
const base = process.env.FEISHU_SYNC_BUILD_MCP_URL || process.env.FEISHU_SYNC_AGENT_URL || '';
const token = process.env.FEISHU_SYNC_BUILD_MCP_TOKEN || process.env.FEISHU_SYNC_AGENT_RUN_TOKEN || '';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || !token) throw new Error('Agent bridge configuration missing');
const headers = { 'X-Agent-Run-Token': token, 'Content-Type': 'application/json' };
// v2：受信 env 身份（存在才发送；普通 Claude 会话无这两项，行为不变）。
const amagiTaskId = process.env.AMAGI_TASK_ID || '';
const amagiAgent = process.env.AMAGI_AGENT || '';
if (amagiTaskId) {
  headers['X-Amagi-Task-Id'] = amagiTaskId;
  if (amagiAgent) headers['X-Amagi-Agent'] = amagiAgent;
}
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
      // v2：工具清单按调用身份下发；annotations.readOnlyHint 透传（amagi
      // 无 shell 子任务的通配 MCP 条目只放行只读标注工具，§3.3）。
      result = { tools: specs.map((s) => ({ name: s.name, description: s.description, inputSchema: s.parameters, ...(s.annotations ? { annotations: s.annotations } : {}) })) };
    } else if (message.method === 'tools/call') {
      const name = message.params?.name;
      if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('工具名称无效');
      // Claude Code：_meta['claudecode/toolUseId'] 透传（§10 身份链）；缺省
      // 保持旧 cc_ 随机（旧用法不回传幂等键）。
      const metaToolUseId = message.params?._meta?.['claudecode/toolUseId'];
      const toolCallId = typeof metaToolUseId === 'string' && metaToolUseId ? metaToolUseId : `cc_${crypto.randomUUID()}`;
      try {
        result = await request(`/api/agent-internal/tools/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify({ toolCallId, args: message.params?.arguments ?? {} }) });
      } catch (error) { result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    } else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); }
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  try { void handle(JSON.parse(line)); } catch { /* Invalid frames never reach the tool service. */ }
});
