/**
 * CLI 编排层（设计 kb-agent-upgrade §6.1/§6.4，S9）
 *
 * 流程：解析 argv → 本地预检（参数构造 → 表内 request 评估 → confirm
 * 预检，退出码 2/4，全部先于端点发现/探活——应用未运行时参数错误与缺
 * --yes 也能就地报错，不依赖服务器）→ 读端点文件 → /api/health 探活
 * （退出码 3）→ POST /api/cli/<command> → 包络输出与退出码映射。
 *
 * 本地路径（不连服务器）：--version / help / 命令组帮助 / completion
 * 补全脚本生成。--timeout <秒> 覆盖本次命令 HTTP 超时（缺省 120s /
 * long-poll 15min）。
 *
 * 退出码：0 成功 / 1 业务错误 / 2 参数错误 / 3 应用不可达或未开启 /
 * 4 需要确认（--yes）。业务命令只走运行中的 server（U16：无离线直写、
 * 不自动拉起应用）。
 *
 * 本模块无副作用入口（runCli 可单测）；进程侧入口见 main.ts。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpsArgumentError } from '../ops/command-table.js';
import {
  buildCommandArgs,
  evaluateRequestSpecs,
  parseInvocation,
  UsageError,
} from './args.js';
import { renderCompletionScript, renderCompletionUsage } from './completion.js';
import { renderCommandHelp, renderGroupHelp, renderTopHelp } from './help.js';
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

/** 供 main.ts / 单测使用的主入口。 */
export async function runCli(argv: string[]): Promise<number> {
  // --json 先从 argv 裸探（parseInvocation 抛用法错时 catch 分支也要走 json 输出）
  let json = process.env.FEISHU_SYNC_CLI_JSON === '1' || argv.includes('--json');
  try {
    const invocation = parseInvocation(argv);
    json = invocation.flags.json;

    // ---- 本地路径（不连服务器）----
    if (invocation.flags.version) {
      process.stdout.write(`feishu-sync CLI v${readVersion()}（Node ${process.version}）\n`);
      return 0;
    }
    if (invocation.words[0] === 'completion') {
      if (invocation.flags.help || !invocation.completionShell) {
        process.stdout.write(renderCompletionUsage());
        return invocation.flags.help ? 0 : 2;
      }
      process.stdout.write(renderCompletionScript(invocation.completionShell));
      return 0;
    }
    if (invocation.group) {
      // 只输入到命令组（如 `kb`）：列出组内子命令；--help/help kb 退出 0，
      // 裸组名退出 2 并同样列出。
      process.stdout.write(renderGroupHelp(invocation.group));
      return invocation.flags.help ? 0 : 2;
    }
    if (invocation.flags.help && invocation.helpTarget) {
      process.stdout.write(renderCommandHelp(invocation.helpTarget));
      return 0;
    }
    if (invocation.flags.help && invocation.command) {
      process.stdout.write(renderCommandHelp(invocation.command));
      return 0;
    }
    if (invocation.flags.help || !invocation.command) {
      process.stdout.write(renderTopHelp());
      return invocation.flags.help ? 0 : 2;
    }
    const def = invocation.command;

    // ---- 本地预检（退出码 2/4 语义；先于端点发现/探活）----
    const args = buildCommandArgs(def, invocation.restTokens);

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

    // ---- 执行 ----
    const body: Record<string, unknown> = { args };
    if (confirmRequired && def.confirm) {
      body[def.confirm.field] = def.confirm.value;
    }
    const timeoutMs = invocation.flags.timeoutSec !== undefined
      ? Math.round(invocation.flags.timeoutSec * 1000)
      : (def.stream === 'long-poll' ? LONG_POLL_TIMEOUT_MS : COMMAND_TIMEOUT_MS);
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

/** 当前模块目录：cjs（esbuild 单文件产物）用 __filename；ESM（tsx/tsc 产物）用 import.meta.url。 */
function moduleDirname(): string | undefined {
  try {
    if (typeof __filename === 'string' && __filename.length > 0) return path.dirname(__filename);
  } catch {
    // __filename 未定义（ESM）——走 import.meta.url 分支
  }
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}

/** esbuild define 注入的应用版本（根 package.json）；tsx/tsc 运行时不存在。 */
declare const __FEISHU_SYNC_APP_VERSION__: string | undefined;

/**
 * 版本号：打包产物用构建期注入的应用版本；非打包运行（tsx/tsc dist）依次读
 * 仓库根 package.json（应用版本）、server/package.json（兜底），都读不到报 unknown。
 */
function readVersion(): string {
  if (typeof __FEISHU_SYNC_APP_VERSION__ === 'string' && __FEISHU_SYNC_APP_VERSION__) {
    return __FEISHU_SYNC_APP_VERSION__;
  }
  const dir = moduleDirname();
  if (!dir) return 'unknown';
  for (const rel of [['..', '..', '..'], ['..', '..']]) {
    try {
      const version = JSON.parse(fs.readFileSync(path.join(dir, ...rel, 'package.json'), 'utf-8')).version;
      if (typeof version === 'string' && version) return version;
    } catch {
      // 继续尝试下一个候选
    }
  }
  return 'unknown';
}
