/** Browser-only synthetic fixture. No production entry imports this file.
 * Run Vite, open /src/test-fixtures/kb-lan-mcp.html. All fetches are intercepted
 * in this page; it never opens a gateway, reads real credentials or calls server.
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsView } from '../views/SettingsView'
import { ToastProvider } from '../components/common/Toast'
import type { KbLanMcpAuditEntry, KbLanMcpState, KbLanMcpStatus } from '../types/kb-lan-mcp'
import '../styles/index.css'

if (!(import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV) {
  throw new Error('This synthetic UI fixture is development-only')
}
let token = `fskb_${crypto.randomUUID().replaceAll('-', '')}`
let settings = {
  enabled: false,
  bindAddress: 'auto',
  port: 47391,
  maxSessions: 16,
  allowCidrs: undefined as string[] | undefined,
}
let state: KbLanMcpState = 'disabled'
let statusFailure = false
let auditFailure = false
let delay = false
let clipboardFailure = false
const audit: KbLanMcpAuditEntry[] = []
function record(event: string) {
  audit.unshift({ time: new Date().toISOString(), event, remote: '127.0.0.1', status: 'ok' })
}
function status(): KbLanMcpStatus {
  return {
    enabled: settings.enabled,
    state,
    bindAddress: settings.bindAddress,
    resolvedHost: settings.enabled ? '192.168.1.23' : null,
    port: settings.port,
    urls:
      settings.enabled && state === 'running'
        ? [`http://192.168.1.23:${settings.port}/mcp`, `http://studio.local:${settings.port}/mcp`]
        : [],
    sessions: settings.enabled ? 3 : 0,
    inflight: settings.enabled ? 1 : 0,
    queued: settings.enabled ? 2 : 0,
    heapUsed: settings.enabled ? 48 * 1024 * 1024 : 0,
    lastError: null,
    tokenMasked: token ? `${token.slice(0, 9)}…${token.slice(-4)}` : null,
    interfaces: [
      { name: 'en0', address: '192.168.1.23' },
      { name: 'utun4', address: '100.64.0.10' },
    ],
  }
}
window.fetch = async (input, init) => {
  const path = String(input)
  if (delay) await new Promise((resolve) => setTimeout(resolve, 1200))
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  const json = (value: unknown, code = 200) =>
    new Response(JSON.stringify(value), {
      status: code,
      headers: { 'Content-Type': 'application/json' },
    })
  if (path === '/api/config')
    return json({
      knowledgeBaseRoot: '/tmp/synthetic-kb',
      pollIntervalMinutes: 30,
      watchedRootUrls: [],
      watchedRoots: [],
      llm: { enabled: false, providers: [], presets: [] },
      kbLanMcp: settings,
    })
  if (path.endsWith('/status') && path.includes('kb-lan-mcp'))
    return statusFailure ? json({ message: '模拟：服务暂时不可达' }, 503) : json(status())
  if (path.includes('/audit?'))
    return auditFailure ? json({ message: '模拟：审计读取失败' }, 503) : json(audit.slice(0, 20))
  if (path.endsWith('/enable')) {
    settings.enabled = true
    state = 'running'
    if (!token) token = `fskb_${crypto.randomUUID().replaceAll('-', '')}`
    record('enabled')
    return json(status())
  }
  if (path.endsWith('/disable')) {
    settings.enabled = false
    state = 'disabled'
    if (body.revokeToken) token = ''
    record('disabled')
    return json({})
  }
  if (path.endsWith('/settings')) {
    if (body.allowCidrs?.some((cidr: string) => cidr.startsWith('8.8.')))
      return json({ message: '模拟：不允许公网放行网段' }, 400)
    settings = { ...settings, ...body }
    return json({})
  }
  if (path.endsWith('/token/rotate')) {
    token = `fskb_${crypto.randomUUID().replaceAll('-', '')}`
    record('token_rotated')
    return json({ tokenMasked: status().tokenMasked })
  }
  if (path.endsWith('/token/reveal')) {
    record('token_revealed')
    return json({ token })
  }
  // Other Settings cards are out of this synthetic test's scope; expose failure.
  return json({ message: '此接口未接入隔离 UI fixture' }, 503)
}
const clipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard)
navigator.clipboard.writeText = (value: string) =>
  clipboardFailure ? Promise.reject(new Error('fixture clipboard denied')) : clipboardWrite(value)

function Fixture() {
  const [active, setActive] = useState(true)
  return (
    <ToastProvider>
      <div className="min-h-screen bg-paper p-4 space-y-3">
        <aside
          aria-label="模拟验证控制"
          className="text-xs border border-line p-3 flex flex-wrap gap-3 items-center"
        >
          <strong>隔离 UI 验证 · 全部 API 为模拟 · 无真实知识库</strong>
          <label>
            模拟状态{' '}
            <select
              aria-label="模拟状态"
              onChange={(e) => {
                state = e.target.value as KbLanMcpState
              }}
              defaultValue="disabled"
            >
              {[
                'disabled',
                'starting',
                'running',
                'port_in_use',
                'bind_unavailable',
                'no_private_interface',
                'artifact_missing',
                'failed',
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              onChange={(e) => {
                statusFailure = e.target.checked
              }}
            />
            状态失败
          </label>
          <label>
            <input
              type="checkbox"
              onChange={(e) => {
                auditFailure = e.target.checked
              }}
            />
            审计失败
          </label>
          <label>
            <input
              type="checkbox"
              onChange={(e) => {
                clipboardFailure = e.target.checked
              }}
            />
            复制失败
          </label>
          <label>
            <input
              type="checkbox"
              onChange={(e) => {
                delay = e.target.checked
              }}
            />
            慢请求
          </label>
          <button onClick={() => setActive((value) => !value)}>
            {active ? '离开设置主区' : '返回设置主区'}
          </button>
        </aside>
        <div hidden={!active}>
          <SettingsView active={active} />
        </div>
      </div>
    </ToastProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
