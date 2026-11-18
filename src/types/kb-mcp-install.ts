export type McpClientTarget = 'agents' | 'claude' | 'codex' | 'codex-wsl' | 'codex-wsl-shared';
export type McpInstallState = 'not_installed' | 'installed' | 'needs_update' | 'conflict' | 'modified' | 'invalid';
export interface McpInstallStatus {
  target: McpClientTarget;
  path: string;
  state: McpInstallState;
  message?: string;
}
