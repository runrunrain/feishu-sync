/**
 * CLI shell 补全脚本生成（本地命令 `completion bash|zsh|fish`）
 *
 * 由命令表静态生成：命令词分层补全（组 → 子命令）+ 每命令的 --参数名
 * （含别名旗标）+ 全局旗标。本命令不经命令表、不连服务器、不计入命令数。
 * bash/zsh 用同一棵 case 树；fish 用 seen_subcommand_from 守卫。脚本仅含
 * 命令词与旗标名（[a-z0-9_-]+），无注入面。
 */

import { OPS_COMMANDS, type OpsCommandDef } from '../ops/command-table.js';
import { commandFlagNames, spacedName } from './args.js';
import { GLOBAL_FLAGS } from './help.js';

export type CompletionShell = 'bash' | 'zsh' | 'fish';

export const COMPLETION_SHELLS: readonly CompletionShell[] = ['bash', 'zsh', 'fish'];

export function renderCompletionUsage(): string {
  return [
    'feishu-sync completion —— 生成 shell 补全脚本（本地命令，不连服务器）',
    '',
    '用法：feishu-sync completion bash|zsh|fish',
    '',
    '安装示例：',
    '  bash: echo \'source <(feishu-sync completion bash)\' >> ~/.bashrc',
    '  zsh:  echo \'source <(feishu-sync completion zsh)\' >> ~/.zshrc（需已加载 compinit）',
    '  fish: feishu-sync completion fish > ~/.config/fish/completions/feishu-sync.fish',
    '',
  ].join('\n');
}

/** 顶层命令词（去重排序）。 */
function topSegments(): string[] {
  return [...new Set(OPS_COMMANDS.map((def) => def.name.split('.')[0]))].sort();
}

/** 组前缀 → 直接子段（命令末段或更深一层的组段，去重排序）。 */
function groupChildren(): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const def of OPS_COMMANDS) {
    const parts = def.name.split('.');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join('.');
      const seg = parts[depth];
      if (!map.has(prefix)) map.set(prefix, new Set());
      map.get(prefix)!.add(seg);
    }
  }
  return new Map([...map.entries()].map(([prefix, segs]) => [prefix, [...segs].sort()]));
}

/** 组下全部命令的末段集合（fish 组守卫用：已见叶子命令就不再补组内词）。 */
function leafSegmentsUnder(prefix: string): string[] {
  const segs = new Set<string>();
  for (const def of OPS_COMMANDS) {
    if (def.name.startsWith(`${prefix}.`)) segs.add(def.name.split('.').pop()!);
  }
  return [...segs].sort();
}

/** 值型旗标（非 boolean 参数）需独立标记；别名旗标（--full 等）视为开关。 */
function valueFlags(def: OpsCommandDef): Set<string> {
  const typed = new Set<string>();
  for (const [key, schema] of Object.entries(def.params.properties)) {
    if (schema.type !== 'boolean') {
      typed.add(key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
    }
  }
  return typed;
}

function wordList(words: string[]): string {
  return words.join(' ');
}

function renderBash(): string {
  const children = groupChildren();
  const arms: string[] = [];
  const pushArm = (ctx: string, words: string[]): void => {
    arms.push(`    '${ctx}')`);
    arms.push(`      COMPREPLY=($(compgen -W "${wordList(words)}" -- "$cur"))`);
    arms.push('      ;;');
  };
  pushArm('', [...topSegments(), ...GLOBAL_FLAGS]);
  for (const [prefix, segs] of children) {
    if (prefix !== '') pushArm(spacedName(prefix), [...segs, ...GLOBAL_FLAGS]);
  }
  for (const def of OPS_COMMANDS) {
    pushArm(spacedName(def.name), [...commandFlagNames(def).map((flag) => `--${flag}`), ...GLOBAL_FLAGS]);
  }
  arms.push('    *)');
  arms.push(`      COMPREPLY=($(compgen -W "${wordList([...GLOBAL_FLAGS])}" -- "$cur"))`);
  arms.push('      ;;');
  return [
    '# feishu-sync bash 补全 —— 由命令表自动生成（feishu-sync completion bash）',
    '# 安装：source <(feishu-sync completion bash)',
    '_feishu_sync_complete() {',
    '  local cur',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  local ctx',
    '  ctx="${COMP_WORDS[*]:1:COMP_CWORD-1}"',
    '  case "$ctx" in',
    ...arms,
    '  esac',
    '}',
    'complete -F _feishu_sync_complete feishu-sync',
    '',
  ].join('\n');
}

function renderZsh(): string {
  const children = groupChildren();
  const arms: string[] = [];
  const pushArm = (ctx: string, words: string[]): void => {
    arms.push(`    '${ctx}')`);
    arms.push(`      cands=(${wordList(words)})`);
    arms.push('      ;;');
  };
  pushArm('', [...topSegments(), ...GLOBAL_FLAGS]);
  for (const [prefix, segs] of children) {
    if (prefix !== '') pushArm(spacedName(prefix), [...segs, ...GLOBAL_FLAGS]);
  }
  for (const def of OPS_COMMANDS) {
    pushArm(spacedName(def.name), [...commandFlagNames(def).map((flag) => `--${flag}`), ...GLOBAL_FLAGS]);
  }
  arms.push('    *)');
  arms.push(`      cands=(${wordList([...GLOBAL_FLAGS])})`);
  arms.push('      ;;');
  return [
    '#compdef feishu-sync',
    '# feishu-sync zsh 补全 —— 由命令表自动生成（feishu-sync completion zsh）',
    '# 安装：source <(feishu-sync completion zsh)（需已加载 compinit）',
    '_feishu_sync() {',
    '  local -a cands',
    '  local ctx',
    '  ctx="${(j: :)words[2,CURRENT-1]}"',
    '  case "$ctx" in',
    ...arms,
    '  esac',
    '  compadd -- "${cands[@]}"',
    '}',
    'if (( $+functions[compdef] )); then',
    '  compdef _feishu_sync feishu-sync',
    'fi',
    '',
  ].join('\n');
}

function fishQuote(text: string): string {
  return text.replace(/'/g, '’');
}

function renderFish(): string {
  const children = groupChildren();
  const lines: string[] = [
    '# feishu-sync fish 补全 —— 由命令表自动生成（feishu-sync completion fish）',
    '# 安装：feishu-sync completion fish > ~/.config/fish/completions/feishu-sync.fish',
    `complete -c feishu-sync -f -a '${wordList(topSegments())}'`,
  ];
  // 全局旗标（-r 表示需要值）
  lines.push(`complete -c feishu-sync -l home -r -d '${fishQuote('数据根（默认 FEISHU_SYNC_HOME）')}'`);
  lines.push(`complete -c feishu-sync -l json -d '${fishQuote('结构化输出')}'`);
  lines.push(`complete -c feishu-sync -l yes -d '${fishQuote('确认执行')}'`);
  lines.push(`complete -c feishu-sync -l timeout -r -d '${fishQuote('覆盖本次命令 HTTP 超时秒数')}'`);
  lines.push(`complete -c feishu-sync -l help -d '${fishQuote('帮助')}'`);
  lines.push(`complete -c feishu-sync -l version -d '${fishQuote('版本')}'`);
  // 组：已见该组词且未进入任何叶子命令时，补组内子命令词
  for (const [prefix, segs] of children) {
    if (prefix === '') continue;
    const guardWords = prefix.split('.');
    const leaves = leafSegmentsUnder(prefix);
    const condition = [
      ...guardWords.map((word) => `__fish_seen_subcommand_from ${word}`),
      ...leaves.map((leaf) => `not __fish_seen_subcommand_from ${leaf}`),
    ].join('; and ');
    lines.push(`complete -c feishu-sync -f -n '${condition}' -a '${wordList(segs)}'`);
  }
  // 命令参数：按末段词匹配（表内末段跨命令重复仅发生在无参数命令间，无副作用）
  for (const def of OPS_COMMANDS) {
    const lastSegment = def.name.split('.').pop()!;
    const typed = valueFlags(def);
    for (const flag of commandFlagNames(def)) {
      const needsValue = typed.has(flag) ? ' -r' : '';
      const description = Object.entries(def.params.properties)
        .find(([key]) => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`) === flag)?.[1]?.description ?? '';
      const descPart = description ? ` -d '${fishQuote(description.slice(0, 60))}'` : '';
      lines.push(`complete -c feishu-sync -f -n '__fish_seen_subcommand_from ${lastSegment}' -l ${flag}${needsValue}${descPart}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function renderCompletionScript(shell: CompletionShell): string {
  if (shell === 'bash') return renderBash();
  if (shell === 'zsh') return renderZsh();
  return renderFish();
}
