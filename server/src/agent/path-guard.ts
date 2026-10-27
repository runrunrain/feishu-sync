/**
 * PathGuard — 路径守卫（唯一实现，server 内权威）
 *
 * 设计 §7.3：所有 Agent 工具触达的文件路径必须经本模块裁决。要点：
 *  - 拒绝：绝对路径、`..` 段、NUL、Windows 盘符/UNC/冒号流（ADS）、空段。
 *  - containment 以 realpath 的规范路径精确比较（POSIX 含 macOS）；
 *    不可假定 macOS 卷大小写不敏感。Windows 仅按平台规则规范大小写。
 *  - read：realpath(target) 必须以 rootReal + sep 开头（或等于）。
 *  - write：realpath(dirname(target)) 在 rootReal 内；target 存在时 lstat
 *    不得为 symlink、nlink 必须为 1（拒绝硬链接写逃逸）；写入走
 *    同目录临时文件 → fsync → rename。
 *  - mkdir：逐级创建，每级创建后 realpath 复核。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type PathGuardIntent = 'read' | 'write' | 'mkdir';

export class PathGuardError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Windows 冒号流（ADS，如 "file.md:stream"）与盘符前缀的统一拒收。 */
function rejectWindowsSpecialSegments(segments: string[]): void {
  for (const segment of segments) {
    if (segment.includes('\0')) {
      throw new PathGuardError('path_invalid', '路径包含 NUL 字符');
    }
    // 盘符（C:）或任意冒号流（file:ads、UNC \\\\server\\share）
    if (/:/i.test(segment)) {
      throw new PathGuardError('path_invalid', `路径段包含非法冒号: ${segment}`);
    }
    if (segment.startsWith('\\\\') || segment.startsWith('//')) {
      throw new PathGuardError('path_invalid', 'UNC 路径不被允许');
    }
    // Windows 保留设备名（CON/PRN/AUX/NUL/COM1..9/LPT1..9，含带扩展名形式）
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment)) {
      throw new PathGuardError('path_invalid', `Windows 保留设备名: ${segment}`);
    }
  }
}

/** 解析相对路径分段：拒绝绝对路径与 `..`，返回规范化段列表。 */
function parseRelativeSegments(relPath: unknown): string[] {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new PathGuardError('path_invalid', '路径不能为空');
  }
  if (relPath.includes('\0')) {
    throw new PathGuardError('path_invalid', '路径包含 NUL 字符');
  }
  // 统一按分隔符切分前先拒绝反斜杠混入 POSIX 语义（Windows 段分隔与
  // ADS 都由 rejectWindowsSpecialSegments 与此处共同兜底）
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new PathGuardError('path_invalid', '绝对路径不被允许');
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '') {
      throw new PathGuardError('path_invalid', '路径包含空段');
    }
    if (segment === '.') {
      continue; // normalize 语义：. 段折叠
    }
    if (segment === '..') {
      throw new PathGuardError('path_invalid', '路径包含 .. 段');
    }
  }
  const filtered = segments.filter((segment) => segment !== '.');
  rejectWindowsSpecialSegments(filtered);
  return filtered;
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

/**
 * containment 判定：candidate 是否等于 root 或位于 root 之内。
 * POSIX（含 macOS）精确比较 —— 不做大小写折叠；macOS 大小写敏感卷上
 * 不同大小写就是不同目录。Windows 按平台分隔符比较（规范化小写）。
 */
export function isPathInside(rootReal: string, candidate: string): boolean {
  if (process.platform === 'win32') {
    const a = path.win32.resolve(rootReal).toLowerCase().replace(/[\\/]+$/, '');
    const b = path.win32.resolve(candidate).toLowerCase().replace(/[\\/]+$/, '');
    if (a === b) return true;
    return b.startsWith(a + '\\');
  }
  const a = path.resolve(rootReal);
  const b = path.resolve(candidate);
  if (a === b) return true;
  return b.startsWith(a + path.sep);
}

/** 解析 root 的 realpath（root 必须已存在且为目录）。 */
export function resolveRootReal(root: string): string {
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat) {
    throw new PathGuardError('root_missing', `根目录不存在: ${root}`);
  }
  if (!stat.isDirectory()) {
    throw new PathGuardError('root_invalid', `根路径不是目录: ${root}`);
  }
  const real = realpathOrNull(root);
  if (!real) {
    throw new PathGuardError('root_invalid', `根目录 realpath 解析失败: ${root}`);
  }
  return real;
}

/**
 * 在 root 内解析 relPath 并按 intent 裁决。
 * 返回绝对路径（针对 read 返回 realpath 后的目标；write 返回规范 join
 * 后的目标，供临时文件写入与 rename）。
 */
export function resolveInside(
  root: string,
  relPath: unknown,
  intent: PathGuardIntent,
): string {
  const segments = parseRelativeSegments(relPath);
  const rootReal = resolveRootReal(root);
  const joined = path.join(rootReal, ...segments);

  if (intent === 'read') {
    const targetReal = realpathOrNull(joined);
    if (!targetReal) {
      throw new PathGuardError('not_found', `文件不存在: ${segments.join('/')}`);
    }
    if (!isPathInside(rootReal, targetReal)) {
      throw new PathGuardError('path_escape', `路径越出根目录: ${segments.join('/')}`);
    }
    const lstat = fs.lstatSync(targetReal, { throwIfNoEntry: false });
    if (!lstat) {
      throw new PathGuardError('not_found', `文件不存在: ${segments.join('/')}`);
    }
    // 符号链接最终段必须落在 root 内（realpath 已保证）；目录可读但
    // 调用方按需区分 —— 这里只做存在性与围栏判定。
    return targetReal;
  }

  if (intent === 'mkdir') {
    // 逐级创建，每级创建后 realpath 复核
    let current = rootReal;
    for (const segment of segments) {
      current = path.join(current, segment);
      const existing = fs.lstatSync(current, { throwIfNoEntry: false });
      if (existing) {
        if (!existing.isDirectory()) {
          throw new PathGuardError('path_conflict', `路径已被文件占用: ${current}`);
        }
      } else {
        fs.mkdirSync(current);
      }
      const real = realpathOrNull(current);
      if (!real || !isPathInside(rootReal, real)) {
        throw new PathGuardError('path_escape', `mkdir 越出根目录: ${current}`);
      }
      current = real;
    }
    return current;
  }

  // write：父目录必须已在 root 内（realpath 精确比较），target 若存在
  // 则 lstat 不得为 symlink、nlink 必须为 1。
  const parentDir = path.dirname(joined);
  const parentReal = realpathOrNull(parentDir);
  if (!parentReal || !isPathInside(rootReal, parentReal)) {
    throw new PathGuardError('path_escape', `写入目标父目录越出根目录: ${segments.join('/')}`);
  }
  const target = path.join(parentReal, path.basename(joined));
  const lstat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (lstat) {
    if (lstat.isSymbolicLink()) {
      throw new PathGuardError('path_escape', `写入目标是符号链接: ${segments.join('/')}`);
    }
    if (lstat.nlink !== 1) {
      throw new PathGuardError('path_escape', `写入目标硬链接数 > 1（nlink=${lstat.nlink}）`);
    }
    if (lstat.isDirectory()) {
      throw new PathGuardError('path_conflict', `写入目标是目录: ${segments.join('/')}`);
    }
  }
  return target;
}

/**
 * 原子写入：同目录临时文件 → 写入 → fsync → rename。
 * 调用方必须先用 resolveInside(root, relPath, 'write') 裁决过目标。
 */
export function atomicWriteFile(target: string, data: string | Buffer): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.pgwrite-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const fd = fs.openSync(tmp, 'wx', 0o644);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/** 删除 root 内文件（不跟随 symlink；拒绝目录）。 */
export function removeFileInside(root: string, relPath: unknown): string {
  const segments = parseRelativeSegments(relPath);
  const rootReal = resolveRootReal(root);
  const joined = path.join(rootReal, ...segments);
  const lstat = fs.lstatSync(joined, { throwIfNoEntry: false });
  if (!lstat) {
    throw new PathGuardError('not_found', `文件不存在: ${segments.join('/')}`);
  }
  if (lstat.isDirectory()) {
    throw new PathGuardError('path_conflict', `目标是目录: ${segments.join('/')}`);
  }
  // lstat 非符号链接且 join 基于已解析 rootReal，无需再 realpath。
  fs.rmSync(joined);
  return joined;
}

/**
 * 列目录条目（不跟随 symlink；symlink 条目 type 标记 'symlink'）。
 */
export interface GuardedEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
}

export function listDirInside(root: string, relPath: unknown): GuardedEntry[] {
  const segments = relPath == null || relPath === '' ? [] : parseRelativeSegments(relPath);
  const rootReal = resolveRootReal(root);
  const joined = segments.length > 0 ? path.join(rootReal, ...segments) : rootReal;
  const real = realpathOrNull(joined);
  if (!real || !isPathInside(rootReal, real)) {
    throw new PathGuardError('path_escape', `目录越出根目录: ${segments.join('/')}`);
  }
  const stat = fs.statSync(real, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    throw new PathGuardError('not_found', `目录不存在: ${segments.join('/')}`);
  }
  const entries: GuardedEntry[] = [];
  for (const name of fs.readdirSync(real)) {
    const childPath = path.join(real, name);
    const lstat = fs.lstatSync(childPath, { throwIfNoEntry: false });
    if (!lstat) continue;
    if (lstat.isSymbolicLink()) {
      entries.push({ name, type: 'symlink', size: 0 });
    } else if (lstat.isDirectory()) {
      entries.push({ name, type: 'dir', size: lstat.size });
    } else if (lstat.isFile()) {
      entries.push({ name, type: 'file', size: lstat.size });
    } else {
      entries.push({ name, type: 'other', size: lstat.size });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

export interface WorkspaceRootGuards {
  knowledgeBaseRoot: string;
  outputRoot: string;
  dataRoot: string;
  /** 额外受保护根（pi 包根、node_modules、Electron 资源等；可缺省） */
  protectedRoots?: string[];
}

export function normalizeForCompare(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = platform === 'win32' ? path.win32.resolve(value) : path.resolve(value);
  const realpathOrNull = (target: string): string | null => {
    try {
      return fs.realpathSync.native(target);
    } catch {
      return null;
    }
  };
  // macOS 的 /var → /private/var、/tmp → /private/tmp 等根别名必须归一。
  // 目标不存在时不能直接回退 resolve——那会得到未归一的 /var/… 前缀，
  // 与已 realpath 的另一侧永远判不出重叠（F3-R02 实测：不存在的
  // outputRoot vs 已存在 Workspace 漏判）。逐级上溯最近的已存在祖先做
  // realpath，再拼回不存在的尾段。
  let real = realpathOrNull(resolved);
  if (real === null) {
    const plat = platform === 'win32' ? path.win32 : path.posix;
    const tail: string[] = [];
    let current = resolved;
    while (true) {
      // current 自身未能 realpath：它的末段必计入尾段，否则返回值会丢层
      // （实测：/private/system → /private 会把整个 /private 子树误判系统目录；
      // <repo>/dist-electron → <repo> 会误护整个仓库根）。
      tail.unshift(plat.basename(current));
      const parent = plat.dirname(current);
      const parentReal = realpathOrNull(parent);
      if (parentReal !== null || parent === current) {
        current = parentReal ?? parent;
        break;
      }
      current = parent;
    }
    real = plat.join(current, ...tail);
  }
  return platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * 只做根重叠判定（等于/包含/位于双向）：workspace 与任一 guard 命中即
 * 拒绝。R02 动态复核（能力使用时目录可能已被删除）与配置合并交叉校验
 * 只用本函数，不查存在性、不做系统目录拦截。
 */
export function checkRootOverlap(
  workspaceReal: string,
  guards: WorkspaceRootGuards,
  options: { platform?: NodeJS.Platform } = {},
): { ok: true } | { ok: false; code: string; message: string } {
  const platform = options.platform ?? process.platform;
  const realNorm = normalizeForCompare(workspaceReal, platform);
  for (const [label, guardPath] of [
    ['知识库根目录', guards.knowledgeBaseRoot],
    ['标准库目录', guards.outputRoot],
    ['应用数据目录', guards.dataRoot],
    ...(guards.protectedRoots ?? []).map((root, index) => [`受保护运行资源 ${index + 1}`, root] as const),
  ] as const) {
    if (!guardPath) continue;
    const guardNorm = normalizeForCompare(guardPath, platform);
    if (!guardNorm) continue;
    if (
      realNorm === guardNorm
      || realNorm.startsWith(guardNorm + (platform === 'win32' ? '\\' : '/'))
      || guardNorm.startsWith(realNorm + (platform === 'win32' ? '\\' : '/'))
    ) {
      return { ok: false, code: 'workspace_path_forbidden', message: `目录与${label}冲突: ${workspaceReal}` };
    }
  }
  return { ok: true };
}

/**
 * Workspace 授权校验（§7.3 + Leader steer #3 + F3-R01）：路径必须存在且为目录；
 * realpath 不得等于/包含/位于 knowledgeBaseRoot、outputRoot、dataRoot；
 * 不得为文件系统根、用户主目录本身、系统目录；也不得与受保护的
 * 运行资源重叠（应用源码/构建产物/node_modules、Electron 资源、pi 安装
 * 树与凭据目录、外部 Node 安装根——否则 ws_write 可改写
 * pi-extension/models.json 或 node 二进制把「无 shell」绕成本机任意代码执行）。
 */
export function validateWorkspacePath(
  workspacePath: string,
  guards: WorkspaceRootGuards,
  options: { homeDir?: string; platform?: NodeJS.Platform } = {},
): { ok: true; realPath: string } | { ok: false; code: string; message: string } {
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  let real: string;
  try {
    const stat = fs.lstatSync(workspacePath, { throwIfNoEntry: false });
    if (!stat) {
      return { ok: false, code: 'workspace_path_invalid', message: `目录不存在: ${workspacePath}` };
    }
    if (!stat.isDirectory()) {
      return { ok: false, code: 'workspace_path_invalid', message: `路径不是目录: ${workspacePath}` };
    }
    const resolved = realpathOrNull(workspacePath);
    if (!resolved) {
      return { ok: false, code: 'workspace_path_invalid', message: `realpath 解析失败: ${workspacePath}` };
    }
    real = resolved;
  } catch (error) {
    return { ok: false, code: 'workspace_path_invalid', message: String(error) };
  }

  const realNorm = normalizeForCompare(real, platform);

  // 系统目录拦截：subtree 目录拒绝其及内部；exact 目录只拒绝本身。
  // macOS 的 /var 是 /private/var 的 symlink，用户临时目录合法位于
  // /private/var/folders 下——/var 只做 exact 拦截，不做子树拦截。
  const systemSubtreeDirs = platform === 'win32'
    ? ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)']
    : ['/system', '/usr', '/bin', '/sbin', '/etc', '/private/system'];
  const systemExactDirs = platform === 'win32'
    ? ['c:\\windows\\temp']
    : ['/var', '/opt', '/private', '/private/var', '/library'];

  if (realNorm === '/' || realNorm === '' || /^[a-z]:\\?$/.test(realNorm)) {
    return { ok: false, code: 'workspace_path_forbidden', message: `不允许使用文件系统根目录: ${real}` };
  }
  if (systemExactDirs.some((dir) => realNorm === normalizeForCompare(dir))) {
    return { ok: false, code: 'workspace_path_forbidden', message: `不允许使用系统目录: ${real}` };
  }
  if (systemSubtreeDirs.some((dir) => realNorm.startsWith(normalizeForCompare(dir) + (platform === 'win32' ? '\\' : '/')))) {
    return { ok: false, code: 'workspace_path_forbidden', message: `不允许使用系统目录: ${real}` };
  }
  if (realNorm === normalizeForCompare(homeDir, platform)) {
    return { ok: false, code: 'workspace_path_forbidden', message: `不允许使用用户主目录本身: ${real}` };
  }

  const overlap = checkRootOverlap(real, guards, { platform });
  if (!overlap.ok) {
    return overlap;
  }
  return { ok: true, realPath: real };
}
