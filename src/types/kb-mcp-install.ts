export type McpClientTarget = 'agents' | 'claude' | 'codex' | 'claude-wsl' | 'codex-wsl' | 'codex-wsl-shared';
export type McpInstallState = 'not_installed' | 'installed' | 'needs_update' | 'adoptable' | 'conflict' | 'modified' | 'invalid';
export interface McpInstallStatus {
  target: McpClientTarget;
  path: string;
  state: McpInstallState;
  message?: string;
}
