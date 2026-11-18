/** Resolve the default WSL user's Codex configuration without accepting renderer paths. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { serverDistRoot } from '../agent/agent-assets.js';
import { runtimeExecutable } from '../modules/runtime-executable.js';
import type { KbMcpInfoDto } from '../types/agent-knowledge.js';

export interface WslCodexLocation { path: string; linuxPath: string; distro: string }
export interface WslBridgeEntry { command: string; args: string[]; env: Record<string, string> }
export interface WslMcpSupport {
  resolve(): WslCodexLocation;
  entry(info: KbMcpInfoDto): WslBridgeEntry;
  replace?(location: WslCodexLocation, before: { exists: boolean; text: string }, text: string | null): void;
}

const RESOLVE = `set -eu
home="\${CODEX_HOME:-$HOME/.codex}"
case "$home" in /*) ;; *) exit 71 ;; esac
test -n "\${WSL_DISTRO_NAME:-}"
printf '%s\\n' "$WSL_DISTRO_NAME" "\${home%/}/config.toml"
wslpath -w "\${home%/}/config.toml"
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

export function resolveDefaultWslCodex(): WslCodexLocation {
  const output = execFileSync(wslExecutable(), ['--exec', 'sh', '-c', RESOLVE], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 16_384,
  }).trimEnd().split(/\r?\n/);
  const [distro, linuxPath, windowsPath] = output;
  if (output.length !== 3 || !distro || distro.length > 256 || /[\0\r\n]/.test(distro)
    || !linuxPath?.startsWith('/') || !linuxPath.endsWith('/config.toml') || !path.win32.isAbsolute(windowsPath ?? '')) {
    throw new Error('invalid_wsl_codex_location');
  }
  return { distro, linuxPath, path: windowsPath };
}

export function replaceWslCodex(location: WslCodexLocation, before: { exists: boolean; text: string }, text: string | null): void {
  const expected = before.exists ? crypto.createHash('sha256').update(before.text, 'utf8').digest('hex') : 'missing';
  execFileSync(wslExecutable(), ['--distribution', location.distro, '--exec', 'sh', '-c', REPLACE, 'sh', location.linuxPath, expected, text === null ? 'delete' : 'write'], {
    input: text ?? '', encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function createWslMcpSupport(dataRoot: string): WslMcpSupport {
  return {
    resolve: resolveDefaultWslCodex,
    replace: replaceWslCodex,
    entry(info) {
      if (!('url' in info)) throw new Error('local_http_required');
      const url = new URL(info.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) {
        throw new Error('invalid_local_http_endpoint');
      }
      const root = serverDistRoot();
      const dist = path.basename(root) === 'src' ? path.join(root, '..', 'dist') : root;
      const shim = path.join(dist, 'mcp', 'kb-mcp-wsl.cmd');
      const bundle = path.join(dist, 'mcp', 'kb-mcp-http-bridge.cjs');
      if (!fs.existsSync(shim) || !fs.existsSync(bundle)) throw new Error('wsl_bridge_not_built');
      return {
        // Delayed expansion happens after cmd.exe parses metacharacters, so
        // spaces, &, %, ! and parentheses in the installation path stay literal.
        command: 'cmd.exe', args: ['/d', '/v:on', '/c', '!FEISHU_SYNC_BRIDGE_SHIM!'],
        env: {
          FEISHU_SYNC_BRIDGE_SHIM: shim, FEISHU_SYNC_BRIDGE_APP: runtimeExecutable(), FEISHU_SYNC_BRIDGE_BUNDLE: bundle,
          FEISHU_SYNC_BRIDGE_HOME: path.resolve(dataRoot), FEISHU_SYNC_BRIDGE_PORT: url.port || '80',
          WSLENV: 'FEISHU_SYNC_BRIDGE_SHIM:FEISHU_SYNC_BRIDGE_APP:FEISHU_SYNC_BRIDGE_BUNDLE:FEISHU_SYNC_BRIDGE_HOME:FEISHU_SYNC_BRIDGE_PORT',
        },
      };
    },
  };
}
