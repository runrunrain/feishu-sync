/** Keep one stdio connection while replacing expired sessions on the loopback JSON gateway. */
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  InitializeResultSchema, isInitializedNotification, isInitializeRequest, isJSONRPCRequest,
  JSONRPCMessageSchema, type JSONRPCMessage, type JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';

export interface HttpStdioBridgeOptions {
  url: URL;
  token: string;
  input?: Readable;
  output?: Writable;
  onError?: () => void;
}

interface HttpSession {
  id: string | null;
  protocolVersion: string;
}

const REPLAYABLE_METHODS = new Set(['ping', 'tools/list', 'tools/call']);

/** The caller supplies only a loopback URL and a local credential. */
export async function startHttpStdioBridge(options: HttpStdioBridgeOptions): Promise<{ close: () => Promise<void> }> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const stdio = new StdioServerTransport(input, output);
  const lifetime = new AbortController();
  let initializeRequest: JSONRPCRequest | undefined;
  let connection: ReturnType<typeof initialize> | undefined;

  function headers(session?: HttpSession): Record<string, string> {
    return {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/json, text/event-stream',
      ...(session ? { 'Mcp-Protocol-Version': session.protocolVersion } : {}),
      ...(session?.id ? { 'Mcp-Session-Id': session.id } : {}),
    };
  }

  function post(message: JSONRPCMessage, session?: HttpSession): Promise<Response> {
    return fetch(options.url, {
      method: 'POST',
      headers: { ...headers(session), 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      redirect: 'error',
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(60_000)]),
    });
  }

  async function disconnect(session?: HttpSession): Promise<void> {
    if (!session?.id) return;
    try {
      const response = await fetch(options.url, {
        method: 'DELETE', headers: headers(session), redirect: 'error', signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
    } catch { /* The gateway may already have released the session. */ }
  }

  async function readReply(response: Response): Promise<JSONRPCMessage | undefined> {
    if (!response.ok || response.status === 202) {
      await response.body?.cancel();
      if (!response.ok) throw new Error('gateway_request_failed');
      return;
    }
    return JSONRPCMessageSchema.parse(await response.json());
  }

  async function initialize(request: JSONRPCRequest) {
    const response = await post(request);
    const reply = await readReply(response);
    if (!reply || !('result' in reply) || reply.id !== request.id) throw new Error('gateway_initialize_failed');
    const { protocolVersion } = InitializeResultSchema.parse(reply.result);
    const session = { id: response.headers.get('mcp-session-id'), protocolVersion };
    try {
      await readReply(await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session));
      return { session, reply };
    } catch (error) {
      await disconnect(session);
      throw error;
    }
  }

  function connect(request: JSONRPCRequest) {
    // Parallel calls observing the same expired connection share one new handshake.
    if (connection) return connection;
    const opening = initialize(request);
    connection = opening;
    void opening.catch(() => { if (connection === opening) connection = undefined; });
    return opening;
  }

  async function relay(message: JSONRPCMessage): Promise<void> {
    if (isJSONRPCRequest(message) && isInitializeRequest(message)) {
      initializeRequest = message;
      await stdio.send((await connect(message)).reply);
      return;
    }
    if (isInitializedNotification(message)) return; // Each upstream handshake already sent it.
    if (!initializeRequest) throw new Error('initialize_required');

    const original = connect(initializeRequest);
    const { session } = await original;
    let response = await post(message, session);
    if (response.status === 404 && session.id) {
      if (connection === original) connection = undefined;
      if (isJSONRPCRequest(message) && REPLAYABLE_METHODS.has(message.method)) {
        await response.body?.cancel();
        const replacement = connect(initializeRequest);
        const { session: fresh } = await replacement;
        response = await post(message, fresh);
        if (response.status === 404 && fresh.id && connection === replacement) connection = undefined;
      }
    }
    const reply = await readReply(response);
    if (reply && !lifetime.signal.aborted) await stdio.send(reply);
  }

  const close = async () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    input.off('end', onEnd);
    output.off('error', onOutputError);
    const established = await connection?.catch(() => undefined);
    await Promise.allSettled([disconnect(established?.session), stdio.close()]);
  };
  const onEnd = () => { void close(); };
  const onOutputError = () => { options.onError?.(); void close(); };
  input.once('end', onEnd);
  output.once('error', onOutputError);
  stdio.onerror = onOutputError;
  stdio.onmessage = (message) => {
    void relay(message).catch(async () => {
      if (lifetime.signal.aborted) return;
      options.onError?.();
      if (isJSONRPCRequest(message)) {
        await stdio.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: '本机 HTTP MCP 连接失败，请检查 Feishu Sync 的本机服务。' } }).catch(onOutputError);
      }
    });
  };
  try {
    await stdio.start();
  } catch (error) {
    await close();
    throw error;
  }
  return { close };
}
