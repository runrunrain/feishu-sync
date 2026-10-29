/** 知识库共享：独立即时管理面，不参与通用设置草稿。只消费已发布标准库。
 * 明文不进 toast/logger/配置；仅显式 reveal 持有，隐藏/失焦/离开卡片即清除。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Network, RefreshCw } from 'lucide-react'
import { Button } from './common/Button'
import { Modal } from './common/Modal'
import { StatusBadge } from './common/StatusBadge'
import {
  APIError,
  getKbLanMcpStatus,
  getKbLanMcpSettings,
  getKbLanMcpAudit,
  enableKbLanMcp,
  disableKbLanMcp,
  saveKbLanMcpSettings,
  revealKbLanMcpToken,
  rotateKbLanMcpToken,
} from '../api/client'
import {
  DEFAULT_KB_LAN_SETTINGS,
  DEFAULT_KB_LAN_CIDRS,
  type KbLanMcpStatus,
  type KbLanMcpSettings,
  type KbLanMcpAuditEntry,
} from '../types/kb-lan-mcp'

export function kbLanStateText(status: KbLanMcpStatus): string {
  const labels: Record<KbLanMcpStatus['state'], string> = {
    disabled: '已停用 · 端口不监听',
    starting: '正在启动，请稍候',
    running: '共享运行中',
    port_in_use: `端口 ${status.port} 已被占用，请换一个端口`,
    bind_unavailable: '绑定地址不可用，请检查网卡或重新选择地址',
    no_private_interface: '没有可用的私网网卡，请连接可信内网',
    artifact_missing: '网关产物缺失，请更新或重新构建应用',
    failed: '共享服务启动失败，请检查设置后重试启用',
  }
  return labels[status.state] ?? '未知服务状态，请刷新'
}
export function kbLanClientConfig(client: 'pi' | 'claude', url: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'feishu-kb': {
          ...(client === 'claude' ? { type: 'http' } : {}),
          url,
          headers: { Authorization: 'Bearer ${FEISHU_KB_TOKEN}' },
          ...(client === 'pi'
            ? {
                description:
                  '飞书同步标准知识库（只读）：策划与程序设计文档的检索、grep、章节大纲与正文读取',
                timeout: 60,
              }
            : {}),
        },
      },
    },
    null,
    2,
  )
}
function safeMessage(error: unknown): string {
  return (error instanceof APIError ? error.message : '操作未完成，请检查服务后重试').replace(
    /fskb_[A-Za-z0-9_-]+/g,
    '[令牌已隐藏]',
  )
}
const AUDIT_EVENT_LABELS: Record<string, string> = {
  tool_call: '工具调用',
  auth_fail: '认证失败',
  forbidden_source: '来源被拒绝',
  browser_forbidden: '浏览器请求被拒绝',
  rate_limited: '请求限速',
  session_open: '会话建立',
  session_close: '会话结束',
  session_evicted: '会话回收',
  foreign_token_header: '其它令牌域请求',
  watchdog_kill: '看门狗重启',
  token_rotated: '令牌轮换',
  token_revealed: '令牌查看',
  enabled: '启用共享',
  disabled: '停用共享',
  regex_start: '正则查询开始',
}
const inputClass =
  'w-full min-w-0 rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-seal'
const focusClass =
  'focus-visible:!outline focus-visible:!outline-2 focus-visible:!outline-offset-2 focus-visible:!outline-seal'
type ConfirmAction = 'enable' | 'disable' | 'rotate' | 'wildcard' | null

/** 复用 Modal 的视觉；在本卡补齐初始焦点、焦点圈定和返回焦点。 */
function SharingConfirm({
  action,
  busy,
  onClose,
  onConfirm,
  children,
}: {
  action: Exclude<ConfirmAction, null>
  busy: boolean
  onClose: () => void
  onConfirm: () => void
  children: React.ReactNode
}) {
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    body.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  const title = {
    enable: '开启内网知识库共享？',
    disable: '停用知识库共享？',
    rotate: '轮换共享令牌？',
    wildcard: '在所有网卡上监听？',
  }[action]
  return (
    <Modal open title={title} onClose={busy ? undefined : onClose}>
      <div
        ref={body}
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return
          const items = body.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled)',
          )
          if (!items?.length) {
            e.preventDefault()
            return
          }
          const first = items[0],
            last = items[items.length - 1]
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }}
        className="space-y-4 text-sm text-ink-soft leading-relaxed"
      >
        {children}
        <div className="flex justify-end flex-wrap gap-2">
          <Button className={focusClass} variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button className={focusClass} loading={busy} onClick={onConfirm}>
            {action === 'wildcard'
              ? '确认所有网卡'
              : action === 'enable'
                ? '确认开启'
                : action === 'disable'
                  ? '确认停用'
                  : '确认轮换'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function KbLanMcpSettingsCard() {
  const [status, setStatus] = useState<KbLanMcpStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusError, setStatusError] = useState('')
  const [audit, setAudit] = useState<KbLanMcpAuditEntry[] | null>(null)
  const [auditError, setAuditError] = useState('')
  const [settings, setSettings] = useState<KbLanMcpSettings | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [cidrs, setCidrs] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmAction>(null)
  const [revoke, setRevoke] = useState(false)
  const [wildcard, setWildcard] = useState('')
  const [configUrl, setConfigUrl] = useState('')
  const [client, setClient] = useState<'pi' | 'claude'>('pi')
  const alive = useRef(false)
  const generation = useRef(0)
  const secretGeneration = useRef(0)
  const pollBusy = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const clearToken = useCallback(() => {
    secretGeneration.current++
    setToken(null)
  }, [])

  const refreshStatus = useCallback(async () => {
    const id = ++generation.current
    try {
      const next = await getKbLanMcpStatus(controller.current?.signal)
      if (!alive.current || id !== generation.current) return
      setStatus(next)
      setStatusError('')
      if (!next.enabled) clearToken()
    } catch (error) {
      if (alive.current && id === generation.current) {
        setStatusError(safeMessage(error))
        clearToken()
      }
    } finally {
      if (alive.current && id === generation.current) setLoading(false)
    }
  }, [clearToken])
  const refreshAudit = useCallback(async () => {
    try {
      const next = await getKbLanMcpAudit(controller.current?.signal)
      if (alive.current) {
        setAudit(next.slice(0, 20))
        setAuditError('')
      }
    } catch (error) {
      if (alive.current) setAuditError(safeMessage(error))
    }
  }, [])
  const loadSettings = useCallback(async () => {
    try {
      const next = await getKbLanMcpSettings(controller.current?.signal)
      if (!alive.current) return
      const value = next.kbLanMcp ?? DEFAULT_KB_LAN_SETTINGS
      setSettings(value)
      setCidrs(value.allowCidrs?.join('\n') ?? '')
      setDirty(false)
      setSettingsError('')
    } catch (error) {
      if (alive.current) setSettingsError(safeMessage(error))
    }
  }, [])
  useEffect(() => {
    const requestVersion = generation
    const secretVersion = secretGeneration
    alive.current = true
    controller.current = new AbortController()
    void refreshStatus()
    void refreshAudit()
    void loadSettings()
    const timer = window.setInterval(() => {
      if (document.hidden || pollBusy.current) return
      pollBusy.current = true
      void Promise.all([refreshStatus(), refreshAudit()]).finally(() => {
        pollBusy.current = false
      })
    }, 4000)
    const hideSecret = () => clearToken()
    window.addEventListener('blur', hideSecret)
    document.addEventListener('visibilitychange', hideSecret)
    return () => {
      alive.current = false
      requestVersion.current++
      secretVersion.current++
      controller.current?.abort()
      window.clearInterval(timer)
      window.removeEventListener('blur', hideSecret)
      document.removeEventListener('visibilitychange', hideSecret)
    }
  }, [refreshStatus, refreshAudit, loadSettings, clearToken])

  useEffect(() => {
    clearToken()
  }, [status?.tokenMasked, clearToken])

  const run = async (action: () => Promise<unknown>, message: string, reloadSettings = false) => {
    setBusy(true)
    setFeedback(null)
    clearToken()
    generation.current++
    try {
      await action()
      if (!alive.current) return
      setConfirm(null)
      await Promise.all([
        refreshStatus(),
        refreshAudit(),
        ...(reloadSettings ? [loadSettings()] : []),
      ])
      if (alive.current) setFeedback({ error: false, text: message })
    } catch (error) {
      if (alive.current) {
        setConfirm(null)
        setFeedback({ error: true, text: safeMessage(error) })
        await refreshStatus()
      }
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      if (alive.current) setFeedback({ error: false, text: `${label}已复制` })
    } catch {
      if (alive.current)
        setFeedback({
          error: true,
          text: `${label}复制失败：剪贴板不可用或权限被拒绝，请重试；地址与配置可手动选择复制。`,
        })
    }
  }
  const accessToken = async (show: boolean) => {
    setBusy(true)
    setFeedback(null)
    const id = ++secretGeneration.current
    try {
      const value = await revealKbLanMcpToken()
      if (!alive.current || id !== secretGeneration.current) return
      if (show) setToken(value)
      else await copy(value, '令牌')
      void refreshAudit()
    } catch {
      if (alive.current) setFeedback({ error: true, text: '无法读取共享令牌，请检查服务后重试' })
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const blocked = busy || loading || !!statusError || !status
  const urls = status?.urls ?? []
  const loopbackOnly = ['127.0.0.1', '::1'].includes(status?.resolvedHost ?? status?.bindAddress ?? '')
  const isLoopbackLocalName = (url: string) => loopbackOnly && /^https?:\/\/[^/]+\.local(?::\d+)?\//i.test(url)
  const usableUrls = urls.filter((url) => !isLoopbackLocalName(url))
  const selectedUrl = usableUrls.includes(configUrl) ? configUrl : (usableUrls[0] ?? '')
  const changeSettings = (value: Partial<KbLanMcpSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...value } : prev))
    setDirty(true)
  }
  const saveSettings = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!settings) return
    if (
      !Number.isInteger(settings.port) ||
      settings.port < 1024 ||
      settings.port > 65535 ||
      !Number.isInteger(settings.maxSessions) ||
      settings.maxSessions < 1 ||
      settings.maxSessions > 64
    ) {
      setFeedback({ error: true, text: '端口须为 1024–65535 的整数，最大会话数须为 1–64 的整数' })
      return
    }
    const allowCidrs = cidrs.trim()
      ? cidrs
          .trim()
          .split(/[\s,，]+/)
          .filter(Boolean)
      : undefined
    void run(
      () => saveKbLanMcpSettings({ ...settings, allowCidrs }),
      '高级设置已提交；运行中的网关会重启，请查看最新状态',
      true,
    )
  }

  return (
    <section
      aria-label="知识库共享（内网 MCP）"
      aria-busy={busy || loading}
      className="rounded-md border border-line bg-card-bg shadow-sm overflow-hidden"
    >
      <header className="px-4 py-3 border-b border-line/60 flex items-start gap-3">
        <Network className="w-4 h-4 mt-0.5 shrink-0 text-ink-soft" />
        <div>
          <h3 className="text-sm font-kai font-medium text-ink">知识库共享（内网 MCP）</h3>
          <p className="mt-1 text-xs text-ink-soft leading-relaxed">
            让可信内网设备上的 Agent 只读检索已发布标准库；不开放原始库、写入或应用管理权限。
          </p>
        </div>
      </header>
      <div className="p-4 space-y-5 text-xs text-ink-soft">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              className="min-w-0 max-w-full !shrink !whitespace-normal !text-ink"
              status={
                statusError
                  ? 'error'
                  : status?.state === 'running'
                    ? 'success'
                    : status?.state === 'disabled'
                      ? 'neutral'
                      : 'warning'
              }
            >
              {loading
                ? '正在读取共享状态…'
                : statusError
                  ? '状态不可用'
                  : status
                    ? kbLanStateText(status)
                    : '状态不可用'}
            </StatusBadge>
            <Button
              className={focusClass}
              size="sm"
              variant={status?.enabled ? 'secondary' : 'primary'}
              disabled={blocked}
              onClick={() => {
                setRevoke(false)
                setConfirm(status?.enabled ? 'disable' : 'enable')
              }}
            >
              {status?.enabled ? '停用共享' : '开启共享'}
            </Button>
            {status?.enabled && status.state !== 'running' && status.state !== 'starting' ? (
              <Button
                className={focusClass}
                size="sm"
                disabled={blocked || dirty}
                onClick={() => setConfirm('enable')}
              >
                重新启用
              </Button>
            ) : null}
            <Button
              className={focusClass}
              size="sm"
              variant="ghost"
              disabled={busy || loading}
              onClick={() => {
                void refreshStatus()
                void refreshAudit()
              }}
              aria-label="刷新共享状态"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </Button>
          </div>
          {statusError ? (
            <p role="alert" className="text-seal-2">
              状态读取失败：{statusError}。当前状态未知，请刷新后操作。
            </p>
          ) : null}
          {status ? (
            <p>
              {statusError ? '上次读数：' : ''}会话 {status.sessions} · 在途 {status.inflight} ·
              排队 {status.queued}
              {status.heapUsed > 0
                ? ` · 内存 ${(status.heapUsed / 1024 / 1024).toFixed(1)} MB`
                : ''}
            </p>
          ) : null}
          {status?.lastError ? (
            <p className="text-seal-2 break-words">
              服务诊断：{status.lastError.replace(/fskb_[A-Za-z0-9_-]+/g, '[令牌已隐藏]')}
            </p>
          ) : null}
          <p>默认关闭。这里的操作立即生效，不需要顶部「保存」。停用会关闭监听并断开全部会话。</p>
        </div>
        {busy ? <p role="status">正在处理共享请求，请稍候…</p> : null}
        {feedback ? (
          <p
            role={feedback.error ? 'alert' : 'status'}
            className={`break-words ${feedback.error ? 'text-seal-2' : 'text-ink'}`}
          >
            {feedback.text}
          </p>
        ) : null}
        {status?.enabled ? (
          <div className="border-t border-line/60 pt-4 space-y-4">
            <div className="space-y-2">
              <h4 className="font-medium text-ink">连接地址</h4>
              {status.state !== 'running' ? <p className="text-seal-2">服务未运行，下列地址仅供排障，不能用于连接。</p> : null}
              {urls.length ? (
                urls.map((url) => (
                  <div key={url} className="flex items-start gap-2 min-w-0">
                    <code className="flex-1 min-w-0 break-all select-text py-1.5">{url}</code>
                    <Button
                      className={focusClass}
                      size="sm"
                      variant="secondary"
                      disabled={blocked || status.state !== 'running' || isLoopbackLocalName(url)}
                      onClick={() => void copy(url, '地址')}
                      aria-label={`复制地址 ${url}`}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      复制
                    </Button>
                  </div>
                ))
              ) : (
                <p>网关尚未提供可用地址；请等待启动或检查下方排障。</p>
              )}
              {loopbackOnly ? <p>当前仅监听本机回环地址，其他设备无法连接；.local 主机名通常解析为网卡地址，不适用于此监听。请在本机使用回环地址。</p> : <p>
                优先使用服务提供的 .local 地址；若使用 IP，建议在路由器设置 DHCP
                地址保留。地址变化后请更新客户端配置。
              </p>}
            </div>
            <div className="space-y-2">
              <h4 className="font-medium text-ink">共享令牌</h4>
              <div className="flex flex-wrap items-center gap-2">
                <code
                  role="group"
                  aria-label={token ? '已显示的共享令牌' : '共享令牌掩码'}
                  className="min-w-0 break-all select-text flex-1"
                >
                  {token ?? status.tokenMasked ?? '尚无令牌'}
                </code>
                <Button
                  className={focusClass}
                  size="sm"
                  variant="secondary"
                  disabled={blocked || !status.tokenMasked}
                  onClick={() => (token ? clearToken() : void accessToken(true))}
                >
                  {token ? '隐藏' : '显示'}
                </Button>
                <Button
                  className={focusClass}
                  size="sm"
                  variant="secondary"
                  disabled={blocked || !status.tokenMasked}
                  onClick={() => void accessToken(false)}
                >
                  复制令牌
                </Button>
                <Button
                  className={focusClass}
                  size="sm"
                  variant="secondary"
                  disabled={blocked}
                  onClick={() => setConfirm('rotate')}
                >
                  轮换令牌
                </Button>
              </div>
              <p>
                显示或复制会记入审计。令牌可读取标准库全文，请仅交给可信设备；离开卡片或窗口失焦会隐藏明文。轮换后旧令牌立即失效。
              </p>
            </div>
            <div className="space-y-2">
              <h4 className="font-medium text-ink">客户端配置</h4>
              <div className="flex flex-wrap gap-2 items-center">
                <label className="flex items-center gap-2 whitespace-nowrap">
                  <span className="shrink-0">客户端</span>
                  <select
                    className={`${inputClass} !w-auto`}
                    value={client}
                    onChange={(e) => setClient(e.target.value as 'pi' | 'claude')}
                  >
                    <option value="pi">pi</option>
                    <option value="claude">Claude Code</option>
                  </select>
                </label>
                {urls.length > 1 ? (
                  <label className="flex items-center gap-2 min-w-0 flex-1 basis-60">
                    <span className="shrink-0">配置地址</span>
                    <select
                      className={inputClass}
                      value={selectedUrl}
                      onChange={(e) => setConfigUrl(e.target.value)}
                    >
                      {urls.map((url) => (
                        <option key={url} value={url} disabled={isLoopbackLocalName(url)}>
                          {url}{isLoopbackLocalName(url) ? '（仅回环监听时不可用）' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <Button
                  className={focusClass}
                  size="sm"
                  variant="secondary"
                  disabled={blocked || !selectedUrl || status.state !== 'running'}
                  onClick={() => void copy(kbLanClientConfig(client, selectedUrl), '配置')}
                >
                  复制{client === 'pi' ? ' pi' : ' Claude Code'}配置
                </Button>
              </div>
              <p>
                在客户端设备的 shell 或密钥管理器中设置 <code>FEISHU_KB_TOKEN</code>{' '}
                环境变量，再从同一环境启动客户端。请勿把令牌提交到 Git。
              </p>
              <p>
                {client === 'pi'
                  ? '合并到 ~/.pi/agent/mcp.json；保留文件中其它 mcpServers 条目。'
                  : '合并到项目 .mcp.json；保留其它 mcpServers 条目，按客户端提示批准项目 MCP。'}
              </p>
              {selectedUrl ? (
                <pre
                  role="region"
                  tabIndex={0}
                  aria-label="客户端 JSON 配置"
                  className="rounded border border-line bg-paper/50 p-3 whitespace-pre-wrap break-all text-[11px] leading-relaxed select-text"
                >
                  {kbLanClientConfig(client, selectedUrl)}
                </pre>
              ) : (
                <p>网关提供地址后可生成配置。</p>
              )}
              <p>
                配置仅引用 <code>{'${FEISHU_KB_TOKEN}'}</code>
                ，不会嵌入明文。不要使用会把令牌在添加时展开写入文件的 --header 命令。
              </p>
            </div>
          </div>
        ) : null}
        <details className="border-t border-line/60 pt-3">
          <summary className={`cursor-pointer font-medium text-ink py-1 ${focusClass}`}>
            高级网络设置
          </summary>
          <div className="pt-3 space-y-3">
            {settingsError ? (
              <p role="alert" className="text-seal-2">
                高级配置读取失败：{settingsError}{' '}
                <Button size="sm" variant="secondary" onClick={() => void loadSettings()}>
                  重试配置
                </Button>
              </p>
            ) : null}
            {!settings ? (
              <p>正在读取高级配置…</p>
            ) : (
              <form onSubmit={saveSettings} className="space-y-3">
                <fieldset disabled={blocked || !!settingsError} className="space-y-3">
                  <label className="block space-y-1">
                    <span>绑定网卡</span>
                    <select
                      className={inputClass}
                      value={settings.bindAddress}
                      onChange={(e) => {
                        const value = e.target.value
                        if (value === '0.0.0.0' || value === '::') {
                          setWildcard(value)
                          setConfirm('wildcard')
                        } else changeSettings({ bindAddress: value })
                      }}
                    >
                      <option value="auto">自动选择私网网卡（auto）</option>
                      {status?.interfaces
                        .filter(
                          (item, index, all) =>
                            all.findIndex((other) => other.address === item.address) === index,
                        )
                        .map((item) => (
                          <option key={item.address} value={item.address}>
                            {item.name} · {item.address}
                          </option>
                        ))}
                      {!status?.interfaces.some((item) => item.address === settings.bindAddress) &&
                      !['auto', '0.0.0.0', '::', '127.0.0.1'].includes(settings.bindAddress) ? (
                        <option value={settings.bindAddress}>
                          {settings.bindAddress}（当前不可用）
                        </option>
                      ) : null}
                      {!status?.interfaces.some((item) => item.address === '127.0.0.1') ? (
                        <option value="127.0.0.1">127.0.0.1（仅本机自测）</option>
                      ) : null}
                      <option value="0.0.0.0">所有 IPv4 网卡（0.0.0.0，高级）</option>
                      <option value="::">所有 IPv6 网卡（::，高级）</option>
                    </select>
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block space-y-1">
                      <span>端口（1024–65535）</span>
                      <input
                        className={inputClass}
                        type="number"
                        required
                        min={1024}
                        max={65535}
                        step={1}
                        value={settings.port}
                        onChange={(e) => changeSettings({ port: Number(e.target.value) })}
                      />
                    </label>
                    <label className="block space-y-1">
                      <span>最大会话数（1–64）</span>
                      <input
                        className={inputClass}
                        type="number"
                        required
                        min={1}
                        max={64}
                        step={1}
                        value={settings.maxSessions}
                        onChange={(e) => changeSettings({ maxSessions: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <label className="block space-y-1">
                    <span>放行网段（CIDR，每行一项或逗号分隔）</span>
                    <textarea
                      className={`${inputClass} font-mono text-xs`}
                      rows={3}
                      value={cidrs}
                      onChange={(e) => {
                        setCidrs(e.target.value)
                        setDirty(true)
                      }}
                    />
                  </label>
                  <p className="break-words">
                    留空使用默认私网段：{DEFAULT_KB_LAN_CIDRS.join('、')}
                    。填写后替换默认列表；只允许收窄到默认段的子集，公网段会被服务端拒绝。
                  </p>
                  <p>
                    运行时修改会重启网关、断开所有会话。需要加密请绑定 Tailscale / WireGuard 接口
                    IP。
                  </p>
                  <div className="flex flex-wrap gap-2 items-center">
                    <Button
                      className={focusClass}
                      type="submit"
                      size="sm"
                      loading={busy}
                      disabled={!dirty}
                    >
                      应用高级设置
                    </Button>
                    <Button
                      className={focusClass}
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!dirty}
                      onClick={() => void loadSettings()}
                    >
                      放弃修改
                    </Button>
                    {dirty ? <span>有未应用修改；开启共享使用已保存配置。</span> : null}
                  </div>
                </fieldset>
              </form>
            )}
          </div>
        </details>
        <div className="border-t border-line/60 pt-4 space-y-2">
          <h4 className="font-medium text-ink">最近访问 · 最多 20 条</h4>
          {auditError ? (
            <p role="alert" className="text-seal-2">
              审计读取失败：{auditError}{' '}
              <Button
                className={focusClass}
                size="sm"
                variant="secondary"
                onClick={() => void refreshAudit()}
              >
                重试审计
              </Button>
            </p>
          ) : null}
          {audit === null ? (
            <p>正在读取访问记录…</p>
          ) : audit.length === 0 ? (
            <p>暂无访问记录。启用、令牌查看与客户端访问后会在此显示。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">最近知识库共享审计</caption>
                <thead className="text-ink">
                  <tr>
                    {['时间', '来源 IP', '工具 / 事件', '状态'].map((label) => (
                      <th key={label} scope="col" className="py-2 pr-3 font-medium">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {audit.map((entry, index) => (
                    <tr key={`${entry.time}-${index}`} className="border-t border-line/50">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {Number.isNaN(Date.parse(entry.time))
                          ? '时间不可用'
                          : new Date(entry.time).toLocaleString()}
                      </td>
                      <td className="py-2 pr-3 break-all">{entry.remote || '本机'}</td>
                      <td className="py-2 pr-3 break-all">
                        {entry.tool || AUDIT_EVENT_LABELS[entry.event] || entry.event}
                      </td>
                      <td className="py-2 break-all">
                        {entry.status === 'ok'
                          ? '成功'
                          : entry.status === 'error'
                            ? '失败'
                            : entry.status || '已记录'}
                        {entry.errorCode ? ` · ${entry.errorCode}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <details className="border-t border-line/60 pt-3">
          <summary className={`cursor-pointer font-medium text-ink py-1 ${focusClass}`}>
            连接不上？排障清单
          </summary>
          <ol className="mt-3 space-y-2 list-decimal pl-5 leading-relaxed">
            <li>
              先确认状态为「共享运行中」，客户端 URL 使用上方当前地址。IP
              变更时更新配置，或使用可解析的 .local 地址。
            </li>
            <li>
              在客户端设备执行 <code>nc -vz &lt;主机IP&gt; &lt;端口&gt;</code>{' '}
              检查连通性；确认两台设备在同一内网，访客 Wi-Fi 未开启客户端隔离。
            </li>
            <li>
              macOS 防火墙开启时允许应用（开发态 Electron /
              node）传入连接，不启用「阻止所有传入连接」。ad-hoc 签名应用升级后可能再次询问。
            </li>
            <li>
              Windows Defender 弹窗只勾选「专用网络」。本应用不会替你修改系统防火墙或添加端口转发。
            </li>
            <li>
              401：检查客户端环境变量与最新令牌；轮换后所有设备都需要更新。404：旧会话已失效，重新连接或重启客户端。
            </li>
            <li>
              503 /
              kb_sessions_full：会话已满，请关闭闲置客户端；kb_busy：排队繁忙，稍后重试。网卡不可用时改选当前私网
              IP。
            </li>
            <li>
              不要用浏览器直接访问 MCP：带 Origin 的请求会被拒绝。公共或访客 Wi-Fi
              请停用共享；加密需求使用 Tailscale / WireGuard。
            </li>
          </ol>
        </details>
      </div>
      {confirm ? (
        <SharingConfirm
          action={confirm}
          busy={busy}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm === 'wildcard') {
              changeSettings({ bindAddress: wildcard })
              setConfirm(null)
            } else if (confirm === 'enable')
              void run(() => enableKbLanMcp(), '启用请求已完成，请以最新服务状态为准')
            else if (confirm === 'disable')
              void run(
                () => disableKbLanMcp(revoke),
                revoke ? '停用请求已完成，令牌已作废' : '停用请求已完成，保留令牌供下次启用',
              )
            else
              void run(
                () => rotateKbLanMcpToken(),
                '令牌已轮换；请在所有设备上更新环境变量并重新连接',
              )
          }}
        >
          {confirm === 'enable' ? (
            <>
              <p className="text-seal-2 font-medium">
                传输未加密：HTTP 会传送令牌与知识库正文，同网段嗅探可能截获内容。
              </p>
              <p>
                只在家庭、公司有线网或可信 Wi-Fi 上开启；公共或访客 Wi-Fi 请勿开启。需要加密请绑定
                Tailscale / WireGuard 地址。
              </p>
              <p>仅共享已发布标准库的只读检索与正文，不开放原始库、写操作或应用管理权限。</p>
              <p>
                随时可在本卡点击「停用共享」关闭监听；怀疑令牌泄露时选择轮换，或停用并作废令牌。
              </p>
              {dirty ? <p className="text-seal-2">高级设置尚未应用，本次使用已保存配置。</p> : null}
            </>
          ) : null}
          {confirm === 'disable' ? (
            <>
              <p>将关闭监听并断开全部会话。默认保留令牌，下次启用无需重新配置设备。</p>
              <label className="flex gap-2 items-center">
                <input
                  type="checkbox"
                  checked={revoke}
                  disabled={busy}
                  onChange={(e) => setRevoke(e.target.checked)}
                />
                停用并作废令牌（所有设备需重新配置）
              </label>
            </>
          ) : null}
          {confirm === 'rotate' ? (
            <p>
              所有已配置设备将断开，需要更新令牌。旧令牌立即失效，无宽限期；本操作不会自动显示新令牌。
            </p>
          ) : null}
          {confirm === 'wildcard' ? (
            <p className="text-seal-2">
              {wildcard} 会在所有网卡上监听，包括
              VPN、热点与虚拟机网桥，可能扩大暴露范围。源地址放行段仍然生效。确认后仍需点击「应用高级设置」才会生效。
            </p>
          ) : null}
        </SharingConfirm>
      ) : null}
    </section>
  )
}
