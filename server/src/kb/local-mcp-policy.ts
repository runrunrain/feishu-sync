import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, resolveInside } from '../agent/path-guard.js';

export const KB_MCP_INSTANCE_HEADER = 'X-Feishu-Sync-Mcp-Instance';
const PRESENCE_FILE = 'run/kb-mcp-desktop.json';

export function createDesktopMcpPresence(dataRoot: string) {
  const instanceId = randomUUID();
  let publishedFile: string | undefined;
  return {
    matches(candidate: string | undefined): boolean {
      return publishedFile !== undefined && candidate === instanceId;
    },
    publish(port: number): void {
      resolveInside(dataRoot, 'run', 'mkdir');
      const file = resolveInside(dataRoot, PRESENCE_FILE, 'write');
      atomicWriteFile(file, JSON.stringify({ port, instanceId }));
      publishedFile = file;
    },
    clear(): void {
      const file = publishedFile;
      publishedFile = undefined;
      if (!file) return;
      try {
        if (JSON.parse(fs.readFileSync(file, 'utf8')).instanceId === instanceId) fs.unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}

export function readLocalMcpConfig(dataRoot: string): {
  allowStandaloneKbMcp?: unknown;
  standardKb?: { outputRoot?: unknown };
} {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf8'));
    return config && typeof config === 'object' && !Array.isArray(config) ? config : { allowStandaloneKbMcp: false };
  } catch (error) {
    // No config preserves existing standalone use. Unreadable settings require a live desktop.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : { allowStandaloneKbMcp: false };
  }
}

export async function canRunLocalMcp(dataRoot: string): Promise<boolean> {
  const { allowStandaloneKbMcp } = readLocalMcpConfig(dataRoot);
  if (allowStandaloneKbMcp === undefined || allowStandaloneKbMcp === true) return true;
  try {
    const { port, instanceId } = JSON.parse(fs.readFileSync(path.join(dataRoot, PRESENCE_FILE), 'utf8'));
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof instanceId !== 'string'
      || !/^[a-f0-9-]{36}$/.test(instanceId)) return false;
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      method: 'HEAD',
      headers: { [KB_MCP_INSTANCE_HEADER]: instanceId },
      redirect: 'error',
      signal: AbortSignal.timeout(1000),
    });
    return response.ok && response.headers.get(KB_MCP_INSTANCE_HEADER) === instanceId;
  } catch {
    return false;
  }
}
