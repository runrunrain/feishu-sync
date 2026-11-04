/** Offline distribution of the private plugin. All runtime installs use the existing Pi package installer. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { agentAssetsRoot, serverDistRoot } from './agent-assets.js';
import { AmagiPackageError, amagiInstallDir, computePackageContentHash, installAmagiPackage,
  verifyAmagiPackage, INSTALL_RECORD_FILENAME } from './build-runtime/amagi-package.js';

export interface BundledAmagi {
  schemaVersion: 1;
  package: 'amagi-pi';
  version: string;
  sourceHash: string;
  sourceCommit: string | null;
  contentHash: string;
  archiveSha256: string;
  archiveBytes: number;
  files: number;
  bytes: number;
  archivePath: string;
}

export function readBundledAmagi(directory?: string): BundledAmagi | null {
  const root = directory ?? [path.join(agentAssetsRoot(), 'bundled-amagi'),
    path.resolve(serverDistRoot(), '..', 'bundled', 'amagi-pi'),
  ].find((candidate) => fs.existsSync(path.join(candidate, 'manifest.json')));
  if (!root || !fs.existsSync(path.join(root, 'manifest.json'))) return null;
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as BundledAmagi;
  if (raw.schemaVersion !== 1 || raw.package !== 'amagi-pi' || !/^\d+\.\d+\.\d+$/.test(raw.version)
    || ![raw.contentHash, raw.archiveSha256, raw.sourceHash].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
    || !Number.isSafeInteger(raw.files) || raw.files <= 0 || raw.files > 30_000
    || !Number.isSafeInteger(raw.bytes) || raw.bytes <= 0 || raw.bytes > 512 * 1024 * 1024
    || !Number.isSafeInteger(raw.archiveBytes) || raw.archiveBytes <= 0 || raw.archiveBytes > 128 * 1024 * 1024) {
    throw new AmagiPackageError('amagi_bundle_invalid', '应用内置 amagi-pi 清单无效，请重新安装应用');
  }
  return { ...raw, archivePath: path.join(root, 'package.zip') };
}

export function bundledAmagiPackageRoot(dataRoot: string, bundle: BundledAmagi): string {
  return path.join(amagiInstallDir(dataRoot, bundle.version, bundle.contentHash), 'package');
}

const pending = new Map<string, ReturnType<typeof installAmagiPackage>>();
export function installBundledAmagi(input: {
  dataRoot: string; nodePath: string; piCliPath: string; bundle?: BundledAmagi;
  log?: (line: string) => void;
}): ReturnType<typeof installAmagiPackage> {
  const bundle = input.bundle ?? readBundledAmagi();
  if (!bundle) throw new AmagiPackageError('amagi_bundle_missing', '应用缺少内置 amagi-pi，请重新构建或安装应用');
  const key = amagiInstallDir(input.dataRoot, bundle.version, bundle.contentHash);
  const existing = pending.get(key); if (existing) return existing;
  const task = materialize(input, bundle).finally(() => pending.delete(key));
  pending.set(key, task); return task;
}

async function materialize(input: { dataRoot: string; nodePath: string; piCliPath: string; log?: (line: string) => void }, bundle: BundledAmagi) {
  const installDir = amagiInstallDir(input.dataRoot, bundle.version, bundle.contentHash);
  if (fs.existsSync(path.join(installDir, INSTALL_RECORD_FILENAME))) {
    return { ...verifyAmagiPackage({ dataRoot: input.dataRoot, version: bundle.version, contentHash: bundle.contentHash }), fresh: false };
  }
  const archive = fs.readFileSync(bundle.archivePath);
  if (archive.length !== bundle.archiveBytes || crypto.createHash('sha256').update(archive).digest('hex') !== bundle.archiveSha256) {
    throw new AmagiPackageError('amagi_bundle_corrupt', '内置 amagi-pi 安装包校验失败，请重新安装应用');
  }
  const parent = path.dirname(installDir); fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, '.bundled-amagi-'));
  try {
    const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
    let count = 0; let bytes = 0;
    for (const file of Object.values(zip.files)) {
      const originalName = (file as typeof file & { unsafeOriginalName?: string }).unsafeOriginalName ?? file.name;
      if (file.dir) continue;
      if (originalName !== file.name || file.name.includes('\\') || file.name.includes(':')
        || file.name.startsWith('/') || file.name.split('/').some((part) => !part || part === '.' || part === '..')
        || (Number(file.unixPermissions) & 0o170000) === 0o120000) {
        throw new AmagiPackageError('amagi_bundle_invalid', '内置插件包含不安全的文件路径或符号链接');
      }
      const content = await file.async('nodebuffer'); count++; bytes += content.length;
      if (count > bundle.files || bytes > bundle.bytes) throw new AmagiPackageError('amagi_bundle_invalid', '内置插件超出清单大小');
      const target = path.join(stage, file.name); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { mode: Number(file.unixPermissions) & 0o111 ? 0o755 : 0o644 });
    }
    const content = computePackageContentHash(stage);
    if (content.contentHash !== bundle.contentHash || count !== bundle.files || bytes !== bundle.bytes) {
      throw new AmagiPackageError('amagi_bundle_corrupt', '内置插件解压内容与应用清单不一致');
    }
    input.log?.(`[agent] 正在离线安装内置 amagi-pi ${bundle.version}`);
    return await installAmagiPackage({ ...input, version: bundle.version, sourceDir: stage,
      includeDependencies: true, expectedContentHash: bundle.contentHash });
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
