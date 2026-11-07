/**
 * CLI 帮助文本渲染（顶层 / 单命令 / 命令组）
 *
 * 全部由命令表纯数据生成：用法行含位置参数形态（positionalPlanFor），
 * 参数表列名称/类型/必填/默认/描述，示例由参数 schema 机械拼出（占位符
 * 形式，不编造真实值）。组 = 命令名点号前缀；组本身不是命令。
 */

import { OPS_COMMANDS, type OpsCommandDef } from '../ops/command-table.js';
import { camelToKebab, positionalPlanFor, spacedName } from './args.js';

/** 全局旗标（顶层帮助、单命令示例与补全脚本共用同一清单）。 */
export const GLOBAL_FLAGS = ['--home', '--json', '--yes', '--help', '--version', '--timeout'] as const;

export function renderTopHelp(): string {
  const lines: string[] = [
    'feishu-sync —— feishu-sync 知识库同步与标准库构建的命令行客户端',
    '',
    '用法：feishu-sync [--home <数据根>] [--json] [--yes] [--timeout <秒>] <命令> [参数…]',
    '',
    '全局旗标：',
    '  --home <dir>   数据根（默认 FEISHU_SYNC_HOME，再缺省 ~/.feishu-sync）',
    '  --json         结构化输出（stdout 单个 {ok,data|error} 包络）',
    '  --yes          确认 destructive/remote_write 命令（注入命令表的 confirm 值）',
    '  --timeout <秒> 覆盖本次命令 HTTP 超时（缺省 120 秒 / long-poll 15 分钟）',
    '  --help / -h    帮助；--version 版本',
    '',
    '命令（风险级：read 读取 / mutate 修改 / destructive 破坏性 / remote_write 远端写）：',
  ];
  for (const def of OPS_COMMANDS) {
    lines.push(`  feishu-sync ${spacedName(def.name).padEnd(34)} [${def.risk}] ${def.summary}`);
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
  lines.push('feishu-sync help <命令> 查看单命令用法；completion <shell> 生成补全');
  return `${lines.join('\n')}\n`;
}

/** 参数 schema → 对齐参数表（名称/类型/必填/默认/描述；标记位置形态）。 */
function renderParamTable(def: OpsCommandDef): string {
  const entries = Object.entries(def.params.properties);
  if (entries.length === 0) return '（无参数）';
  const positional = new Set(positionalPlanFor(def));
  const rows = entries.map(([key, schema]) => ({
    name: `--${camelToKebab(key)}`,
    positional: positional.has(key) ? '位置' : '旗标',
    type: schema.type,
    required: (def.params.required ?? []).includes(key) ? '必填' : '可选',
    default: schema.default !== undefined ? JSON.stringify(schema.default) : '—',
    description: schema.description ?? '',
  }));
  const nameW = Math.max(...rows.map((row) => row.name.length));
  const formW = 4;
  const typeW = Math.max(...rows.map((row) => row.type.length));
  const reqW = 4;
  const defW = Math.max(...rows.map((row) => row.default.length));
  return rows
    .map((row) => `  ${row.name.padEnd(nameW)}  ${row.positional.padEnd(formW)}  ${row.type.padEnd(typeW)}  ${row.required.padEnd(reqW)}  ${row.default.padEnd(defW)}  ${row.description}`)
    .join('\n');
}

/** 位置参数顺序说明（用法行之外的可读补充）。 */
function renderPositionalOrder(def: OpsCommandDef): string {
  const plan = positionalPlanFor(def);
  if (plan.length === 0) return '无位置参数（全部参数用 --<name> 旗标）';
  const required = new Set(def.params.required ?? []);
  return plan
    .map((param, index) => `${param}（第 ${index + 1} 位${required.has(param) ? '' : '，可选'}）`)
    .join('、');
}

/** 位置参数的用法行片段：<name> / [<name>]；尾位 array 为 <name…> 形态。 */
function positionalUsagePart(def: OpsCommandDef): string {
  const plan = positionalPlanFor(def);
  const required = new Set(def.params.required ?? []);
  const parts = plan.map((param) => {
    const schemaType = def.params.properties[param]?.type;
    const name = schemaType === 'array' ? `${param}…` : param;
    return required.has(param) ? `<${name}>` : `[<${name}>]`;
  });
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/** 示例（schema 机械生成，占位符形式，不编造真实值）。 */
function renderExamples(def: OpsCommandDef): string[] {
  const spaced = spacedName(def.name);
  const plan = positionalPlanFor(def);
  const required = new Set(def.params.required ?? []);
  const positionalSet = new Set(plan);
  // 示例 1：必填标量位置参数的最小形态（object/array 位置参数走旗标更直观）。
  const base = plan
    .filter((param) => required.has(param) && def.params.properties[param]?.type !== 'array')
    .map((param) => `<${param}>`);
  const example1 = `feishu-sync ${spaced}${base.length > 0 ? ` ${base.join(' ')}` : ''}`;
  // 示例 2：旗标形态——优先 boolean 参数（可裸传），否则取第一个非位置参数；
  // 都没有时用全局 --json；带确认值的命令附 --yes。
  const entries = Object.entries(def.params.properties).filter(([key]) => !positionalSet.has(key));
  const booleanEntry = entries.find(([, schema]) => schema.type === 'boolean');
  const chosen = booleanEntry ?? entries[0];
  let flagPart = ' --json';
  if (chosen) {
    flagPart = chosen[1].type === 'boolean'
      ? ` --${camelToKebab(chosen[0])}`
      : ` --${camelToKebab(chosen[0])} <${chosen[1].type}>`;
  }
  const example2 = `${example1}${flagPart}${def.confirm ? ' --yes' : ''}`;
  return [example1, example2];
}

export function renderCommandHelp(def: OpsCommandDef): string {
  const lines: string[] = [
    `feishu-sync ${spacedName(def.name)} —— ${def.summary}`,
    '',
    `用法：feishu-sync ${spacedName(def.name)}${positionalUsagePart(def)}${Object.keys(def.params.properties).length > 0 ? ' [--参数…]' : ''}`,
    '',
    `风险级：${def.risk}${def.confirm ? `；执行需 --yes（注入 ${def.confirm.field}=${def.confirm.value}）` : ''}`,
    '',
    '参数：',
    renderParamTable(def),
    '',
    `位置参数顺序：${renderPositionalOrder(def)}`,
    '',
    '示例：',
    ...renderExamples(def).map((line) => `  ${line}`),
    '',
    '全局旗标：--home <dir> / --json / --yes / --timeout <秒> / --help',
  ];
  return `${lines.join('\n')}\n`;
}

/** 组 = 点号前缀；列出该组下全部命令（含更深层，按表内顺序）。 */
export function renderGroupHelp(group: string): string {
  const members = OPS_COMMANDS.filter((def) => def.name.startsWith(`${group}.`));
  const lines: string[] = [
    `feishu-sync ${spacedName(group)} —— 命令组（子命令用空格分层）`,
    '',
    ...members.map((def) => `  feishu-sync ${spacedName(def.name).padEnd(34)} [${def.risk}] ${def.summary}`),
    '',
    `提示：feishu-sync ${spacedName(members[0]?.name ?? group)} --help 查看单命令用法。`,
  ];
  return `${lines.join('\n')}\n`;
}
