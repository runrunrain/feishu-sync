/** 内网 MCP 管理面，冻结契约：检索设计 §13.8.2。与 server 类型独立。 */
export type KbLanMcpState =
  | 'disabled'
  | 'starting'
  | 'running'
  | 'port_in_use'
  | 'bind_unavailable'
  | 'no_private_interface'
  | 'artifact_missing'
  | 'failed'
export interface KbLanMcpSettings {
  bindAddress: string
  port: number
  maxSessions: number
  allowCidrs?: string[]
}
export interface KbLanMcpStatus {
  enabled: boolean
  state: KbLanMcpState
  bindAddress: string
  resolvedHost: string | null
  port: number
  urls: string[]
  sessions: number
  inflight: number
  queued: number
  heapUsed: number
  lastError: string | null
  tokenMasked: string | null
  interfaces: Array<{ name: string; address: string }>
}
export interface KbLanMcpAuditEntry {
  time: string
  event: string
  remote?: string
  session?: string
  tool?: string
  releaseId?: string
  status?: string
  errorCode?: string | null
  queueMs?: number
  durationMs?: number
  resultChars?: number
}
export const DEFAULT_KB_LAN_SETTINGS: KbLanMcpSettings = {
  bindAddress: 'auto',
  port: 47391,
  maxSessions: 16,
}
export const DEFAULT_KB_LAN_CIDRS = [
  '127.0.0.0/8',
  '::1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  'fc00::/7',
  'fe80::/10',
]
