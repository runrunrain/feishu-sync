export type AgentPluginScope = 'discuss' | 'work' | 'build';
export interface AgentContextPlugin {
  id: string;
  name: string;
  description: string;
  kind: 'context';
  builtin: boolean;
  enabled: boolean;
  scopes: AgentPluginScope[];
  content: string;
}
export interface AgentPluginsDto {
  revision: string;
  plugins: AgentContextPlugin[];
}
export interface AgentPluginInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  scopes?: AgentPluginScope[];
  content?: string;
}
