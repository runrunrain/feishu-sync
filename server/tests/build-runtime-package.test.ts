/**
 * 版本化 amagi-pi 安装管理测试（设计v2 §3.1/§11；Leader 修正轮 steer #11）
 *
 * pi CLI 以假可执行 fixture 代替（模拟 `pi install npm:...` 与 `pi install <本地路径>`
 * 的落盘行为），测本模块的编排、staging/rename、幂等（默认全量校验）、预算拒绝与
 * symlink 拒绝；真实 pi + 真实本机源码安装另做一次性实测（记录在 runtime-report 包节）。
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AmagiPackageError, amagiInstallDir, computePackageContentHash, inspectAmagiPackageLayout,
  installAmagiPackage, verifyAmagiPackage, INSTALL_RECORD_FILENAME,
} from '../src/agent/build-runtime/amagi-package.js';

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-pkg-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * 假 pi CLI（测试 fixture）：
 * - `install npm:amagi-pi@<ver>` → 落 pi 受管 npm 布局（<agentDir>/npm/node_modules/amagi-pi）；
 * - `install <存在的绝对目录>` → local source：只校验存在并写 settings.json
 *   （packages 记相对 agentDir 的路径——对齐真实 pi normalizePackageSourceForSettings）。
 */
function makeFakePiCli(root: string): string {
  const file = path.join(root, 'fake-pi.mjs');
  fs.writeFileSync(file, `#!/usr/bin/env node
// 测试 fixture：模拟 pi install 的两种落盘行为（仅供 build-runtime 测试）
const [,, cmd, source] = process.argv;
if (cmd !== 'install') { console.error(\`fake-pi: unsupported command \${cmd}\`); process.exit(1); }
const fs = await import('node:fs');
const path = await import('node:path');
const root = process.env.PI_CODING_AGENT_DIR;
const m = /^npm:amagi-pi@(\\d+\\.\\d+\\.\\d+)$/.exec(source ?? '');
const layout = (pkgRoot) => {
  fs.mkdirSync(path.join(pkgRoot, 'extensions', 'amagi-core'), { recursive: true });
  fs.mkdirSync(path.join(pkgRoot, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'amagi-pi', version: m ? m[1] : '0.0.0', pi: { extensions: ['./extensions'] } }, null, 2));
  fs.writeFileSync(path.join(pkgRoot, 'extensions', 'amagi-core', 'index.ts'), '// fake amagi-core\\n');
  for (const agent of ['luban', 'diting', 'baize']) {
    fs.writeFileSync(path.join(pkgRoot, 'agents', agent + '.md'), '---\\\\ndescription: fake\\\\ntype: work\\\\ntools: read\\\\n---\\\\n');
  }
};
if (m) {
  const pkgRoot = path.join(root, 'npm', 'node_modules', 'amagi-pi');
  fs.mkdirSync(pkgRoot, { recursive: true });
  layout(pkgRoot);
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ packages: [source] }, null, 2));
  console.log('fake-pi installed', source);
} else {
  if (!source || !path.isAbsolute(source) || !fs.existsSync(source)) {
    console.error('fake-pi: bad source ' + source); process.exit(1);
  }
  const rel = path.relative(root, source) || '.';
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ packages: [rel] }, null, 2));
  console.log('fake-pi installed local', source);
}
`, { mode: 0o755 });
  return file;
}

/** 迷你 amagi-pi 源目录（source 模式用）。 */
function makeMiniSource(root: string, version = '2.21.31'): string {
  const src = path.join(root, `amagi-src-${version}`);
  fs.mkdirSync(path.join(src, 'extensions', 'amagi-core'), { recursive: true });
  fs.mkdirSync(path.join(src, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'amagi-pi', version, pi: { extensions: ['./extensions'] } }, null, 2));
  fs.writeFileSync(path.join(src, 'extensions', 'amagi-core', 'index.ts'), '// mini\n');
  for (const agent of ['luban', 'diting', 'baize']) fs.writeFileSync(path.join(src, 'agents', `${agent}.md`), 'x\n');
  return src;
}

describe('computePackageContentHash（完整内容冻结）', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('确定性：同内容两次哈希一致；内容变化即变', () => {
    const pkg = path.join(root, 'pkg');
    fs.mkdirSync(path.join(pkg, 'a'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'a', 'x.txt'), 'hello');
    fs.writeFileSync(path.join(pkg, 'b.txt'), 'world');
    const h1 = computePackageContentHash(pkg);
    const h2 = computePackageContentHash(pkg);
    expect(h1.contentHash).toBe(h2.contentHash);
    expect(h1.files).toBe(2);
    fs.writeFileSync(path.join(pkg, 'b.txt'), 'changed');
    expect(computePackageContentHash(pkg).contentHash).not.toBe(h1.contentHash);
  });

  it('>8MiB 文件尾部同尺寸篡改也被检出（旧实现只哈希前 8MiB 的回归）', () => {
    const pkg = path.join(root, 'pkg');
    fs.mkdirSync(pkg, { recursive: true });
    const big = path.join(pkg, 'big.bin');
    const size = 9 * 1024 * 1024; // 9 MiB > 旧实现的 8 MiB 窗口
    fs.writeFileSync(big, Buffer.alloc(size, 7));
    const before = computePackageContentHash(pkg);
    // 同尺寸尾部篡改：只改最后 1 字节
    const fd = fs.openSync(big, 'r+');
    try { fs.writeSync(fd, Buffer.from('X'), 0, 1, size - 1); } finally { fs.closeSync(fd); }
    const after = computePackageContentHash(pkg);
    expect(after.files).toBe(1);
    expect(after.bytes).toBe(size); // 全量字节计入
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it('包内 symlink 一律拒绝（不留未哈希的可加载入口）', () => {
    const pkg = path.join(root, 'pkg');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'real.txt'), 'r');
    let linked = true;
    try { fs.symlinkSync(path.join(pkg, 'real.txt'), path.join(pkg, 'link.txt')); } catch { linked = false; }
    if (linked) {
      expect(() => computePackageContentHash(pkg)).toThrow(AmagiPackageError);
      try { computePackageContentHash(pkg); } catch (error) { expect((error as { code?: string }).code).toBe('amagi_symlink_in_package'); }
    }
  });

  it('超出预算明确拒绝（文件数 / 总字节），不产出截断哈希', () => {
    const pkg = path.join(root, 'pkg');
    fs.mkdirSync(pkg, { recursive: true });
    for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(pkg, `f${i}.txt`), 'x');
    try {
      computePackageContentHash(pkg, { maxFiles: 3, maxTotalBytes: 1024 * 1024 });
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_hash_budget_exceeded');
      expect((error as Error).message).toContain('文件数');
    }
    fs.writeFileSync(path.join(pkg, 'big.bin'), Buffer.alloc(64 * 1024));
    try {
      computePackageContentHash(pkg, { maxFiles: 100, maxTotalBytes: 32 * 1024 });
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_hash_budget_exceeded');
      expect((error as Error).message).toContain('总字节');
    }
  });

  it('目录不存在 → 明确报错', () => {
    expect(() => computePackageContentHash(path.join(root, 'missing'))).toThrow(AmagiPackageError);
  });
});

describe('amagiInstallDir / verifyAmagiPackage', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('版本号形式校验（拒绝范围/标签/路径注入）', () => {
    expect(amagiInstallDir(root, '2.21.31')).toContain('amagi-pi@2.21.31');
    expect(() => amagiInstallDir(root, '^2.21.0')).toThrow();
    expect(() => amagiInstallDir(root, '../../evil')).toThrow();
    expect(() => amagiInstallDir(root, 'latest')).toThrow();
  });

  it('未安装 → verify 报错', () => {
    try {
      verifyAmagiPackage({ dataRoot: root, version: '1.0.0' });
      expect.unreachable('应抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AmagiPackageError);
    }
  });

  it('npm 模式：install → record + verify 通过 → 幂等复用（fresh=false，含全量哈希）', async () => {
    const fakePi = makeFakePiCli(root);
    const result = await installAmagiPackage({
      nodePath: process.execPath, piCliPath: fakePi, dataRoot: root, version: '2.21.31',
    });
    expect(result.fresh).toBe(true);
    expect(result.record.layout).toBe('npm');
    expect(result.record.installedVia.piInstallArgs).toContain('npm:amagi-pi@2.21.31');
    expect(fs.existsSync(path.join(result.installDir, INSTALL_RECORD_FILENAME))).toBe(true);
    const recordText = fs.readFileSync(path.join(result.installDir, INSTALL_RECORD_FILENAME), 'utf-8');
    expect(recordText).not.toMatch(/ZHIPU|TOKEN|SECRET/i);
    const verified = verifyAmagiPackage({ dataRoot: root, version: '2.21.31' });
    expect(verified.contentHash).toBe(result.contentHash);
    expect(inspectAmagiPackageLayout(result.packageRoot).ok).toBe(true);
    const again = await installAmagiPackage({
      nodePath: process.execPath, piCliPath: fakePi, dataRoot: root, version: '2.21.31',
    });
    expect(again.fresh).toBe(false);
    expect(again.contentHash).toBe(result.contentHash);
  });

  it('幂等复用默认完整校验：篡改包后 install 直接失败，不返回可信 fresh:false', async () => {
    const fakePi = makeFakePiCli(root);
    const result = await installAmagiPackage({
      nodePath: process.execPath, piCliPath: fakePi, dataRoot: root, version: '2.21.31',
    });
    fs.appendFileSync(path.join(result.packageRoot, 'extensions', 'amagi-core', 'index.ts'), '// tampered\n');
    try {
      await installAmagiPackage({ nodePath: process.execPath, piCliPath: fakePi, dataRoot: root, version: '2.21.31' });
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_content_drift');
    }
  });

  it('安装后原地篡改 → 内容漂移检出（verifyHash 全量）', async () => {
    const fakePi = makeFakePiCli(root);
    const result = await installAmagiPackage({
      nodePath: process.execPath, piCliPath: fakePi, dataRoot: root, version: '2.21.31',
    });
    fs.appendFileSync(path.join(result.packageRoot, 'extensions', 'amagi-core', 'index.ts'), '// tampered\n');
    expect(() => verifyAmagiPackage({ dataRoot: root, version: '2.21.31' })).toThrow('内容哈希漂移');
    // verifyHash=false 快速路径只核对版本与记录存在（调用方自担）
    expect(() => verifyAmagiPackage({ dataRoot: root, version: '2.21.31', verifyHash: false })).not.toThrow();
  });

  it('安装记录被删 → verify 拒绝（外部改动不默认可信）', async () => {
    const fakePi = makeFakePiCli(root);
    const result = await installAmagiPackage({
      nodePath: process.execPath, piCliPath: fakePi, dataRoot: root, version: '2.21.31',
    });
    fs.rmSync(path.join(result.installDir, INSTALL_RECORD_FILENAME));
    try {
      verifyAmagiPackage({ dataRoot: root, version: '2.21.31', verifyHash: false });
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_record_missing');
    }
  });

  it('安装失败（假 CLI 非零退出）→ 明确错误码', async () => {
    const badCli = path.join(root, 'bad-pi.mjs');
    fs.writeFileSync(badCli, '#!/usr/bin/env node\nprocess.exit(3);\n', { mode: 0o755 });
    try {
      await installAmagiPackage({ nodePath: process.execPath, piCliPath: badCli, dataRoot: root, version: '1.2.3' });
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_install_failed');
    }
  });
});

describe('source 模式（物化冻结 + 正式 pi install）', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('物化到 staging → rename → 正式 pi install 本地路径 → settings 包来源核对入记录', async () => {
    const fakePi = makeFakePiCli(root);
    const sourceDir = makeMiniSource(root);
    const result = await installAmagiPackage({
      nodePath: process.execPath, piCliPath: fakePi, dataRoot: root, version: '2.21.31', sourceDir,
    });
    expect(result.fresh).toBe(true);
    expect(result.record.layout).toBe('source');
    expect(result.packageRoot).toBe(path.join(result.installDir, 'package'));
    // 正式 pi install 的命令与目标（绝对物化包路径）
    expect(result.record.installedVia.piInstallArgs).toEqual([fakePi, 'install', result.packageRoot]);
    expect(result.record.installedVia.sourceDir).toBe(sourceDir);
    // pi 写入安装 home 的 settings.json（fixture 对齐真实 pi 的相对路径归一）
    const settings = JSON.parse(fs.readFileSync(path.join(result.installDir, 'settings.json'), 'utf-8'));
    expect(settings.packages).toEqual(['package']);
    expect(result.record.piSettingsPackages).toEqual(['package']);
    // staging 不残留
    expect(fs.readdirSync(path.dirname(result.installDir)).filter((n) => n.includes('.staging-'))).toEqual([]);
    // 复用（完整校验通过）
    const again = await installAmagiPackage({
      nodePath: process.execPath, piCliPath: fakePi, dataRoot: root, version: '2.21.31', sourceDir,
    });
    expect(again.fresh).toBe(false);
    expect(again.contentHash).toBe(result.contentHash);
  });

  it('源版本与请求不一致 → 拒绝（不猜测）', async () => {
    const fakePi = makeFakePiCli(root);
    const sourceDir = makeMiniSource(root, '1.2.3');
    try {
      await installAmagiPackage({ nodePath: process.execPath, piCliPath: fakePi, dataRoot: root, version: '2.21.31', sourceDir });
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_version_mismatch');
    }
  });

  it('源目录与安装目录存在包含关系 → 拒绝（防递归拷贝/自我覆盖）', async () => {
    const fakePi = makeFakePiCli(root);
    const installDir = amagiInstallDir(root, '1.0.0');
    const nestedSource = path.join(installDir, 'pkg-src');
    try {
      await installAmagiPackage({ nodePath: process.execPath, piCliPath: fakePi, dataRoot: root, version: '1.0.0', sourceDir: nestedSource });
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_source_target_overlap');
    }
  });

  it('无记录残留目录移 aside（不删除、不覆盖），安装继续成功', async () => {
    const fakePi = makeFakePiCli(root);
    const sourceDir = makeMiniSource(root);
    const installDir = amagiInstallDir(root, '2.21.31');
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, 'junk.txt'), 'half-installed');
    const result = await installAmagiPackage({
      nodePath: process.execPath, piCliPath: fakePi, dataRoot: root, version: '2.21.31', sourceDir,
    });
    expect(result.fresh).toBe(true);
    const parent = path.dirname(installDir);
    const aside = fs.readdirSync(parent).filter((n) => n.startsWith('amagi-pi@2.21.31.stale-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(parent, aside[0], 'junk.txt'), 'utf-8')).toBe('half-installed');
  });

  it('源目录含 symlink → 物化阶段拒绝（不静默丢弃，包内容必须与源一致）', async () => {
    const fakePi = makeFakePiCli(root);
    const sourceDir = makeMiniSource(root);
    fs.writeFileSync(path.join(sourceDir, 'target.txt'), 'x');
    let linked = true;
    try { fs.symlinkSync(path.join(sourceDir, 'target.txt'), path.join(sourceDir, 'link.txt')); } catch { linked = false; }
    if (linked) {
      try {
        await installAmagiPackage({ nodePath: process.execPath, piCliPath: fakePi, dataRoot: root, version: '2.21.31', sourceDir });
        expect.unreachable('应抛错');
      } catch (error) {
        expect((error as { code?: string }).code).toBe('amagi_symlink_in_source');
      }
      // staging 已清理，最终目录未入位
      expect(fs.existsSync(amagiInstallDir(root, '2.21.31'))).toBe(false);
    }
  });

  it('pi install 后 settings.json 包来源与物化包根不符 → 拒绝', async () => {
    // 假 CLI 变体：local install 写一个错误来源
    const badLocalPi = path.join(root, 'bad-local-pi.mjs');
    fs.writeFileSync(badLocalPi, `#!/usr/bin/env node
const fs = await import('node:fs');
const path = await import('node:path');
const [,, cmd, source] = process.argv;
if (cmd === 'install' && path.isAbsolute(source)) {
  fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ packages: ['elsewhere'] }));
} else { process.exit(1); }
`, { mode: 0o755 });
    const sourceDir = makeMiniSource(root);
    try {
      await installAmagiPackage({ nodePath: process.execPath, piCliPath: badLocalPi, dataRoot: root, version: '2.21.31', sourceDir });
      expect.unreachable('应抛错');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('amagi_pi_settings_mismatch');
    }
  });
});

describe('install 进程环境隔离', () => {
  it('安装子进程不继承应用凭据（fixture 回显 env 断言）', async () => {
    const root = tmpRoot();
    const sourceDir = makeMiniSource(root);
    const echoCli = path.join(root, 'echo-env-pi.mjs');
    const outFile = path.join(root, 'env.json');
    fs.writeFileSync(echoCli, `#!/usr/bin/env node
const fs = await import('node:fs');
const path = await import('node:path');
const [,, cmd, source] = process.argv;
if (cmd === 'install' && path.isAbsolute(source) && fs.existsSync(source)) {
  fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ packages: [path.relative(process.env.PI_CODING_AGENT_DIR, source)] }));
  fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ env: process.env }));
}
`, { mode: 0o755 });
    await installAmagiPackage({
      nodePath: process.execPath, piCliPath: echoCli, dataRoot: root, version: '2.21.31', sourceDir,
    });
    const captured = JSON.parse(fs.readFileSync(outFile, 'utf-8')) as { env: Record<string, string> };
    expect(captured.env.PI_CODING_AGENT_DIR).toBe(amagiInstallDir(root, '2.21.31'));
    expect(captured.env.ZHIPU_API_KEY).toBeUndefined();
    expect(captured.env.FEISHU_SYNC_AGENT_API_KEY).toBeUndefined();
  });
});
