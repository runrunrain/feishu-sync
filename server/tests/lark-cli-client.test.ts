import { describe, expect, it } from 'vitest';
import { LarkCliClient, LarkCliError } from '../src/modules/lark-cli-client.js';

type ClientInternals = {
  parseJsonOutput(stdout: string): any;
  extractJsonValues(stdout: string): string[];
};

function createClient(): LarkCliClient {
  return new LarkCliClient({
    requiredScopes: [],
    timeout: 1_000,
    larkCliPath: 'lark-cli-not-invoked-by-these-tests',
  });
}

function internals(client: LarkCliClient): ClientInternals {
  return client as unknown as ClientInternals;
}

describe('LarkCliClient output parsing and classification', () => {
  it('merges log-prefixed ANSI NDJSON pages without losing nodes', () => {
    const client = createClient();
    const result = internals(client).parseJsonOutput(
      '\u001b[32mINFO fetching page 1\u001b[0m\n' +
      '{"data":{"nodes":[{"node_token":"A"}],"has_more":true}}\n' +
      'progress: 50%\n' +
      '{"data":{"nodes":[{"node_token":"B"}],"has_more":false}}\n',
    );

    expect(result).toEqual({
      ok: true,
      data: {
        nodes: [{ node_token: 'A' }, { node_token: 'B' }],
        has_more: false,
      },
    });
  });

  it('handles braces inside JSON strings while extracting a log-prefixed value', () => {
    const client = createClient();
    const values = internals(client).extractJsonValues(
      'debug before {not-json}\n{"data":{"title":"literal } and { braces"}}\n',
    );
    expect(values).toContain('{"data":{"title":"literal } and { braces"}}');
    expect(internals(client).parseJsonOutput('debug {not-json}\n{"data":{"title":"literal } and { braces"}}'))
      .toEqual({ ok: true, data: { title: 'literal } and { braces' } });
  });

  it('classifies JSON permission errors as non-retryable structured errors', () => {
    const client = createClient();
    try {
      internals(client).parseJsonOutput('{"ok":false,"code":40403,"msg":"forbidden"}');
      throw new Error('expected parseJsonOutput to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(LarkCliError);
      expect(error).toMatchObject({ code: 'permission', retryable: false, upstreamCode: '40403' });
    }
  });

  it('does not treat ordinary text as malformed JSON (version output)', () => {
    const client = createClient();
    expect(internals(client).parseJsonOutput('lark-cli 1.0.53\n')).toEqual({
      ok: true,
      data: { version: 'lark-cli 1.0.53' },
    });
  });
});
