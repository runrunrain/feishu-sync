/** 仅把确定不存在的库内路径判为missing；权限、根目录不可用与符号链接越界不作删除证据。 */
import fs from 'node:fs';
import path from 'node:path';
export type LocalPathState = 'present' | 'missing' | 'unavailable' | 'unsafe';
export function createLocalPathInspector(root: string): (target: string, kind?: 'file' | 'directory') => LocalPathState {
  let rootReal: string;
  const rootLex = path.resolve(root || '.');
  try {
    if (!root) return () => 'unavailable';
    rootReal = fs.realpathSync.native(root);
    if (!fs.statSync(rootReal).isDirectory()) return () => 'unavailable';
    fs.accessSync(rootReal, fs.constants.R_OK | fs.constants.X_OK);
  } catch { return () => 'unavailable'; }
  return (target: string, kind = 'file') => {
    if (!target || target.includes('\0')) return 'unsafe';
    try {
      const abs = path.resolve(rootLex, target);
      let rel = path.relative(rootLex, abs);
      if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) rel = path.relative(rootReal, abs);
      if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return 'unsafe';
      const candidate = path.join(rootReal, rel);
      let ancestor = candidate;
      while (true) {
        try {
          const real = fs.realpathSync.native(ancestor);
          if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return 'unsafe';
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') return 'unavailable';
          try { if (fs.lstatSync(ancestor).isSymbolicLink()) return 'unsafe'; } catch { /* missing ancestor */ }
          if (ancestor === rootReal) return 'unavailable';
          ancestor = path.dirname(ancestor);
        }
      }
      try { const stat = fs.statSync(candidate); return (kind === 'file' ? stat.isFile() : stat.isDirectory()) ? 'present' : 'missing'; }
      catch (error) { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'missing' : 'unavailable'; }
    } catch { return 'unavailable'; }
  };
}
export function localPathState(root: string, target: string, kind: 'file' | 'directory' = 'file'): LocalPathState {
  return createLocalPathInspector(root)(target, kind);
}
