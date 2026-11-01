import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { KbBuildService, type KbBuildDeps } from '../src/kb/kb-build-service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-persist-mode-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const rowInput = (id: string) => ({ id, mode: 'full' as const, status: 'published', baseReleaseId: null, model: 'fixture', createdAt: new Date().toISOString() });
function open(name: string): LocalMapStore {
  const store = new LocalMapStore(path.join(root, name));
  store.initialize();
  return store;
}
function dtoService(): KbBuildService {
  // 仅调用无活动进程的DTO投影；刻意用新模式配置验证旧行不会被当前配置重解释。
  return new KbBuildService({
    dataRoot: root,
    configProvider: () => ({ knowledgeBaseRoot: root, standardKb: { outputRoot: root, orchestrationMode: 'pi-amagi' } }),
  } as unknown as KbBuildDeps);
}

describe('构建模式是持久身份，不随内存entry清理消失', () => {
  it('新库写入pi-amagi，关闭/重开及新service后终局DTO仍是pi-amagi', () => {
    const first = open('native.db');
    first.createKbBuild({ ...rowInput('b_native'), orchestrationMode: 'pi-amagi' });
    first.close();
    const reopened = open('native.db');
    try {
      const row = reopened.getKbBuild('b_native')!;
      expect(row.orchestration_mode).toBe('pi-amagi');
      expect(dtoService().toDto(row).orchestrationMode).toBe('pi-amagi');
      reopened.updateKbBuild('b_native', { status: 'published', docsWritten: 2 });
      expect(reopened.getKbBuild('b_native')!.orchestration_mode).toBe('pi-amagi');
    } finally { reopened.close(); }
  });

  it('旧表原地additive迁移，旧行legacy且业务字段不变，重复初始化幂等', () => {
    const store = open('legacy.db');
    store.createKbBuild(rowInput('b_old'));
    store.close();
    const legacy = new Database(path.join(root, 'legacy.db'));
    legacy.exec('ALTER TABLE kb_builds DROP COLUMN orchestration_mode');
    legacy.close();
    const migrated = open('legacy.db');
    try {
      migrated.initialize();
      const row = migrated.getKbBuild('b_old')!;
      expect(row).toMatchObject({ id: 'b_old', status: 'published', model: 'fixture', orchestration_mode: 'legacy' });
      expect(dtoService().toDto(row).orchestrationMode).toBeUndefined();
    } finally { migrated.close(); }
  });

  it('恢复旧原生检查点时可补写持久模式，普通状态更新不重置它', () => {
    const store = open('resume.db');
    try {
      store.createKbBuild(rowInput('b_resume'));
      store.updateKbBuild('b_resume', { orchestrationMode: 'pi-amagi', status: 'queued' });
      store.updateKbBuild('b_resume', { status: 'published' });
      expect(dtoService().toDto(store.getKbBuild('b_resume')!).orchestrationMode).toBe('pi-amagi');
    } finally { store.close(); }
  });

  it('缺模式的历史行保持legacy，不从当前配置猜原生模式', () => {
    expect(dtoService().toDto({ ...rowInput('b_unknown'), created_at: 'fixture' }).orchestrationMode).toBeUndefined();
  });
});
