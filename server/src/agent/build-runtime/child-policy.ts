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

/** 设计 §3.3 冻结的子任务禁用工具名（面过滤 + 调用阻断同一份名单）。 */
export const CHILD_POLICY_DISABLED_TOOLS: readonly string[] = ['codemode', 'tool_search'];

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
 * 行为（设计 v2 §3.3/§13.1）——多锚点面过滤 + 一重调用阻断：
 * 1) session_start / before_agent_start / turn_start / turn_end / agent_end /
 *    tool_result / message_end(assistant) / message_start(系统面补丁) 八锚点从
 *    active 面移除禁用名（不卸载扩展、不改注册表——模型每轮收到的工具声明即
 *    不含禁用面）；锚点布局对齐宿主重置机制（工具迟到注册、长度截断恢复、
 *    auto-retry 轮）与「下一请求快照前」的全部收尾窗口（live 证据见实施报告）；
 * 2) tool_call 拒绝对禁用名的调用（含运行中被重新激活后的调用、以及经
 *    ctx.executeTool 嵌套触达的路径）。
 * 不注册工具、不激活工具、不改权限 grant、不触网、不读写文件。
 * 作用域：仅 AMAGI_TASK_ID 存在的 amagi 子任务进程；其余进程（含以
 * --no-extensions 启动的构建 Leader）零行为。
 */
const DENY = new Set([${denyList}]);
const REASON = 'child-policy（构建子任务面冻结）：' + [${denyList}].join('/') +
  ' 不对子任务模型开放（设计 §3.3）；请改用任务书授权的工具完成任务。';

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
  pi.on('tool_call', (event) => {
    if (event && typeof event.toolName === 'string' && DENY.has(event.toolName)) {
      return { block: true, reason: REASON };
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
