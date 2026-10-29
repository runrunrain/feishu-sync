/** Explicitly synthetic fixtures; scale expansion is performance-only, never qrels. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KbManifest } from '../../src/types/agent-knowledge.js';
import { sha256 } from './kb-eval-io.js';

export const fixtureDir = fileURLToPath(new URL('../../tests/fixtures/kb-eval/', import.meta.url));
interface FixtureDoc { path: string; title: string; summary: string; headings: string[]; body: string }
const fixture = () => JSON.parse(fs.readFileSync(path.join(fixtureDir, 'synthetic-corpus.json'), 'utf8')) as {
  synthetic: true; releaseId: string; docs: FixtureDoc[];
};
export const BENCH_QUERIES = ['暴击', '宠物 升星 消耗', '暴击伤害结算顺序', '1001', '血量', '公会'];
export const SYNTHETIC_SEED = 0x20261029;

export function materializeSynthetic(dir: string, mb?: 10 | 30, progress?: (message: string) => void): void {
  // Only fresh caller-owned temporary directories. No overwriting existing release contents.
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error('synthetic_target_not_empty');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const source = fixture();
  const total = mb === undefined ? source.docs.length : mb * 25;
  const targetBytes = mb === undefined ? undefined : mb * 1024 * 1024;
  let emitted = 0;
  let seed = SYNTHETIC_SEED;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const manifest: KbManifest & { synthetic: true; syntheticSeed: number; benchmarkOnly: boolean } = {
    schemaVersion: 1, releaseId: mb ? `synthetic-perf-${mb}mib-v1` : source.releaseId,
    buildId: 'synthetic-e0', mode: 'full', baseReleaseId: null,
    publishedAt: '2026-10-29T00:00:00.000Z', model: null, sourceSnapshot: [], skippedSources: [], docs: [],
    synthetic: true, syntheticSeed: SYNTHETIC_SEED, benchmarkOnly: mb !== undefined,
  };
  for (let i = 0; i < total; i++) {
    const entry = source.docs[i % source.docs.length];
    const docId = `synthetic-${String(i).padStart(4, '0')}`;
    const relative = mb ? `synthetic-${String(i).padStart(4, '0')}/${entry.path}` : entry.path;
    let body = entry.body;
    if (targetBytes !== undefined) {
      const size = Math.floor(targetBytes / total) + (i < targetBytes % total ? 1 : 0);
      // Different deterministic rows, headings, IDs and Chinese body lines. Avoid one huge
      // repeated string (unrepresentative V8 ropes/compression); pad only final <3 bytes.
      const rows = [body];
      let bytes = Buffer.byteLength(body);
      while (bytes + 160 < size) {
        const row = `合成样本${next().toString(16)}：资源规则按轮次记录，编号${next() % 10000}，系统设计不代表真实游戏配置。\n`;
        rows.push(row); bytes += Buffer.byteLength(row);
      }
      rows.push('x'.repeat(size - bytes));
      body = rows.join('');
    }
    emitted += Buffer.byteLength(body);
    const header = `<!--\nfeishu_sync_kb:\n  doc_id: ${docId}\n  sources:\n    - synthetic-source\n  build_id: synthetic-e0\n-->\n`;
    const markdown = header + body;
    const file = path.join(dir, 'docs', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, markdown);
    manifest.docs.push({
      docId, path: relative, title: entry.title, summary: entry.summary, headings: entry.headings,
      tags: ['synthetic'], sources: ['synthetic-source'], contentHash: sha256(markdown), updatedInBuild: 'synthetic-e0',
    });
    if ((i + 1) % 100 === 0) progress?.(`synthetic: ${i + 1}/${total} documents`);
  }
  if (targetBytes !== undefined && emitted !== targetBytes) throw new Error('synthetic_size_mismatch');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
