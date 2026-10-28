/**
 * CLI 参数解析（设计 kb-agent-upgrade §6.1/§6.3）
 *
 * 命令面直接对照 S8 命令表（ops/command-table.ts，25 条）：空格分层
 * 子命令映射点号名（`kb build` → `kb.build`），参数定义（名称/类型/
 * 必填）全部来自表内 params schema，CLI 不另立一份命令清单——共表防
 * 语义漂移（U14）。本文件只读消费命令表，不修改它。
 *
 * 全局旗标：--home <dir> / --json / --yes（confirm 确认）/ --help /
 * --version。命令参数旗标用 kebab-case（--build-id → buildId），
 * object/array 类型取 JSON 字面量（--sources '[{"objToken":…}]'）。
 */

import { OPS_COMMANDS, type JsonSchemaObject, type OpsCommandDef, type OpsRequestSpec } from '../ops/command-table.js';

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
};

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

  // `help [command…]`：顶层/定向帮助
  if (words[0] === 'help') {
    const targetWords = rest.slice(1).filter((token) => !token.startsWith('-'));
    const target = findCommandByWords(targetWords);
    if (targetWords.length > 0 && !target) {
      throw new UsageError(`未知命令 ${targetWords.join(' ')}（--help 查看全部命令）`);
    }
    return { flags: { ...flags, help: true }, command: null, helpTarget: target, restTokens: [], words };
  }

  const command = findCommandByWords(words);
  if (!command) {
    throw new UsageError(`未知命令 ${words.join(' ')}（--help 查看全部命令）`);
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
        throw new UsageError(`命令 ${spacedName(def.name)} 不认识参数 --${rawName}（help ${spacedName(def.name)} 查看参数）`);
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

  // 位置参数绑定
  const positionalPlan = POSITIONALS[def.name] ?? [];
  for (let i = 0; i < positionalPlan.length; i += 1) {
    const param = positionalPlan[i];
    const schemaType = def.params.properties[param]?.type;
    const isLast = i === positionalPlan.length - 1;
    if (schemaType === 'array' && isLast) {
      const values = positionalValues.slice(i);
      if (values.length > 0) args[param] = values;
      break;
    }
    const value = positionalValues[i];
    if (value === undefined) break;
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
