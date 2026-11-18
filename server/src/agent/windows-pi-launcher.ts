import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicWriteFile } from './path-guard.js';

const run = promisify(execFile);
const marker = 'rem Feishu Sync managed Pi launcher';

export function ensurePiLauncher(prefix: string, nodePath: string, cliPath: string): void {
  const relative = path.relative(prefix, cliPath);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Pi 命令入口超出了应用管理的安装目录');
  }
  const escape = (value: string) => value.replaceAll('%', '%%');
  const file = path.join(prefix, 'pi.cmd');
  const body = [
    '@echo off',
    marker,
    'setlocal DisableDelayedExpansion',
    `"${escape(nodePath)}" "%~dp0${escape(relative.replaceAll('/', '\\'))}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
  const existing = fs.lstatSync(file, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isFile() || existing.size > 4096) throw new Error('应用的 Pi 命令入口已被其他文件占用');
    const current = fs.readFileSync(file, 'utf8');
    if (current === body) return;
    if (current.split(/\r?\n/)[1] !== marker) throw new Error('应用的 Pi 命令入口已被其他文件占用');
  }
  atomicWriteFile(file, body);
}

// Preserve expandable entries such as %USERPROFILE%\bin and the registry value type.
const appendUserPath = String.raw`
$ErrorActionPreference = 'Stop'
$entry = $env:FEISHU_SYNC_MANAGED_PI_BIN
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $found = $raw.Split(';') | Where-Object {
    [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"')).TrimEnd('\') -ieq $entry.TrimEnd('\')
  }
  if ($found) { return }
  $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { 'ExpandString' }
  $updated = if ($raw -and !$raw.EndsWith(';')) { "$raw;$entry" } else { "$raw$entry" }
  $key.SetValue('Path', $updated, $kind)
} finally {
  $key.Dispose()
}
Add-Type -Namespace FeishuSync -Name UserEnvironment -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr window, uint message, System.IntPtr wParam,
    string lParam, uint flags, uint timeout, out System.IntPtr result);
'@
$result = [IntPtr]::Zero
[FeishuSync.UserEnvironment]::SendMessageTimeout([IntPtr]65535, 26, [IntPtr]::Zero, 'Environment', 2, 500, [ref]$result) | Out-Null
`;

export async function publishWindowsPi(prefix: string, nodePath: string, cliPath: string): Promise<void> {
  if (/[;%]/.test(prefix)) throw new Error('Pi 安装路径含 Windows PATH 无法可靠表示的字符');
  ensurePiLauncher(prefix, nodePath, cliPath);
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = Buffer.from(appendUserPath, 'utf16le').toString('base64');
  await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    cwd: systemRoot, windowsHide: true, timeout: 20_000,
    env: { ...process.env, FEISHU_SYNC_MANAGED_PI_BIN: prefix },
  }).catch(() => { throw new Error('Pi 已安装，但无法将命令入口加入 Windows 用户 PATH'); });
}
