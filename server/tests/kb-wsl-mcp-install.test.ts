import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { replaceWslCodex, resolveDefaultWslCodex } from '../src/kb/wsl-mcp-install.js';

const wsl = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe') : '';
const available = !!wsl && spawnSync(wsl, ['--exec', 'sh', '-c', 'command -v mktemp && command -v wslpath && command -v sha256sum'], { windowsHide: true, timeout: 10_000 }).status === 0;

describe.skipIf(!available)('Windows 与 WSL 文件系统交互', () => {
  it('识别默认发行版的实际 Codex 配置路径', () => {
    const location = resolveDefaultWslCodex();
    expect(location.distro).toBeTruthy();
    expect(location.linuxPath).toMatch(/\/config\.toml$/);
    expect(path.win32.isAbsolute(location.path)).toBe(true);
  });

  it('在 WSL 独立目录原子创建、更新和删除配置，并拒绝陈旧快照', () => {
    const run = (...args: string[]) => execFileSync(wsl, ['--exec', ...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim();
    const root = run('mktemp', '-d', '/tmp/feishu mcp fixture.XXXXXXXX');
    if (!root.startsWith('/tmp/feishu mcp fixture.')) throw new Error('unexpected fixture path');
    const distro = run('sh', '-c', 'printf %s "$WSL_DISTRO_NAME"');
    const linuxPath = `${root}/config.toml`;
    const location = { path: run('wslpath', '-w', linuxPath), linuxPath, distro };
    try {
      replaceWslCodex(location, { exists: false, text: '' }, 'model = "初始"\n');
      expect(fs.readFileSync(location.path, 'utf8')).toContain('初始');
      run('chmod', '640', linuxPath);
      replaceWslCodex(location, { exists: true, text: 'model = "初始"\n' }, 'model = "更新"\n');
      expect(fs.readFileSync(location.path, 'utf8')).toContain('更新');
      expect(run('stat', '-c', '%a', linuxPath)).toBe('640');
      try {
        replaceWslCodex(location, { exists: true, text: 'model = "陈旧"\n' }, 'wrong');
        throw new Error('stale snapshot was accepted');
      } catch (error) {
        expect(error).toMatchObject({ status: 73 });
      }
      expect(fs.readFileSync(location.path, 'utf8')).toContain('更新');
      replaceWslCodex(location, { exists: true, text: 'model = "更新"\n' }, null);
      expect(fs.existsSync(location.path)).toBe(false);
      const protectedPath = `${root}/protected.toml`;
      run('sh', '-c', 'printf protected > "$1"; ln -s "$1" "$2"', 'sh', protectedPath, linuxPath);
      expect(() => replaceWslCodex(location, { exists: true, text: 'protected' }, 'wrong')).toThrow();
      expect(run('cat', protectedPath)).toBe('protected');
    } finally {
      run('rm', '-r', '--', root);
    }
  });
});
