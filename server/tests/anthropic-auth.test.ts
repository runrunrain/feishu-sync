import { expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DirectChannel } from '../src/modules/direct-channel.js';
import { VisionChannel } from '../src/agent/vision/vision-channel.js';

it.each(['api-key', 'auth-token'] as const)('direct and vision SDK calls honor provider Anthropic auth %s', async (anthropicAuthType) => {
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer(async (req, res) => {
    for await (const _part of req) { /* drain request */ }
    headers.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'model', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const llm = { apiKey: '', openAiCompatBaseUrl: '', model: '', providers: [{ id: 'p', name: 'Fixture', enabled: true, protocol: 'anthropic-messages' as const, anthropicAuthType,
    apiKey: 'fixture-key', openAiCompatBaseUrl: `http://127.0.0.1:${port}`, models: [{ id: 'm', name: 'Preset', enabled: true, openAiModel: 'model', maxTokens: 128 }] }] };
  try {
    const adapted = await new DirectChannel(llm).adapt({ rawContent: 'fixture', localOldContent: null, options: { timeoutMs: 5000 } });
    expect(adapted.finishReason).toBe('stop');
    const vision = await new VisionChannel(llm).describe({ bytes: Buffer.from('fixture'), mime: 'image/png', prompt: 'fixture' }, { timeoutMs: 5000 });
    expect(vision.finishReason).toBe('stop');
    expect(headers).toHaveLength(2);
    for (const captured of headers) {
      expect(captured.authorization).toBe(anthropicAuthType === 'auth-token' ? 'Bearer fixture-key' : undefined);
      expect(captured['x-api-key']).toBe(anthropicAuthType === 'api-key' ? 'fixture-key' : undefined);
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
