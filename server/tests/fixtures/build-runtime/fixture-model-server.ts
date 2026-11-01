/**
 * fixture-model-server.ts — 本地 OpenAI 兼容「脚本化」模型服务器（测试夹具）
 *
 * 仅供 probe 驱动真实 pi/amagi 链路：它替换的是「模型」这一环，不替换
 * pi、amagi、MCP 桥或应用工具服务的任何真实执行。产出证据时必须声明：
 * fixture 模型不是实际 LLM 质量/性能证据。
 *
 * 工作方式：
 * - 按请求 messages 中的 marker 选择脚本（PROBE-LEADER-RUN / PROBE-TASK-W1 /
 *   PROBE-TASK-W2 / PROBE-TASK-R1 / PROBE-TASK-SLOW / PROBE-RESUME-W1）；
 * - 脚本步进按「历史里已出现的 probe-step 标记数」推导（无服务端会话状态，
 *   幂等可重放）；Leader 脚本为历史函数（需要从 tool result 里解析任务句柄）；
 * - 全量记录每次请求的 model / tools 名单 / marker / 消息计数 / 步进号，
 *   供 probe 断言「子任务真实工具面」（无 codemode/tool_search/bash 等）。
 */

import http from 'node:http';

export interface ToolCallSpec {
  name: string;
  args: Record<string, unknown>;
}

export interface ScriptStep {
  toolCalls?: ToolCallSpec[];
  text?: string;
  delayMs?: number;
}

/** Leader 步进是「历史 → 动作」函数：可解析 tool result 中的任务句柄。 */
export type LeaderStepFn = (history: ParsedHistory) => ScriptStep | null;

export interface ParsedHistory {
  /** 全部消息的纯文本（按消息序拼接）。 */
  allText: string;
  /** tool 角色消息的文本列表（工具执行结果）。 */
  toolResultTexts: string[];
  /** assistant 文本（含 probe-step 标记）。 */
  assistantTexts: string[];
  /** 最近的 user 消息文本（任务书/续接通知）。 */
  lastUserText: string;
}

export interface ModelRequestLogEntry {
  t: string;
  model: string;
  script: string;
  step: number;
  tools: string[];
  messageCount: number;
  systemContains: string[];
  requestId: number;
}

export interface FixtureModelConfig {
  /** marker → 固定步进脚本（子任务）。 */
  scripts: Record<string, ScriptStep[]>;
  /** 固定脚本的终止文本（全部步进耗尽后返回）。 */
  finals: Record<string, string>;
  /** Leader 脚本（步进函数；返回 null 表示直接终止文本）。 */
  leaderSteps: LeaderStepFn[];
  leaderFinal: string;
  /** 供脚本闭包读取的运行期注入（sentinel 路径等），不参与匹配。 */
  context?: Record<string, unknown>;
  /** 额外密钥（日志脱敏用）。 */
  secrets?: string[];
}

interface ChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

function messageText(message: ChatMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text'
      ? String((block as { text?: string }).text ?? '')
      : ''))
    .join('');
}

const SCRIPT_MARKERS: Array<{ script: string; marker: string }> = [
  // Leader 会话优先（Leader 历史里会引用各任务 marker；只有 Leader 对话含 PROBE-LEADER-RUN）
  { script: 'leader', marker: 'PROBE-LEADER-RUN' },
  { script: 'resume-w1', marker: 'PROBE-RESUME-W1' },
  { script: 'w1', marker: 'PROBE-TASK-W1' },
  { script: 'w2', marker: 'PROBE-TASK-W2' },
  { script: 'r1', marker: 'PROBE-TASK-R1' },
  { script: 'slow', marker: 'PROBE-TASK-SLOW' },
];

export class FixtureModelServer {
  readonly log: ModelRequestLogEntry[] = [];
  /** 每脚本最后一次请求的消息历史（证据提取：工具结果/任务书/通知）。 */
  readonly historyByScript = new Map<string, unknown[]>();
  /** 每脚本最后一次请求的系统提示（skill 加载/工具面断言用）。 */
  readonly systemByScript = new Map<string, string>();
  /** 每脚本发出的 tool_calls 与终止文本（证据核对用）。 */
  readonly emissions: Array<{ t: string; script: string; step: number; kind: 'tool_calls' | 'final'; names?: string[]; text?: string }> = [];
  private server: http.Server | null = null;
  private requestIdSeq = 0;
  port = 0;

  constructor(private readonly config: FixtureModelConfig) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server!.address();
    if (address === null || typeof address === 'string') throw new Error('fixture 模型服务器端口解析失败');
    this.port = address.port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => { this.server!.close(() => resolve()); });
    this.server = null;
  }

  /** 脚本是否已完成终止轮（步进脚本：已发 final；Leader：发过 leaderFinal）。 */
  scriptSawFinal(script: string): boolean {
    return this.emissions.some((entry) => entry.script === script && entry.kind === 'final');
  }

  /** 脚本是否已收到首个模型请求（子任务已真实启动）。 */
  scriptStarted(script: string): boolean {
    return this.log.some((entry) => entry.script === script);
  }

  private parseHistory(messages: ChatMessage[]): ParsedHistory {
    const toolResultTexts: string[] = [];
    const assistantTexts: string[] = [];
    let lastUserText = '';
    const allTexts: string[] = [];
    for (const message of messages) {
      const text = messageText(message);
      allTexts.push(text);
      if (message.role === 'tool') toolResultTexts.push(text);
      else if (message.role === 'assistant') {
        const callParts = (message.tool_calls ?? []).map((call) => `${call.function?.name ?? ''}(${String(call.function?.arguments ?? '').slice(0, 160)})`);
        assistantTexts.push(text + (callParts.length ? ` [calls:${callParts.join(';')}]` : ''));
      } else if (message.role === 'user' && text.trim()) lastUserText = text;
    }
    return { allText: allTexts.join('\n'), toolResultTexts, assistantTexts: assistantTexts.filter(Boolean), lastUserText };
  }

  private static countSteps(history: ParsedHistory, script: string): number {
    // 分脚本步进标记（resume 会话继承原会话历史：各脚本只认自己的标记）
    const tagPrefix = `probe:${script}:`;
    let count = 0;
    for (const text of history.assistantTexts) {
      const matches = text.match(/probe:[a-z0-9-]+:(\d+)/g) ?? [];
      for (const match of matches) {
        if (!match.startsWith(tagPrefix)) continue;
        count = Math.max(count, Number(match.slice(tagPrefix.length)));
      }
    }
    return count;
  }

  private pickScript(messages: ChatMessage[]): string | null {
    // 逐消息扫描（resume 会话同时含 W1 任务书与续接通知：续接 marker 优先）
    for (const { script, marker } of SCRIPT_MARKERS) {
      for (const message of messages) {
        const text = messageText(message);
        if (text.includes(marker)) return script;
      }
    }
    return null;
  }

  private extractToolNames(body: { tools?: unknown }): string[] {
    if (!Array.isArray(body.tools)) return [];
    const names: string[] = [];
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object') continue;
      const record = tool as { function?: { name?: unknown }; name?: unknown };
      const name = record.function?.name ?? record.name;
      if (typeof name === 'string' && name) names.push(name);
    }
    return names;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '';
    if (!req.url || !(url === '/v1/chat/completions' || url === '/chat/completions') || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture 模型服务器只提供 chat/completions' } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: {
      model?: string;
      messages?: ChatMessage[];
      tools?: unknown;
      stream?: boolean;
    };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid JSON' } }));
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const script = this.pickScript(messages);
    const history = this.parseHistory(messages);
    const priorSteps = script ? FixtureModelServer.countSteps(history, script) : 0;
    const requestId = ++this.requestIdSeq;
    const systemMessage = messages.find((message) => message.role === 'system');
    const systemText = systemMessage ? messageText(systemMessage) : '';
    if (script) {
      this.historyByScript.set(script, messages);
      this.systemByScript.set(script, systemText);
    }
    const entry: ModelRequestLogEntry = {
      t: new Date().toISOString(),
      model: String(body.model ?? ''),
      script: script ?? 'unknown',
      step: priorSteps + 1,
      tools: this.extractToolNames(body),
      messageCount: messages.length,
      systemContains: [
        'PROBE-SKILL' /** marker 通用前缀，由调用方再精确断言 */ ,
      ].filter((needle) => systemText.includes(needle)),
      requestId,
    };
    this.log.push(entry);

    let step: ScriptStep | null = null;
    let finalText: string | null = null;
    if (script === 'leader') {
      const action = this.config.leaderSteps[priorSteps] ? this.config.leaderSteps[priorSteps](history) : null;
      if (action) step = action;
      else finalText = this.config.leaderFinal;
    } else if (script) {
      const steps = this.config.scripts[script] ?? [];
      if (priorSteps < steps.length) step = steps[priorSteps];
      else finalText = this.config.finals[script] ?? `probe-step 结束（${script}）`;
    } else {
      finalText = '（probe fixture：未识别 marker——真实链路里这表示任务书未被原样送达）';
    }

    if (step?.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));

    const tag = `probe:${script ?? 'unknown'}:${priorSteps + 1}`;
    if (step && step.toolCalls && step.toolCalls.length > 0) {
      this.emissions.push({ t: new Date().toISOString(), script: script ?? 'unknown', step: priorSteps + 1, kind: 'tool_calls', names: step.toolCalls.map((call) => call.name) });
      this.writeCompletion(res, body.stream === true, {
        model: String(body.model ?? 'fixture'),
        toolCalls: step.toolCalls.map((call, index) => ({
          id: `call_${requestId}_${index}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
        // 极小标记文本：步进推导只认 assistant 文本里的 probe-step-N 标记
        text: `[${tag}]`,
      });
      return;
    }
    const text = (step?.text ? `${step.text}\n[${tag}]` : null) ?? finalText ?? `[${tag}] 终止`;
    this.emissions.push({ t: new Date().toISOString(), script: script ?? 'unknown', step: priorSteps + 1, kind: 'final', text });
    this.writeCompletion(res, body.stream === true, { model: String(body.model ?? 'fixture'), toolCalls: [], text });
  }

  private writeCompletion(res: http.ServerResponse, stream: boolean, payload: { model: string; toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; text: string }): void {
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-fixture',
        object: 'chat.completion',
        model: payload.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: payload.toolCalls.length === 0 ? payload.text : payload.text,
            tool_calls: payload.toolCalls.length > 0 ? payload.toolCalls : undefined,
          },
          finish_reason: payload.toolCalls.length > 0 ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (data: unknown): void => { res.write(`data: ${JSON.stringify(data)}\n\n`); };
    if (payload.text) send({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: payload.model, choices: [{ index: 0, delta: { role: 'assistant', content: payload.text }, finish_reason: null }] });
    payload.toolCalls.forEach((call, callIndex) => {
      send({
        id: 'chatcmpl-fixture',
        object: 'chat.completion.chunk',
        model: payload.model,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: callIndex, id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } }] },
          finish_reason: null,
        }],
      });
    });
    send({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: payload.toolCalls.length > 0 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
