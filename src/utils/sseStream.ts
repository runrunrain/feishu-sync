/**
 * 带鉴权的 SSE 客户端（fetch + ReadableStream）
 *
 * 为什么不用 EventSource：设计契约 §9 明确——EventSource 不能携带
 * X-Desktop-Token，desktop 认证下会被 401 拒绝。因此用 fetch 流式读取
 * response.body，按 SSE 规范解析 event/data/id 行，重连时带
 * `Last-Event-ID` 请求头续传（§9.3 会话环形缓冲约定）。
 *
 * 连接策略（会话页「断线重连」体验）：
 *   - start() 后循环连接；断开/出错按退避重试（1s → 2s → 4s → 上限 8s），
 *     期间通过 onStatus 通知调用方展示「连接中断，正在重连」；
 *   - 收到 `resync` 事件时由调用方拉取权威全量消息（messages API）；
 *   - stop() 主动断开（切会话/卸载时必须调用，防止事件串流到旧会话）。
 */

export type SseStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/**
 * 按行喂入的增量 SSE 解析器。纯逻辑、无 IO，便于单测。
 * 规则（WHATWG SSE）：
 *   - `\r\n` / `\r` / `\n` 均为换行；空行（或只剩注释）分发当前事件；
 *   - `event:` / `data:` / `id:` 冒号后允许一个空格；`:` 开头为注释；
 *   - 多行 data 以 `\n` 连接；仅 `data` 存在才分发（否则事件丢弃）；
 *   - `id` 含 NUL 时忽略（规范要求）。
 */
export class SseParser {
  private event = '';
  private dataLines: string[] = [];
  private lastId = '';
  private disposed = false;

  constructor(private readonly onMessage: (m: SseMessage) => void) {}

  /** 获取最近一次收到的 id（重连时作为 Last-Event-ID）。 */
  get lastEventId(): string {
    return this.lastId;
  }

  /** 喂入一段文本（可含不完整行），分发完成的事件。 */
  feed(chunk: string): void {
    if (this.disposed) return;
    // 按三种行结束符切分；末尾若非完整行则保留在缓冲。
    // 简化实现：逐字符扫描成本高，先统一替换 \r\n → \n、\r → \n，
    // 但末尾可能截断在 \r 处——把它当作完整行结束符处理是规范允许的
    // 行为差异（浏览器实现同样把孤立 \r 当行结束）。
    const normalized = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    // split 后最后一段是不完整行（若 chunk 不以换行结尾），
    // 与后续 chunk 拼接由调用方（feed 契约）保证：本类要求调用方
    // 把「未以换行结尾的尾部」留在缓冲。这里通过 carry 实现。
    const carry = normalized.endsWith('\n') ? '' : lines.pop() ?? '';
    for (const line of lines) this.processLine(line);
    if (carry) this.processPartial(carry);
  }

  private carry = '';

  private processPartial(text: string): void {
    // 拼回缓冲，等待下一个 chunk 补全。
    this.carry += text;
  }

  /** 处理一行（完整）。 */
  private processLine(line: string): void {
    if (this.carry) {
      line = this.carry + line;
      this.carry = '';
    }
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return; // 注释/心跳
    let field: string;
    let value: string;
    const colon = line.indexOf(':');
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    switch (field) {
      case 'event':
        this.event = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) this.lastId = value;
        break;
      default:
        break; // 忽略未知字段
    }
  }

  /** 分发当前事件并重置。 */
  private dispatch(): void {
    const data = this.dataLines.join('\n');
    const hadData = this.dataLines.length > 0;
    const event = this.event || 'message';
    this.event = '';
    this.dataLines = [];
    if (hadData) {
      this.onMessage({ event, data, id: this.lastId || undefined });
    }
    // 规范：空 data 块也重置 event，这里统一重置。
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** 建立 SSE 请求头（含鉴权 token 与可选续传游标）。 */
async function buildSseRequest(
  endpoint: string,
  headers: Record<string, string>,
  lastEventId: string | undefined,
  baseUrl: string,
  signal: AbortSignal,
): Promise<Request> {
  return new Request(`${baseUrl}${endpoint}`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...headers,
      ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
    },
    signal,
    // SSE 需要 CORS 模式下的同源/许可请求；desktop 下同源。
    mode: 'cors',
  });
}

export interface SseConnectionOptions {
  endpoint: string;
  /** 从已加载的状态快照继续，避免重放恢复前的旧终态。 */
  initialLastEventId?: string;
  /** 每次尝试连接时重新获取鉴权头与 baseUrl（token 可能轮换）。 */
  getAuth: () => Promise<{ headers: Record<string, string>; baseUrl: string }>;
  onMessage: (m: SseMessage) => void;
  onStatus?: (status: SseStatus) => void;
  /** 重连退避上限（毫秒），默认 8000。 */
  maxBackoffMs?: number;
  /** 请求失败后的重试次数上限；默认无限（页面卸载时 stop()）。 */
  maxRetries?: number;
}

/**
 * 自管理 SSE 连接：循环 fetch + 退避重连 + Last-Event-ID 续传。
 * 一个实例服务一个 endpoint（一个会话 / 一次构建）。
 */
export class SseConnection {
  private stopped = false;
  private controller: AbortController | null = null;
  private attempt = 0;
  private lastEventId = '';

  constructor(private readonly options: SseConnectionOptions) { this.lastEventId = options.initialLastEventId ?? ''; }

  get status(): SseStatus {
    return this.stopped ? 'closed' : this.attempt === 0 ? 'connecting' : 'reconnecting';
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.attempt = 0;
    this.options.onStatus?.(this.status);
    await this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
    this.options.onStatus?.('closed');
  }

  /** 外部得知服务端重建（如 resync 后）可清空游标从头接收。 */
  resetCursor(): void {
    this.lastEventId = '';
  }

  private async loop(): Promise<void> {
    const maxBackoff = this.options.maxBackoffMs ?? 8000;
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        const { headers, baseUrl } = await this.options.getAuth();
        const request = await buildSseRequest(
          this.options.endpoint,
          headers,
          this.lastEventId || undefined,
          baseUrl,
          this.controller.signal,
        );
        const response = await fetch(request);
        if (!response.ok || !response.body) {
          throw new Error(`SSE HTTP ${response.status}`);
        }
        this.attempt = 0;
        this.options.onStatus?.('open');
        const parser = new SseParser((m) => {
          if (m.id) this.lastEventId = m.id;
          if (!this.stopped) this.options.onMessage(m);
        });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parser.feed(decoder.decode());
        // 流正常结束（服务端关闭）→ 视为断线，走重连。
      } catch {
        if (this.stopped) return;
        if (this.options.maxRetries !== undefined && this.attempt >= this.options.maxRetries) {
          this.options.onStatus?.('closed');
          return;
        }
      }
      if (this.stopped) return;
      this.attempt += 1;
      this.options.onStatus?.('reconnecting');
      const backoff = Math.min(1000 * 2 ** (this.attempt - 1), maxBackoff);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}
