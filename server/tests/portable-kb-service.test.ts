import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { StandardKbStore } from '../src/kb/standard-kb-store.js';
import { KbVersionStore } from '../src/kb/kb-version-store.js';
import { exportPortableKb, importPortableKb, inspectPortableKb, isImportedRelease, restorePreviousLocalKb } from '../src/kb/portable-kb-service.js';
import { writeSearchRelease } from './helpers/kb-search-fixture.js';
import { kbRoutes } from '../src/routes/kb.js';

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
      localMapStore: {} as never,
      documentsProvider: () => [], sheetCsvPaths: () => [],
    });
    const status = await (await routes.request('/api/kb/status')).json() as { current: { imported: boolean }; pending: unknown };
    expect(status).toMatchObject({ current: { imported: true }, pending: { added: 0, changed: 0, removed: 0 } });
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
