/** Relay one stdio MCP connection to the existing loopback HTTP gateway. */
import type { Readable, Writable } from 'node:stream';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';

export interface HttpStdioBridgeOptions {
  url: URL;
  token: string;
  input?: Readable;
  output?: Writable;
  onError?: () => void;
}

/** The caller supplies only a loopback URL and a local credential. */
export async function startHttpStdioBridge(options: HttpStdioBridgeOptions): Promise<{ close: () => Promise<void> }> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const stdio = new StdioServerTransport(input, output);
  const http = new StreamableHTTPClientTransport(options.url, {
    requestInit: { headers: { Authorization: `Bearer ${options.token}` }, redirect: 'error' },
  });
  let initializeId: RequestId | undefined;
  let closing = false;
  let initialized = Promise.resolve();

  const close = async () => {
    if (closing) return;
    closing = true;
    input.off('end', onEnd);
    output.off('error', onOutputError);
    // Explicitly free the gateway session; do not hang shutdown on a dead server.
    await Promise.race([http.terminateSession().catch(() => {}), new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
    await Promise.allSettled([http.close(), stdio.close()]);
  };
  const onEnd = () => { void close(); };
  const onOutputError = () => { options.onError?.(); void close(); };
  input.once('end', onEnd);
  output.once('error', onOutputError);

  http.onmessage = (message: JSONRPCMessage) => {
    if (closing) return;
    if ('id' in message && message.id === initializeId && 'result' in message) {
      const result = message.result as { protocolVersion?: unknown };
      if (typeof result?.protocolVersion === 'string') http.setProtocolVersion(result.protocolVersion);
    }
    void stdio.send(message).catch(() => { options.onError?.(); void close(); });
  };
  // The SDK reports transport failures separately from the rejected send. Never
  // print remote response bodies or credentials to the client's protocol stream.
  http.onerror = () => {};
  stdio.onerror = () => { options.onError?.(); void close(); };
  stdio.onmessage = (message: JSONRPCMessage) => {
    if ('method' in message && message.method === 'initialize' && 'id' in message) initializeId = message.id;
    // A client may issue its first tool request immediately after the initialized
    // notification. Keep that notification ahead of requests without serializing
    // independent calls once the session is ready.
    const sent = 'method' in message && message.method === 'notifications/initialized'
      ? (initialized = http.send(message))
      : initialized.then(() => http.send(message));
    void sent.catch(async () => {
      if (closing) return;
      if ('method' in message && 'id' in message && message.id !== undefined) {
        await stdio.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: '本机 HTTP MCP 连接失败，请检查 Feishu Sync 的本机服务。' } }).catch(() => {});
      }
      options.onError?.();
      await close();
    });
  };
  try {
    await http.start();
    await stdio.start();
  } catch (error) {
    await close();
    throw error;
  }
  return { close };
}
