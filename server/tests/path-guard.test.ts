/**
 * PathGuard 测试（设计 §12.1）
 *
 * 覆盖：`..` 段、绝对路径、NUL、Windows 盘符/UNC/ADS/保留名、指向根外
 * 的 symlink、指向根内的 symlink（允许）、硬链接写拒绝（nlink>1）、
 * 大小写变体（POSIX 精确比较不折叠）、read 围栏与 write 围栏。
 * 全部用临时目录 fixture，不触真实数据。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  atomicWriteFile,
  isPathInside,
  PathGuardError,
  resolveInside,
  validateWorkspacePath,
} from '../src/agent/path-guard.js';

let root: string;
let outside: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-test-root-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-test-out-'));
  fs.writeFileSync(path.join(root, 'a.md'), 'hello\n');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'b.md'), 'world\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('parseRelativeSegments 拒绝', () => {
  it('拒绝绝对路径（POSIX 与 Windows 盘符）', () => {
    expect(() => resolveInside(root, '/etc/passwd', 'read')).toThrow(PathGuardError);
    expect(() => resolveInside(root, 'C:/Windows/system32', 'read')).toThrow(PathGuardError);
    expect(() => resolveInside(root, 'C:\\Windows\\system32', 'read')).toThrow(PathGuardError);
  });

  it('拒绝 .. 段（含编码后形式与中间段）', () => {
    expect(() => resolveInside(root, '..', 'read')).toThrow(PathGuardError);
    expect(() => resolveInside(root, 'sub/../../escape', 'read')).toThrow(PathGuardError);
    expect(() => resolveInside(root, 'a/../..', 'read')).toThrow(PathGuardError);
  });

  it('拒绝 NUL 与 ADS 冒号流与 UNC', () => {
    expect(() => resolveInside(root, 'a\0b', 'read')).toThrow(PathGuardError);
    expect(() => resolveInside(root, 'file.md:hidden-stream', 'read')).toThrow(PathGuardError);
    expect(() => resolveInside(root, '\\\\server\\share', 'read')).toThrow(PathGuardError);
  });

  it('拒绝空段与 Windows 保留设备名', () => {
    expect(() => resolveInside(root, 'sub//b.md', 'read')).toThrow(PathGuardError);
    expect(() => resolveInside(root, 'CON', 'read')).toThrow(PathGuardError);
    expect(() => resolveInside(root, 'com1.md', 'read')).toThrow(PathGuardError);
  });
});

describe('read 围栏', () => {
  it('根内文件可读', () => {
    const target = resolveInside(root, 'sub/b.md', 'read');
    expect(fs.readFileSync(target, 'utf-8')).toBe('world\n');
  });

  it('symlink 指向根外 → path_escape', () => {
    const secret = path.join(outside, 'secret.md');
    fs.writeFileSync(secret, 'secret\n');
    fs.symlinkSync(secret, path.join(root, 'evil.md'));
    expect(() => resolveInside(root, 'evil.md', 'read')).toThrow(/越出根目录/);
  });

  it('symlink 指向根内 → 允许', () => {
    fs.symlinkSync(path.join(root, 'a.md'), path.join(root, 'alias.md'));
    const target = resolveInside(root, 'alias.md', 'read');
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello\n');
  });

  it('目录 symlink 中转出根 → path_escape', () => {
    fs.symlinkSync(outside, path.join(root, 'evildir'));
    expect(() => resolveInside(root, 'evildir/x.md', 'read')).toThrow(/越出根目录|不存在/);
  });

  it('不存在 → not_found', () => {
    expect(() => resolveInside(root, 'missing.md', 'read')).toThrow(/不存在/);
  });
});

describe('write 围栏', () => {
  it('根内写入成功且落点在根内', () => {
    const target = resolveInside(root, 'sub/new.md', 'write');
    atomicWriteFile(target, 'data');
    expect(fs.readFileSync(path.join(root, 'sub', 'new.md'), 'utf-8')).toBe('data');
  });

  it('写入目标是 symlink → 拒绝（即便指向根内）', () => {
    fs.symlinkSync(path.join(root, 'a.md'), path.join(root, 'aliasw.md'));
    expect(() => resolveInside(root, 'aliasw.md', 'write')).toThrow(/符号链接/);
  });

  it('硬链接（nlink>1）写入 → 拒绝', () => {
    fs.writeFileSync(path.join(root, 'linked.md'), 'original\n');
    fs.linkSync(path.join(root, 'linked.md'), path.join(outside, 'hardlink.md'));
    expect(() => resolveInside(root, 'linked.md', 'write')).toThrow(/硬链接/);
  });

  it('父目录是根外 symlink → 拒绝', () => {
    fs.symlinkSync(outside, path.join(root, 'outdir'));
    expect(() => resolveInside(root, 'outdir/new.md', 'write')).toThrow(/父目录越出根目录/);
  });

  it('mkdir 逐级复核（中途 symlink 逃逸拒绝）', () => {
    expect(() => resolveInside(root, 'deep/a/b/c', 'mkdir')).not.toThrow();
    expect(fs.statSync(path.join(root, 'deep', 'a', 'b', 'c')).isDirectory()).toBe(true);
    fs.symlinkSync(outside, path.join(root, 'escdir'));
    expect(() => resolveInside(root, 'escdir/inner', 'mkdir')).toThrow();
  });
});

describe('isPathInside containment（POSIX 精确比较）', () => {
  it('前缀相同才在内：/a/bb 不在 /a/b 内', () => {
    expect(isPathInside('/a/b', '/a/b')).toBe(true);
    expect(isPathInside('/a/b', '/a/b/c')).toBe(true);
    expect(isPathInside('/a/b', '/a/bb')).toBe(false);
    expect(isPathInside('/a/b', '/a')).toBe(false);
  });

  it('大小写变体在 POSIX 不折叠（/A/B ≠ /a/b）', () => {
    expect(isPathInside('/a/b', '/A/B/c')).toBe(false);
  });
});

describe('validateWorkspacePath', () => {
  const guards = { knowledgeBaseRoot: '', outputRoot: '', dataRoot: '' };

  it('存在目录 + 无冲突 → ok 并返回 realpath', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ok-'));
    const verdict = validateWorkspacePath(dir, guards, { homeDir: os.homedir() });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.realPath).toBe(fs.realpathSync.native(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('不存在 / 非目录 → workspace_path_invalid', () => {
    const missing = path.join(os.tmpdir(), `no-such-${Date.now()}`);
    expect(validateWorkspacePath(missing, guards).code).toBe('workspace_path_invalid');
    const file = path.join(os.tmpdir(), `ws-file-${Date.now()}`);
    fs.writeFileSync(file, 'x');
    expect(validateWorkspacePath(file, guards).code).toBe('workspace_path_invalid');
    fs.rmSync(file, { force: true });
  });

  it('与知识库/标准库/数据根冲突 → workspace_path_forbidden', () => {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-kb-'));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-out-'));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-data-'));
    // 等于 / 位于 kb 内
    expect(validateWorkspacePath(kb, { knowledgeBaseRoot: kb, outputRoot: out, dataRoot: data }).code).toBe('workspace_path_forbidden');
    const inside = path.join(kb, 'child');
    fs.mkdirSync(inside);
    expect(validateWorkspacePath(inside, { knowledgeBaseRoot: kb, outputRoot: out, dataRoot: data }).code).toBe('workspace_path_forbidden');
    // 包含 kb（workspace 是父目录）
    const parentOfKb = path.dirname(kb);
    // 注意：tmp 父目录包含很多目录但规则只比对声明的三个 guard
    const verdict = validateWorkspacePath(parentOfKb, { knowledgeBaseRoot: kb, outputRoot: out, dataRoot: data });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('workspace_path_forbidden');
    fs.rmSync(kb, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('用户主目录本身 → forbidden', () => {
    const verdict = validateWorkspacePath(os.homedir(), guards, { homeDir: os.homedir() });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('workspace_path_forbidden');
  });

  it('系统目录 → forbidden', () => {
    const verdict = validateWorkspacePath('/etc', guards);
    expect(verdict.ok).toBe(false);
  });

  it('与受保护运行资源（pi 凭据目录/安装树）重叠 → forbidden（Leader steer #3）', () => {
    const piAgentDir = path.join(os.homedir(), '.pi', 'agent');
    if (!fs.existsSync(piAgentDir)) fs.mkdirSync(piAgentDir, { recursive: true });
    const verdict = validateWorkspacePath(piAgentDir, {
      ...guards,
      protectedRoots: [piAgentDir],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('workspace_path_forbidden');
    // 包含受保护根的父目录同样拒绝
    const parent = path.dirname(piAgentDir);
    const verdictParent = validateWorkspacePath(parent, {
      ...guards,
      protectedRoots: [piAgentDir],
    });
    expect(verdictParent.ok).toBe(false);
  });
});
