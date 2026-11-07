/**
 * CLI 参数解析（设计 kb-agent-upgrade §6.1/§6.3）
 *
 * 命令面直接对照 S8 命令表（ops/command-table.ts，25 条）：空格分层
 * 子命令映射点号名（`kb build` → `kb.build`），参数定义（名称/类型/
 * 必填）全部来自表内 params schema，CLI 不另立一份命令清单——共表防
 * 语义漂移（U14）。本文件只读消费命令表，不修改它。
 *
 * 全局旗标：--home <dir> / --json / --yes（confirm 确认）/ --help /
 * --version / --timeout <秒>（覆盖本次命令 HTTP 超时）。命令参数旗标用
 * kebab-case（--build-id → buildId），object/array 类型取 JSON 字面量
 * （--sources '[{"objToken":…}]'）。
 *
 * 位置参数：POSITIONALS 显式登记最高优先；未登记命令按表内 required
 * 顺序自动推导（array/object 沿用既有尾位/JSON 规则）。同一参数以位置
 * 形态与旗标形态同时给出时显式报冲突，绝不静默覆盖。
 */

import { OPS_COMMANDS, type JsonSchemaObject, type OpsCommandDef, type OpsRequestSpec } from '../ops/command-table.js';
import { suggestClosest } from './suggest.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface GlobalFlags {
  home?: string;
  json: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
  /** --timeout <秒>：覆盖本次命令 HTTP 超时（缺省 120s / long-poll 15min）。 */
  timeoutSec?: number;
}

export interface ParsedInvocation {
  flags: GlobalFlags;
  /** 命令表定义；help/version/无命令时为 null。 */
  command: OpsCommandDef | null;
  /** `help kb build` 目标命令（flags.help 为 true 时生效）。 */
  helpTarget: OpsCommandDef | null;
  /** 命令词之后的所有 token（旗标 + 位置参数）。 */
  restTokens: string[];
  /** 前导命令词（诊断用）。 */
  words: string[];
  /** 命令组前缀（如 `kb` / `kb sources`）：输入只到组、未到具体命令时生效。 */
  group?: string;
  /** 本地命令 completion 的目标 shell（不经命令表、不连服务器）。 */
  completionShell?: 'bash' | 'zsh' | 'fish';
}

/** 命令名最大层级深度（auth.login.start / lark.config-init.start = 3）。 */
const MAX_COMMAND_DEPTH = Math.max(...OPS_COMMANDS.map((def) => def.name.split('.').length));

/** 点号名 → 空格名（帮助文本与错误消息用）。 */
export function spacedName(name: string): string {
  return name.replace(/\./g, ' ');
}

export function findCommandByWords(words: string[]): OpsCommandDef | null {
  for (let depth = Math.min(words.length, MAX_COMMAND_DEPTH); depth >= 1; depth -= 1) {
    const candidate = words.slice(0, depth).join('.');
    const def = OPS_COMMANDS.find((command) => command.name === candidate);
    if (def) return def;
  }
  return null;
}

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/** camel 参数名 → kebab 旗标名（buildId → build-id；帮助/补全/错误消息共用）。 */
export function camelToKebab(name: string): string {
  return name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** 命令级旗标别名（设计 §6.3 用法示例的惯用写法 → 表内参数）。 */
const FLAG_ALIASES: Record<string, Record<string, { param: string; value: unknown }>> = {
  'kb.build': { full: { param: 'mode', value: 'full' } },
  'auth.login.start': { 'switch-account': { param: 'mode', value: 'switch_account' } },
};

/** 位置参数映射（按命令表 required/惯用法定义）。 */
const POSITIONALS: Record<string, string[]> = {
  'config.get': ['path'],
  'config.set': ['path', 'value'],
  'kb.cancel': ['buildId'],
  'auth.login.complete': ['deviceCode'],
  'auth.login.cancel': ['deviceCode'],
  'clean.trash.restore': ['objToken'],
  'clean.trash.purge': ['objToken'],
  'kb.sources.include': ['tokens'],
  'kb.sources.exclude': ['tokens'],
  // S13 登记：source.* 首位置参数统一为 objToken（设计 §6.3 用法形态）。
  'source.edit-status': ['objToken'],
  'source.edit': ['objToken'],
  'source.revert': ['objToken'],
  'source.push-preview': ['objToken'],
  'source.push': ['objToken'],
  // P0-S4 登记：cloud.* 首位置参数 objToken（cloud.revert 第二位为目标版本 id）。
  'cloud.history_list': ['objToken'],
  'cloud.revert': ['objToken', 'historyVersionId'],
  // P0-S9 登记：cloud.rename_title 首位 objToken、第二位新标题。
  'cloud.rename_title': ['objToken', 'title'],
  // P0-S8 登记：docTokens 为尾位 array 参数，多个位置参数全量收集
  //（feishu-sync sync whiteboard-backfill <tok1> <tok2> …）。
  'sync.whiteboard_backfill': ['docTokens'],
  // 可用性补齐（cli-polish）：列表类命令的常用过滤参数开放位置形态。
  'kb.builds': ['limit'],
  'cloud.moves': ['objToken'],
  'cloud.move_status': ['moveId'],
};

/** 位置参数绑定计划：显式登记最高优先；未登记命令按 required 顺序自动推导。 */
export function positionalPlanFor(def: OpsCommandDef): string[] {
  const explicit = POSITIONALS[def.name];
  if (explicit) return explicit;
  const required = def.params.required ?? [];
  // 必填参数按 schema 属性顺序依次作为位置参数；array/object 类型在
  // buildCommandArgs 内沿用既有规则（array 尾位全量收集 / object JSON）。
  return Object.keys(def.params.properties).filter((param) => required.includes(param));
}

/** 命令组判定：prefix 本身不是命令，但有命令以其为点号前缀（如 kb / auth.login）。 */
export function isCommandGroup(prefix: string): boolean {
  if (prefix.length === 0) return false;
  return OPS_COMMANDS.some((def) => def.name.startsWith(`${prefix}.`));
}

/** 全部命令的空格分层名（拼写建议候选，按命令全名匹配）。 */
const ALL_SPACED_NAMES = OPS_COMMANDS.map((def) => spacedName(def.name));

/** 命令可用旗标名（裸 kebab 名，别名在前）——帮助/补全/建议共用；bash/zsh 词表自行加 -- 前缀。 */
export function commandFlagNames(def: OpsCommandDef): string[] {
  const aliases = Object.keys(FLAG_ALIASES[def.name] ?? {});
  const params = Object.keys(def.params.properties).map(camelToKebab);
  return [...aliases, ...params.filter((param) => !aliases.includes(param))];
}

function parseTimeoutSeconds(raw: string): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    throw new UsageError(`--timeout 需要正数秒数（如 --timeout 30），收到 "${raw}"`);
  }
  return num;
}

export function parseInvocation(argv: string[]): ParsedInvocation {
  const flags: GlobalFlags = { json: process.env.FEISHU_SYNC_CLI_JSON === '1', yes: false, help: false, version: false };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      rest.push(...argv.slice(i)); // 保留 -- 标记：buildCommandArgs 依它切换字面模式
      break;
    }
    if (token === '--home') {
      const value = argv[i + 1];
      if (!value) throw new UsageError('--home 需要一个目录参数');
      flags.home = value;
      i += 1;
      continue;
    }
    if (token.startsWith('--home=')) {
      flags.home = token.slice('--home='.length);
      continue;
    }
    if (token === '--json') { flags.json = true; continue; }
    if (token === '--yes' || token === '-y') { flags.yes = true; continue; }
    if (token === '--help' || token === '-h') { flags.help = true; continue; }
    if (token === '--version') { flags.version = true; continue; }
    if (token === '--timeout') {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError('--timeout 需要一个秒数参数（如 --timeout 30）');
      flags.timeoutSec = parseTimeoutSeconds(value);
      i += 1;
      continue;
    }
    if (token.startsWith('--timeout=')) {
      flags.timeoutSec = parseTimeoutSeconds(token.slice('--timeout='.length));
      continue;
    }
    rest.push(token);
  }

  // 前导非旗标 token = 命令词
  const words: string[] = [];
  let index = 0;
  while (index < rest.length && !rest[index].startsWith('-') && rest[index] !== '--') {
    words.push(rest[index]);
    index += 1;
    if (words.length >= MAX_COMMAND_DEPTH) break;
  }

  if (words.length === 0) {
    return { flags, command: null, helpTarget: null, restTokens: rest, words };
  }

  // `completion <shell>`：本地命令（生成 shell 补全脚本），不经命令表、
  // 不连服务器、不计入命令数。表内无 completion.* 命令，独占该词安全。
  if (words[0] === 'completion') {
    if (flags.help) {
      // `completion --help`：只展示用法，不要求 shell 参数。
      return { flags, command: null, helpTarget: null, restTokens: [], words };
    }
    const shell = words[1];
    if (words.length > 2 || shell !== 'bash' && shell !== 'zsh' && shell !== 'fish') {
      throw new UsageError('用法：feishu-sync completion bash|zsh|fish（本地命令，生成 shell 补全脚本）');
    }
    return { flags, command: null, helpTarget: null, restTokens: [], words, completionShell: shell };
  }

  // `help [command…]`：顶层/定向帮助；目标也可以是命令组（help kb）。
  if (words[0] === 'help') {
    const targetWords = rest.slice(1).filter((token) => !token.startsWith('-'));
    const target = findCommandByWords(targetWords);
    if (target) {
      return { flags: { ...flags, help: true }, command: null, helpTarget: target, restTokens: [], words };
    }
    const groupCandidate = targetWords.join('.');
    if (targetWords.length > 0 && isCommandGroup(groupCandidate)) {
      return { flags: { ...flags, help: true }, command: null, helpTarget: null, restTokens: [], words, group: groupCandidate };
    }
    if (targetWords.length > 0) {
      throw unknownCommandError(targetWords);
    }
    return { flags: { ...flags, help: true }, command: null, helpTarget: null, restTokens: [], words };
  }

  const command = findCommandByWords(words);
  if (!command) {
    // 只输入到命令组（如 `kb` / `kb sources`）：进入组帮助路径，退出码由
    // 是否带 --help 决定（见 cli-app）。
    const groupCandidate = words.join('.');
    if (isCommandGroup(groupCandidate)) {
      return { flags, command: null, helpTarget: null, restTokens: rest, words, group: groupCandidate };
    }
    throw unknownCommandError(words);
  }
  const consumed = command.name.split('.').length;
  return {
    flags,
    command,
    helpTarget: null,
    restTokens: rest.slice(consumed),
    words: words.slice(0, consumed),
  };
}

/** 未知命令错误：带拼写建议（最多 3 条，按命令全名匹配；无相近候选则不提）。 */
function unknownCommandError(words: string[]): UsageError {
  const suggestions = suggestClosest(words.join(' '), ALL_SPACED_NAMES);
  const suffix = suggestions.length > 0
    ? `（你是不是想输入：${suggestions.join('、')}）`
    : '（--help 查看全部命令）';
  return new UsageError(`未知命令 ${words.join(' ')}${suffix}`);
}

function convertFlagValue(def: OpsCommandDef, param: string, raw: string | undefined): unknown {
  const schema = def.params.properties[param];
  const type = schema?.type;
  if (type === 'boolean') {
    if (raw === undefined) return true;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new UsageError(`参数 --${param} 需要 boolean（true/false），收到 "${raw}"`);
  }
  if (raw === undefined) {
    throw new UsageError(`参数 --${param} 需要一个值`);
  }
  if (type === 'number') {
    const num = Number(raw);
    if (!Number.isFinite(num)) throw new UsageError(`参数 --${param} 需要数字，收到 "${raw}"`);
    return num;
  }
  if (type === 'object' || type === 'array') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new UsageError(`参数 --${param} 需要合法 JSON（如 '${type === 'array' ? '["a","b"]' : '{"k":1}'}'），收到 "${raw.slice(0, 80)}"`);
    }
  }
  return raw;
}

/** 把命令词之后的 token 解析为命令 args（旗标 + 位置参数 + 必填校验）。 */
export function buildCommandArgs(def: OpsCommandDef, tokens: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const positionalValues: string[] = [];
  let literal = false; // -- 之后：余下 token 一律按位置参数处理

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=');
      const rawName = eq >= 0 ? token.slice(2, eq) : token.slice(2);
      const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;
      const param = kebabToCamel(rawName);
      const alias = FLAG_ALIASES[def.name]?.[rawName];
      if (alias) {
        args[alias.param] = alias.value;
        continue;
      }
      if (!(param in def.params.properties)) {
        // 拼写建议：与表内参数/别名相近时直接给出候选，减少查表来回。
        const suggestions = suggestClosest(rawName, commandFlagNames(def));
        const suffix = suggestions.length > 0
          ? `（你是不是想输入：${suggestions.map((s) => `--${s}`).join(' ')}）`
          : `（help ${spacedName(def.name)} 查看参数）`;
        throw new UsageError(`命令 ${spacedName(def.name)} 不认识参数 --${rawName}${suffix}`);
      }
      let valueToken = inlineValue;
      if (valueToken === undefined) {
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          valueToken = next;
          i += 1;
        }
      }
      args[param] = convertFlagValue(def, param, valueToken);
      continue;
    }
    if (!literal && token.startsWith('-') && token.length > 1 && !/^-\d+$/.test(token)) {
      throw new UsageError(`不认识旗标 ${token}（命令参数请用 --<name> 形式）`);
    }
    positionalValues.push(token);
  }

  // 位置参数绑定（显式登记 > required 自动推导）；与同名旗标同时给出时
  // 显式报冲突，绝不静默覆盖。
  const positionalPlan = positionalPlanFor(def);
  const assertNoFlagConflict = (param: string): void => {
    if (param in args) {
      throw new UsageError(`参数 ${param} 同时以位置参数与 --${camelToKebab(param)} 旗标提供，请只保留一种形式`);
    }
  };
  for (let i = 0; i < positionalPlan.length; i += 1) {
    const param = positionalPlan[i];
    const schemaType = def.params.properties[param]?.type;
    const isLast = i === positionalPlan.length - 1;
    if (schemaType === 'array' && isLast) {
      const values = positionalValues.slice(i);
      if (values.length > 0) {
        assertNoFlagConflict(param);
        args[param] = values;
      }
      break;
    }
    const value = positionalValues[i];
    if (value === undefined) break;
    assertNoFlagConflict(param);
    if (schemaType === 'object' || schemaType === 'array') {
      try {
        args[param] = JSON.parse(value);
      } catch {
        throw new UsageError(`参数 ${param} 需要合法 JSON，收到 "${value.slice(0, 80)}"`);
      }
    } else if (schemaType === 'number') {
      const num = Number(value);
      if (!Number.isFinite(num)) throw new UsageError(`参数 ${param} 需要数字，收到 "${value}"`);
      args[param] = num;
    } else {
      args[param] = value;
    }
  }
  const consumedPositionals = Math.min(positionalValues.length, positionalPlan.length === 0 ? 0 : positionalPlan.length);
  if (positionalValues.length > consumedPositionals && !(positionalPlan.length > 0 && def.params.properties[positionalPlan[positionalPlan.length - 1]]?.type === 'array')) {
    throw new UsageError(`命令 ${spacedName(def.name)} 有多余的位置参数：${positionalValues.slice(consumedPositionals).join(' ')}`);
  }

  for (const required of def.params.required ?? []) {
    if (!(required in args)) {
      throw new UsageError(`命令 ${spacedName(def.name)} 缺少必填参数 ${required}（help ${spacedName(def.name)} 查看用法）`);
    }
  }
  return args;
}

/** 参数 schema → 人类可读摘要（help 输出用）。 */
export function describeParams(params: JsonSchemaObject): string {
  const entries = Object.entries(params.properties);
  if (entries.length === 0) return '（无参数）';
  return entries.map(([key, schema]) => {
    const required = (params.required ?? []).includes(key) ? '必填' : '可选';
    const def = schema.default !== undefined ? `，默认 ${JSON.stringify(schema.default)}` : '';
    return `  --${key.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`)} <${schema.type}>  [${required}]${schema.description ? ` ${schema.description}` : ''}${def}`;
  }).join('\n');
}

/** 命令表快照（帮助文本用；与 GET /api/cli/commands 同源）。 */
export function commandListForHelp(): Array<{ def: OpsCommandDef; usage: string }> {
  return OPS_COMMANDS.map((def) => ({ def, usage: spacedName(def.name) }));
}

/** 本地评估请求形态（confirm 预检用；与表内 request 纯函数一致）。 */
export function evaluateRequestSpecs(def: OpsCommandDef, args: Record<string, unknown>): OpsRequestSpec[] {
  return def.request(args);
}
