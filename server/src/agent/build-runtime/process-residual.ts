/**
 * build-runtime/process-residual.ts — F10 残留核对与回收（受信锚点 + OS 身份交叉核验）
 *
 * 数据源（发现线索 → 身份证明）：
 * 1. 受信原生启动锚点：amagi-pi（2.21.31+）在派发子任务时同步写入
 *    <agentDir>/amagi/data/process-audits/<taskId>/launch-anchor.json
 *    （rootPid/pgid/rootIdentityToken/leaderPid/at；落在构建 agentDir 内，由
 *    我们启动的 Leader 写入，agentDir 配置面在模型禁区）。锚点是发现线索
 *    与出生令牌基准，归属判定仍需 OS 侧交叉核验。
 * 2. v2-store 派发意图（<agentDir>/amagi/v2-store/<taskId>/current.json）：
 *    任务记录先于 spawn 写入——活跃任务若**无锚点覆盖**，即 spawn→锚点写入
 *    之间的硬崩窗口（或不支持锚点的旧版 amagi）：个体不可发现、不可证明，
 *    结论必须 unconfirmed（不能把证据缺失当无残留）。
 * 3. 应用进程账本（process-ledger.ts）：Leader 自身启动记录（pid/argv 指纹/
 *    出生令牌；应用重启句柄丢失的补偿路径）。
 *
 * 证明与回收纪律（Leader 反馈修订，不放宽）：
 * - 根个体回收**只认出生令牌**（锚点/账本令牌）：无令牌 → unconfirmed 不发
 *   信号——pgid===rootPid + node 可执行名不是"本次启动身份"，旧锚点 PID/PGID
 *   可被无关 detached Node 复用，绝不以此降级放行。
 * - **每个信号前 fresh 证明**（尤其首个 SIGTERM）：分类用的整批令牌快照在
 *   多个体回收过程中会陈旧；任何信号发出前都必须现场重采令牌并比对，
 *   首信号前身份变化 → 零信号。
 * - 组员（孙进程/桥）：在根个体仍可证明存活时枚举同 pgid 成员并**封存**
 *   其自身出生令牌（发现仅候选；封存要求根前后端点证明 + 成员身份/
 *   membership 双夹逼，见 snapshotGroupMembersWithBirth）；根回收后每个
 *   成员信号前按其自身令牌 fresh 复核——成员 PID 复用 → not-ours 不发
 *   信号，绝不在根死后仅凭"同 pgid 仍存活"补刀。
 * - F10-R2：组员发现/取样必须与根**当时**的出生归属组成有效时序证明（root
 *   前后端点夹住成员身份与 membership 双夹逼）；任一步失败 → 该成员不封存
 *   或整份 memberPlan 作废（成员自身 birth 匹配只证明"还是刚发现的那个
 *   进程"，不证明属于本次构建）。
 * - F10-R1：根 pid 已退出 ≠ 该任务后代全退——同 pgid 的桥/孙进程可能仍活
 *   （普通同组遗留，无需 setsid 逃逸）。根死后无法建立"根存活期枚举"的
 *   归属时序 → 存活组员逐个如实上报 unconfirmed（零信号，不按 PGID 杀）。
 * - 无法证明的个体不杀、不假装已退出：unconfirmed 持久化并阻断新 Leader
 *   （换 epoch 也不能绕过）。
 * - 信号能力纪律（裁决 #5）：生产**没有**针对历史发现/仅数字 PID 目标的
 *   稳定引用——ReapContext.kill 只能由调用方注入（测试的 identity-bound
 *   原子出口，或桥接到测试/宿主当前持有的自有 ChildProcess 句柄），缺省
 *   即无该能力：归属可证且存活 → 如实 unconfirmed（零信号），绝不以
 *   process.kill(pid) 作默认出口。"有 birth 令牌"只解决归属证明，不等于
 *   有稳定引用。自有句柄的正常关闭/终止（rpc.terminate 等）不受影响，
 *   也不以重命名 kill 回调冒充身份绑定。
 * - 同 PGID 本身不授归属（同组≠同 run）：封存组员还须私有 session 前提
 *   （linux 实际 SID；darwin 无 sid 字段 → 依赖固定启动实现前提：amagi
 *   2.21.31 pin + 内容哈希逐次核验的 detached spawn 语义），前提不可
 *   验证 → 不封存、零信号。
 * - R2-F10-01（锚点归属分区）：锚点读取成功 ≠ 已匹配构建归属。Leader
 *   登记集（binding+账本，leaderPids）非空时：匹配 run 进个体对账；不匹配
 *   run 归属不明（登记缺失或外来写入）——绝不既充当 v2-store「已覆盖」
 *   又被无声丢弃，也绝不纳入可信号集合，逐 run 如实 unconfirmed。登记集
 *   为空（binding 不可得且账本无 Leader 条目）时：build home 是构建私有
 *   目录，锚点即本构建可见运行事实——全部 run 进入逐个体对账（真实探测
 *   root：exited/not-ours/unconfirmed/可回收性），绝不因过滤后空集合直接
 *   confirmed；信号资格仍只由出生令牌+注入出口决定（生产零信号不变）。
 * - R2-F10-01 追加（PID 冲突不变量）：PID 不是运行身份。同一 pid 的多份
 *   运行声称（锚点-锚点/账本-锚点/账本-账本，去重「完全重复」后仍 >1）
 *   全部保留、逐声称裁决：pid 已死 → 各声称的出生均已结束（exited）；pid
 *   存活 → 占用者出生令牌至多匹配一份（匹配=该 run 进程存活，冲突个体
 *   保守零信号；不匹配=其声称的出生已结束；令牌缺失/探测失效=不可区分
 *   → unconfirmed）。绝不静默挑一份消除可见事实，也绝不因冲突假 confirmed。
 * - R2-F10-02（内层扫描契约）：锚点/v2-store 目录读取失败显式区分 ENOENT
 *   （合法"无事实"契约：旧版 amagi/全新构建）与非 ENOENT（degraded：证据
 *   不可得）。degraded 与锚点证据不全（untrusted）都直接进入未确认面并
 *   决定总体 state（贯穿 shutdown 等消费者），不能只改 note 却维持
 *   confirmed；单个锚点文件在但不可读（非 ENOENT）同样证据不全。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CHILD_REAP_GRACE_MS, type ChildProcessFinding, type TerminationOutcome } from './contracts.js';
import { readBirthIdentities, readProcessGroups, snapshotProcessTable, type ProcTableRow, type ProcessIdentityDeps } from './process-identity.js';
import { readProcessLedger, type ProcessLedgerEntry } from './process-ledger.js';

/** amagi launch-anchor 最小读取面（只取对账所需字段；损坏即整文件作废）。 */
export interface AnchorRun {
  taskId: string;
  anchorFile: string;
  rootPid: number;
  pgid?: number;
  rootIdentityToken?: string;
  leaderPid: number;
  /** 派发时刻（epoch ms）。 */
  at: number;
  /** 冻结Native锚点的系统启动身份；只能成对缺席或成对合法。 */
  bootId?: string;
  bootTimeMs?: number;
}

export interface AnchorScanResult {
  runs: AnchorRun[];
  /** 锚点不可信（损坏/被截断丢弃 run/锚点文件不可读）→ 证据不全。 */
  untrusted: boolean;
  /** 锚点根目录不可枚举（非 ENOENT 读取失败）→ 证据不可得（调用方
 *  fail-closed）；ENOENT 是合法契约（旧版 amagi 无该目录=无锚点事实）。 */
  degraded: boolean;
  /** 扫描到的锚点文件数（诊断）。 */
  files: number;
}

/** ENOENT只有在最近既存祖先确为可达目录时才是缺省；悬空link不是无事实。 */
function confirmedMissing(target: string, error: unknown): boolean {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  let current = target;
  while (true) {
    try {
      fs.lstatSync(current);
      return current !== target && fs.statSync(current).isDirectory();
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      try { fs.lstatSync(current); return false; } catch { /* 当前位置确实缺席 */ }
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

const validProcessId = (value: unknown, minimum = 1): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 0x7fffffff;

/**
 * 扫描构建 agentDir 下的 amagi 启动锚点。目录缺席（ENOENT）→ 空且非
 * degraded（无线索 ≠ 读取失败）；其他读取失败（ENOTDIR/EACCES/损坏）→
 * degraded=true，调用方 fail-closed——不能当"无锚点事实"处理（R2-F10-02）。
 */
export function scanLaunchAnchors(homeDir: string): AnchorScanResult {
  const auditsRoot = path.join(homeDir, 'amagi', 'data', 'process-audits');
  const runs: AnchorRun[] = [];
  let untrusted = false;
  let files = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(auditsRoot);
  } catch (error) {
    const degraded = !confirmedMissing(auditsRoot, error);
    return { runs: [], untrusted: false, degraded, files: 0 };
  }
  for (const name of names) {
    const anchorFile = path.join(auditsRoot, name, 'launch-anchor.json');
    let raw: string;
    try {
      raw = fs.readFileSync(anchorFile, 'utf-8');
    } catch (error) {
      // 任务目录无锚点文件（ENOENT）：是否"无派发"由 v2-store 意图扫描判定；
      // 锚点路径在但不可读（EACCES/ENOTDIR/EISDIR 等非 ENOENT）→ 证据不全
      // （untrusted），不能无差别当"无锚点"跳过（R2-F10-02）。
      if (!confirmedMissing(anchorFile, error)) untrusted = true;
      continue;
    }
    files += 1;
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; taskId?: unknown; runs?: unknown; droppedRuns?: unknown };
      if (parsed?.version !== 1 || typeof parsed.taskId !== 'string' || !parsed.taskId || !Array.isArray(parsed.runs)) {
        untrusted = true;
        continue;
      }
      if (parsed.droppedRuns !== undefined && (!Number.isSafeInteger(parsed.droppedRuns) || (parsed.droppedRuns as number) !== 0)) {
        untrusted = true; // 锚点超上限丢 run → 证据不全（amagi launch-anchor.ts 同语义）
      }
      for (const run of parsed.runs) {
        const candidate = run as Partial<AnchorRun>;
        const hasBootId = candidate?.bootId !== undefined;
        const hasBootTime = candidate?.bootTimeMs !== undefined;
        const validBoot = hasBootId === hasBootTime && (!hasBootId
          || (typeof candidate.bootId === 'string'
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.bootId)
            && Number.isSafeInteger(candidate.bootTimeMs) && candidate.bootTimeMs! > 0));
        if (!validProcessId(candidate?.rootPid, 2) || !validProcessId(candidate.leaderPid)
          || !Number.isSafeInteger(candidate.at) || candidate.at! < 0
          || !validBoot
          || (candidate.pgid !== undefined && !validProcessId(candidate.pgid))
          || (candidate.rootIdentityToken !== undefined && (typeof candidate.rootIdentityToken !== 'string' || !candidate.rootIdentityToken))) {
          untrusted = true;
          continue;
        }
        runs.push({
          taskId: parsed.taskId,
          anchorFile,
          rootPid: candidate.rootPid,
          ...(typeof candidate.pgid === 'number' && candidate.pgid > 0 ? { pgid: candidate.pgid } : {}),
          ...(typeof candidate.rootIdentityToken === 'string' && candidate.rootIdentityToken ? { rootIdentityToken: candidate.rootIdentityToken } : {}),
          leaderPid: candidate.leaderPid,
          at: candidate.at!,
          ...(hasBootId ? { bootId: candidate.bootId, bootTimeMs: candidate.bootTimeMs } : {}),
        });
      }
    } catch {
      untrusted = true;
    }
  }
  return { runs, untrusted, degraded: false, files };
}

/** v2-store 活跃执行态（与 amagi cross-session-writers ACTIVE_EXECUTIONS 同集）。 */
const ACTIVE_EXECUTIONS = new Set(['queued', 'running', 'blocked', 'answering']);
/** 冻结amagi2.21.31 contracts/task.ts的封闭枚举，不把未知字符串当终态。 */
const KNOWN_EXECUTIONS = new Set([...ACTIVE_EXECUTIONS, 'done', 'error', 'answered', 'cancelled', 'truncated', 'resolved-external']);
const KNOWN_PROCESS_STATES = new Set(['not-started', 'alive', 'exited', 'unknown']);
const STORE_AUXILIARY_FILES = new Set(['README', 'README.md', 'README.txt', '.DS_Store', '.gitkeep']);

export interface V2StoreScanResult {
  /** 活跃但无锚点覆盖的任务（taskId = v2-store 目录名）。 */
  anchorlessActiveTasks: string[];
  /** v2-store 是否存在任何任务目录（派发意图证据）。 */
  storePresent: boolean;
  /** 任务目录存在但 current.json 不可读/损坏（意图存在、状态不可证）。 */
  unreadableTasks: string[];
  /** v2-store 目录不可枚举（非 ENOENT 读取失败）→ 证据不可得（调用方
 *  fail-closed）；ENOENT 是合法契约（无 v2-store=无派发意图事实）。 */
  degraded: boolean;
  /** Native initial queue records prove no launch was ever granted. */
  unstartedTasks?: string[];
}

/**
 * v2-store 派发意图扫描：任务记录先于 spawn 写入。活跃任务必须被锚点覆盖
 * （锚点在 spawn 后同步追加）；无锚点覆盖 = spawn→锚点窗口硬崩或旧版 amagi
 * ——个体不可发现，只能按未确认上报，不得当无残留。
 */
export function scanV2StoreIntents(homeDir: string, anchoredTaskIds: ReadonlySet<string>, anchorsUntrusted: boolean): V2StoreScanResult {
  const storeRoot = path.join(homeDir, 'amagi', 'v2-store');
  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(storeRoot, { withFileTypes: true });
  } catch (error) {
    // ENOENT=无 v2-store（旧版 amagi/全新 home）→ 无派发意图事实（合法契约）；
    // 其他读取失败（ENOTDIR/EACCES/损坏）→ degraded：不能当"无派发"（R2-F10-02）。
    const degraded = !confirmedMissing(storeRoot, error);
    return { anchorlessActiveTasks: [], storePresent: false, unreadableTasks: [], degraded };
  }
  const anchorlessActiveTasks: string[] = [];
  const unreadableTasks: string[] = [];
  const unstartedTasks: string[] = [];
  let storePresent = false;
  for (const entry of names) {
    const { name } = entry;
    if (!entry.isDirectory()) {
      // sanitizeId产生1..64字符任务键。任务位置的file/link不可无声过滤；
      // 已知辅助文件不是任务，未知合法任务键则保守保留未确认事实。
      if (/^[A-Za-z0-9_-]{1,64}$/.test(name) && !STORE_AUXILIARY_FILES.has(name)) {
        storePresent = true;
        unreadableTasks.push(name);
      }
      continue;
    }
    storePresent = true;
    let current: Record<string, unknown> | null;
    try {
      current = JSON.parse(fs.readFileSync(path.join(storeRoot, name, 'current.json'), 'utf-8')) as Record<string, unknown>;
    } catch {
      current = null;
    }
    if (!current || typeof current.execution !== 'string' || !KNOWN_EXECUTIONS.has(current.execution)
      || typeof current.processState !== 'string' || !KNOWN_PROCESS_STATES.has(current.processState)) {
      // 任务目录存在但状态不可读：派发意图在，退出不可证
      unreadableTasks.push(name);
      continue;
    }
    const exitedProcess = current.processState === 'exited';
    if (exitedProcess) continue; // 运行实体已由 amagi 登记退出（意图活跃但无进程）
    // amagi's native v1 contract persists grant-start + launchIntent before
    // spawning. Only its complete initial record (seq=1, revision=0) proves an
    // unexecuted queue item; a bare/legacy "not-started" flag proves nothing.
    if (!anchorsUntrusted && current.version === 1 && current.taskId === name && current.specId === name
      && typeof current.ownerId === 'string' && current.ownerId.length > 0
      && current.stateSeq === 1 && current.revision === 0
      && current.execution === 'queued' && current.processState === 'not-started'
      && typeof current.queuedAt === 'number' && Number.isFinite(current.queuedAt) && current.queuedAt > 0
      && current.launchIntent === undefined) {
      unstartedTasks.push(name);
      continue;
    }
    // done/error/truncated等业务终态不代替物理退出；not-started也覆盖
    // grant-start→started记账的微窗口。无独立未派发证明时保持unknown。
    if (!anchoredTaskIds.has(name) || anchorsUntrusted) {
      anchorlessActiveTasks.push(name);
    }
  }
  return { anchorlessActiveTasks, storePresent, unreadableTasks, degraded: false,
    ...(unstartedTasks.length ? { unstartedTasks } : {}) };
}

/**
 * 枚举构建全部 agentDir home（F10-R3 跨 epoch 对账用）：
 * `<buildRoot>/epochs/e<N>/home`（存在者，按 epoch 序）+ legacy `<buildRoot>/home`。
 * rebuild 换 epoch 只是把新运行挪进新目录，旧 epoch 的锚点/v2-store 仍是
 * 残留证据源——对账不得因换目录而绕过旧 epoch。目录读取失败（权限/损坏，
 * 非 ENOENT）→ degraded=true：旧运行事实不可枚举不能当没有（调用方
 * fail-closed）。
 */
export function listBuildHomeDirs(buildRoot: string): { homes: string[]; degraded: boolean } {
  const homes: string[] = [];
  let degraded = false;
  const epochsRoot = path.join(buildRoot, 'epochs');
  let epochNames: string[] = [];
  try {
    epochNames = fs.readdirSync(epochsRoot).sort();
  } catch (error) {
    // ENOENT=无 epochs 目录（legacy 布局或全新构建）；其他错误（权限/损坏）
    // 不能当没旧事实 → degraded（调用方 fail-closed）。
    if (!confirmedMissing(epochsRoot, error)) degraded = true;
  }
  for (const name of epochNames) {
    if (!/^e[1-9][0-9]*$/.test(name)) continue;
    const home = path.join(epochsRoot, name, 'home');
    try {
      if (fs.statSync(home).isDirectory()) homes.push(home);
      else degraded = true;
    } catch (error) {
      if (!confirmedMissing(home, error)) degraded = true;
    }
  }
  const legacy = path.join(buildRoot, 'home');
  try {
    if (fs.statSync(legacy).isDirectory()) homes.push(legacy);
    else degraded = true;
  } catch (error) {
    if (!confirmedMissing(legacy, error)) degraded = true;
  }
  return { homes, degraded };
}

/**
 * 账本未收口 Leader 存活检测（F10-R3 steer 调整 #1：binding 未落盘但账本
 * 有事实的窗口，新 launch 前必须先对账——且旧 Leader 可能**仍存活**，其
 * 子任务不是残留，绝不能在它运行中回收）。只检测不发信号：
 * - 存活且 birthToken 匹配 → ours（阻断新 Leader）；
 * - 存活但 birthToken 不匹配（且探针可得）→ pid 已被无关进程复用，不计；
 * - 存活但探针失效（fresh undefined）→ 探针失效 ≠ 不是本 run：unprovable
 *   保守阻断；
 * - 存活但无令牌可比 → unprovable（不能排除是我们的 Leader，保守阻断）；
 * - 不存活 → 已退出（交常规残留对账）。
 */
export async function findAliveLedgerLeaders(
  buildRoot: string,
  deps: ResidualDeps = {},
): Promise<Array<{ pid: number; launchId: string; evidence: 'birth-token' | 'unprovable' }>> {
  const ledger = readProcessLedger(buildRoot);
  const candidates = ledger.entries.filter((entry) =>
    entry.kind === 'leader' && Number.isInteger(entry.pid) && entry.pid > 1 && !entry.endedAt && !entry.exit);
  if (candidates.length === 0) return [];
  const alive: Array<{ pid: number; launchId: string; evidence: 'birth-token' | 'unprovable' }> = [];
  const isAlive = deps.isAlive ?? ((pid: number) => {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  });
  for (const entry of candidates) {
    if (!isAlive(entry.pid)) continue;
    if (entry.birthToken) {
      const tokens = await readBirthIdentities([entry.pid], deps);
      const fresh = tokens.get(entry.pid);
      if (fresh === undefined) {
        // 探针失效 ≠ 不是本 run：存活且无法排除 → unprovable 保守阻断
        alive.push({ pid: entry.pid, launchId: entry.launchId, evidence: 'unprovable' });
        continue;
      }
      if (fresh !== entry.birthToken) continue; // 令牌不匹配 → pid 复用，不是我们的 Leader
      alive.push({ pid: entry.pid, launchId: entry.launchId, evidence: 'birth-token' });
    } else {
      alive.push({ pid: entry.pid, launchId: entry.launchId, evidence: 'unprovable' });
    }
  }
  return alive;
}

export interface ResidualDeps extends ProcessIdentityDeps {
  /** 可选 identity-bound 信号出口：测试注入的原子出口（模拟，不代表生产
  * 能力）或桥接到调用方当前持有的自有 ChildProcess 句柄（真实 own handle）。
  * 生产**不注入**（历史/仅数字 PID 目标无稳定引用 → 零信号 unconfirmed，
  * 裁决 #5）；缺省无 process.kill 默认实现。 */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** 存活探测（退出确认用；缺省 process.kill(pid,0)）。 */
  isAlive?: (pid: number) => boolean;
  /** 等待（测试注入假时钟）。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  reapGraceMs?: number;
}

export interface ReconcileInput {
  /** 构建 agentDir（锚点/v2-store 扫描根）。 */
  homeDir: string;
  /** 构建根（账本位置）。 */
  buildRoot: string;
  /** 本构建历次 Leader pid（账本+binding；锚点按 leaderPid 归属过滤）。 */
  leaderPids: ReadonlySet<number>;
  /** 是否把账本未收口的 Leader 条目也作为回收个体（cancel 用 true；
  * resume 守卫用 false——旧 Leader 存活由专门检查拒绝，不在守卫里杀）。 */
  includeLeaderEntries?: boolean;
}

interface ReapContext {
  /** 可选的 identity-bound 信号出口（测试注入或自有 ChildProcess 句柄桥接）；
 * 生产缺省为 undefined —— 历史发现/仅数字 PID 目标无稳定引用，零信号。 */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  graceMs: number;
  deps: ResidualDeps;
}

function defaultIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** 组员封存失败原因（发现仅候选，未封存者零信号如实上报）。 */
type MemberUnprovableReason = 'birth-unreadable' | 'membership-sandwich-failed' | 'identity-sandwich-failed' | 'session-premise-unverified';
const UNPROVABLE_MEMBER_DETAIL: Record<MemberUnprovableReason, string> = {
  'birth-unreadable': '组员无法读取自身出生令牌（探测失效）：不可封存也不可证明退出，不杀',
  'membership-sandwich-failed': '组员归属 membership 夹逼失败（第二张进程表已不在同组；pid 可能被组外进程复用或已退出）：不封存、零信号',
  'identity-sandwich-failed': '组员身份夹逼失败（两次 birth 采样不一致；pid 已被另一进程复用）：绝不把后来读到的 birth 当归属，不封存、零信号',
  'session-premise-unverified': '私有 session 前提不可验证（同 PGID 本身不授归属；sid 不可得/不匹配或根非本运行受信实现的 detached 会话）：同组≠同 run，不封存、零信号',
};

/** 组员封存计划（发现→封存的全时序证明见 snapshotGroupMembersWithBirth）。 */
interface MemberSealPlan {
  plan: Array<{ pid: number; token: string }>;
  unprovable: Array<{ pid: number; reason: MemberUnprovableReason }>;
}

/** 现场重采出生令牌并比对的 fresh 证明（每个信号前调用）。 */
async function freshTokenMatch(pid: number, expected: string, deps: ResidualDeps): Promise<boolean> {
  const tokens = await readBirthIdentities([pid], deps);
  const token = tokens.get(pid);
  return token !== undefined && token === expected;
}

/** 单个 pid 的运行身份声称（锚点 run 或账本 Leader 条目；PID 不是身份）。 */
interface PidClaim {
  source: 'anchor' | 'ledger';
  anchor?: AnchorRun;
  ledger?: ProcessLedgerEntry;
}

/**
 * 残留核对。reap=true 时对已证明个体执行回收；任何无法证明的个体不发信号，
 * 并使整体 state=unconfirmed（阻断第二 Leader，换 epoch 也不能绕过）。
 */
export async function reconcileResidualProcesses(
  input: ReconcileInput,
  options: { reap: boolean },
  deps: ResidualDeps = {},
): Promise<TerminationOutcome> {
  const now = deps.now ?? Date.now;
  const at = new Date(now()).toISOString();
  const ctx: ReapContext = {
    kill: deps.kill,
    isAlive: deps.isAlive ?? defaultIsAlive,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); })),
    graceMs: deps.reapGraceMs ?? DEFAULT_CHILD_REAP_GRACE_MS,
    deps,
  };
  const findings: ChildProcessFinding[] = [];

  const anchors = scanLaunchAnchors(input.homeDir);
  const ledger = readProcessLedger(input.buildRoot);

  // ── 证据面完整性（R2-F10-02）：读取失败 ≠ 无事实 ──
  // 内层 scanner 的非 ENOENT 失败（目录不可枚举/锚点文件不可读/账本损坏）
  // 与锚点证据不全（untrusted）都直接进入未确认面并决定总体 state（贯穿
  // shutdown 等消费者）；不能只在 note 里声明不可信却维持 confirmed。
  if (anchors.degraded) {
    findings.push({
      taskId: null, pid: 0, source: 'anchor', verdict: 'unconfirmed', proof: 'none',
      detail: '锚点目录（amagi/data/process-audits）不可枚举（非 ENOENT 读取失败）：本 home 的派发事实不可得，不能证明无残留',
    });
  }
  if (ledger.degraded) {
    findings.push({
      taskId: null, pid: 0, source: 'ledger', verdict: 'unconfirmed', proof: 'none',
      detail: '进程账本不可读（degraded）：Leader 归属事实不可得，不能证明无残留',
    });
  }
  if (anchors.untrusted) {
    findings.push({
      taskId: null, pid: 0, source: 'anchor', verdict: 'unconfirmed', proof: 'none',
      detail: '锚点证据不全（损坏/形状非法/超上限截断/锚点文件不可读）：被丢弃的 run 不可枚举，不能证明无残留',
    });
  }

  // ── 锚点归属分区（R2-F10-01）：锚点读取成功 ≠ 已匹配构建归属 ──
  // 登记集（leaderPids，来自 binding+账本）非空：匹配 run 进个体对账；不匹配
  // run 绝不既充当 v2-store「已覆盖」又被无声丢弃，也绝不纳入可信号集合
  // ——逐 run 如实 unconfirmed（归属不明，不进对账）。登记集为空（binding
  // 不可得且账本无 Leader 事实）：build home 是构建私有目录，锚点即本构建
  // 可见运行事实——全部进入逐个体对账（真实探测 root），不能因过滤后空
  // 集合直接 confirmed。
  const registryAvailable = input.leaderPids.size > 0;
  const reconciledRuns: AnchorRun[] = [];
  for (const run of anchors.runs) {
    if (registryAvailable && !input.leaderPids.has(run.leaderPid)) {
      findings.push({
        taskId: run.taskId, pid: run.rootPid, source: 'anchor', verdict: 'unconfirmed', proof: 'none',
        detail: `锚点 run（root=${run.rootPid}）的 leaderPid=${run.leaderPid} 不在本构建 Leader 登记集（账本/binding 可得但无此 Leader）：归属不明（登记缺失或外来写入），不纳入对账与信号集合，如实未确认`,
      });
      continue;
    }
    reconciledRuns.push(run);
  }
  const anchoredTaskIds = new Set(reconciledRuns.map((run) => run.taskId.replace(/[^a-zA-Z0-9_-]/g, '_')));
  const v2store = scanV2StoreIntents(input.homeDir, anchoredTaskIds, anchors.untrusted);
  if (v2store.degraded) {
    findings.push({
      taskId: null, pid: 0, source: 'v2-store', verdict: 'unconfirmed', proof: 'none',
      detail: 'v2-store 目录（amagi/v2-store）不可枚举（非 ENOENT 读取失败）：派发意图事实不可得，不能证明无派发即无残留',
    });
  }
  // 证据缺口摘要（进入所有返回路径的 note，含进程表不可得的早退——
  // degraded 不能只在某一条路径可见）。
  const evidenceGaps = [
    anchors.degraded ? '锚点目录不可枚举（degraded）' : null,
    ledger.degraded ? '进程账本不可读（degraded）' : null,
    v2store.degraded ? 'v2-store 目录不可枚举（degraded）' : null,
    anchors.untrusted ? '锚点证据不全（损坏/截断/锚点文件不可读）' : null,
  ].filter((item): item is string => item !== null);
  const gapsPrefix = evidenceGaps.length > 0 ? `${evidenceGaps.join('；')}；` : '';

  // v2-store 意图缺口（spawn→锚点窗口/旧版 amagi/锚点截断）：不可发现即不可证明
  for (const taskId of v2store.anchorlessActiveTasks) {
    findings.push({
      taskId, pid: 0, source: 'v2-store', verdict: 'unconfirmed', proof: 'none',
      detail: 'v2-store 活跃任务无锚点覆盖（spawn→锚点写入窗口硬崩、旧版 amagi 或锚点截断）：个体不可发现，不能证明无残留',
    });
  }
  for (const taskId of v2store.unreadableTasks) {
    findings.push({
      taskId, pid: 0, source: 'v2-store', verdict: 'unconfirmed', proof: 'none',
      detail: 'v2-store 任务状态不可读（派发意图存在，退出不可证）',
    });
  }

  // 个体集合（R2-F10-01 追加轮：PID 不是运行身份——同 pid 的多份运行声称
  // 全部保留，绝不静默挑一份消除可见事实；仅「完全重复」（锚点：同任务+
  // 同出生令牌；账本：同 launchId）可去重）。归属已分区的锚点 run + 账本
  // 未收口 leader 条目。
  const claimsByPid = new Map<number, PidClaim[]>();
  for (const run of reconciledRuns) {
    const claims = claimsByPid.get(run.rootPid) ?? [];
    const duplicate = claims.some((claim) => claim.source === 'anchor' && claim.anchor
      && claim.anchor.taskId === run.taskId
      && claim.anchor.leaderPid === run.leaderPid
      && claim.anchor.pgid === run.pgid
      && claim.anchor.bootId === run.bootId && claim.anchor.bootTimeMs === run.bootTimeMs
      && (claim.anchor.rootIdentityToken ?? null) === (run.rootIdentityToken ?? null));
    if (!duplicate) claims.push({ source: 'anchor', anchor: run });
    claimsByPid.set(run.rootPid, claims);
  }
  for (const entry of ledger.entries) {
    if (entry.kind !== 'leader' || !Number.isInteger(entry.pid) || entry.pid <= 1) continue;
    if (!input.includeLeaderEntries) continue;
    if (entry.endedAt || entry.exit) continue; // 已登记退出的 Leader 不重复对账
    const claims = claimsByPid.get(entry.pid) ?? [];
    const duplicate = claims.some((claim) => claim.source === 'ledger'
      && claim.ledger?.launchId === entry.launchId
      && claim.ledger.birthToken === entry.birthToken
      && claim.ledger.buildId === entry.buildId
      && claim.ledger.runtimeEpoch === entry.runtimeEpoch
      && claim.ledger.generation === entry.generation);
    if (!duplicate) claims.push({ source: 'ledger', ledger: entry });
    claimsByPid.set(entry.pid, claims);
  }

  if (claimsByPid.size === 0 && findings.length === 0) {
    return {
      state: 'confirmed', at, leaderExit: null, children: [],
      note: v2store.storePresent
        ? '无未收口个体且 v2-store 活跃任务均有锚点覆盖（全部按个体对账）'
        : '无派发意图（v2-store 无任务）且无锚点——无任务即无子进程可残留',
    };
  }

  const table = await snapshotProcessTable(deps);
  // 已按"根死后同组成员"上报过的成员 pid（多锚点共享同组时去重）。
  const reportedRootDeadMembers = new Set<number>();
  if (table === null) {
    // 进程表不可得：每个个体都无法证明 → 全部 unconfirmed（不猜测；
    // 同 pid 多份声称逐份上报，不静默合并）
    for (const [pid, claimsOfPid] of claimsByPid) {
      for (const individual of claimsOfPid) {
        findings.push({
          taskId: individual.source === 'anchor' ? individual.anchor!.taskId : individual.ledger?.taskId ?? null,
          pid, source: individual.source, verdict: 'unconfirmed', proof: 'none',
          detail: '进程表不可得（ps 失败或平台不支持），无法证明退出或归属',
        });
      }
    }
    const unconfirmed0 = findings.filter((finding) => finding.verdict === 'unconfirmed').length;
    return { state: 'unconfirmed', at, leaderExit: null, children: findings, note: `${gapsPrefix}进程表不可得，${unconfirmed0} 个个体按未确认保留（fail-closed）` };
  }
  const rowOf = new Map<number, ProcTableRow>();
  for (const row of table) rowOf.set(row.pid, row);

  // 只对存活个体探测出生令牌（分类用；此后每个信号前仍会现场重采）
  const tokenCandidates = [...claimsByPid.keys()].filter((pid) => rowOf.has(pid));
  const birthTokens = await readBirthIdentities(tokenCandidates, deps);

  for (const [pid, claims] of claimsByPid) {
    if (claims.length > 1) {
      // ── PID 冲突（去重后仍有多份运行身份声称同 pid）──
      // PID 不是运行身份：不能静默挑一份消除其余可见事实。逐声称按内核
      // 证据裁决（顺序无关）：pid 已死 → 各声称的出生均已结束；pid 存活 →
      // 占用者令牌至多匹配一份（匹配=该 run 进程存活，冲突个体保守零
      // 信号；不匹配=其声称的出生已结束）；令牌缺失/探测失效 → 不可区分
      // → unconfirmed。绝不因冲突假 confirmed。
      const claimTaskId = (claim: PidClaim): string | null =>
        claim.source === 'anchor' ? claim.anchor!.taskId : claim.ledger?.taskId ?? null;
      const conflictRow = rowOf.get(pid);
      if (conflictRow === undefined) {
        // F10-R1 组员检查逐声称 pgid 各自做（同组存活成员是可见事实，去重
        // 上报；冲突不豁免「根死≠后代全退」纪律）。
        const deadMembers: Array<{ claim: PidClaim; member: ProcTableRow; pgid: number }> = [];
        for (const claim of claims) {
          const deadAnchor = claim.source === 'anchor' ? claim.anchor : undefined;
          if (deadAnchor && typeof deadAnchor.pgid === 'number' && deadAnchor.pgid > 0) {
            for (const candidate of table) {
              if (candidate.pgid === deadAnchor.pgid && candidate.pid !== pid && !reportedRootDeadMembers.has(candidate.pid)) {
                reportedRootDeadMembers.add(candidate.pid);
                deadMembers.push({ claim, member: candidate, pgid: deadAnchor.pgid });
              }
            }
          }
        }
        for (const claim of claims) {
          findings.push({
            taskId: claimTaskId(claim), pid, source: claim.source, verdict: 'exited', proof: 'none',
            detail: deadMembers.length > 0
              ? `PID 冲突（去重后 ${claims.length} 份运行身份声称同 pid）：pid 不在进程表，各声称的出生均已结束；但同组仍有 ${deadMembers.length} 个存活成员（见未确认项）`
              : `PID 冲突（去重后 ${claims.length} 份运行身份声称同 pid）：pid 不在进程表，各声称的出生均已结束（对账口径=退出）`,
          });
        }
        for (const entry of deadMembers) {
          findings.push({
            taskId: claimTaskId(entry.claim), pid: entry.member.pid, source: 'anchor', verdict: 'unconfirmed', proof: 'none',
            detail: `根已退出（PID 冲突多声称之一，pgid=${entry.pgid}）但同组成员仍存活：根死亡后无法建立成员归属时序证明，零信号、如实阻断`,
          });
        }
        continue;
      }
      const freshOccupant = birthTokens.get(pid);
      for (const claim of claims) {
        const claimedToken = claim.source === 'anchor' ? claim.anchor?.rootIdentityToken : claim.ledger?.birthToken;
        if (claimedToken && freshOccupant !== undefined && claimedToken === freshOccupant) {
          findings.push({
            taskId: claimTaskId(claim), pid, source: claim.source, verdict: 'unconfirmed', proof: 'birth-token',
            detail: `PID 冲突（去重后 ${claims.length} 份运行身份声称同 pid）：当前占用者出生令牌与该声称匹配（即该 run 的进程存活），冲突个体保守零信号、不纳入回收`,
          });
        } else if (claimedToken && freshOccupant !== undefined) {
          findings.push({
            taskId: claimTaskId(claim), pid, source: claim.source, verdict: 'exited', proof: 'none',
            detail: 'PID 冲突：该声称的出生令牌与当前占用者不一致——声称的进程已结束（pid 现由另一出生占用，可能为同构建新 run 或无关复用）',
          });
        } else if (claimedToken) {
          findings.push({
            taskId: claimTaskId(claim), pid, source: claim.source, verdict: 'unconfirmed', proof: 'none',
            detail: 'PID 冲突 + 当前占用者令牌探测失效：无法区分哪份声称对应存活占用者，保守未确认（零信号）',
          });
        } else {
          findings.push({
            taskId: claimTaskId(claim), pid, source: claim.source, verdict: 'unconfirmed', proof: 'none',
            detail: 'PID 冲突 + 该声称无出生令牌：不能排除存活占用者即此声称（PID 不是运行身份），保守未确认（零信号）',
          });
        }
      }
      continue;
    }
    const individual = claims[0];
    const taskId = individual.source === 'anchor' ? individual.anchor!.taskId : individual.ledger?.taskId ?? null;
    const row = rowOf.get(pid);
    if (row === undefined) {
      // F10-R1：根 pid 不在进程表 ≠ 该任务全部后代已退出——同 pgid 的桥/孙
      // 进程可能仍活（普通同组遗留即可复现，无需 setsid 逃逸）。根已死 →
      // 无法建立"根存活期枚举"的成员归属时序 → 存活组员归属不可证明：
      // 逐个如实上报 unconfirmed（零信号，绝不按 PGID 降级杀），整体因此
      // unconfirmed 并阻断新 Leader；全部组员也已退出才保持 exited/confirmed。
      const deadRootAnchor = individual.source === 'anchor' ? individual.anchor : undefined;
      if (deadRootAnchor && typeof deadRootAnchor.pgid === 'number' && deadRootAnchor.pgid > 0) {
        const members = table.filter(
          (candidate) => candidate.pgid === deadRootAnchor.pgid && candidate.pid !== pid && !reportedRootDeadMembers.has(candidate.pid),
        );
        for (const member of members) reportedRootDeadMembers.add(member.pid);
        if (members.length > 0) {
          findings.push({
            taskId, pid, source: individual.source, verdict: 'exited', proof: 'none',
            detail: `pid 不在进程表（根已退出）；但同组（pgid=${deadRootAnchor.pgid}）仍有 ${members.length} 个存活成员（见未确认项），不能据此宣布任务后代全退`,
          });
          for (const member of members) {
            findings.push({
              taskId, pid: member.pid, source: 'anchor', verdict: 'unconfirmed', proof: 'none',
              detail: `根已退出但同组（pgid=${deadRootAnchor.pgid}）成员仍存活：根死亡后无法建立成员归属时序证明（不按 PGID 降级杀），零信号、如实阻断`,
            });
          }
          continue;
        }
      }
      findings.push({
        taskId, pid, source: individual.source, verdict: 'exited', proof: 'none',
        detail: 'pid 不在进程表（已退出；对账口径=退出）',
      });
      continue;
    }
    const anchor = individual.source === 'anchor' ? individual.anchor : undefined;
    const expectedToken = anchor ? anchor.rootIdentityToken : individual.ledger?.birthToken;
    // 分类快照：令牌不匹配（pid 已被复用）→ not-ours（绝不发信号；
    // 匹配与否的最终执法仍以每个信号前的 fresh 重采为准）
    if (expectedToken && birthTokens.get(pid) !== undefined && birthTokens.get(pid) !== expectedToken) {
      findings.push({
        taskId, pid, source: individual.source, verdict: 'not-ours', proof: 'birth-token',
        detail: `出生令牌不匹配（期望 ${expectedToken} → 当前 ${birthTokens.get(pid)}）：pid 已被无关进程复用，绝不发信号`,
      });
      continue;
    }
    if (!expectedToken) {
      // 无出生令牌：不采用 pgid/可执行名降级（不是本次启动身份，旧 PID/PGID
      // 可被无关 detached Node 复用）——如实 unconfirmed，不发信号。
      findings.push({
        taskId, pid, source: individual.source, verdict: 'unconfirmed', proof: 'none',
        detail: anchor
          ? '锚点无出生令牌：无法证明该 pid 仍是本任务进程（不按 pgid/可执行名降级），不发信号'
          : '账本 Leader 条目无出生令牌可比对，归属无法证明，不发信号',
      });
      continue;
    }
    if (!options.reap) {
      findings.push({
        taskId, pid, source: individual.source, verdict: 'unconfirmed', proof: 'birth-token',
        detail: '归属可证（出生令牌在案）但本次为观察模式，个体仍存活',
      });
      continue;
    }
    // ── 回收（个体级信号；每个信号前 fresh 证明）──
    // F10-R2：组员发现/取样必须与根当时的出生归属组成有效时序证明——
    // snapshotGroupMembersWithBirth 在枚举前后都以根令牌 fresh 复核，任一端
    // 失败（根退出/换人/探测失效）→ memberPlan 整份作废，绝不消费未经归属
    // 证明的成员计划。根 fresh 失败与成员回收互不遮蔽：根零信号 + 计划
    // unavailable 各自如实上报。
    const reverifyRoot = (target: number) => freshTokenMatch(target, expectedToken, deps);
    // 组员封存：在根个体仍可证明存活时按双夹逼+session 前提封存同组成员
    //（只影响归属报告与（有能力时的）回收名单；不构成发信号许可）。
    let memberPlan: MemberSealPlan | { unavailable: string } | null = null;
    if (anchor && typeof anchor.pgid === 'number' && anchor.pgid === anchor.rootPid) {
      memberPlan = await snapshotGroupMembersWithBirth(anchor.pgid, pid, reverifyRoot, ctx);
    }
    // 裁决 #5：生产（未注入 identity-bound 出口）对历史发现/仅数字 PID 目标
    // **零信号**——归属可证且存活 → 如实 unconfirmed（等自有句柄路径或自然
    // 退出/人工处理）。有注入出口时才走逐信号 fresh 复核的回收。
    if (!ctx.kill) {
      findings.push({
        taskId, pid, source: individual.source, verdict: 'unconfirmed', proof: 'birth-token',
        detail: '归属可证（出生令牌在案）且个体存活，但本层无稳定自有引用：不按历史 PID 发信号；交由上层撤销旧写入资格并扫描构建专属进程范围后自动回收',
      });
    } else {
      const ok = await reapIndividual(pid, ctx, reverifyRoot);
      findings.push({
        taskId, pid, source: individual.source, verdict: ok ? 'reaped' : 'unconfirmed', proof: 'birth-token',
        detail: ok
          ? '（注入的 identity-bound 出口/自有句柄桥接）每个信号前 fresh 令牌复核通过后按 TERM→宽限→复核→KILL 回收，退出已确认——非生产默认能力'
          : '回收未确认（首信号前或 KILL 前身份复核失败/退出未观察），未发或仅发已证明信号',
      });
    }
    if (memberPlan) {
      findings.push(...await reapRecordedMembers(memberPlan, anchor ? anchor.taskId : taskId, ctx));
    }
  }

  const unconfirmed = findings.filter((finding) => finding.verdict === 'unconfirmed');
  const note = `${gapsPrefix}${
    unconfirmed.length > 0
      ? `存在 ${unconfirmed.length} 个未确认项（含 pid 未知项），阻断新 Leader`
      : '全部已知个体已证明退出或排除归属'}`;
  return {
    state: unconfirmed.length > 0 ? 'unconfirmed' : 'confirmed',
    at,
    leaderExit: null, // Leader 自身退出事实由 adapter 层合并（rpc.getExitInfo）
    children: findings,
    note,
  };
}

/**
 * 回收单个已证明个体（仅在调用方注入 identity-bound 出口/自有句柄桥接时
 * 可达；生产缺省 ctx.kill 为空 → 直接 unconfirmed 零信号）。
 * **每个信号前 fresh 复核身份证明**（首 TERM 亦然——分类快照在多个体
 * 回收过程中会陈旧）。首信号前复核失败 → 零信号；TERM 后复核失败
 * （身份变化/探测失效）→ 停手不发 KILL，交上层记 unconfirmed。
 */
async function reapIndividual(
  pid: number,
  ctx: ReapContext,
  reverify: (pid: number) => Promise<boolean>,
): Promise<boolean> {
  if (!ctx.kill) return false; // 无 identity-bound 出口（生产缺省）→ 零信号
  if (!(await reverify(pid))) return false; // 首信号前 fresh 证明（失败=零信号）
  ctx.kill(pid, 'SIGTERM');
  await ctx.sleep(ctx.graceMs);
  if (!ctx.isAlive(pid)) return true;
  if (!(await reverify(pid))) return false; // KILL 前 fresh 证明（pid 换人则停手）
  ctx.kill(pid, 'SIGKILL');
  await ctx.sleep(Math.min(ctx.graceMs, 1_000));
  return !ctx.isAlive(pid);
}

/**
 * 组员封存：根个体仍可证明存活时，按裁决采纳的时序 R0→M0→C0→M1→M2→C1→R1
 * 取得封存证明（发现仅候选、封存才可信号）：
 * 1. R0：根出生令牌 fresh 复核（枚举前）——根不是本次启动身份则整份作废；
 * 2. M0：首张发现表——**仅产生候选 pid**，不参与归属连续性证明（不把 M0
 *    反向当身份连续证明：M0 里见过不等于属于本次运行）；
 * 3. C0：读各候选自身 birth；
 * 4. M1、M2：C0 之后的**两张** membership 快照，候选 pid 须在两张中都仍在
 *    同 pgid 组内（同组/私有 session 前提同时核验）——membership 证据整体
 *    落在身份区间 [C0, C1] 内；
 * 5. C1：再读同 pid birth 须与 C0 一致（身份夹逼包住 M1/M2）——不能把
 *    「ps 里见过」与「后来读到的 birth」两个不同时点的各自 fresh 拼成归属；
 * 6. R1：根 fresh 复核（枚举后）——根在两个端点都持锚点令牌即枚举窗口内
 *    未换人，组归属随根证明成立。
 * 任一步失败：该成员不封存（unprovable 如实上报，零信号；M0-only 出现/
 *    消失不算连续）；根端点失败 → 整份计划作废（unavailable）。封存后的
 * 成员信号前仍逐个 fresh 复核其自身 birth（既有纪律不变）。C0 时已自然
 * 退出的候选静默跳过。
 */
async function snapshotGroupMembersWithBirth(
  pgid: number,
  rootPid: number,
  reverifyRoot: (pid: number) => Promise<boolean>,
  ctx: ReapContext,
): Promise<MemberSealPlan | { unavailable: string }> {
  if (!(await reverifyRoot(rootPid))) {
    return { unavailable: `组 ${pgid} 成员枚举前根归属 fresh 复核失败（根已退出/换人/探测失效）：枚举到的组员无法证明属于本次运行，成员计划作废、零信号` };
  }
  let members: ProcTableRow[];
  let membershipOne: ProcTableRow[];
  let membershipTwo: ProcTableRow[];
  try {
    // M0：首张发现表——仅候选 pid（发现不授归属）
    const discovery = await snapshotProcessTable(ctx.deps);
    if (!discovery) return { unavailable: `组 ${pgid} 成员枚举不可得（进程表不可用），孙进程/桥可能未回收` };
    members = discovery.filter((row) => row.pgid === pgid && row.pid !== rootPid);
    // C0：候选身份首次采样
    const birthA = new Map<number, string>();
    for (const member of members) {
      if (!ctx.isAlive(member.pid)) continue;
      const tokens = await readBirthIdentities([member.pid], ctx.deps);
      const token = tokens.get(member.pid);
      if (token === undefined) continue; // 无法读自身 birth → 不进入封存名单
      birthA.set(member.pid, token);
    }
    // M1/M2：C0 之后的两张 membership 快照（身份区间内的组内连续存在证明）
    const first = await snapshotProcessTable(ctx.deps);
    if (!first) return { unavailable: `组 ${pgid} membership 夹逼第一快照不可得（进程表失败），孙进程/桥可能未回收` };
    membershipOne = first;
    const second = await snapshotProcessTable(ctx.deps);
    if (!second) return { unavailable: `组 ${pgid} membership 夹逼第二快照不可得（进程表失败），孙进程/桥可能未回收` };
    membershipTwo = second;
    // ── 私有 session 前提（同 PGID 本身不授归属，裁决：同组≠同 run）──
    // linux：readProcessGroups 返回真实 sid → 要求根 sid===rootPid（根是新
    // session leader）且成员 sid===rootPid（同 session）；darwin 无 sid 字段
    // （实测）→ 依据固定启动实现前提（amagi 2.21.31 pin + 内容哈希逐次核验
    // 的 detached spawn 语义：任务根 setsid，pgid===rootPid），前提校验退为
    // 根/成员 pgid 与 ps 两张快照一致（ps 已有 M1/M2；groups 探测再证一次根
    // 的组长身份）。sid 数据存在但不匹配 / 根非组长 → 前提失败，全部成员
    // 不封存（零信号）。
    const groups = await readProcessGroups([rootPid, ...birthA.keys()], ctx.deps);
    const rootGroup = groups.get(rootPid);
    const sidEvidence = rootGroup?.sid !== undefined;
    let sessionPremiseOk: boolean;
    if (rootGroup === undefined) {
      // 根的组身份探测不可得：ps 仍可证组长（M1/M2 行 pgid===pgid）时按固定
      // 实现前提放行（darwin 正常路径依赖此回退）；ps 也不可证则无从谈起。
      sessionPremiseOk = membershipOne.some((row) => row.pid === rootPid && row.pgid === pgid)
        || membershipTwo.some((row) => row.pid === rootPid && row.pgid === pgid);
    } else if (sidEvidence) {
      sessionPremiseOk = rootGroup.sid === rootPid && rootGroup.pgid === rootPid;
    } else {
      sessionPremiseOk = rootGroup.pgid === rootPid;
    }
    const plan: Array<{ pid: number; token: string }> = [];
    const unprovable: Array<{ pid: number; reason: MemberUnprovableReason }> = [];
    if (!sessionPremiseOk) {
      // 根不是可证的新 session/组长：同组成员与本次运行的联系不成立 → 全部不封存
      for (const pid of birthA.keys()) {
        if (ctx.isAlive(pid)) unprovable.push({ pid, reason: 'session-premise-unverified' });
      }
      return { plan, unprovable };
    }
    for (const [pid, tokenA] of birthA) {
      // M0 仅候选：连续性只认 C0 之后的 M1+M2 双表同组（缺任一即失败——
      // 「M0 里见过、M1 消失、M2 又出现」不构成连续存在，也不反向当证明）。
      const inOne = membershipOne.some((row) => row.pid === pid && row.pgid === pgid);
      const inTwo = membershipTwo.some((row) => row.pid === pid && row.pgid === pgid);
      if (!inOne || !inTwo) {
        // 两张 membership 快照任一缺席：要么已退出/进出不连续，要么 pid 已被
        // 组外进程占用——都无法封存
        if (ctx.isAlive(pid)) unprovable.push({ pid, reason: 'membership-sandwich-failed' });
        continue;
      }
      const tokens = await readBirthIdentities([pid], ctx.deps);
      const tokenB = tokens.get(pid);
      if (tokenB === undefined || tokenB !== tokenA) {
        // 身份夹逼失败：pid 现在是另一个进程（复用）→ 绝不把后来读到的 birth 当归属
        unprovable.push({ pid, reason: 'identity-sandwich-failed' });
        continue;
      }
      if (sidEvidence) {
        const memberGroup = groups.get(pid);
        if (memberGroup?.sid !== rootPid || memberGroup.pgid !== pgid) {
          // 实际 SID 可得时逐成员核 session：同组但不同 session → 不封存
          unprovable.push({ pid, reason: 'session-premise-unverified' });
          continue;
        }
      }
      plan.push({ pid, token: tokenA });
    }
    if (!(await reverifyRoot(rootPid))) {
      return { unavailable: `组 ${pgid} 成员枚举后根归属 fresh 复核失败（枚举窗口内根换人）：预录成员不可信，成员计划作废、零信号` };
    }
    // 未读到 birth 的存活候选（探测失效）同样不封存
    for (const member of members) {
      if (!birthA.has(member.pid) && ctx.isAlive(member.pid)
        && !plan.some((entry) => entry.pid === member.pid)
        && !unprovable.some((entry) => entry.pid === member.pid)) {
        unprovable.push({ pid: member.pid, reason: 'birth-unreadable' });
      }
    }
    return { plan, unprovable };
  } catch {
    return { unavailable: `组 ${pgid} 成员枚举异常，孙进程/桥可能未回收` };
  }
}

/**
 * 处理已封存组员：生产（无注入出口）零信号——封存只产生归属报告
 * （unconfirmed + 时序证明成立说明），不发信号；有注入出口时每个成员
 * 信号前按其**自身出生令牌** fresh 复核（成员 PID 复用 → 令牌不匹配 →
 * not-ours 不发信号）；复核不可得 → unconfirmed 停手。绝不在根死后仅凭
 * "同 pgid 仍存活"补刀。
 */
async function reapRecordedMembers(
  plan: MemberSealPlan | { unavailable: string },
  taskId: string | null,
  ctx: ReapContext,
): Promise<ChildProcessFinding[]> {
  if (!('plan' in plan)) {
    return [{
      taskId, pid: 0, source: 'anchor', verdict: 'unconfirmed', proof: 'none',
      detail: plan.unavailable,
    }];
  }
  const findings: ChildProcessFinding[] = [];
  for (const entry of plan.unprovable) {
    findings.push({
      taskId, pid: entry.pid, source: 'anchor', verdict: 'unconfirmed', proof: 'none',
      detail: UNPROVABLE_MEMBER_DETAIL[entry.reason],
    });
  }
  for (const member of plan.plan) {
    if (!ctx.isAlive(member.pid)) continue; // 快照到信号间已自然退出
    if (!ctx.kill) {
      // 裁决 #5：生产无稳定自有引用，封存组员同样零信号（报告归属即可）
      findings.push({
        taskId, pid: member.pid, source: 'anchor', verdict: 'unconfirmed', proof: 'birth-token',
        detail: '组员归属时序证明成立（双夹逼+session 前提）且存活，但本层无稳定自有引用：交由上层扫描构建专属进程范围后自动回收',
      });
      continue;
    }
    const ok = await reapIndividual(member.pid, ctx, (target) => freshTokenMatch(target, member.token, ctx.deps));
    findings.push({
      taskId, pid: member.pid, source: 'anchor', verdict: ok ? 'reaped' : 'unconfirmed', proof: 'birth-token',
      detail: ok
        ? '（注入的 identity-bound 出口/自有句柄桥接）组员按封存令牌逐信号 fresh 复核后回收，退出已确认——非生产默认能力'
        : '组员身份复核失败（pid 复用或探测失效），未发未证明信号',
    });
  }
  return findings;
}
