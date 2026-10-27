/**
 * 受保护运行资源根（F3-R01）——集中推导应用完整运行依赖树与外部
 * 运行时安装根，供 Workspace 授权、配置合并交叉校验（R02）与工具
 * 执行动态复核共用。此前只保护 ~/.pi/agent、server 资产目录与 pi 包根，
 * node_modules / Electron / 打包资源 / Node 安装根均可被 ws_write 改写
 * （改写 node_modules 或 node 二进制即可在下次 spawn 时执行任意代码）。
 *
 * 方向语义：受保护根与 workspace 的等于/包含/位于双向重叠都拒绝
 * （见 path-guard.checkRootOverlap）——workspace 套住 node_modules 与
 * workspace 位于 node_modules 内同样危险。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverDistRoot } from './agent-assets.js';
import { checkRootOverlap } from './path-guard.js';
import type { PiRuntimeResolver } from './runtime-resolver.js';

export interface ProtectedRootsContext {
  /** 测试注入；缺省 process.env */
  env?: NodeJS.ProcessEnv;
  /** 测试注入；缺省 os.homedir() */
  homeDir?: string;
  /** Electron 资源目录（process.resourcesPath）；standalone/node 下缺省 */
  resourcesPath?: string;
  /** 测试注入；缺省按 import.meta 推导 */
  serverDistOverride?: string;
}

function realpathOrResolve(target: string): string | null {
  try {
    return fs.realpathSync.native(target);
  } catch {
    const resolved = path.resolve(target);
    return resolved && resolved.length > 0 ? resolved : null;
  }
}

/**
 * 静态受保护根（无需运行时发现，同步可推导）：
 *  - server 源码树与构建产物树（tsx 从 src 运行时 dist 可能同时存在，两者都保护）
 *  - 根目录/子包 node_modules
 *  - electron/ 源码目录与 dist-electron 构建产物（dev 存在）
 *  - Electron 打包资源树（resourcesPath；其父目录 Contents/ 覆盖 app.asar、
 *    app.asar.unpacked 与 MacOS 可执行文件）
 *  - pi 凭据目录 ~/.pi/agent 与 PI_CODING_AGENT_DIR（实际 pi 配置根）
 */
export function collectStaticProtectedRoots(context: ProtectedRootsContext = {}): string[] {
  const homeDir = context.homeDir ?? os.homedir();
  const env = context.env ?? process.env;
  const serverDist = context.serverDistOverride ?? serverDistRoot();
  const serverRoot = path.dirname(serverDist);
  const repoRoot = path.dirname(serverRoot);
  const roots: string[] = [
    // 保护完整应用树：前端源码、Vite/构建配置和package入口也会被自动加载，不能只列依赖子树。
    repoRoot,
    path.join(serverRoot, 'src'),
    path.join(serverRoot, 'dist'),
    path.join(serverRoot, 'node_modules'),
    path.join(repoRoot, 'node_modules'),
    path.join(repoRoot, 'electron'),
    path.join(repoRoot, 'dist-electron'),
    path.join(homeDir, '.pi', 'agent'),
  ];
  if (env.PI_CODING_AGENT_DIR && env.PI_CODING_AGENT_DIR.trim()) {
    roots.push(path.resolve(env.PI_CODING_AGENT_DIR.trim()));
  }
  const resourcesPath = context.resourcesPath
    ?? (process.versions?.electron ? (process as unknown as { resourcesPath?: string }).resourcesPath : undefined);
  if (resourcesPath) {
    roots.push(path.resolve(resourcesPath));
    // resourcesPath 形如 <App>.app/Contents/Resources；父目录 Contents 覆盖
    // MacOS 可执行文件与 app.asar.unpacked。非 .app 布局（win/linux 安装
    // 目录）同样成立：父目录覆盖可执行文件。
    roots.push(path.dirname(path.resolve(resourcesPath)));
  }
  // 应用树内临时文档也不作为Workspace；普通独立资料目录仍可授权。
  // 去重 + 只保留可规范化的条目。
  const unique: string[] = [];
  for (const root of roots) {
    const normalized = realpathOrResolve(root);
    if (normalized && !unique.includes(normalized)) unique.push(normalized);
  }
  return unique;
}

/**
 * 运行时受保护根（依赖 runtime-resolver 发现结果）：
 *  - 外部 Node 可执行文件所在目录（安装根 bin；覆盖 PATH shim 与 realpath
 *    两种形态——workspace 含住 bin 即可改写 node 二进制，下次 spawn 执行）
 *  - pi 包根（含 dist/cli.js 与自身 node_modules）
 *  - npm 的字面安装根与入口 realpath 所属包根。即使不再执行 npm 发现，
 *    Work 也不能改写该运行时附带的包管理器代码。
 */
export function collectRuntimeProtectedRoots(runtime: {
  nodePath: string | null | undefined;
  piPackageRoot: string | null | undefined;
}): string[] {
  const roots: string[] = [];
  if (runtime.nodePath) {
    roots.push(path.dirname(runtime.nodePath));
    try {
      const real = fs.realpathSync.native(runtime.nodePath);
      const realDir = path.dirname(real);
      if (!roots.includes(realDir)) roots.push(realDir);
    } catch { /* 节点不存在时按字面目录保护 */ }
    for (const nodeDir of [...new Set(roots)]) {
      const npmRoots = [
        path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm'),
        path.join(nodeDir, 'node_modules', 'npm'),
      ];
      // POSIX npm bin 常是 symlink，可指向另一个 prefix 的 npm 包。
      // 只读回溯包边界，不执行入口或解析任意 shim 脚本。
      try {
        let current = path.dirname(fs.realpathSync.native(path.join(nodeDir, 'npm')));
        for (let depth = 0; depth < 8; depth += 1) {
          const pkgPath = path.join(current, 'package.json');
          if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
            if (pkg.name === 'npm') {
              npmRoots.push(current);
              break;
            }
          }
          const parent = path.dirname(current);
          if (parent === current) break;
          current = parent;
        }
      } catch { /* 没有 npm 或不是标准包入口；发现流程不会执行它 */ }
      roots.push(...npmRoots);
    }
  }
  if (runtime.piPackageRoot) {
    roots.push(runtime.piPackageRoot);
  }
  const unique: string[] = [];
  for (const root of roots) {
    const normalized = realpathOrResolve(root);
    if (normalized && !unique.includes(normalized)) unique.push(normalized);
  }
  return unique;
}

/** 同一服务中发现过的资源都保留保护，覆盖切换配置后仍存活的旧进程。 */
export function collectResolvedRuntimeProtectedRoots(
  resolver: Pick<PiRuntimeResolver, 'getResolvedRuntimes'>,
): string[] {
  return [...new Set(resolver.getResolvedRuntimes().flatMap(collectRuntimeProtectedRoots))];
}

/** 全量受保护根 = 静态 + 运行时（调用方先完成 runtime 发现）。 */
export function collectAllProtectedRoots(
  runtime: { nodePath: string | null | undefined; piPackageRoot: string | null | undefined },
  context: ProtectedRootsContext = {},
): string[] {
  return [...collectStaticProtectedRoots(context), ...collectRuntimeProtectedRoots(runtime)];
}

export interface WorkspaceConflictDetail {
  field: string;
  message: string;
}

/**
 * R02：已授权 Workspace 与合并后配置的交叉校验。任一 workspace 与
 * knowledgeBaseRoot / outputRoot / dataRoot / 受保护运行资源重叠即返回
 * 冲突明细（保存方拒绝落盘，避免冲突配置导致后续同步启动失败或静默
 * 提权）。只做重叠判定，不要求 workspace 目录仍存在（目录被删不算冲突）。
 */
export function validateWorkspacesAgainstConfig(input: {
  workspaces: Array<{ id: string; name: string; path: string }>;
  knowledgeBaseRoot: string;
  outputRoot: string;
  dataRoot: string;
  extraProtectedRoots?: string[];
}): WorkspaceConflictDetail[] {
  const details: WorkspaceConflictDetail[] = [];
  const staticRoots = collectStaticProtectedRoots();
  for (const workspace of input.workspaces) {
    if (!workspace.path) continue;
    const verdict = checkRootOverlap(workspace.path, {
      knowledgeBaseRoot: input.knowledgeBaseRoot,
      outputRoot: input.outputRoot,
      dataRoot: input.dataRoot,
      protectedRoots: [...staticRoots, ...(input.extraProtectedRoots ?? [])],
    });
    if (!verdict.ok) {
      details.push({
        field: `agent.workspaces[${workspace.id}]`,
        message: `Workspace「${workspace.name}」与新配置冲突：${verdict.message}`,
      });
    }
  }
  return details;
}
