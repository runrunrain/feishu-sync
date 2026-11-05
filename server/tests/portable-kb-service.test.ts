import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { KbVersionStore } from '../src/kb/kb-version-store.js';
import { exportPortableKb, importPortableKb, inspectPortableKb, isImportedRelease, restorePreviousLocalKb } from '../src/kb/portable-kb-service.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';
import { kbRoutes } from '../src/routes/kb.js';
import { computeSourceHash } from '../src/kb/raw-source-snapshot.js';
import { captureMissingSourceComparisonHashes, SOURCE_COMPARISON_CACHE, sourceComparisonKey } from '../src/kb/source-comparison.js';
import { computeSnapshotHash } from '../src/kb/build-orchestration.js';

const tempRoots: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portable-'));
  tempRoots.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sourceFixture() {
  const sender = temp(), receiver = temp(), sourceA = temp(), sourceB = temp(), output = path.join(temp(), 'share.fskb');
  const text = (date: string) => `<!--\nfeishu_sync:\n  fetch_date: "${date}"\n  last_synced_modify_time: "${date}"\n-->\n# 正文\n原内容\n`;
  fs.writeFileSync(path.join(sourceA, 'source.md'), text('A'));
  fs.writeFileSync(path.join(sourceB, 'source.md'), text('B'));
  const manifest = writeSearchRelease(sender, 'r_shared', [{ path: 'a.md', body: '# 标准文档' }]);
  const entry = { objToken: 'fixture', objType: 'docx' as const, title: '源', relPath: 'source.md',
    contentHash: computeSourceHash(path.join(sourceA, 'source.md'), [], sourceA), objEditTime: null };
  manifest.sourceSnapshot = [entry, { ...entry, objToken: 'changed', contentHash: `sha256:${'0'.repeat(64)}` }];
  fs.writeFileSync(path.join(sender, 'releases/r_shared/manifest.json'), JSON.stringify(manifest));
  return { sender, receiver, sourceA, sourceB, output, entry };
}

describe('portable source comparison proof', () => {
  it('exports only exact matching entries and merges without losing existing proofs', async () => {
    const f = sourceFixture();
    const manifestFile = path.join(f.sender, 'releases/r_shared/manifest.json');
    const before = fs.readFileSync(manifestFile);
    await exportPortableKb(f.sender, f.output, { knowledgeBaseRoot: f.sourceA, sheetCsvPaths: () => [] });
    expect(fs.readFileSync(manifestFile)).toEqual(before);
    const zip = await JSZip.loadAsync(fs.readFileSync(f.output));
    expect(await zip.file('release/manifest.json')!.async('nodebuffer')).toEqual(before);
    const proof = JSON.parse(await zip.file('source-comparison-v1.json')!.async('string')) as Record<string, string>;
    expect(proof[sourceComparisonKey(f.entry)]).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(Object.keys(proof)).toHaveLength(1);
    const old = JSON.stringify(['old', 'hash', 'path']);
    fs.writeFileSync(path.join(f.receiver, SOURCE_COMPARISON_CACHE), JSON.stringify({ [old]: 'v1:' + 'a'.repeat(64) }));
    await importPortableKb(f.receiver, f.output, null);
    const merged = JSON.parse(fs.readFileSync(path.join(f.receiver, SOURCE_COMPARISON_CACHE), 'utf8'));
    expect(merged).toEqual({ [old]: 'v1:' + 'a'.repeat(64), ...proof });
  });

  it('carries an existing manifest digest even when its original source is unavailable', async () => {
    const f = sourceFixture();
    const file = path.join(f.sender, 'releases/r_shared/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.sourceSnapshot[1].comparisonHash = 'v1:' + 'b'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(manifest));
    await exportPortableKb(f.sender, f.output, { knowledgeBaseRoot: '' });
    const zip = await JSZip.loadAsync(fs.readFileSync(f.output));
    const proof = JSON.parse(await zip.file('source-comparison-v1.json')!.async('string'));
    expect(proof[sourceComparisonKey(manifest.sourceSnapshot[1])]).toBe('v1:' + 'b'.repeat(64));
  });

  it('prefers manifest digest, then only the exact cached key, before computing from files', async () => {
    const f = sourceFixture();
    const file = path.join(f.sender, 'releases/r_shared/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.sourceSnapshot[0].comparisonHash = 'v1:' + '1'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(manifest));
    const firstKey = sourceComparisonKey(manifest.sourceSnapshot[0]);
    const secondKey = sourceComparisonKey(manifest.sourceSnapshot[1]);
    const unrelated = sourceComparisonKey({ ...f.entry, relPath: 'different.md' });
    fs.writeFileSync(path.join(f.sender, SOURCE_COMPARISON_CACHE), JSON.stringify({
      [firstKey]: 'v1:' + '2'.repeat(64), [secondKey]: 'v1:' + '3'.repeat(64), [unrelated]: 'v1:' + '4'.repeat(64),
    }));
    await exportPortableKb(f.sender, f.output, { knowledgeBaseRoot: f.sourceA });
    const zip = await JSZip.loadAsync(fs.readFileSync(f.output));
    const proof = JSON.parse(await zip.file('source-comparison-v1.json')!.async('string'));
    expect(proof).toEqual({ [firstKey]: 'v1:' + '1'.repeat(64), [secondKey]: 'v1:' + '3'.repeat(64) });
  });

  it('forwards an imported proof from A through B to C without rebuilding', async () => {
    const f = sourceFixture();
    const third = temp(), sourceC = temp(), forwarded = path.join(temp(), 'forwarded.fskb');
    const file = path.join(f.sender, 'releases/r_shared/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.sourceSnapshot = [f.entry];
    fs.writeFileSync(file, JSON.stringify(manifest));
    const bytesB = fs.readFileSync(path.join(f.sourceB, 'source.md'), 'utf8');
    fs.writeFileSync(path.join(sourceC, 'source.md'), bytesB.replaceAll('"B"', '"C"'));
    expect(computeSourceHash(path.join(f.sourceB, 'source.md'), [], f.sourceB)).not.toBe(f.entry.contentHash);
    await exportPortableKb(f.sender, f.output, { knowledgeBaseRoot: f.sourceA });
    await importPortableKb(f.receiver, f.output, null);
    await exportPortableKb(f.receiver, forwarded, { knowledgeBaseRoot: f.sourceB });
    const zip = await JSZip.loadAsync(fs.readFileSync(forwarded));
    const proof = JSON.parse(await zip.file('source-comparison-v1.json')!.async('string'));
    expect(proof[sourceComparisonKey(f.entry)]).toMatch(/^v1:[a-f0-9]{64}$/);
    await importPortableKb(third, forwarded, null);
    const routes = kbRoutes({
      buildService: { activeBuild: () => null, visionCacheProbe: () => null } as never,
      configManager: { load: async () => ({ standardKb: { outputRoot: third }, knowledgeBaseRoot: sourceC }) } as never,
      localMapStore: { listKbExcludedSources: () => [], listKbExplicitlyExcludedSources: () => [] } as never,
      documentsProvider: () => [{ objToken: 'fixture', objType: 'docx', title: '源', localRelPath: 'source.md', status: 'synced' }] as never,
      sheetCsvPaths: () => [],
    });
    const response = await routes.request('/api/kb/changes');
    expect(response.status).toBe(200);
    expect((await response.json() as { sources: unknown[] }).sources).toEqual([]);
    fs.appendFileSync(path.join(sourceC, 'source.md'), '真实修改\n');
    const changed = await routes.request('/api/kb/changes');
    expect(changed.status).toBe(200);
    expect((await changed.json() as { sources: unknown[] }).sources).toHaveLength(1);
  });

  it.each(['sha', 'injected', 'oversize'] as const)('rejects %s proof before switching release', async (kind) => {
    const f = sourceFixture();
    await exportPortableKb(f.sender, f.output, { knowledgeBaseRoot: f.sourceA });
    const zip = await JSZip.loadAsync(fs.readFileSync(f.output));
    const bundle = JSON.parse(await zip.file('bundle.json')!.async('string'));
    if (kind === 'sha') bundle.proof.sha256 = '0'.repeat(64);
    if (kind === 'injected') {
      const bytes = Buffer.from(JSON.stringify({ [JSON.stringify(['other', 'hash', 'x'])]: 'v1:' + 'a'.repeat(64) }));
      zip.file('source-comparison-v1.json', bytes);
      bundle.proof.size = bytes.length;
      bundle.proof.sha256 = createHash('sha256').update(bytes).digest('hex');
    }
    if (kind === 'oversize') bundle.proof.size = 8 * 1024 * 1024 + 1;
    zip.file('bundle.json', JSON.stringify(bundle));
    fs.writeFileSync(f.output, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(importPortableKb(f.receiver, f.output, null)).rejects.toThrow(/证明/);
    expect(fs.existsSync(path.join(f.receiver, 'CURRENT.json'))).toBe(false);
  });

  it('keeps a successful import when proof merge fails', async () => {
    const f = sourceFixture();
    await exportPortableKb(f.sender, f.output, { knowledgeBaseRoot: f.sourceA });
    fs.writeFileSync(path.join(f.receiver, SOURCE_COMPARISON_CACHE), 'invalid');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await importPortableKb(f.receiver, f.output, null);
    expect(new StandardKbStore(f.receiver).readCurrent()?.releaseId).toBe('r_shared');
    expect(warning).toHaveBeenCalled();
    expect(fs.readFileSync(path.join(f.receiver, SOURCE_COMPARISON_CACHE), 'utf8')).toBe('invalid');
  });

  it('repairs inherited entries only for exact source versions without changing the snapshot hash', async () => {
    const f = sourceFixture();
    const entries = [f.entry, { ...f.entry, objToken: 'changed', contentHash: `sha256:${'0'.repeat(64)}` }];
    const before = computeSnapshotHash(entries);
    await captureMissingSourceComparisonHashes(entries, f.sourceA, () => []);
    expect(entries[0]).toHaveProperty('comparisonHash', expect.stringMatching(/^v1:/));
    expect(entries[1]).not.toHaveProperty('comparisonHash');
    expect(computeSnapshotHash(entries)).toBe(before);
  });

  it('two devices report zero timestamp-only changes and one real edit through both HTTP endpoints', async () => {
    const f = sourceFixture();
    // Only the matching source is published in this end-to-end scenario.
    const file = path.join(f.sender, 'releases/r_shared/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.sourceSnapshot = [f.entry];
    fs.writeFileSync(file, JSON.stringify(manifest));
    const senderRoutes = kbRoutes({
      buildService: {} as never, localMapStore: {} as never,
      configManager: { load: async () => ({ standardKb: { outputRoot: f.sender }, knowledgeBaseRoot: f.sourceA }) } as never,
      documentsProvider: () => [], sheetCsvPaths: () => [],
    });
    const exported = await senderRoutes.request('/api/kb/portable/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: f.output }),
    });
    expect(exported.status).toBe(200);
    const routes = kbRoutes({
      buildService: { activeBuild: () => null, visionCacheProbe: () => null } as never,
      configManager: { load: async () => ({ standardKb: { outputRoot: f.receiver }, knowledgeBaseRoot: f.sourceB }) } as never,
      localMapStore: { listKbExcludedSources: () => [], listKbExplicitlyExcludedSources: () => [] } as never,
      documentsProvider: () => [{ objToken: 'fixture', objType: 'docx', title: '源', localRelPath: 'source.md', status: 'synced' }] as never,
      sheetCsvPaths: () => [],
    });
    const imported = await routes.request('/api/kb/portable/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: f.output, confirm: 'IMPORT', expectedCurrentReleaseId: null }),
    });
    expect(imported.status).toBe(200);
    const verify = async (count: number) => {
      const statusResponse = await routes.request('/api/kb/status');
      const changesResponse = await routes.request('/api/kb/changes');
      expect(statusResponse.status).toBe(200);
      expect(changesResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({ current: { imported: true }, pending: { added: 0, changed: count, removed: 0 } });
      const changes = await changesResponse.json() as { sources: unknown[] };
      expect(changes.sources).toHaveLength(count);
    };
    await verify(0);
    fs.appendFileSync(path.join(f.sourceB, 'source.md'), '真实修改\n');
    await verify(1);
  });

  it('status and changes both report a metadata-only source rename', async () => {
    const f = sourceFixture();
    const file = path.join(f.sender, 'releases/r_shared/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.sourceSnapshot = [f.entry];
    fs.writeFileSync(file, JSON.stringify(manifest));
    await exportPortableKb(f.sender, f.output, { knowledgeBaseRoot: f.sourceA });
    await importPortableKb(f.receiver, f.output, null);
    const routes = kbRoutes({
      buildService: { activeBuild: () => null, visionCacheProbe: () => null } as never,
      configManager: { load: async () => ({ standardKb: { outputRoot: f.receiver }, knowledgeBaseRoot: f.sourceB }) } as never,
      localMapStore: { listKbExcludedSources: () => [], listKbExplicitlyExcludedSources: () => [] } as never,
      documentsProvider: () => [{ objToken: 'fixture', objType: 'docx', title: '新标题', localRelPath: 'source.md', status: 'synced' }] as never,
      sheetCsvPaths: () => [],
    });
    const status = await (await routes.request('/api/kb/status')).json() as { pending: { changed: number } };
    const changes = await (await routes.request('/api/kb/changes')).json() as { sources: unknown[] };
    expect(status.pending.changed).toBe(1);
    expect(changes.sources).toHaveLength(1);
  });
});

describe('portable standard KB', () => {
  it('exports a complete release, imports to another library, reads it, and restores the previous release', async () => {
    const sender = temp(), receiver = temp(), output = path.join(temp(), 'share.fskb');
    writeSearchRelease(sender, 'r_shared', [{ path: '玩法/规则.md', body: '# 战斗规则\n## 命中\n命中率先计算' }]);
    const evidenceDir = path.join(sender, 'releases', 'r_shared', 'evidence');
    fs.mkdirSync(evidenceDir);
    fs.writeFileSync(path.join(evidenceDir, 'image.bin'), Buffer.from([0, 1, 2, 255]));
    const manifestPath = path.join(sender, 'releases', 'r_shared', 'manifest.json');
    const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { sourceSnapshot: unknown[] };
    manifestData.sourceSnapshot.push({ objToken: 'fixture', title: '样例源', relPath: 'source.md', contentHash: 'sha256:test' });
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData));
    fs.writeFileSync(path.join(sender, 'releases', 'r_shared', 'source-contents.json'), JSON.stringify({ fixture: '# 原始来源\n构建依据' }));
    writeSearchRelease(receiver, 'r_local', [{ path: 'local.md', body: '# 本机原库' }]);

    const exported = await exportPortableKb(sender, output);
    expect(exported.docCount).toBe(1);
    const preview = await inspectPortableKb(receiver, output);
    expect(preview).toMatchObject({ releaseId: 'r_shared', currentReleaseId: 'r_local', docCount: 1 });
    const imported = await importPortableKb(receiver, output, preview.currentReleaseId);
    expect(imported.previousReleaseId).toBe('r_local');
    expect(isImportedRelease(receiver, 'r_shared')).toBe(true);
    const store = new StandardKbStore(receiver);
    expect(store.readCurrent()?.releaseId).toBe('r_shared');
    const manifest = store.readManifest()!;
    expect(store.readReleaseDoc('r_shared', manifest.docs[0]).markdown).toContain('命中率先计算');
    expect(await store.search(manifest, '命中率')).toHaveLength(1);
    expect(fs.readFileSync(path.join(receiver, 'releases', 'r_shared', 'evidence', 'image.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(new KbVersionStore(receiver).readSourceContents('r_shared').fixture).toContain('构建依据');
    const routes = kbRoutes({
      buildService: { activeBuild: () => null } as never,
      configManager: { load: async () => ({ standardKb: { outputRoot: receiver }, knowledgeBaseRoot: path.join(receiver, 'no-local-sources') }) } as never,
      localMapStore: { listKbExcludedSources: () => [], listKbExplicitlyExcludedSources: () => [] } as never,
      documentsProvider: () => [], sheetCsvPaths: () => [],
    });
    const status = await (await routes.request('/api/kb/status')).json() as { current: { imported: boolean }; pending: unknown };
    expect(status).toMatchObject({ current: { imported: true }, pending: { added: 0, changed: 0, removed: 1 } });
    const publishedDoc = await (await routes.request('/api/kb/docs/kd_0')).json() as { sources: Array<{ state: string }> };
    expect(publishedDoc.sources[0].state).toBe('packaged');
    const packagedSource = await (await routes.request('/api/kb/portable/sources/fixture')).json() as { markdown: string };
    expect(packagedSource.markdown).toContain('构建依据');
    expect(new Set(new KbVersionStore(receiver).listVersions().map((v) => v.releaseId))).toEqual(new Set(['r_shared', 'r_local']));
    expect(restorePreviousLocalKb(receiver).releaseId).toBe('r_local');
    expect(store.readCurrent()?.releaseId).toBe('r_local');
  });

  it('rejects changed archive bytes and keeps the receiver pointer and releases untouched', async () => {
    const sender = temp(), receiver = temp(), output = path.join(temp(), 'share.fskb');
    writeSearchRelease(sender, 'r_shared', [{ path: 'a.md', body: '# 正文\n原文' }]);
    writeSearchRelease(receiver, 'r_local', [{ path: 'local.md', body: '# 本机原库' }]);
    await exportPortableKb(sender, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    zip.file('release/docs/a.md', '# 篡改正文', { createFolders: false });
    fs.writeFileSync(output, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(importPortableKb(receiver, output, 'r_local')).rejects.toThrow(/校验失败|大小不符/);
    expect(new StandardKbStore(receiver).readCurrent()?.releaseId).toBe('r_local');
    expect(fs.existsSync(path.join(receiver, 'releases', 'r_shared'))).toBe(false);
  });

  it('does not offer a rollback when the same release is imported again', async () => {
    const root = temp(), output = path.join(temp(), 'share.fskb');
    writeSearchRelease(root, 'r_same', [{ path: 'a.md', body: '# 正文' }]);
    await exportPortableKb(root, output);
    const result = await importPortableKb(root, output, 'r_same');
    expect(result.previousReleaseId).toBeNull();
    expect(() => restorePreviousLocalKb(root)).toThrow(/没有可恢复/);
  });

  it('replaces an existing archive after native save confirmation, through the export API', async () => {
    const root = temp(), output = path.join(temp(), 'share.fskb');
    writeSearchRelease(root, 'r_old', [{ path: 'a.md', body: '# 旧版本' }]);
    await exportPortableKb(root, output);
    const before = fs.readFileSync(output);
    writeSearchRelease(root, 'r_new', [{ path: 'a.md', body: '# 新版本\n确认覆盖后导出' }]);
    const routes = kbRoutes({
      buildService: {} as never, localMapStore: {} as never,
      configManager: { load: async () => ({ standardKb: { outputRoot: root } }) } as never,
      documentsProvider: () => [], sheetCsvPaths: () => [],
    });
    const response = await routes.request('/api/kb/portable/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: output, overwrite: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ releaseId: 'r_new', docCount: 1, path: output });
    expect(fs.readFileSync(output)).not.toEqual(before);
    expect(await inspectPortableKb(temp(), output)).toMatchObject({ releaseId: 'r_new', docCount: 1 });
    const receiver = temp();
    await importPortableKb(receiver, output, null);
    const store = new StandardKbStore(receiver);
    expect(store.readReleaseDoc('r_new', store.readManifest()!.docs[0]).markdown).toContain('确认覆盖后导出');
  });

  it('keeps an existing archive when overwrite is not authorized', async () => {
    const root = temp(), output = path.join(temp(), 'share.fskb');
    writeSearchRelease(root, 'r_old', [{ path: 'a.md', body: '# 旧版本' }]);
    await exportPortableKb(root, output);
    const before = fs.readFileSync(output);
    await expect(exportPortableKb(root, output)).rejects.toMatchObject({ code: 'kb_bundle_exists', status: 409 });
    expect(fs.readFileSync(output)).toEqual(before);
  });

  it('keeps the previous archive and removes the temporary package if replacement fails', async () => {
    const root = temp(), outputDir = temp(), output = path.join(outputDir, 'share.fskb');
    writeSearchRelease(root, 'r_old', [{ path: 'a.md', body: '# 旧版本' }]);
    await exportPortableKb(root, output);
    const before = fs.readFileSync(output);
    writeSearchRelease(root, 'r_new', [{ path: 'a.md', body: '# 新版本' }]);
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('模拟无写入权限'), { code: 'EACCES' }));
    await expect(exportPortableKb(root, output, { overwrite: true })).rejects.toThrow('模拟无写入权限');
    expect(fs.readFileSync(output)).toEqual(before);
    expect(fs.readdirSync(outputDir)).toEqual(['share.fskb']);
  });

  it('rejects directories and symbolic links as overwrite targets', async () => {
    const root = temp(), outputDir = temp(), folder = path.join(outputDir, 'folder.fskb');
    writeSearchRelease(root, 'r_source', [{ path: 'a.md', body: '# 正文' }]);
    fs.mkdirSync(folder);
    await expect(exportPortableKb(root, folder, { overwrite: true })).rejects.toMatchObject({ code: 'invalid_kb_export_target' });
    expect(fs.statSync(folder).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      const file = path.join(outputDir, 'original.txt'), link = path.join(outputDir, 'link.fskb');
      fs.writeFileSync(file, '原文件');
      fs.symlinkSync(file, link);
      await expect(exportPortableKb(root, link, { overwrite: true })).rejects.toMatchObject({ code: 'invalid_kb_export_target' });
      expect(fs.readFileSync(file, 'utf8')).toBe('原文件');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    }
  });

  it('rejects an archive path traversal before extraction', async () => {
    const sender = temp(), receiver = temp(), output = path.join(temp(), 'share.fskb');
    writeSearchRelease(sender, 'r_shared', [{ path: 'a.md', body: '# 正文' }]);
    await exportPortableKb(sender, output);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const bundle = JSON.parse(await zip.file('bundle.json')!.async('string')) as { files: Array<{ path: string }> };
    bundle.files[0].path = '../escape';
    zip.file('bundle.json', JSON.stringify(bundle));
    fs.writeFileSync(output, await zip.generateAsync({ type: 'nodebuffer' }));
    await expect(importPortableKb(receiver, output, null)).rejects.toThrow(/路径无效/);
    expect(fs.existsSync(path.join(receiver, 'escape'))).toBe(false);
  });
});
