export interface PiPackagePlugin {
  id: string;
  source: string;
  sourceType: 'builtin' | 'npm' | 'git' | 'local';
  name: string;
  version: string;
  description: string;
  installPath: string;
  enabled: boolean;
  resources: { type: string; path: string; enabled?: boolean }[];
}
export interface PiPluginsDto { revision: string; agentDir: string; packages: PiPackagePlugin[]; busy: boolean }
