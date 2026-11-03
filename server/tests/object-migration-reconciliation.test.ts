import { describe, expect, it } from 'vitest';
import { objectMigrationGaps, validateObjectMigrationRegistration } from '../src/kb/object-migration-reconciliation.js';
import type { KnowledgeDraftFile } from '../src/agent/agent-tool-service.js';
import type { KnowledgeManifest } from '../src/kb/knowledge-schema.js';

function fixture() {
  const old = { objectId: 'ko_old', title: '灾荒事件', familyKey: 'old-event',
    canonical: { path: '旧篇.md' } };
  const replacement = { objectId: 'ko_new', title: '灾荒事件', familyKey: 'new-event',
    canonical: { path: '新篇.md' } };
  const previous = { objects: [old], evidence: [{ objectId: 'ko_old', sourceRef: { sourceId: 'source-1' } }] } as KnowledgeManifest;
  const draft = { objects: [replacement], evidence: [{ objectId: 'ko_new', sourceRef: { sourceId: 'source-1' } }],
    coverage: [], relations: [], presentations: [], docs: { '新篇.md': { docId: 'kd_new', revision: 1, bodyLineOffset: 0 } } } as unknown as KnowledgeDraftFile;
  return { previous, draft };
}

describe('object migration reconciliation', () => {
  it('shows a compact, evidence-linked successor and stops reporting it once registered', () => {
    const { previous, draft } = fixture();
    const gaps = objectMigrationGaps({ previous, draft, plan: { migrations: [] }, docBody: () => '灾荒事件在下一回合触发' });
    expect(gaps).toEqual([{
      objectId: 'ko_old', title: '灾荒事件', priorPath: '旧篇.md',
      candidates: [{ objectId: 'ko_new', title: '灾荒事件', path: '新篇.md', sharedSources: ['source-1'] }],
    }]);
    expect(objectMigrationGaps({ previous, draft, plan: { migrations: [{
      objectId: 'ko_old', kind: 'merge', successorObjectIds: ['ko_new'], reason: '合并规则',
    }] } })).toEqual([]);
  });

  it('accepts a valid semantic mapping and rejects fabricated or still-referenced identities', () => {
    const { previous, draft } = fixture();
    const migration = { objectId: 'ko_old', kind: 'merge' as const, successorObjectIds: ['ko_new'], reason: '同一灾荒规则迁往新篇' };
    expect(validateObjectMigrationRegistration({ previous, draft, existing: [], proposed: [migration] })).toEqual([]);
    expect(validateObjectMigrationRegistration({ previous, draft, existing: [migration], proposed: [migration] }))
      .toContain('ko_old: 已登记迁移，禁止覆盖旧去向');
    const missingSource = { ...draft, evidence: [] };
    expect(validateObjectMigrationRegistration({ previous, draft: missingSource, existing: [], proposed: [migration] }))
      .toContain('ko_old: 后继 ko_new 与旧对象缺少共同来源证据');
    const dangling = { ...draft, coverage: [{ targetObjectIds: ['ko_old'] }] } as KnowledgeDraftFile;
    expect(validateObjectMigrationRegistration({ previous, draft: dangling, existing: [], proposed: [migration] }))
      .toContain('ko_old: 草稿仍有引用，先由写作任务处理引用与覆盖归属');
  });
});
