/**
 * CLI 编排层（设计 kb-agent-upgrade §6.1/§6.4，S9）
 *
 * 流程：解析 argv → （必要时）读端点文件 → /api/health 探活 →
 * confirm 预检（destructive/remote_write 无 --yes → 退出码 4，不打扰
 * 服务器）→ POST /api/cli/<command> → 包络输出与退出码映射。
 *
 * 退出码：0 成功 / 1 业务错误 / 2 参数错误 / 3 应用不可达或未开启 /
 * 4 需要确认（--yes）。业务命令只走运行中的 server（U16：无离线直写、
 * 不自动拉起应用）。
 *
 * 本模块无副作用入口（runCli 可单测）；进程侧入口见 main.ts。
 */

import fs from 'node:fs';
import path from 'node:path';
import { OpsArgumentError } from '../ops/command-table.js';
import {
  buildCommandArgs,
  commandListForHelp,
  describeParams,
  evaluateRequestSpecs,
  parseInvocation,
  spacedName,
  UsageError,
} from './args.js';
import {
  CLI_TOKEN_HEADER,
  endpointFilePath,
  httpJson,
  loadEndpoint,
  resolveHome,
} from './client.js';
import { printError, printOk, type CliErrorFace } from './output.js';

const HEALTH_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 120_000;
/** long-poll 命令（auth login complete 等，服务端最长约 12 分钟）。 */
const LONG_POLL_TIMEOUT_MS = 15 * 60_000;

const HINT_ENABLE = '请先启动 feishu-sync 应用，并在 设置 → 应用 → 命令行访问 开启「命令行访问」。';

function usageError(message: string): never {
  throw new UsageError(message);
}

function printTopHelp(): void {
  const lines: string[] = [
    'feishu-sync —— feishu-sync 知识库同步与标准库构建的命令行客户端',
    '',
    '用法：feishu-sync [--home <数据根>] [--json] [--yes] <命令> [参数…]',
    '',
    '全局旗标：',
    '  --home <dir>   数据根（默认 FEISHU_SYNC_HOME，再缺省 ~/.feishu-sync）',
    '  --json         结构化输出（stdout 单个 {ok,data|error} 包络）',
    '  --yes          确认 destructive/remote_write 命令（注入命令表的 confirm 值）',
    '  --help / -h    帮助；--version 版本',
    '',
    '命令（风险级：read 读取 / mutate 修改 / destructive 破坏性 / remote_write 远端写）：',
  ];
  for (const { def, usage } of commandListForHelp()) {
    lines.push(`  feishu-sync ${usage.padEnd(34)} [${def.risk}] ${def.summary}`);
  }
  lines.push('');
  lines.push('示例：');
  lines.push('  feishu-sync status --json');
  lines.push('  feishu-sync config get');
  lines.push('  feishu-sync config set enableNotifications true');
  lines.push('  feishu-sync kb build --full --yes');
  lines.push('  feishu-sync clean orphans           # 预览（dry-run）');
  lines.push('  feishu-sync clean orphans --apply --yes');
  lines.push('');
  lines.push('提示：命令行访问需在应用 设置 → 应用 → 命令行访问 中开启；');
  lines.push(' destructive/remote_write 命令需 --yes 确认，否则退出码 4。');
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printCommandHelp(def: { name: string; summary: string; risk: string; params: Parameters<typeof describeParams>[0]; confirm?: { field: string; value: string } }): void {
  const lines: string[] = [
    `feishu-sync ${spacedName(def.name)} —— ${def.summary}`,
    '',
    `风险级：${def.risk}${def.confirm ? `；执行需 --yes（注入 ${def.confirm.field}=${def.confirm.value}）` : ''}`,
    '',
    '参数：',
    describeParams(def.params),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** 供 main.ts / 单测使用的主入口。 */
export async function runCli(argv: string[]): Promise<number> {
  // --json 先从 argv 裸探（parseInvocation 抛用法错时 catch 分支也要走 json 输出）
  let json = process.env.FEISHU_SYNC_CLI_JSON === '1' || argv.includes('--json');
  try {
    const invocation = parseInvocation(argv);
    json = invocation.flags.json;

    if (invocation.flags.version) {
      process.stdout.write(`feishu-sync CLI v${readVersion()}（Node ${process.version}）\n`);
      return 0;
    }
    if (invocation.flags.help && invocation.helpTarget) {
      printCommandHelp(invocation.helpTarget);
      return 0;
    }
    if (invocation.flags.help || !invocation.command) {
      printTopHelp();
      return invocation.flags.help ? 0 : 2;
    }
    const def = invocation.command;

    // ---- 端点发现 + 探活（退出码 3 语义）----
    const home = resolveHome(invocation.flags.home);
    const loaded = loadEndpoint(home);
    if (!loaded.ok) {
      const code = loaded.code === 'endpoint_invalid' ? 'app_not_running' : loaded.code;
      printError({ code, message: loaded.message }, { json, hint: HINT_ENABLE });
      return 3;
    }
    const { url, cliToken } = loaded.endpoint;
    try {
      const health = await httpJson(`${url}/api/health`, { method: 'GET', timeoutMs: HEALTH_TIMEOUT_MS });
      if (health.status !== 200) usageError(`探活失败：/api/health 返回 ${health.status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printError(
        { code: 'app_not_reachable', message: `应用不可达（${url}）：${message}` },
        { json, hint: `端点文件 ${endpointFilePath(home)} 可能已过期（应用退出后不自动删除）。请启动应用后重试。` },
      );
      return 3;
    }

    // ---- 参数构造（退出码 2 语义）----
    const args = buildCommandArgs(def, invocation.restTokens);

    // ---- confirm 预检（退出码 4 语义；与表内 request 纯函数一致）----
    let specs;
    try {
      specs = evaluateRequestSpecs(def, args);
    } catch (error) {
      if (error instanceof OpsArgumentError) {
        // 表内参数构造错误（禁止路径/形态非法）：保留表内错误码，仍是用法错。
        printError({ code: error.code, message: error.message }, { json, hint: '使用 --help 查看用法。' });
        return 2;
      }
      throw error;
    }
    const confirmRequired = Boolean(def.confirm) && specs.some((spec) => spec.method !== 'GET');
    if (confirmRequired && !invocation.flags.yes) {
      const confirm = def.confirm!;
      printError(
        {
          code: 'confirmation_required',
          message: `命令 ${def.name}（${def.risk}）需要确认后才会执行`,
          details: { field: confirm.field, value: confirm.value },
        },
        {
          json,
          hint: def.name === 'clean.orphans'
            ? '先运行 `feishu-sync clean orphans` 查看预览；确认后追加 --apply --yes 执行。'
            : `确认无误后追加 --yes 重新执行（将注入 ${confirm.field}=${confirm.value}）。`,
        },
      );
      return 4;
    }

    // ---- 执行 ----
    const body: Record<string, unknown> = { args };
    if (confirmRequired && def.confirm) {
      body[def.confirm.field] = def.confirm.value;
    }
    const timeoutMs = def.stream === 'long-poll' ? LONG_POLL_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    let response;
    try {
      response = await httpJson(`${url}/api/cli/${def.name}`, {
        method: 'POST',
        headers: { [CLI_TOKEN_HEADER]: cliToken },
        body: JSON.stringify(body),
        timeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printError(
        { code: 'app_not_reachable', message: `请求失败：${message}` },
        { json, hint: '应用可能在请求期间退出；请确认应用仍在运行后重试。' },
      );
      return 3;
    }

    if (response.status === 401) {
      const face = (response.body as { error?: unknown; message?: unknown } | null) ?? {};
      printError(
        {
          code: typeof face.error === 'string' ? face.error : 'cli_token_invalid',
          message: typeof face.message === 'string' ? face.message : 'CLI 令牌缺失或无效',
          httpStatus: 401,
        },
        { json, hint: HINT_ENABLE },
      );
      return 3;
    }

    const envelope = (response.body ?? {}) as { ok?: unknown; data?: unknown; error?: Partial<CliErrorFace> };
    if (response.status === 200 && envelope.ok === true) {
      printOk(pickConfigPath(def, args, envelope.data), { json, command: def.name, note: configPathNote(def, args, envelope.data) });
      return 0;
    }

    const errorFace: CliErrorFace = {
      code: typeof envelope.error?.code === 'string' ? envelope.error.code : 'upstream_error',
      message: typeof envelope.error?.message === 'string' ? envelope.error.message : `HTTP ${response.status}`,
      httpStatus: response.status,
      details: envelope.error?.details,
    };
    printError(errorFace, { json });
    if (errorFace.code === 'confirmation_required') return 4;
    if (response.status === 400 || ['invalid_args', 'forbidden_path', 'invalid_json', 'unknown_command'].includes(errorFace.code)) return 2;
    return 1;
  } catch (error) {
    if (error instanceof UsageError) {
      printError({ code: 'usage_error', message: error.message }, { json, hint: '使用 --help 查看用法。' });
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    printError({ code: 'internal_error', message }, { json });
    return 1;
  }
}

/** config get <path>：按表内注释做输出裁剪（缺失时不裁剪并提示）。 */
function pickConfigPath(def: { name: string }, args: Record<string, unknown>, data: unknown): unknown {
  if (def.name !== 'config.get' || typeof args.path !== 'string' || !args.path) return data;
  if (data && typeof data === 'object' && args.path in (data as Record<string, unknown>)) {
    return (data as Record<string, unknown>)[args.path];
  }
  return data;
}

function configPathNote(def: { name: string }, args: Record<string, unknown>, data: unknown): string | undefined {
  if (def.name !== 'config.get' || typeof args.path !== 'string' || !args.path) return undefined;
  if (data && typeof data === 'object' && args.path in (data as Record<string, unknown>)) {
    return `（config.get 按 path=${args.path} 裁剪输出；完整配置用 \`feishu-sync config get\`）`;
  }
  return `（配置中不存在路径 ${args.path}，返回完整配置）`;
}

/** 版本号：打包产物（dist/cli/*.cjs）与 tsc 产物上溯两级都到 server 根。 */
function readVersion(): string {
  try {
    if (typeof __filename === 'undefined') return 'unknown';
    const pkgPath = path.join(path.dirname(__filename), '..', '..', 'package.json');
    return String(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}
