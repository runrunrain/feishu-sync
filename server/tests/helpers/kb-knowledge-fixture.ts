/**
 * v2（组织化）release fixture：在 writeSearchRelease 之上补写 knowledge.json
 * 并升级 manifest（schemaVersion 2 + organization 段，哈希按写入字节计算）。
 * 合成数据，非生产 fixture。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { KbManifest } from '../../src/types/agent-knowledge.js';
import type { KnowledgeManifest } from '../../src/kb/knowledge-schema.js';
import { writeSearchRelease, type FixtureDoc } from './kb-search-fixture.js';

export function writeKnowledgeRelease(
  root: string,
  releaseId: string,
  docs: FixtureDoc[],
  knowledge: KnowledgeManifest,
  options: { coverageMode?: 'managed' | 'mixed'; current?: boolean } = {},
): KbManifest {
  const manifest = writeSearchRelease(root, releaseId, docs, options.current ?? true);
  const bytes = `${JSON.stringify(knowledge, null, 2)}\n`;
  const releaseDir = path.join(root, 'releases', releaseId);
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'knowledge.json'), bytes);
  manifest.schemaVersion = 2;
  manifest.organization = {
    schemaVersion: knowledge.schemaVersion,
    path: 'knowledge.json',
    hash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    coverageMode: options.coverageMode ?? 'managed',
  };
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}
