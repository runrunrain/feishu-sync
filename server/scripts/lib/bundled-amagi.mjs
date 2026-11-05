/** Private amagi-pi distribution: build from the npm publication allowlist, never the whole checkout. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const bundlerVersion = 3;
function requiredLocalPatch(version) {
  if (version !== '2.21.36') return null;
  const patchPath = path.join(serverRoot, 'patches/amagi-pi-2.21.31-background-continue.patch');
  return { patchPath, sha256: sha(fs.readFileSync(patchPath)) };
}

function npm(args, cwd) {
  const cli = [process.env.npm_execpath,
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ].find((candidate) => candidate && fs.existsSync(candidate));
  if (!cli) throw new Error('Bundling amagi-pi requires npm; run this command with npm run.');
  return execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
}

export async function bundleAmagi({ sourceDir = process.env.AMAGI_PI_SOURCE_DIR,
  bundleDir = path.join(serverRoot, 'bundled', 'amagi-pi'),
  destination = path.join(serverRoot, 'dist', 'agent', 'bundled-amagi'),
} = {}) {
  const sibling = path.resolve(serverRoot, '../../amagi-pi');
  const source = sourceDir === false || process.env.AMAGI_PI_USE_BUNDLED === '1' ? null
    : sourceDir ? path.resolve(sourceDir) : fs.existsSync(path.join(sibling, 'package.json')) ? sibling : null;
  const manifestPath = path.join(bundleDir, 'manifest.json');
  const archivePath = path.join(bundleDir, 'package.zip');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* first bundle */ }
  if (source) {
    const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    if (pkg.name !== 'amagi-pi' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('AMAGI_PI_SOURCE_DIR must contain a stable amagi-pi package');
    const localPatch = requiredLocalPatch(pkg.version);
    const [packed] = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'], source));
    const files = packed.files.map((file) => file.path).sort();
    const lock = fs.readFileSync(path.join(source, 'package-lock.json'));
    const entries = files.map((name) => {
      const full = path.resolve(source, name);
      if (!full.startsWith(source + path.sep) || fs.lstatSync(full).isSymbolicLink()) throw new Error(`Unsafe published file: ${name}`);
      return [name, sha(fs.readFileSync(full))];
    });
    const sourceHash = sha(JSON.stringify({ entries, lockHash: sha(lock), localPatchSha256: localPatch?.sha256 ?? null }));
    if (previous?.bundlerVersion !== bundlerVersion || previous?.sourceHash !== sourceHash || !fs.existsSync(archivePath) || sha(fs.readFileSync(archivePath)) !== previous.archiveSha256) {
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-amagi-bundle-'));
      try {
        const published = path.join(stage, 'published'); fs.mkdirSync(published);
        for (const name of files) {
          const dest = path.join(published, name); fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(path.join(source, name), dest);
        }
        if (localPatch) {
          const args = ['apply', '--include=extensions/*'];
          try {
            execFileSync('git', [...args, '--check', localPatch.patchPath], { cwd: published, stdio: 'pipe' });
            execFileSync('git', [...args, localPatch.patchPath], { cwd: published, stdio: 'pipe' });
          } catch (error) {
            // A source checkout may already carry the complete exact patch.
            // Accept only a verifiable reverse application; partial patches fail.
            try { execFileSync('git', [...args, '--reverse', '--check', localPatch.patchPath], { cwd: published, stdio: 'pipe' }); }
            catch { throw new Error('Required amagi continuation/shutdown patch cannot be verified in the private bundle', { cause: error }); }
          }
        }
        // Resolve production dependencies from the exact lock in isolation. No host Pi/peer/dev packages are shipped.
        // Older npm locks can mark TypeScript dev-only when it appears in both dependency sections.
        // Remove dev declarations only in the temporary install manifest, keeping locked versions/integrities.
        const installPkg = { ...pkg }; delete installPkg.devDependencies;
        fs.writeFileSync(path.join(published, 'package.json'), JSON.stringify(installPkg));
        const installLock = JSON.parse(lock); delete installLock.packages[''].devDependencies;
        for (const name of Object.keys(pkg.dependencies ?? {})) {
          if (installLock.packages[`node_modules/${name}`]) delete installLock.packages[`node_modules/${name}`].dev;
        }
        fs.writeFileSync(path.join(published, 'package-lock.json'), JSON.stringify(installLock));
        npm(['ci', '--omit=dev', '--omit=peer', '--ignore-scripts', '--no-audit', '--no-fund'], published);
        for (const name of Object.keys(pkg.dependencies ?? {})) {
          if (!fs.existsSync(path.join(published, 'node_modules', name, 'package.json'))) throw new Error(`Missing locked production dependency: ${name}`);
        }
        fs.copyFileSync(path.join(source, 'package.json'), path.join(published, 'package.json'));
        fs.rmSync(path.join(published, 'package-lock.json'));
        fs.rmSync(path.join(published, 'node_modules', '.package-lock.json'), { force: true });
        const { copyTreeFiltered, computePackageContentHash } = await import('../../dist/agent/build-runtime/amagi-package.js');
        const frozen = path.join(stage, 'package'); fs.mkdirSync(frozen);
        copyTreeFiltered(published, frozen, { includeNodeModules: true });
        // JS-only package can be shipped to either desktop platform; preserve the native target path of bin wrappers.
        const binDir = path.join(frozen, 'node_modules', '.bin');
        if (fs.existsSync(binDir)) for (const name of fs.readdirSync(binDir).filter((name) => !/\.(cmd|ps1)$/.test(name))) {
          const shim = fs.readFileSync(path.join(binDir, name), 'utf8');
          const target = shim.match(/exec "\$\(dirname "\$0"\)\/([^"\n]+)"/u)?.[1];
          if (target) fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@ECHO OFF\r\nnode "%~dp0${target.replaceAll('/', '\\')}" %*\r\n`);
        }
        const content = computePackageContentHash(frozen);
        const zip = new JSZip();
        const add = (dir, prefix = '') => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(dir, entry.name); const rel = prefix + entry.name;
            if (entry.isDirectory()) add(full, rel + '/');
            else {
              if (!entry.isFile() || rel.endsWith('.node')) throw new Error(`amagi bundle must contain portable regular files: ${rel}`);
              zip.file(rel, fs.readFileSync(full), { date: new Date('1980-01-01T00:00:00Z'), unixPermissions: fs.statSync(full).mode & 0o777, createFolders: false });
            }
          }
        };
        add(frozen);
        const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }, platform: 'UNIX' });
        let commit = null;
        try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(); } catch { /* source archive */ }
        for (const [name, hash] of entries) if (sha(fs.readFileSync(path.join(source, name))) !== hash) throw new Error('amagi-pi source changed during bundling; rebuild to get a consistent snapshot');
        const manifest = { schemaVersion: 1, bundlerVersion, package: 'amagi-pi', version: pkg.version, sourceHash,
          ...(localPatch ? { localPatchSha256: localPatch.sha256 } : {}),
          sourceCommit: commit, contentHash: content.contentHash, files: content.files, bytes: content.bytes,
          archiveSha256: sha(bytes), archiveBytes: bytes.length };
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.writeFileSync(`${archivePath}.tmp`, bytes); fs.renameSync(`${archivePath}.tmp`, archivePath);
        fs.writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2) + '\n'); fs.renameSync(`${manifestPath}.tmp`, manifestPath);
        previous = manifest;
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }
  }
  const requiredPatch = previous && requiredLocalPatch(previous.version);
  if (requiredPatch && (previous.bundlerVersion !== bundlerVersion || previous.localPatchSha256 !== requiredPatch.sha256))
    throw new Error('Frozen amagi bundle lacks the required continuation/shutdown patch. Supply AMAGI_PI_SOURCE_DIR to rebuild it.');
  if (!previous || sha(fs.readFileSync(archivePath)) !== previous.archiveSha256) throw new Error('Bundled amagi-pi is missing/corrupt. Supply AMAGI_PI_SOURCE_DIR to rebuild the private bundle.');
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(manifestPath, path.join(destination, 'manifest.json'));
  fs.copyFileSync(archivePath, path.join(destination, 'package.zip'));
  console.info(`[bundled-amagi] amagi-pi ${previous.version}, ${previous.files} files, ${(previous.archiveBytes / 1024 / 1024).toFixed(1)} MB; ${source ? 'local source verified' : 'using checked-in private bundle'}`);
  return previous;
}
