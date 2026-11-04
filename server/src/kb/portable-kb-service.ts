/** Portable, self-contained standard KB release. The archive contains one immutable
 * release, never local credentials, build checkpoints, or the raw sync database. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { isPathInside } from '../agent/path-guard.js';
import { buildKbIndex } from './search/kb-index.js';
import { loadReleaseKnowledge, resolveRelease, validateReleaseId } from './search/release-reader.js';
import type { KbCurrentPointer, KbManifest } from '../types/agent-knowledge.js';

const FORMAT = 'feishu-sync-standard-kb';
const MAX_FILES = 100_000;
const MAX_BYTES = 20 * 1024 ** 3;
const MAX_BUNDLE_JSON = 32 * 1024 ** 2;

interface BundleFile { path: string; size: number; sha256: string }
interface Bundle {
  format: typeof FORMAT;
  schemaVersion: 1;
  releaseId: string;
  exportedAt: string;
  docCount: number;
  sourceCount: number;
  files: BundleFile[];
}
export interface PortableKbPreview {
  releaseId: string;
  docCount: number;
  sourceCount: number;
  fileCount: number;
  unpackedBytes: number;
  archiveBytes: number;
  currentReleaseId: string | null;
  alreadyInstalled: boolean;
}

export class PortableKbError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'PortableKbError';
  }
}
function invalid(message: string): never { throw new PortableKbError('invalid_kb_bundle', message); }
function assertSafeRelative(value: string): void {
  if (!value || value.includes('\\') || value.includes('\0') || value.includes(':') || value.startsWith('/')
    || value.split('/').some((part) => !part || part === '.' || part === '..')) invalid(`包内路径无效：${value}`);
}
async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
async function listReleaseFiles(dir: string): Promise<BundleFile[]> {
  const result: BundleFile[] = [];
  let totalBytes = 0;
  const visit = async (relative: string): Promise<void> => {
    const entries = await fs.promises.readdir(path.join(dir, relative), { withFileTypes: true });
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      assertSafeRelative(name);
      if (entry.isSymbolicLink()) invalid(`版本含符号链接：${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        const full = path.join(dir, name);
        const size = (await fs.promises.stat(full)).size;
        result.push({ path: name, size, sha256: await sha256File(full) });
        totalBytes += size;
        if (result.length > MAX_FILES || totalBytes > MAX_BYTES) invalid('版本超过共享包大小上限');
      } else invalid(`版本含非普通文件：${name}`);
    }
  };
  await visit('');
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function assertPathOutsideRoot(root: string, destination: string): void {
  if (!path.isAbsolute(destination)) invalid('请选择绝对文件路径');
  const rootReal = fs.realpathSync.native(root);
  const parent = fs.realpathSync.native(path.dirname(destination));
  if (isPathInside(rootReal, parent)) invalid('共享包不能保存到标准库数据目录内');
}
function writePointer(root: string, pointer: KbCurrentPointer): void {
  const target = path.join(root, 'CURRENT.json');
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(pointer, null, 2), { flag: 'wx' });
    fs.renameSync(temp, target);
  } finally { fs.rmSync(temp, { force: true }); }
}
function pointerFor(manifest: KbManifest): KbCurrentPointer {
  return { schemaVersion: 1, releaseId: manifest.releaseId, publishedAt: manifest.publishedAt };
}
function currentId(root: string): string | null {
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(root, 'CURRENT.json'), 'utf8')) as KbCurrentPointer;
    validateReleaseId(pointer.releaseId);
    return pointer.releaseId;
  } catch { return null; }
}

function exportTargetStat(destination: string): fs.Stats | undefined {
  const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new PortableKbError('invalid_kb_export_target', '导出目标是文件夹或符号链接，请选择普通文件');
  return stat;
}
function exportExistsError(): PortableKbError {
  return new PortableKbError('kb_bundle_exists', '目标文件已存在，请重新选择并确认替换', 409);
}

export async function exportPortableKb(
  root: string, destination: string, options: { overwrite?: boolean } = {},
): Promise<PortableKbPreview & { path: string }> {
  assertPathOutsideRoot(root, destination);
  const existing = exportTargetStat(destination);
  if (existing && !options.overwrite) throw exportExistsError();
  const release = resolveRelease(root);
  const files = await listReleaseFiles(release.releaseDir);
  const bundle: Bundle = {
    format: FORMAT, schemaVersion: 1, releaseId: release.releaseId,
    exportedAt: new Date().toISOString(), docCount: release.manifest.docs.length,
    sourceCount: release.manifest.sourceSnapshot.length, files,
  };
  const temp = `${destination}.${randomUUID()}.tmp`;
  const archive = archiver('zip', { zlib: { level: 6 } });
  const output = fs.createWriteStream(temp, { flags: 'wx' });
  // Attach stream failure handlers before archiving starts; disk/write errors
  // must reject this request and leave the previously exported archive intact.
  const writing = pipeline(archive, output);
  archive.on('warning', (error) => archive.destroy(error));
  try {
    archive.append(JSON.stringify(bundle), { name: 'bundle.json' });
    for (const item of files) archive.file(path.join(release.releaseDir, item.path), { name: `release/${item.path}` });
    await Promise.all([archive.finalize(), writing]);
    if (existing) {
      const current = exportTargetStat(destination);
      if (!current || current.dev !== existing.dev || current.ino !== existing.ino
        || current.size !== existing.size || current.mtimeMs !== existing.mtimeMs || current.ctimeMs !== existing.ctimeMs) {
        throw new PortableKbError('kb_export_target_changed', '导出期间目标文件已变化，请重新选择并确认替换', 409);
      }
      // Native SaveDialog already obtained overwrite approval. Only replace the
      // directory entry after the complete ZIP stream has closed successfully.
      await fs.promises.rename(temp, destination);
    } else {
      // A file created by another operation while we archive was never approved
      // for replacement, even when this request came from the save dialog.
      try { await fs.promises.link(temp, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw exportExistsError();
        throw error;
      }
      await fs.promises.unlink(temp);
    }
    const stat = await fs.promises.stat(destination);
    return {
      path: destination, releaseId: release.releaseId, docCount: bundle.docCount,
      sourceCount: bundle.sourceCount, fileCount: files.length,
      unpackedBytes: files.reduce((sum, item) => sum + item.size, 0), archiveBytes: stat.size,
      currentReleaseId: currentId(root), alreadyInstalled: true,
    };
  } catch (error) {
    archive.destroy();
    output.destroy();
    await writing.catch(() => undefined);
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

async function openBundle(archivePath: string): Promise<{ bundle: Bundle; entries: Map<string, unzipper.File>; archiveBytes: number }> {
  if (!path.isAbsolute(archivePath)) invalid('请选择绝对文件路径');
  const stat = await fs.promises.lstat(archivePath).catch(() => invalid('共享包不存在或无法读取'));
  if (!stat.isFile() || stat.isSymbolicLink()) invalid('共享包不是普通文件');
  if (stat.size > MAX_BYTES || stat.size === 0) invalid('共享包大小无效');
  const zip = await unzipper.Open.file(archivePath).catch(() => invalid('共享包不是有效 ZIP 文件'));
  if (zip.files.length > MAX_FILES + 1) invalid('共享包文件过多');
  const entries = new Map<string, unzipper.File>();
  for (const entry of zip.files) {
    if (entry.type !== 'File' || entries.has(entry.path)) invalid('共享包含目录或重复条目');
    if (entry.path !== 'bundle.json') {
      if (!entry.path.startsWith('release/')) invalid('共享包含未知条目');
      assertSafeRelative(entry.path.slice('release/'.length));
    }
    // Unix symlinks and special files are not accepted even when ZIP marks them as File.
    const mode = entry.externalFileAttributes >>> 16;
    if (mode && (mode & 0o170000) && (mode & 0o170000) !== 0o100000) invalid('共享包含符号链接或特殊文件');
    entries.set(entry.path, entry);
  }
  const metadata = entries.get('bundle.json');
  if (!metadata || metadata.uncompressedSize > MAX_BUNDLE_JSON) invalid('共享包清单缺失或过大');
  let bundle: Bundle;
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of metadata.stream()) {
      const bytes = chunk as Buffer;
      length += bytes.length;
      if (length > MAX_BUNDLE_JSON) invalid('共享包清单超过大小上限');
      chunks.push(bytes);
    }
    bundle = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Bundle;
  }
  catch (error) {
    if (error instanceof PortableKbError) throw error;
    return invalid('共享包清单不是合法 JSON');
  }
  if (bundle.format !== FORMAT || bundle.schemaVersion !== 1 || !Array.isArray(bundle.files)
    || !Number.isSafeInteger(bundle.docCount) || bundle.docCount < 0
    || !Number.isSafeInteger(bundle.sourceCount) || bundle.sourceCount < 0) invalid('共享包格式或版本不支持');
  try { validateReleaseId(bundle.releaseId); } catch { invalid('版本标识无效'); }
  if (bundle.files.length !== entries.size - 1 || bundle.files.length > MAX_FILES || !bundle.files.length) invalid('共享包文件清单不匹配');
  let bytes = 0;
  const seen = new Set<string>();
  for (const item of bundle.files) {
    if (!item || typeof item.path !== 'string' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
      || !Number.isSafeInteger(item.size) || item.size < 0) invalid('共享包文件清单无效');
    assertSafeRelative(item.path);
    if (seen.has(item.path)) invalid('共享包文件清单重复');
    seen.add(item.path);
    const entry = entries.get(`release/${item.path}`);
    if (!entry || entry.uncompressedSize !== item.size) invalid(`共享包文件大小不符：${item.path}`);
    bytes += item.size;
    if (bytes > MAX_BYTES) invalid('共享包解压大小超过上限');
  }
  if (!seen.has('manifest.json')) invalid('共享包缺少 manifest.json');
  return { bundle, entries, archiveBytes: stat.size };
}

export async function inspectPortableKb(root: string, archivePath: string): Promise<PortableKbPreview> {
  const { bundle, archiveBytes } = await openBundle(archivePath);
  return {
    releaseId: bundle.releaseId, docCount: bundle.docCount, sourceCount: bundle.sourceCount,
    fileCount: bundle.files.length, unpackedBytes: bundle.files.reduce((n, item) => n + item.size, 0),
    archiveBytes, currentReleaseId: currentId(root),
    alreadyInstalled: fs.existsSync(path.join(root, 'releases', bundle.releaseId)),
  };
}

async function verifyRelease(stagingRoot: string, bundle: Bundle): Promise<KbManifest> {
  try {
  const release = resolveRelease(stagingRoot);
  const manifest = release.manifest;
  if (manifest.releaseId !== bundle.releaseId || manifest.docs.length !== bundle.docCount
    || manifest.sourceSnapshot.length !== bundle.sourceCount) invalid('共享包清单与正式版本不一致');
  const index = await buildKbIndex(release.releaseDir, manifest);
  if (index.integrity.mismatched.length || index.integrity.missing.length) invalid('共享包文档哈希或路径无效');
  if (manifest.organization) loadReleaseKnowledge(release);
  for (const section of [
    manifest.evidence && { path: manifest.evidence.resourcesPath, hash: manifest.evidence.hash },
    manifest.governance,
  ]) {
    if (!section) continue;
    assertSafeRelative(section.path);
    const file = path.join(release.releaseDir, section.path);
    if (`sha256:${await sha256File(file)}` !== section.hash) invalid(`共享包索引损坏：${section.path}`);
  }
  if (manifest.evidence) {
    const data = JSON.parse(fs.readFileSync(path.join(release.releaseDir, manifest.evidence.resourcesPath), 'utf8')) as { evidenceFiles?: Array<{ path: string; hash: string }> };
    if (!Array.isArray(data.evidenceFiles)) invalid('共享包证据清单无效');
    for (const item of data.evidenceFiles) {
      assertSafeRelative(item.path);
      if (!/^sha256:[a-f0-9]{64}$/.test(item.hash) || `sha256:${await sha256File(path.join(release.releaseDir, item.path))}` !== item.hash) {
        invalid(`共享包证据损坏：${item.path}`);
      }
    }
  }
  return manifest;
  } catch (error) {
    if (error instanceof PortableKbError) throw error;
    return invalid(`共享包正式版本无法验证：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Install only after all streamed entries and release references pass validation. */
export async function importPortableKb(
  root: string, archivePath: string, expectedCurrentReleaseId: string | null,
  assertIdle: () => void = () => undefined,
): Promise<PortableKbPreview & { previousReleaseId: string | null }> {
  assertIdle();
  const before = currentId(root);
  if (before !== expectedCurrentReleaseId) throw new PortableKbError('kb_current_changed', '当前标准库已变化，请重新预览后导入', 409);
  const { bundle, entries, archiveBytes } = await openBundle(archivePath);
  await fs.promises.mkdir(path.join(root, 'releases'), { recursive: true });
  const stage = await fs.promises.mkdtemp(path.join(root, '.portable-import-'));
  const stageRelease = path.join(stage, 'releases', bundle.releaseId);
  let installed = false;
  try {
    await fs.promises.mkdir(stageRelease, { recursive: true });
    for (const item of bundle.files) {
      const entry = entries.get(`release/${item.path}`)!;
      const target = path.join(stageRelease, item.path);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const hash = createHash('sha256');
      let size = 0;
      await pipeline(entry.stream(), new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > item.size) return callback(new Error('文件超过清单大小'));
          hash.update(chunk);
          callback(null, chunk);
        },
      }), fs.createWriteStream(target, { flags: 'wx' }));
      if (size !== item.size || hash.digest('hex') !== item.sha256) invalid(`共享包校验失败：${item.path}`);
    }
    const manifestRaw = JSON.parse(await fs.promises.readFile(path.join(stageRelease, 'manifest.json'), 'utf8')) as KbManifest;
    if (manifestRaw.releaseId !== bundle.releaseId) invalid('共享包版本标识不一致');
    await fs.promises.writeFile(path.join(stage, 'CURRENT.json'), JSON.stringify(pointerFor(manifestRaw)));
    const manifest = await verifyRelease(stage, bundle);
    assertIdle();
    if (currentId(root) !== before) throw new PortableKbError('kb_current_changed', '当前标准库已变化，请重新预览后导入', 409);
    const targetDir = path.join(root, 'releases', bundle.releaseId);
    if (fs.existsSync(targetDir)) {
      const actual = await listReleaseFiles(targetDir);
      const expected = new Map(bundle.files.map((item) => [item.path, item]));
      if (actual.length !== bundle.files.length || actual.some((item) => {
        const match = expected.get(item.path);
        return !match || match.size !== item.size || match.sha256 !== item.sha256;
      })) {
        throw new PortableKbError('kb_release_conflict', '本机已有同名但内容不同的版本，未覆盖', 409);
      }
    } else {
      await fs.promises.rename(stageRelease, targetDir);
      installed = true;
    }
    if (before !== bundle.releaseId) {
      const markerDir = path.join(root, 'imports');
      await fs.promises.mkdir(markerDir, { recursive: true });
      const marker = path.join(markerDir, `${bundle.releaseId}.json`);
      const markerTemp = `${marker}.${randomUUID()}.tmp`;
      await fs.promises.writeFile(markerTemp, JSON.stringify({ previousLocalReleaseId: before, importedAt: new Date().toISOString() }));
      await fs.promises.rename(markerTemp, marker);
    }
    writePointer(root, pointerFor(manifest));
    return {
      releaseId: bundle.releaseId, docCount: bundle.docCount, sourceCount: bundle.sourceCount,
      fileCount: bundle.files.length, unpackedBytes: bundle.files.reduce((n, item) => n + item.size, 0),
      archiveBytes, currentReleaseId: bundle.releaseId, alreadyInstalled: installed || fs.existsSync(targetDir),
      previousReleaseId: before === bundle.releaseId ? null : before,
    };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

export function previousLocalReleaseId(root: string, releaseId: string): string | null {
  try {
    validateReleaseId(releaseId);
    const marker = path.join(root, 'imports', `${releaseId}.json`);
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as { previousLocalReleaseId: string };
    validateReleaseId(parsed.previousLocalReleaseId);
    return fs.existsSync(path.join(root, 'releases', parsed.previousLocalReleaseId)) ? parsed.previousLocalReleaseId : null;
  } catch { return null; }
}

export function isImportedRelease(root: string, releaseId: string): boolean {
  try {
    validateReleaseId(releaseId);
    return fs.lstatSync(path.join(root, 'imports', `${releaseId}.json`)).isFile();
  } catch { return false; }
}

export function restorePreviousLocalKb(root: string): { releaseId: string; previousReleaseId: string } {
  const importedId = currentId(root);
  const previous = importedId && previousLocalReleaseId(root, importedId);
  if (!importedId || !previous) throw new PortableKbError('kb_restore_unavailable', '没有可恢复的导入前版本', 404);
  const release = resolveRelease(root, previous);
  writePointer(root, pointerFor(release.manifest));
  return { releaseId: previous, previousReleaseId: importedId };
}
