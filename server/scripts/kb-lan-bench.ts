/** Real MCP HTTP benchmark. Run against an explicitly enabled test gateway.
 * npx tsx scripts/kb-lan-bench.ts --url http://127.0.0.1:PORT/mcp --queries /tmp/queries.jsonl
 * Token comes only from FEISHU_KB_TOKEN (or --token-env NAME), never argv/output.
 * Query JSONL accepts E0 rows {query}; reports aggregates, never query text.
 */
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string, fallback?: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const url = new URL(arg('--url') ?? '');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid_url');
  const token = process.env[arg('--token-env', 'FEISHU_KB_TOKEN')!];
  if (!token) throw new Error('missing_token_env');
  const queriesFile = arg('--queries');
  if (!queriesFile) throw new Error('--queries JSONL is required (use an explicit synthetic fixture or E0 file)');
  const queries = fs.readFileSync(queriesFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).query as string);
  if (!queries.length || queries.some((q) => typeof q !== 'string' || !q.length)) throw new Error('invalid_queries');
  const count = Number(arg('--clients', '3')); const parallel = Number(arg('--parallel', '4')); const rounds = Number(arg('--rounds', '5'));
  if (![count, parallel, rounds].every((n) => Number.isInteger(n) && n >= 1 && n <= 100)) throw new Error('invalid_load');
  const clients: Client[] = [];
  const samples: number[] = []; const first: number[] = [];
  let busy = 0; let errors = 0;
  const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
  try {
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      const client = new Client({ name: 'kb-lan-bench', version: '1' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      const response = await client.callTool({ name: 'search_knowledge', arguments: { query: queries[0] } });
      if (response.isError) errors++;
      first.push(performance.now() - start);
    }
    for (let round = 0; round < rounds; round++) {
      await Promise.all(clients.flatMap((client, i) => Array.from({ length: parallel }, async (_, j) => {
        const start = performance.now();
        try {
          const result = await client.callTool({ name: 'search_knowledge', arguments: { query: queries[(round * parallel + i + j) % queries.length] } });
          if (result.isError) { if (JSON.stringify(result).includes('kb_busy')) busy++; else errors++; }
        } catch { errors++; }
        samples.push(performance.now() - start);
      })));
      console.error(`progress ${round + 1}/${rounds}`);
    }
    console.log(JSON.stringify({ clients: count, parallel, rounds, calls: samples.length, firstCallMs: first, p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95), maxMs: percentile(samples, 1), kbBusy: busy, errors }));
    if (errors || busy) process.exitCode = 1;
  } finally { await Promise.allSettled(clients.map((client) => client.close())); }
}
void main().catch((e) => { console.error(e instanceof Error ? e.message : 'benchmark_failed'); process.exitCode = 1; });
