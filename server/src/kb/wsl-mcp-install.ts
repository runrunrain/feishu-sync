/** Resolve and edit the default WSL user's client configuration without renderer paths. */
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { KbMcpInfoDto } from '../types/agent-knowledge.js';
import { localMcpBridgeEntry, type LocalMcpBridgeEntry } from './local-mcp-bridge-entry.js';

export type WslMcpClient = 'codex' | 'claude';
export interface WslMcpLocation { path: string; linuxPath: string; distro: string }
export const WSL_CONFIG_FILES = { codex: 'config.toml', claude: '.claude.json' } as const;
export interface WslMcpSupport {
  resolve(client: WslMcpClient): WslMcpLocation;
  entry(info: KbMcpInfoDto): LocalMcpBridgeEntry;
  replace?(location: WslMcpLocation, before: { exists: boolean; text: string }, text: string | null): void;
}

const RESOLVE = `set -eu
case "$1" in
  codex) home="\${CODEX_HOME:-$HOME/.codex}"; name=config.toml ;;
  claude) home="\${CLAUDE_CONFIG_DIR:-$HOME}"; name=.claude.json ;;
  *) exit 71 ;;
esac
case "$home" in /*) ;; *) exit 71 ;; esac
test -n "\${WSL_DISTRO_NAME:-}"
file="\${home%/}/$name"
printf '%s\\n' "$WSL_DISTRO_NAME" "$file"
wslpath -w "$file"
`;

// Windows cannot preserve POSIX ACLs or create hard links through \\wsl.localhost.
// Perform the same exclusive-create / compare-and-replace in the selected distro.
const REPLACE = `set -eu
file=$1 expected=$2 operation=$3
check() {
  if [ -e "$file" ] || [ -L "$file" ]; then
    [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c %h -- "$file")" = 1 ] || exit 74
    [ "$expected" != missing ] || exit 73
    [ "$(sha256sum < "$file" | cut -d ' ' -f 1)" = "$expected" ] || exit 73
  else
    [ "$expected" = missing ] || exit 73
  fi
}
check
if [ "$operation" = delete ]; then
  [ "$expected" = missing ] || rm -- "$file"
  exit 0
fi
dir=$(dirname -- "$file")
umask 077
mkdir -p -- "$dir"
[ -d "$dir" ] && [ ! -L "$dir" ] || exit 74
tmp=$(mktemp "\${file}.feishu-sync.XXXXXXXX")
trap 'if [ -e "$tmp" ]; then rm -- "$tmp"; fi' EXIT HUP INT TERM
if [ "$expected" != missing ]; then cp -p -- "$file" "$tmp"; fi
cat > "$tmp"
sync -f "$tmp"
check
if [ "$expected" = missing ]; then ln -- "$tmp" "$file"; else mv -- "$tmp" "$file"; fi
`;

function wslExecutable(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
}

export function resolveDefaultWslMcp(client: WslMcpClient): WslMcpLocation {
  const output = execFileSync(wslExecutable(), ['--exec', 'sh', client === 'claude' ? '-lc' : '-c', RESOLVE, 'sh', client], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 16_384,
  }).trimEnd().split(/\r?\n/);
  const [distro, linuxPath, windowsPath] = output;
  if (output.length !== 3 || !distro || distro.length > 256 || /[\0\r\n]/.test(distro)
    || !linuxPath?.startsWith('/') || !linuxPath.endsWith('/' + WSL_CONFIG_FILES[client]) || /[\0\r\n]/.test(linuxPath)
    || !path.win32.isAbsolute(windowsPath ?? '') || /[\0\r\n]/.test(windowsPath)) {
    throw new Error('invalid_wsl_mcp_location');
  }
  return { distro, linuxPath, path: windowsPath };
}

export function replaceWslMcp(location: WslMcpLocation, before: { exists: boolean; text: string }, text: string | null): void {
  const expected = before.exists ? crypto.createHash('sha256').update(before.text, 'utf8').digest('hex') : 'missing';
  execFileSync(wslExecutable(), ['--distribution', location.distro, '--exec', 'sh', '-c', REPLACE, 'sh', location.linuxPath, expected, text === null ? 'delete' : 'write'], {
    input: text ?? '', encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function createWslMcpSupport(dataRoot: string): WslMcpSupport {
  return {
    resolve: resolveDefaultWslMcp,
    replace: replaceWslMcp,
    entry: (info) => localMcpBridgeEntry(info, dataRoot),
  };
}
