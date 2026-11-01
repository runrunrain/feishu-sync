/**
 * build-runtime/process-identity.ts — F10 进程身份探测（最小可实测实现）
 *
 * 目的：残留回收前证明「这个 pid 还是当初那个进程」。裸 pid 在长窗口后可能
 * 已被无关进程复用——只看 pid 存活不构成归属证明。
 *
 * 证明模型（单一身份层，不另造重复身份层）:
 * 1. birth-token：内核出生身份。darwin 用 /usr/bin/python3 + libproc
 *    （PROC_PIDTBSDINFO 的进程启动秒/微秒，与 amagi-pi 2.21.31
 *    process-audit.ts DARWIN_BIRTH_PROBE 同源同格式 `darwin:<sec>:<usec>`，
 *    可直接与 amagi 启动锚点 rootIdentityToken 比对）；linux 用
 *    /proc/<pid>/stat 第 22 列 starttime + boot_id（`linux:<boot>:<start>`，
 *    boot_id 已含于令牌，不另建第二身份层）。
 *    连续两次采样一致才采信（防采样瞬间进程退出/pid 换人）。
 * 2. pgid（进程组归属线索，**不是回收证明**）：amagi 派发 detached:true 时
 *    pgid===rootPid，同 pgid 用于发现组员候选与归属时序夹逼（见
 *    process-residual.ts F10-R1/R2）；旧版曾把「POSIX 组长 pid 存续期间
 *    不被复用」作为缺 birth 令牌时的次级回收证明（pgid-invariant），该
 *    降级路径已删除——组长存活不证明该 pid 就是本次启动身份，绝不凭
 *    pgid/可执行名发信号。contracts/ledger 的 proof 联合类型保留
 *    'pgid-invariant' 仅为历史持久化记录兼容，现行代码不再产生该值。
 * 3. 进程组身份（pgid/sid，readProcessGroups）：封存组员前的**私有 session
 *    前提**验证用——同 PGID 本身不授归属（裁决：同组≠同 run）。linux 从
 *    /proc/<pid>/stat 读真实 session（sid）与 pgrp；darwin 经 libproc
 *    PROC_PIDTBSDINFO 只能读 pgid（实测无 sid 字段，word[25]=pgid），实际
 *    SID 不可得 → 按「固定启动实现」前提：amagi-pi 2.21.31（pin + 内容
 *    哈希逐次核验）任务根固定 detached spawn（setsid，pgid===rootPid）。
 *    前提不可验证（探测失效/sid 不匹配）→ 不封存、零信号。
 *
 * 能力边界（如实）：
 * - Windows 无 ps/libproc/procfs → 全部探测不可用，返回空结果；调用方对
 *   无法证明的个体只能 unconfirmed，绝不发信号（不是沙箱，是能力诚实）。
 * - python3 缺失（未装 CLT）→ darwin 出生令牌不可得 → 同上降级。
 * - 本模块只读探测 + 可注入信号出口；不做任务状态调度。
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** ps 进程表行（POSIX；etime 秒粒度；comm 为可执行名）。 */
export interface ProcTableRow {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  /** 已运行秒数（ps etime；不可解析时缺省）。 */
  elapsedSec?: number;
  /** 可执行名（不含参数；诊断与指纹用）。 */
  comm?: string;
}

export type ProbePlatform = NodeJS.Platform;

export interface ProcessIdentityDeps {
  platform?: ProbePlatform;
  /** ps 全表（缺省 POSIX `ps -axo pid=,ppid=,pgid=,uid=,etime=,comm=`；测试注入）。 */
  runPs?: () => Promise<string | null>;
  /** 出生令牌原始探测（缺省 darwin/linux 实现；测试注入）。 */
  probeBirthTokens?: (pids: readonly number[]) => Promise<Map<number, string>>;
  /** 进程组身份探测（pgid/sid；缺省 linux /proc、darwin libproc；测试注入）。
 *  darwin 无 sid（实测）→ 返回 sid 为 undefined，调用方按固定实现前提或
 *  不封存处理；探测不可用 → 该 pid 无条目（fail-closed）。 */
  probeProcessGroups?: (pids: readonly number[]) => Promise<Map<number, { pgid: number; sid?: number }>>;
  execFileImpl?: (file: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
  readFileSyncImpl?: (file: string) => string;
}

/** 与 amagi launch-anchor 身份令牌同格式（darwin:sec:usec / linux:boot:start）。 */
export type BirthToken = string;

const PS_TIMEOUT_MS = 5_000;
const BIRTH_TIMEOUT_MS = 2_000;

function defaultExecFile(file: string, args: string[], opts: { timeout: number; maxBuffer: number }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout, maxBuffer: opts.maxBuffer, encoding: 'utf-8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout) });
    });
  });
}

function parseEtime(text: string): number | undefined {
  const match = text.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600 + Number(match[3]) * 60 + Number(match[4]);
}

/** 解析 ps 表输出（LC_ALL=C 稳定列序）。 */
export function parsePsTable(output: string): ProcTableRow[] {
  const rows: ProcTableRow[] = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const elapsedSec = parseEtime(match[5]);
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      uid: Number(match[4]),
      ...(elapsedSec !== undefined ? { elapsedSec } : {}),
      ...(match[6] ? { comm: match[6] } : {}),
    });
  }
  return rows;
}

/** 全量进程表快照（POSIX）。不可用 → null（不猜测）。 */
export async function snapshotProcessTable(deps: ProcessIdentityDeps = {}): Promise<ProcTableRow[] | null> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return null;
  const runPs = deps.runPs ?? (async (): Promise<string | null> => {
    try {
      const { stdout } = await (deps.execFileImpl ?? defaultExecFile)(
        'ps', ['-axo', 'pid=,ppid=,pgid=,uid=,etime=,comm='],
        { timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      );
      return stdout;
    } catch {
      return null;
    }
  });
  const raw = await runPs();
  if (raw === null) return null;
  const rows = parsePsTable(raw);
  // 空表不可信（ps 至少能看到自身）
  return rows.length > 0 ? rows : null;
}

/** 与 amagi process-audit.ts DARWIN_BIRTH_PROBE 同源（libproc PROC_PIDTBSDINFO）。 */
const DARWIN_BIRTH_PROBE = `import ctypes,json,sys
class B(ctypes.Structure):
 _fields_=[("head",ctypes.c_uint32*12),("comm",ctypes.c_char*16),("name",ctypes.c_char*32),("tail",ctypes.c_uint32*6),("sec",ctypes.c_uint64),("usec",ctypes.c_uint64)]
lib=ctypes.CDLL("/usr/lib/libproc.dylib")
lib.proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]
lib.proc_pidinfo.restype=ctypes.c_int
out=[]
for pid in json.loads(sys.argv[1]):
 b=B()
 if lib.proc_pidinfo(pid,3,0,ctypes.byref(b),ctypes.sizeof(b))==ctypes.sizeof(b) and b.head[3]==pid and b.sec:
  out.append({"pid":pid,"identityToken":"darwin:%s:%s"%(b.sec,b.usec)})
print(json.dumps(out))`;

async function collectBirthTokens(
  pids: readonly number[],
  deps: ProcessIdentityDeps,
  platform: ProbePlatform,
): Promise<Map<number, BirthToken>> {
  const out = new Map<number, BirthToken>();
  const selected = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 1))].slice(0, 16_384);
  if (selected.length === 0) return out;
  try {
    if (platform === 'darwin') {
      const { stdout } = await (deps.execFileImpl ?? defaultExecFile)(
        '/usr/bin/python3', ['-c', DARWIN_BIRTH_PROBE, JSON.stringify(selected)],
        { timeout: BIRTH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout) as Array<{ pid?: unknown; identityToken?: unknown }>;
      for (const row of parsed) {
        if (typeof row.pid === 'number' && typeof row.identityToken === 'string'
          && /^darwin:\d+:\d+$/.test(row.identityToken) && selected.includes(row.pid)) {
          out.set(row.pid, row.identityToken);
        }
      }
    } else if (platform === 'linux') {
      const read = deps.readFileSyncImpl ?? ((file: string) => readFileSync(file, 'utf-8'));
      const boot = read('/proc/sys/kernel/random/boot_id').trim();
      for (const pid of selected) {
        const stat = read(`/proc/${pid}/stat`);
        // 第 22 列 starttime；comm 含空格的括号后第一个字段起算
        const after = stat.slice(stat.lastIndexOf(')') + 2);
        const fields = after.split(' ');
        const startTime = fields[19];
        if (/^\d+$/.test(startTime ?? '')) out.set(pid, `linux:${boot}:${startTime}`);
      }
    }
  } catch {
    // 探测不可用 → 无令牌（调用方降级或 unconfirmed），不猜测
  }
  return out;
}

/**
 * 读取进程组身份（pgid/sid；封存组员的私有 session 前提验证用）。
 * - linux：/proc/<pid>/stat（括号后第 3/4 字段 pgrp/session）→ 真实 sid；
 * - darwin：libproc PROC_PIDTBSDINFO（实测 word[25]=pgid；无 sid 字段）→
 *   sid 恒 undefined，固定实现前提由调用方承担；
 * - 其他平台/探测失败 → 空 Map（能力诚实，不伪验证）。
 * 只读探测，不发信号。
 */
export async function readProcessGroups(
  pids: readonly number[],
  deps: ProcessIdentityDeps = {},
): Promise<Map<number, { pgid: number; sid?: number }>> {
  const platform = deps.platform ?? process.platform;
  const selected = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 1))];
  if (selected.length === 0) return new Map();
  const probe = deps.probeProcessGroups ?? (async (candidates: readonly number[]) => {
    const out = new Map<number, { pgid: number; sid?: number }>();
    try {
      if (platform === 'linux') {
        const read = deps.readFileSyncImpl ?? ((file: string) => readFileSync(file, 'utf-8'));
        for (const pid of candidates) {
          const stat = read(`/proc/${pid}/stat`);
          const after = stat.slice(stat.lastIndexOf(')') + 2);
          const fields = after.split(' ');
          const pgrp = Number(fields[2]);
          const session = Number(fields[3]);
          if (Number.isSafeInteger(pgrp) && pgrp > 0) {
            out.set(pid, Number.isSafeInteger(session) && session > 0 ? { pgid: pgrp, sid: session } : { pgid: pgrp });
          }
        }
      } else if (platform === 'darwin') {
        // 实测：PROC_PIDTBSDINFO 返回 136 字节；word[3]=pid（自校验）、
        // word[25]=pgid；无 sid 字段。与 amagi DARWIN_BIRTH_PROBE 同源工具链。
        const script = `import ctypes,json,sys\nclass B(ctypes.Structure):\n _fields_=[('w',ctypes.c_uint32*34)]\nlib=ctypes.CDLL('/usr/lib/libproc.dylib')\nlib.proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]\nlib.proc_pidinfo.restype=ctypes.c_int\nout=[]\nfor pid in json.loads(sys.argv[1]):\n b=B()\n if lib.proc_pidinfo(pid,3,0,ctypes.byref(b),ctypes.sizeof(b))==ctypes.sizeof(b) and b.w[3]==pid and b.w[25]>0:\n  out.append({'pid':pid,'pgid':b.w[25]})\nprint(json.dumps(out))`;
        const { stdout } = await (deps.execFileImpl ?? defaultExecFile)(
          '/usr/bin/python3', ['-c', script, JSON.stringify(selected)],
          { timeout: PS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout) as Array<{ pid?: unknown; pgid?: unknown }>;
        for (const row of parsed) {
          if (typeof row.pid === 'number' && typeof row.pgid === 'number' && row.pgid > 0 && selected.includes(row.pid)) {
            out.set(row.pid, { pgid: row.pgid });
          }
        }
      }
    } catch {
      // 探测不可用 → 空结果（调用方按 fail-closed 处理），不伪验证
    }
    return out;
  });
  return probe(selected);
}

/**
 * 读取内核出生令牌（双采样一致性校验后采信；与 amagi 同款防竞态）。
 * 平台不支持/工具缺失 → 空 Map（能力诚实，不降级为伪证明）。负载下探针
 * 偶发超时 → 空结果时短退避重试（最多 3 次；仍空如实报告不可得）。
 */
export async function readBirthIdentities(
  pids: readonly number[],
  deps: ProcessIdentityDeps = {},
): Promise<Map<number, BirthToken>> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return new Map();
  const probe = deps.probeBirthTokens ?? ((candidates: readonly number[]) => collectBirthTokens(candidates, deps, platform));
  const selected = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 1))];
  if (selected.length === 0) return new Map();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const first = await probe(selected);
    if (first.size === 0) {
      await new Promise((resolve) => { setTimeout(resolve, 150).unref?.(); });
      continue;
    }
    const second = await probe(selected);
    const stable = new Map<number, BirthToken>();
    for (const [pid, token] of first) {
      if (second.get(pid) === token) stable.set(pid, token);
    }
    if (stable.size > 0) return stable;
    await new Promise((resolve) => { setTimeout(resolve, 150).unref?.(); });
  }
  return new Map();
}
