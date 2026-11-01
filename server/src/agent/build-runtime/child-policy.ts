/**
 * build-runtime/child-policy.ts — 应用自有「子任务工具面防御扩展」（child-policy）
 *
 * 背景（2026-11 真实 probe b361ce73 暴露的缺口，非猜测）：
 * amagi-pi 2.21.31@929000e 的 task-run.resolveSpawnPermissionDelivery
 * （extensions/amagi-core/task-run.ts:358）把 "codemode"/"toolcall_continue"
 * 无条件并入子任务 spawn 的 --tools 交付面；`--tools` 点名的已注册工具会被激活，
 * 因此 MCP `autoEnableCodemode:false` 挡不住这条激活路径——子任务模型工具面
 * 实测出现 codemode。设计 v2 §3.3/§13.1 要求子任务模型工具面无 codemode/
 * tool_search。
 *
 * 方案（Leader 已裁定的最小安全设计增补，Advisor 方案 C）：
 * - 构建专用 agentDir 的 settings.json 以 `extensions` 显式声明本扩展。相对路径
 *   按 agentDir 解析（pi DefaultPackageManager.resolveLocalEntries 以
 *   globalBaseDir=agentDir 调 resolvePathFromBase——dist 源码已核实）；packages
 *   仍唯一固定版本化 amagi-pi。Leader 以 `--no-extensions` 启动，resource-loader
 *   的 noExtensions 分支只保留 CLI `-e` 扩展，天然不加载本扩展；子任务由 amagi
 *   以 `--mode json -p` spawn（无 --no-extensions），默认发现加载本扩展。
 * - 扩展只做 active 面过滤 + tool_call 阻断，不声称卸载扩展：在 settings 写
 *   `-builtin:codemode` 会让 amagi-core 在装载期注册自己的 codemode 替身
 *   （codemode-runtime.ts builtinCodemodeMayLoad 分支，exposure model-only +
 *   defaultActive:true），禁用内置反而换来实现，故不走那条路。
 * - toolcall_continue 保留在面内：amagi length-continuation 只续传「保存时与
 *   执行时均 active 且可调用」的原工具，且执行经 ctx.executeTool 走完整
 *   tool_call 钩子链（length-continuation.ts 已核实），被禁名两层都进不去。
 * - 作用域：仅 `AMAGI_TASK_ID` 存在的 amagi 子任务进程生效；其余进程零行为。
 *   扩展不注册工具、不激活未授权工具、不改权限 grant、不触网、不读凭据。
 *
 * F12-R1 增补（2026-11 增量复审 recursive-sentinel-probe 真实复现，Major）：
 * - amagi-pi 2.21.31 的 grep/find 宿主守卫只校验「请求的搜索根」是否命中 deny
 *   （guards.ts diting-M5-F1 段）；file-permission.checkRead 只判请求路径本身。
 *   对不在 deny 内、但包含 forbiddenRoot 的祖先目录递归搜索，搜索根合法放行，
 *   递归遍历照样读进 deny 子树并把内容送回模型（上游源码注释自证：
 *   task-permission.ts deriveTools F01 冻结段「宿主 grep/find 搜索根粒度校验
 *   无法证明 deny 子树排除；deny 感知受控搜索属后续批」——但那只是 codemode
 *   scriptTools 收窄，普通工具面未动）。
 * - amagi deriveTools 从 read 授权无条件派生 grep/find（grant.read 非空即加），
 *   应用侧 scope 收紧无法把它们从子任务 --tools 交付面剥除；不改上游的前提下，
 *   唯一应用自有执法点是本扩展的面过滤 + 调用阻断。
 * - 裁决（安全优先于便利）：构建子任务工具面整体移除 grep/find/ls 等未经
 *   逐文件授权的递归/目录工具。替代通道：mcp_call 桥的 raw_search/draft_search/
 *   raw_list/manifest 等受控检索 + read 逐文件读取（read 自身仍受上游 deny
 *   执法保护——请求路径本身命中 deny 即拒，无递归面）。ls/powershell 不经
 *   amagi deriveTools 授权（子任务面本不含），一并列入名单属防御纵深：任何
 *   路径（迟到注册/重激活/上游后续放开派生）把它送进面内时同样被清出/阻断。
 * - 相对路径与 symlink alias 不另设白名单：这些工具被整体移除后，任何形态的
 *   调用（绝对/相对/别名）都到不了执行层；不宣称「未知 root 安全」，而是
 *   「无递归工具可用」。
 *
 * F12-R1 第二段（steer 补做：child native 根约束）：上游 deny 是黑名单，不阻
 * Linux /proc/self/environ 等未枚举路径——黑名单不穷举任意系统路径。裁决：
 * 知识仅经 MCP（raw 与 draft、kb 系桥接工具），native read 无需任意外部文件。
 * read 白名单 = 冻结信封根（skill 同目录协议 + 任务工作区）；write/edit 白名单
 * = 仅报告根（上游 ev-20260919 已把 write 授予面执法退役为声明性，本层补执法）。
 * 元数据经 PI_BUILD_CHILD_ROOTS_JSON（environment.ts buildLeaderEnv 注入，
 * PI_* 前缀经 amagi buildMinimalEnv 全量透传子任务；数据源 = 冻结 spec 的
 * workflowSkillPath + dirs.workDir，写入面与 freezeGuardConfig 默认
 * reportRoot='agent-outputs' 同源——adapter 从不传自定义值，若未来可自定义需
 * 同步两处，属最小接口变更）。缺元数据/非法 → read/write/edit 全部 fail-closed
 * 阻断，不降级放行。词法与 symlink 真实落点（realpathSync）双判：任一越界即拒
 * （与上游 checkRead「词法或落点任一命中 deny 即拒」对称的白名单版本）。
 * Windows 盘符路径不匹配 POSIX 白名单 → fail-closed 拒（平台未测，如实从严）。
 *
 * 完整性绑定（防「只记 hash 不验证」）：
 * - 纯 JS 源码确定性渲染，文件按内容 hash 命名物化在构建 home 根（不放
 *   `extensions/` 子目录——该目录被 pi 自动发现，显式声明是唯一加载路径，
 *   冻结面核对才有单一事实源）；settings.json 含 hash 文件名，因此
 *   agentDirConfigHash 间接绑定 policy 内容。
 * - 启动/恢复/probe 由 verifyChildPolicyFile 对磁盘内容做字节级核对，
 *   缺失/篡改一律 fail-closed（见 agent-dir-config.ts 的接线）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 设计 §3.3 冻结的子任务禁用工具名（面过滤 + 调用阻断同一份名单）。
 *
 * - codemode/tool_search：设计 §3.3 原始禁面（amagi 无条件交付 + pi model-only
 *   可声明，见模块头）；
 * - grep/find/ls：F12-R1 增补——上游 grep/find 只校验搜索根（祖先目录递归可
 *   越过 deny 子树），amagi deriveTools 又从 read 授权无条件派生 grep/find，
 *   应用侧无法经 scope 剥除；ls 为防御纵深（当前不经 amagi 授权，防迟到
 *   注册/重激活/上游演进）。构建子任务的内容/文件检索一律走 mcp_call 桥的
 *   受控工具（raw_search/draft_search/raw_list/manifest）或 read 逐文件读取。
 */
export const CHILD_POLICY_DISABLED_TOOLS: readonly string[] = [
  'codemode',
  'tool_search',
  'grep',
  'find',
  'ls',
];

/** 物化文件名前缀（陈旧文件清理与本文件识别用）。 */
export const CHILD_POLICY_FILE_PREFIX = 'child-policy-';

/**
 * 渲染 child-policy 扩展源码（纯 JS、零 import、零依赖；确定性输出）。
 *
 * pi 扩展契约（pi 1.4.0 docs/extensions.md + agent-session 源码已核实）：
 * - `session_start` 在工具注册后、首个 agent run 前发出；
 * - `before_agent_start` 每个 agent run（含重试/恢复/续接轮）前发出，此处
 *   setActiveTools 的结果不被 loadout 复算回退；auto-retry 续起的新 run 不重发；
 * - 实测（2026-11 live，真实 pi+amagi 子进程）关键时序事实：
 *   · 运行中任何工具注册/长度截断恢复会触发宿主 _refreshToolRegistry 或等价重置，
 *     把 --tools 点名的可声明工具（amagi 交付面点名 codemode；pi 1.4.0 的
 *     tool_search 也是 model-only 可声明）重新激活；
 *   · 下一请求的面在 prepareNextTurnWithContext 里从 active 集快照，而 turn_start
 *     在快照之后才发出——只挂 turn_start 会晚一拍（live 证据：截断后一请求被污染）；
 *   · 因此过滤锚必须覆盖「上一轮末尾 → 下一轮快照前」的全窗口：
 *     message_end(assistant)/tool_result/turn_end 收尾链 + turn_start/agent_end
 *     补拍下一拍 + message_start(系统面补丁) 兑底；
 *   · 残余窗口（重激活落在最后一次过漏与快照之间的微任务间隙）由 tool_call
 *     阻断死守；结构性收口需 amagi 上游停止无条件交付 codemode（见实施报告）；
 * - `tool_call` 返回 { block:true, reason } 拒绝执行；handler 抛错时 pi 以阻断该调用
 *   为 fail-safe——与「面过滤失败不吞调用面」的双层意图一致。
 */
export function renderChildPolicySource(): string {
  const denyList = CHILD_POLICY_DISABLED_TOOLS.map((name) => `'${name}'`).join(', ');
  return `/**
 * feishu-sync child-policy —— 应用自有构建子任务工具面防御扩展（内容寻址物化，勿手改）。
 * 由 server/src/agent/build-runtime/child-policy.ts 确定性渲染；文件名含内容 hash。
 *
 * 行为（设计 v2 §3.3/§13.1 + F12-R1 工具面收窄）——多锚点面过滤 + 一重调用阻断：
 * 1) session_start / before_agent_start / turn_start / turn_end / agent_end /
 *    tool_result / message_end(assistant) / message_start(系统面补丁) 八锚点从
 *    active 面移除禁用名（不卸载扩展、不改注册表——模型每轮收到的工具声明即
 *    不含禁用面）；锚点布局对齐宿主重置机制（工具迟到注册、长度截断恢复、
 *    auto-retry 轮）与「下一请求快照前」的全部收尾窗口（live 证据见实施报告）；
 * 2) tool_call 拒绝对禁用名的调用（含运行中被重新激活后的调用、以及经
 *    ctx.executeTool 嵌套触达的路径）。
 * 3) F12-R1：grep/find/ls 一并禁用——上游 grep/find 守卫只校验搜索根，对包含
 *    禁区的祖先目录递归搜索会越过 deny 子树读出内容；构建子任务的检索请走
 *    mcp_call 桥受控工具（raw_search/draft_search/raw_list/manifest）。
 * 4) F12-R1 二段：read/write/edit 冻结信封根复核——read 限 skill 同目录协议与
 *    任务工作区；write/edit 仅限报告根（上游 write 授予面执法已退役，本层补）。
 *    词法与 symlink 真实落点双判；缺 PI_BUILD_CHILD_ROOTS_JSON 元数据全部
 *    fail-closed 阻断。知识读取一律走 mcp_call 桥。
 * 不注册工具、不激活工具、不改权限 grant、不触网；仅对文件工具目标做
 * realpath 元数据解析（node:fs.realpathSync，动态 import），不读任何文件内容。
 * 作用域：仅 AMAGI_TASK_ID 存在的 amagi 子任务进程；其余进程（含以
 * --no-extensions 启动的构建 Leader）零行为。
 */
const DENY = new Set([${denyList}]);
const REASON = 'child-policy（构建子任务面冻结）：' + [${denyList}].join('/') +
  ' 不对子任务模型开放（设计 §3.3 + F12-R1 工具面收窄）；' +
  '内容/文件检索请走 mcp_call 桥受控工具（raw_search/draft_search/raw_list 等），' +
  '不要尝试经祖先目录/相对路径/别名递归遍历。';
const FILE_TOOLS = new Set(['read', 'write', 'edit']);
const ROOTS_ENV = 'PI_BUILD_CHILD_ROOTS_JSON';
const ROOT_REASON = 'child-policy（F12-R1 根约束）：文件工具目标越出冻结信封根——' +
  '知识读取请走 mcp_call 桥受控工具（raw_read/raw_search 等）；本地文件仅限任务工作区、' +
  'skill 同目录协议与报告根（词法/symlink 落点双判）。';
const NO_ROOTS_REASON = 'child-policy（F12-R1 根约束）：缺少冻结信封根元数据（' + ROOTS_ENV +
  '）——fail-closed 拒绝文件工具调用；请改用 mcp_call 桥受控工具。';
let rootsPromise = null;
let fsModule = null;
let pathModule = null;
// path 语义：动态 import node builtin，取宿主默认（Windows 盘符/UNC/分隔符由平台标准库
// 处理，不手写 POSIX 解析——F13 同款教训）；PI_BUILD_CHILD_PATH_FLAVOR 仅为单测在非
// Windows 宿主覆盖 win32/posix 词法行为的接缝（生产无此 env，恒宿主语义）。
async function ensurePath() {
  if (pathModule !== null) return pathModule;
  const mod = await import('node:path');
  const flavor = process.env.PI_BUILD_CHILD_PATH_FLAVOR;
  pathModule = flavor === 'win32' ? mod.win32 : flavor === 'posix' ? mod.posix : (mod.default || mod);
  return pathModule;
}
function normalizeInput(p) {
  let s = String(p == null ? '' : p);
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\\\')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) s = s === '~' ? home : home + s.slice(1);
  }
  return pathModule.resolve(process.env.AMAGI_PERMISSION_CWD || process.cwd(), s);
}
// 白名单根双形态归一：词法形态 + realpath 形态（macOS /var → /private/var 等 symlink 前缀
// 下，目标的 realpath 落点与词法根前缀天然不一致；根自身 realpath 后两个形态都认——
// 词法与落点双判语义不变：symlink 别名指向白名单外仍拒（落点不在任何形态根内））。
async function allowedRoots() {
  if (rootsPromise === null) {
    rootsPromise = (async () => {
      const P = await ensurePath();
      let parsed = null;
      const raw = process.env[ROOTS_ENV];
      if (raw) { try { parsed = JSON.parse(raw); } catch (error) { parsed = null; } }
      const okList = (value) => Array.isArray(value) && value.length > 0 &&
        value.every((entry) => typeof entry === 'string' && entry && P.isAbsolute(entry));
      if (!parsed || !okList(parsed.readRoots) || !okList(parsed.writeRoots)) {
        return { ok: false, readRoots: [], writeRoots: [] };
      }
      fsModule = fsModule || (await import('node:fs'));
      const expand = async (list) => {
        const out = [];
        for (const entry of list) {
          const lexical = P.resolve(entry);
          out.push(lexical);
          // 报告根尚未建立时也以最近既存祖先生成canonical根，避免 /var
          // 或其它symlink前缀让合法首次write被误拒；目标仍独立解析并双判。
          const canonicalRoot = await resolveRealLanding(lexical);
          if (canonicalRoot.ok) out.push(P.resolve(canonicalRoot.real));
        }
        return out;
      };
      return { ok: true, readRoots: await expand(parsed.readRoots), writeRoots: await expand(parsed.writeRoots) };
    })();
  }
  return rootsPromise;
}
function insideAny(target, roots) {
  const P = pathModule;
  for (const root of roots) {
    const rel = P.relative(root, target);
    if (rel === '') return true;
    if (P.isAbsolute(rel)) continue; // 跨盘符/跨 UNC 根 → 不同根
    if (rel.split(P.sep)[0] === '..') continue; // 父级逃逸（'a..b' 等合法目录名不误伤）
    return true;
  }
  return false;
}
// 真实落点解析：取「最近既存祖先」的 realpath 重拼剩余未存在段（write 新文件/新建目录的
// 落点必须可证）。既存但无法解析的条目（dangling symlink / EACCES / 其它 fs 异常）一律
// fail-closed 拒绝——不得把所有 fs 异常等同「普通未建文件」放行（父 symlink 新建泄漏与
// dangling leaf 写入面由这里封死）。
async function resolveRealLanding(absPath) {
  if (fsModule === null) fsModule = await import('node:fs');
  const P = await ensurePath();
  let current = absPath;
  const rest = [];
  for (let hops = 0; hops < 128; hops += 1) {
    let exists = false;
    try { fsModule.lstatSync(current); exists = true; }
    catch (error) {
      const code = error && error.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') exists = false;
      else return { ok: false, reason: String(code || 'lstat-failed') };
    }
    if (exists) {
      try {
        const real = fsModule.realpathSync(current);
        let existingTarget = rest.length === 0;
        if (existingTarget) {
          try { fsModule.accessSync(absPath, fsModule.constants.F_OK); }
          catch (error) { existingTarget = false; }
        }
        return { ok: true, real: rest.length === 0 ? real : P.join(real, ...rest), existingTarget };
      } catch (error) {
        return { ok: false, reason: String((error && error.code) || 'realpath-failed') };
      }
    }
    const parent = P.dirname(current);
    if (parent === current) return { ok: false, reason: 'unresolvable-root' };
    rest.unshift(P.basename(current));
    current = parent;
  }
  return { ok: false, reason: 'too-many-hops' };
}

export default function childPolicy(pi) {
  if (!process.env.AMAGI_TASK_ID) return;
  const filterActiveFace = () => {
    try {
      const active = pi.getActiveTools();
      if (!Array.isArray(active) || !active.some((name) => DENY.has(name))) return;
      pi.setActiveTools(active.filter((name) => !DENY.has(name)));
    } catch (error) {
      console.error('[child-policy] active 面过滤失败：' + (error && error.message ? error.message : String(error)) +
        '（tool_call 阻断仍独立生效）');
    }
  };
  pi.on('session_start', filterActiveFace);
  pi.on('before_agent_start', filterActiveFace);
  // —— 轮次收尾链（「上一轮末尾 → 下一请求快照前」的重激活在这里清掉）：
  // tool_result/turn_end 在工具执行与轮末发出；message_end(assistant) 盖住长度
  // 截断恢复路径（live 实测：截断消息终结时 codemode/tool_search 被重新激活，
  // 下一请求面在 turn_start 之前已快照——只挂 turn_start 会晚一拍）。
  pi.on('tool_result', filterActiveFace);
  pi.on('turn_end', filterActiveFace);
  pi.on('message_end', (event) => {
    const message = event && event.message;
    if (message && message.role === 'assistant') filterActiveFace();
  });
  // —— 补拍下一拍与系统面补丁兑底（turn_start 在快照后发出，清理的是下一请求；
  // agent_end 盖住 run 间空档；message_start(系统面) 盖住 toolsAdded 补丁追记）。
  pi.on('turn_start', filterActiveFace);
  pi.on('agent_end', filterActiveFace);
  pi.on('message_start', (event) => {
    const message = event && event.message;
    if (message && message.role === 'system') filterActiveFace();
  });
  pi.on('tool_call', async (event) => {
    const name = event && typeof event.toolName === 'string' ? event.toolName : '';
    if (DENY.has(name)) return { block: true, reason: REASON };
    if (FILE_TOOLS.has(name)) {
      const roots = await allowedRoots();
      if (!roots.ok) return { block: true, reason: NO_ROOTS_REASON };
      const input = (event && event.input) || {};
      const rawPath = typeof input.path === 'string' && input.path
        ? input.path
        : (typeof input.file_path === 'string' && input.file_path ? input.file_path : '');
      if (!rawPath) return { block: true, reason: ROOT_REASON + '（缺少路径参数）' };
      // Pi文件工具会剥离@、转换file URL/Unicode空格及Windows shell盘符；
      // 本围栏只接受无二次解释的常规绝对/相对路径，防校验与执行目标不同。
      const sdkSpace = [...rawPath].some((c) => {
        const n = c.codePointAt(0);
        return n === 0xa0 || (n >= 0x2000 && n <= 0x200a) || n === 0x202f || n === 0x205f || n === 0x3000;
      });
      const shellSegments = rawPath.slice(1).split('/');
      const shellDrive = ['mnt', 'cygdrive'].includes((shellSegments[0] || '').toLowerCase())
        ? shellSegments[1] : shellSegments[0];
      const shellAlias = pathModule.sep !== '/' && rawPath.startsWith('/') && !rawPath.startsWith('//')
        && !rawPath.includes(String.fromCharCode(92)) && /^[a-z]$/i.test(shellDrive || '');
      if (rawPath.startsWith('@') || rawPath.startsWith('~') || /^file:/i.test(rawPath) || sdkSpace || shellAlias) {
        return { block: true, reason: ROOT_REASON + '（请使用普通绝对或相对路径，不使用SDK便捷路径别名）' };
      }
      if (pathModule.sep !== '/') {
        const segments = rawPath.split(String.fromCharCode(92)).join('/').split('/');
        const ambiguous = segments.some((part, i) => {
          if (part === '' || part === '.' || part === '..') return false;
          const stem = part.split('.')[0].toUpperCase();
          const reserved = ['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$', 'CLOCK$'].includes(stem)
            || /^(COM|LPT)[0-9¹²³]$/.test(stem);
          return reserved || part.endsWith('.') || part.endsWith(' ')
            || (part.includes(':') && !(i === 0 && /^[a-z]:$/i.test(part)));
        });
        if (ambiguous) return { block: true, reason: ROOT_REASON + '（不接受Win32设备名、流或非规范路径分量）' };
      }
      const rootsFor = name === 'read' ? roots.readRoots : roots.writeRoots;
      const lexical = normalizeInput(rawPath);
      if (!insideAny(lexical, rootsFor)) return { block: true, reason: ROOT_REASON };
      const landing = await resolveRealLanding(lexical);
      if (!landing.ok) {
        return { block: true, reason: ROOT_REASON + '（真实落点无法解析：' + landing.reason + '，fail-closed）' };
      }
      if (!insideAny(landing.real, rootsFor)) {
        return { block: true, reason: ROOT_REASON + '（symlink 落点越界）' };
      }
      // read仅允许原目标确实存在，禁止SDK在ENOENT时对整条路径尝试NFD/
      // 弯引号/截图文件名候选，从而把原本在根内的校验目标换成另一个根。
      if (name === 'read' && !landing.existingTarget) {
        return { block: true, reason: ROOT_REASON + '（读取落点不存在或不可确认，不允许路径候选回退）' };
      }
    }
    return undefined;
  });
}
`;
}

/** 源码 sha256（十六进制）。 */
export function childPolicyContentHash(source: string = renderChildPolicySource()): string {
  return crypto.createHash('sha256').update(source, 'utf-8').digest('hex');
}

/** 物化文件名：`child-policy-<hash 前 12 位>.js`（内容寻址；hash 撞前 12 位且内容不同时由写后核验拒绝）。 */
export function childPolicyFileName(source: string = renderChildPolicySource()): string {
  return `${CHILD_POLICY_FILE_PREFIX}${childPolicyContentHash(source).slice(0, 12)}.js`;
}

/** 陈旧 policy 文件识别（不含当前名；清理用，见 writeAgentDirConfig）。 */
export function isStaleChildPolicyFile(name: string, currentName: string): boolean {
  return /^child-policy-[0-9a-f]{12}\.js$/.test(name) && name !== currentName;
}

/**
 * 加载前完整性核验：磁盘文件必须存在且与确定性源码逐字节一致。
 * 缺失/篡改返回 issues（调用方 fail-closed，不得降级为“仅记录”）。
 */
export function verifyChildPolicyFile(homeDir: string): { ok: boolean; issues: string[]; fileName: string; filePath: string } {
  const source = renderChildPolicySource();
  const fileName = childPolicyFileName(source);
  const filePath = path.join(homeDir, fileName);
  const issues: string[] = [];
  let actual: string | null = null;
  try {
    actual = fs.readFileSync(filePath, 'utf-8');
  } catch {
    issues.push(`child-policy 文件缺失（${fileName}）——子任务工具面防御未物化，拒绝放行`);
  }
  if (actual !== null && actual !== source) {
    issues.push(`child-policy 文件内容与确定性源码不一致（${fileName}，疑似篡改/损坏）——拒绝放行`);
  }
  return { ok: issues.length === 0, issues, fileName, filePath };
}

/**
 * 物化 policy 文件到构建 home（幂等）：
 * - 同名文件存在：内容必须逐字节一致，否则按篡改 fail-closed 抛错（内容寻址
 *   文件名下内容漂移没有合法来源——渲染是纯函数，同名即同内容）；
 * - 不存在：tmp + rename 原子写入（0600）；
 * - 写后核验（verifyChildPolicyFile）通过才算成功；
 * - 顺带清理陈旧 hash 的 policy 文件（未声明即不加载，清理仅卫生，失败不阻断）。
 */
export function materializeChildPolicyFile(homeDir: string): { fileName: string; filePath: string } {
  const source = renderChildPolicySource();
  const fileName = childPolicyFileName(source);
  const filePath = path.join(homeDir, fileName);
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing !== source) {
      throw new Error(
        `child-policy 内容寻址文件被篡改（${fileName} 与确定性源码不一致）——拒绝覆盖，请人工核查构建 home：${homeDir}`,
      );
    }
  } else {
    const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, source, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }
  // 写后核验：不能只写不验。
  const verify = verifyChildPolicyFile(homeDir);
  if (!verify.ok) throw new Error(`child-policy 物化后核验失败：${verify.issues.join('；')}`);
  try {
    for (const name of fs.readdirSync(homeDir)) {
      if (isStaleChildPolicyFile(name, fileName)) fs.rmSync(path.join(homeDir, name));
    }
  } catch { /* 卫生清理失败不阻断：陈旧文件未被声明，不会被加载 */ }
  return { fileName, filePath };
}
