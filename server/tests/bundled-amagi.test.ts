import { afterAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { readBundledAmagi, installBundledAmagi } from '../src/agent/bundled-amagi.js';
import { computePackageContentHash, verifyAmagiPackage, installAmagiPackage } from '../src/agent/build-runtime/amagi-package.js';
import { PiPluginService } from '../src/agent/pi-plugin-service.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { buildPiProcessEnv, PiRpcProcess } from '../src/agent/pi-rpc-process.js';
import { buildDefaultAgentConfig } from '../src/types/agent-knowledge.js';
import { BuildRuntimeHost } from '../src/kb/build-runtime-host.js';
import { ConfigManager } from '../src/modules/config-manager.js';

const roots: string[] = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-amagi-test-')); roots.push(root); return root; };
afterAll(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
const sha = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(version = '2.21.36', marker = 'first') {
  const root = temp(); const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'amagi-pi', version, type: 'module', pi: { extensions: ['./extensions/index.ts'] } }));
  fs.writeFileSync(path.join(source, 'extensions/index.ts'), `export default function(pi) { /* ${marker} */ }`);
  const zip = new JSZip();
  for (const name of ['package.json', 'extensions/index.ts']) zip.file(name, fs.readFileSync(path.join(source, name)), { createFolders: false });
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const content = computePackageContentHash(source);
  fs.writeFileSync(path.join(root, 'package.zip'), bytes);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, package: 'amagi-pi', version,
    sourceHash: sha(marker), sourceCommit: null, contentHash: content.contentHash, archiveSha256: sha(bytes),
    archiveBytes: bytes.length, files: content.files, bytes: content.bytes }));
  return readBundledAmagi(root)!;
}

function fakeCli(root: string) {
  const cli = path.join(root, 'pi.mjs');
  fs.writeFileSync(cli, `import fs from 'node:fs';import path from 'node:path';
const [action,source] = process.argv.slice(2);
if(action!=='install'||!path.isAbsolute(source)) throw new Error('only offline local registration is allowed');
fs.appendFileSync(${JSON.stringify(path.join(root, 'calls.jsonl'))},JSON.stringify({action,source})+'\\n');
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'settings.json'),JSON.stringify({packages:[source]}));`);
  return cli;
}

it('first-launch offline install is single-flight and idempotent, and the original bundle is untouched', async () => {
  const bundle = await fixture(); const root = temp(); const piCliPath = fakeCli(root);
  const input = { dataRoot: root, nodePath: process.execPath, piCliPath, bundle };
  const [first, same] = await Promise.all([installBundledAmagi(input), installBundledAmagi(input)]);
  expect(first.packageRoot).toBe(same.packageRoot);
  expect(first.fresh).toBe(true);
  expect(first.record.installedVia.piInstallArgs).toEqual([piCliPath, 'install', first.packageRoot]);
  const recordPath = path.join(first.installDir, 'install-record.json'); const before = fs.readFileSync(recordPath, 'utf8');
  expect((await installBundledAmagi(input)).fresh).toBe(false);
  expect(fs.readFileSync(recordPath, 'utf8')).toBe(before);
  expect(fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  expect(sha(fs.readFileSync(bundle.archivePath))).toBe(bundle.archiveSha256);
});

it('same-version plugin updates coexist without changing a previous build; tampered installs fail verification', async () => {
  const root = temp(); const piCliPath = fakeCli(root);
  const firstBundle = await fixture(); const nextBundle = await fixture('2.21.36', 'updated');
  const input = { dataRoot: root, nodePath: process.execPath, piCliPath };
  const legacy = await installAmagiPackage({ ...input, version: firstBundle.version,
    sourceDir: path.join(path.dirname(firstBundle.archivePath), 'source') });
  const first = await installBundledAmagi({ ...input, bundle: firstBundle });
  const next = await installBundledAmagi({ ...input, bundle: nextBundle });
  expect(next.installDir).not.toBe(first.installDir);
  expect(verifyAmagiPackage({ dataRoot: root, version: legacy.version, contentHash: legacy.contentHash, installDir: legacy.installDir }).installDir).toBe(legacy.installDir);
  expect(verifyAmagiPackage({ dataRoot: root, version: first.version, contentHash: first.contentHash }).packageRoot).toBe(first.packageRoot);
  fs.appendFileSync(path.join(next.packageRoot, 'extensions/index.ts'), '// drift');
  await expect(installBundledAmagi({ ...input, bundle: nextBundle })).rejects.toMatchObject({ code: 'amagi_content_drift' });
  expect(computePackageContentHash(first.packageRoot).contentHash).toBe(first.contentHash);
});

it('corrupt archive, path traversal and content mismatch never reach Pi install', async () => {
  const root = temp(); const bundle = await fixture(); const input = { dataRoot: root, nodePath: process.execPath, piCliPath: fakeCli(root) };
  fs.appendFileSync(bundle.archivePath, 'corrupt');
  await expect(installBundledAmagi({ ...input, bundle })).rejects.toMatchObject({ code: 'amagi_bundle_corrupt' });
  const mismatch = await fixture();
  await expect(installBundledAmagi({ ...input, bundle: { ...mismatch, contentHash: sha('wrong-content') } })).rejects.toMatchObject({ code: 'amagi_bundle_corrupt' });
  const badZip = new JSZip(); badZip.file('../outside', 'bad');
  const bytes = await badZip.generateAsync({ type: 'nodebuffer' }); fs.writeFileSync(bundle.archivePath, bytes);
  const traversal = { ...bundle, archiveBytes: bytes.length, archiveSha256: sha(bytes) };
  await expect(installBundledAmagi({ ...input, bundle: traversal })).rejects.toMatchObject({ code: 'amagi_bundle_invalid' });
  expect(fs.existsSync(path.join(root, 'calls.jsonl'))).toBe(false);
  expect(fs.readdirSync(path.join(root, 'agent', 'runtime-packages')).filter((name) => name.startsWith('.bundled-'))).toEqual([]);
});

it('application builds can reuse the frozen private bundle without a source checkout or npm install', async () => {
  const { bundleAmagi } = await import('../scripts/lib/bundled-amagi.mjs');
  const destination = temp();
  const result = await bundleAmagi({ sourceDir: false, destination });
  expect(readBundledAmagi(destination)?.contentHash).toBe(result.contentHash);
  expect(sha(fs.readFileSync(path.join(destination, 'package.zip')))).toBe(result.archiveSha256);
  expect(result.bundlerVersion).toBe(3);
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(destination, 'package.zip')));
  if (result.version === '2.21.36') {
    // 2.21.36 冻结包强制本地补丁（requiredLocalPatch 仅对该版本生效）。
    expect(result.localPatchSha256).toBe(sha(fs.readFileSync(path.resolve('patches/amagi-pi-2.21.31-background-continue.patch'))));
    const shutdown = await zip.file('extensions/amagi-core/task-run.ts')!.async('string');
    expect(shutdown).toContain('shutdown-never-spawned');
    expect(shutdown.indexOf('session shutdown before child cleanup')).toBeLessThan(shutdown.indexOf('const running = registry.getRunningChildren();', shutdown.indexOf('export async function cleanupChildrenOnShutdown')));
  } else {
    // 2.22.0 起 background-continue/queued-shutdown 修复已上游化：无本地补丁字段，
    // task-background.ts 内置 shouldAutoContinue，task-run.ts 内置 cleanupChildrenOnShutdown。
    expect(result.localPatchSha256).toBeUndefined();
    const background = await zip.file('extensions/amagi-core/task-background.ts')!.async('string');
    expect(background).toContain('export function shouldAutoContinue');
    const shutdown = await zip.file('extensions/amagi-core/task-run.ts')!.async('string');
    expect(shutdown).toContain('export async function cleanupChildrenOnShutdown');
  }
});

it('a valid older frozen archive cannot silently bypass required native shutdown fixes', async () => {
  const { bundleAmagi } = await import('../scripts/lib/bundled-amagi.mjs');
  const old = await fixture();
  await expect(bundleAmagi({ sourceDir: false, bundleDir: path.dirname(old.archivePath), destination: temp() }))
    .rejects.toThrow('lacks the required continuation/shutdown patch');
});

it('next application version replaces only the managed declaration and keeps old frozen packages', async (ctx) => {
  const root = temp(); const config = buildDefaultAgentConfig(root); const resolver = new PiRuntimeResolver();
  const runtime = await resolver.resolveRuntime(config);
  if (!runtime.nodePath || !runtime.piCliPath) { ctx.skip(); return; }
  const previous = await fixture(); const next = await fixture('2.21.36', 'next-app-same-plugin-version');
  const make = (bundle: typeof next) => new PiPluginService({ dataRoot: root, resolver, agentConfig: () => config,
    running: () => false, retireIdle: async () => {}, bundledAmagi: bundle });
  const first = (await make(previous).refresh()).packages.find((pkg) => pkg.managed)!;
  const settingsPath = path.join(root, 'agent/pi-home/settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); settings.images = { autoResize: false }; settings.defaultThinkingLevel = 'high';
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const upgraded = await make(next).refresh();
  expect(upgraded.packages.filter((pkg) => pkg.managed)).toHaveLength(1);
  expect(upgraded.packages.find((pkg) => pkg.managed)?.installPath).not.toBe(first.installPath);
  expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toMatchObject({ images: { autoResize: false }, defaultThinkingLevel: 'high' });
  expect(computePackageContentHash(first.installPath).contentHash).toBe(previous.contentHash);
}, 30_000);

it('shipped private bundle installs with real Pi, is reported as builtin, loads native commands, and is selected by the build host', async (ctx) => {
  const bundle = readBundledAmagi(); expect(bundle).not.toBeNull();
  const root = temp(); const config = buildDefaultAgentConfig(root); const resolver = new PiRuntimeResolver();
  const runtime = await resolver.resolveRuntime(config);
  if (!runtime.nodePath || !runtime.piCliPath) { ctx.skip(); return; }
  const service = new PiPluginService({ dataRoot: root, resolver, agentConfig: () => config,
    running: () => false, retireIdle: async () => {}, bundledAmagi: bundle });
  const first = await service.refresh();
  const amagi = first.packages.find((pkg) => pkg.name === 'amagi-pi')!;
  expect(amagi).toMatchObject({ sourceType: 'builtin', version: bundle!.version, enabled: true, managed: true });
  expect(amagi.resources.some((resource) => resource.type === 'extensions')).toBe(true);
  expect(fs.existsSync(path.join(amagi.installPath, 'node_modules/typescript/lib/typescript.js'))).toBe(true);
  expect(fs.existsSync(path.join(amagi.installPath, 'node_modules/typescript-language-server/lib/cli.mjs'))).toBe(true);
  expect(fs.existsSync(path.join(amagi.installPath, 'node_modules/@earendil-works/pi-coding-agent'))).toBe(false);
  // Ordinary conversations retain app task tools, avoiding the same-name native task schemas.
  expect(service.runtimeResources().sources.every((file) => !file.startsWith(amagi.installPath + path.sep))).toBe(true);
  const restart = new PiPluginService({ dataRoot: root, resolver, agentConfig: () => config,
    running: () => false, retireIdle: async () => {}, bundledAmagi: bundle });
  expect((await restart.refresh()).packages.filter((pkg) => pkg.name === 'amagi-pi')).toHaveLength(1);
  const report = path.join(root, 'loaded-tools.json'); const reportExtension = path.join(root, 'report-tools.mjs');
  fs.writeFileSync(reportExtension, `import fs from 'node:fs';export default function(pi){pi.on('session_start',()=>{fs.writeFileSync(${JSON.stringify(report)},JSON.stringify(pi.getAllTools().map(t=>t.name)));});}`);
  const rpc = new PiRpcProcess({ nodePath: runtime.nodePath, piCliPath: runtime.piCliPath,
    additionalExtensionPaths: [amagi.installPath, reportExtension], noSession: true, tools: ['amagi_resource', 'task_submit', 'task_query', 'task_resume', 'task_control'], buildMode: true,
    cwd: path.join(root, 'empty'), env: buildPiProcessEnv({ mode: 'app-llm', parentEnv: {}, dataRoot: root, agentUrl: '', runToken: '' }) });
  let stderr = ''; rpc.on('stderr', (chunk) => { stderr += chunk; });
  try {
    await rpc.start();
    const response = await rpc.sendCommand('get_state');
    expect(response.success, stderr).toBe(true);
    expect(JSON.parse(fs.readFileSync(report, 'utf8'))).toEqual(expect.arrayContaining(['amagi_resource', 'task_submit', 'task_query', 'task_resume', 'task_control']));
    expect(stderr).not.toMatch(/Error loading extension|duplicate tool|Cannot find module/i);
  } finally { await rpc.terminate(); }
  const manager = new ConfigManager(path.join(root, 'config.json')); await manager.load();
  const host = new BuildRuntimeHost({ dataRoot: root, resolver, toolService: null as never, pool: null as never,
    configProvider: () => manager.getConfig(), internalBaseUrl: () => '', knowledgeBaseRoot: () => '', outputRoot: () => '' });
  const status = await host.statusDto();
  expect(status.amagi).toMatchObject({ version: bundle!.version, distribution: 'bundled', installed: true, contentHash: bundle!.contentHash });
  expect((await host.installAmagi()).fresh).toBe(false);
}, 90_000);
