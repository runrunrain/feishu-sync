/** Minimal stdio MCP bridge: all authority remains in the application tool service.
 *
 * v2（设计 v2 §3.3/§4.1/§10）：桥接进程继承子进程 env——AMAGI_TASK_ID 与
 * AMAGI_AGENT 是 amagi 启动子进程时写入的受信身份，随每次调用经
 * X-Amagi-Task-Id / X-Amagi-Agent 头发给工具服务（模型无法经工具参数
 * 改变身份；子任务无 shell，无法以其他身份重启桥接）。
 * Claude Code 路径透传 _meta['claudecode/toolUseId'] 作为 toolCallId
 * （应用侧按消息链回溯子 agent 身份）；无 _meta 时保持旧 cc_ 随机回退。
 * F02（审核修复 + Leader steer 迟到确认 liveness）：initialize 声明
 * tools.listChanged，并在受信身份存在时对工具面变化发送标准
 * notifications/tools/list_changed（同连接受控刷新；逐次业务授权仍由
 * 服务端裁决）。观测分两段：快窗（默认 250ms×30s）捕捉常态确认；到期
 * 未变则转入【自退避低频段】（默认 5s 起、逐次翻倍至 8× 上限）继续观测
 * ——迟到 confirmed 仍可刷新，绝不静默停后永久只读。观测生命周期由
 * 「stdio 活跃 + token 有效」约束：定时器全 unref、单次 HTTP 限时 5s、
 * stdin 关闭即停、401 run_token_invalid 即永久终止；无受信身份不观测。 */
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

// ── F02（审核修复）：同连接工具面受控刷新 ────────────────────────────
// 背景（已复现）：桥首次 tools/list 早于原生创建事件时服务端返回 pending 只读
// 面；Pi/amagi 客户端只在收到 notifications/tools/list_changed 后才重新拉取
// （pi dist/extensions/mcp/runtime.js onNotification→refreshTools 已核实），而旧
// 桥从不声明/发送 → 同一连接永久卡在只读面，写工具“尚未连接/已隐藏”。
// 方案：initialize 声明 tools.listChanged；有受信身份（amagiTaskId）时对工具
// 面做两段式最小 catalog 观测（Leader steer 迟到确认 liveness）：快窗（固定间隔、
// deadline 内）覆盖常态 pending→confirmed；到期未变【不自停】——转入自退避低频
// 段继续观测，迟到 confirmed 仍可刷新，绝不静默停后永久只读。这不是任务调度
// 器：定时器全部 unref、单次 HTTP 限时、stdin 关闭即清、令牌失效（401
// run_token_invalid）即永久终止，不写任何日志（无密钥/URL 泄漏面）。
// 快窗默认 30s/250ms，低频段默认 5s 起倍增至 8×；
// 可用 FEISHU_SYNC_BRIDGE_SURFACE_WATCH_*_MS 调试覆写（仅改时序不改语义）。
const readPositiveIntEnv = (name, fallback) => {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};
const SURFACE_WATCH_INTERVAL_MS = Math.min(readPositiveIntEnv('FEISHU_SYNC_BRIDGE_SURFACE_WATCH_INTERVAL_MS', 250), 5_000);
const SURFACE_WATCH_DEADLINE_MS = Math.min(readPositiveIntEnv('FEISHU_SYNC_BRIDGE_SURFACE_WATCH_DEADLINE_MS', 30_000), 120_000);
// 低频转段基频与自退避上限（快窗到期未变后降频继续观测——迟到确认仍可刷新，
// 不解解停后永久只读；观测生命周期由「stdio 活跃 + token 有效」约束）。
const SURFACE_WATCH_LOW_MS = Math.min(Math.max(readPositiveIntEnv('FEISHU_SYNC_BRIDGE_SURFACE_WATCH_LOW_MS', 5_000), 100), 120_000);
const SURFACE_WATCH_LOW_MAX_MS = Math.min(SURFACE_WATCH_LOW_MS * 8, 120_000);
// 单次观测 HTTP 限时（防悬挂请求堆积；不影响 tools/list / tools/call 主路径）。
const SURFACE_WATCH_HTTP_TIMEOUT_MS = 5_000;
const SURFACE_WATCH_MAX_POLLS = Math.ceil(SURFACE_WATCH_DEADLINE_MS / SURFACE_WATCH_INTERVAL_MS);
let lastSurface = null;
const surfaceWatch = { timer: null, polls: 0, changed: false, phase: 'fast', deadlineAt: 0, lowInterval: SURFACE_WATCH_LOW_MS, dead: false };

function stopSurfaceWatch() {
  if (surfaceWatch.timer !== null) { clearTimeout(surfaceWatch.timer); surfaceWatch.timer = null; }
}

function surfaceSignature(specs) {
  return JSON.stringify(specs.map((spec) => spec && spec.name));
}

/** 观测一次：面变化 → 发标准变更通知（返回 true）；令牌失效（401
 * run_token_invalid）→ 观测永久停止（token 生命周期即观测生命周期）。 */
async function pollSurfaceOnce() {
  try {
    const specs = await request('/api/agent-internal/tools', { signal: AbortSignal.timeout(SURFACE_WATCH_HTTP_TIMEOUT_MS) });
    if (!Array.isArray(specs)) throw new Error('工具清单无效');
    const signature = surfaceSignature(specs);
    if (signature !== lastSurface) {
      lastSurface = signature;
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      return true;
    }
    return false;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/run_token_invalid/.test(text)) {
      // 令牌已失效（撤销/换代）：观测随 token 生命周期终止，不再轮询。
      surfaceWatch.dead = true;
      stopSurfaceWatch();
    }
    return false; // 其它失败（未就绪/撤销中/回环抖动/超时）：按本次无变化退避继续
  }
}

function armSurfaceWatch() {
  if (!amagiTaskId || surfaceWatch.dead || surfaceWatch.timer !== null) return;
  // 快窗（固定间隔，deadline 内）：捕捉常态的 pending→confirmed（<1s）。
  surfaceWatch.phase = 'fast';
  surfaceWatch.deadlineAt = Date.now() + SURFACE_WATCH_DEADLINE_MS;
  surfaceWatch.lowInterval = SURFACE_WATCH_LOW_MS;
  const tick = () => {
    surfaceWatch.polls += 1;
    void pollSurfaceOnce().then((changed) => {
      if (surfaceWatch.timer === null || surfaceWatch.dead) return; // 已停止（stdin 关闭/令牌失效）
      let next;
      if (changed) {
        // 面已变并已通知：重臂快窗捕捉紧跟的后续变化（如确认后撤销收缩面），
        // 然后回到低频；通知次数由服务端真实变化驱动，非常驻。
        surfaceWatch.phase = 'fast';
        surfaceWatch.deadlineAt = Date.now() + SURFACE_WATCH_DEADLINE_MS;
        surfaceWatch.lowInterval = SURFACE_WATCH_LOW_MS;
        next = SURFACE_WATCH_INTERVAL_MS;
      } else if (surfaceWatch.phase === 'fast' && Date.now() >= surfaceWatch.deadlineAt) {
        // 快窗到期未变：转入自退避低频段（迟到确认仍可刷新，不永久停）。
        surfaceWatch.phase = 'low';
        surfaceWatch.lowInterval = SURFACE_WATCH_LOW_MS;
        next = surfaceWatch.lowInterval;
      } else if (surfaceWatch.phase === 'fast') {
        next = SURFACE_WATCH_INTERVAL_MS;
      } else {
        surfaceWatch.lowInterval = Math.min(surfaceWatch.lowInterval * 2, SURFACE_WATCH_LOW_MAX_MS);
        next = surfaceWatch.lowInterval;
      }
      surfaceWatch.timer = setTimeout(tick, next);
      surfaceWatch.timer.unref();
    });
  };
  surfaceWatch.timer = setTimeout(tick, SURFACE_WATCH_INTERVAL_MS);
  surfaceWatch.timer.unref();
}

async function handle(message) {
  if (message.id === undefined) return;
  try {
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'feishu-sync', version: '1.0.0' } };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') {
      const specs = await request('/api/agent-internal/tools');
      if (!Array.isArray(specs)) throw new Error('工具清单无效');
      // v2：工具清单按调用身份下发；annotations.readOnlyHint 透传（amagi
      // 无 shell 子任务的通配 MCP 条目只放行只读标注工具，§3.3）。
      lastSurface = surfaceSignature(specs);
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
    // F02：响应发出后武装面观测（首次 tools/list 起；变更→通知→永久停止）
    if (message.method === 'tools/list') armSurfaceWatch();
  } catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); }
}
const stdinReader = createInterface({ input: process.stdin, crlfDelay: Infinity });
stdinReader.on('line', (line) => {
  try { void handle(JSON.parse(line)); } catch { /* Invalid frames never reach the tool service. */ }
});
// stdin 关闭即停观测（无定时器/轮询残留；unref 定时器不阻止进程退出）
stdinReader.on('close', () => stopSurfaceWatch());
