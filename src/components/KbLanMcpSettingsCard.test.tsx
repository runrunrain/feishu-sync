// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KbLanMcpStatus } from '../types/kb-lan-mcp'
const api = vi.hoisted(() => ({
  status: vi.fn(),
  settings: vi.fn(),
  audit: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  save: vi.fn(),
  rotate: vi.fn(),
  reveal: vi.fn(),
}))
vi.mock('../api/client', () => ({
  APIError: class extends Error {},
  getKbLanMcpStatus: api.status,
  getKbLanMcpSettings: api.settings,
  getKbLanMcpAudit: api.audit,
  enableKbLanMcp: api.enable,
  disableKbLanMcp: api.disable,
  saveKbLanMcpSettings: api.save,
  rotateKbLanMcpToken: api.rotate,
  revealKbLanMcpToken: api.reveal,
}))
import { KbLanMcpSettingsCard, kbLanClientConfig, kbLanStateText } from './KbLanMcpSettingsCard'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const base: KbLanMcpStatus = {
  enabled: false,
  state: 'disabled',
  bindAddress: 'auto',
  resolvedHost: null,
  port: 47391,
  urls: [],
  sessions: 0,
  inflight: 0,
  queued: 0,
  heapUsed: 0,
  lastError: null,
  tokenMasked: null,
  interfaces: [{ name: 'en0', address: '192.168.1.23' }],
}
const running: KbLanMcpStatus = {
  ...base,
  enabled: true,
  state: 'running',
  resolvedHost: '192.168.1.23',
  urls: ['http://192.168.1.23:47391/mcp', 'http://studio.local:47391/mcp'],
  sessions: 3,
  queued: 2,
  tokenMasked: 'fskb_abcd…wxyz',
}
// Synthetic credential stays inside test memory. Never output it in snapshots/reports.
const secret = ['fskb', 'component', 'fixture'].join('_')
let container: HTMLDivElement, root: Root, clipboard: ReturnType<typeof vi.fn>
async function mount(status = base) {
  api.status.mockResolvedValue(status)
  await act(async () => root.render(<KbLanMcpSettingsCard />))
}
function button(name: string): HTMLButtonElement {
  const item = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
  if (!item) throw new Error(`Missing button: ${name}`)
  return item
}
async function click(name: string) {
  await act(async () => button(name).click())
}
async function change(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      element.tagName === 'SELECT'
        ? HTMLSelectElement.prototype
        : element.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(
      new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    )
  })
}
beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset())
  api.settings.mockResolvedValue({
    kbLanMcp: { bindAddress: 'auto', port: 47391, maxSessions: 16 },
  })
  api.audit.mockResolvedValue([])
  api.enable.mockResolvedValue(running)
  api.disable.mockResolvedValue({})
  api.save.mockResolvedValue({})
  api.rotate.mockResolvedValue({})
  api.reveal.mockResolvedValue(secret)
  clipboard = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboard },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('内网 MCP 设置交互（模拟管理 API）', () => {
  it('默认关闭；开启必须确认明文风险/只读范围/停用方式，并刷新权威状态', async () => {
    await mount()
    expect(container.textContent).toContain('已停用')
    expect(api.reveal).not.toHaveBeenCalled()
    await click('开启共享')
    expect(api.enable).not.toHaveBeenCalled()
    const dialog = container.querySelector('[role=dialog]')!
    expect(dialog.textContent).toContain('传输未加密')
    expect(dialog.textContent).toContain('只读')
    expect(dialog.textContent).toContain('停用共享')
    expect(document.activeElement).toBe(button('取消'))
    api.status.mockResolvedValue(running)
    await click('确认开启')
    expect(api.enable).toHaveBeenCalledWith()
    expect(container.textContent).toContain('共享运行中')
    expect(api.status.mock.calls.length).toBeGreaterThan(1)
    expect(container.textContent).toContain('会话 3 · 在途 0 · 排队 2')
    expect(api.reveal).not.toHaveBeenCalled()
  })
  it('加载与不可达禁用开关，刷新后可恢复', async () => {
    let resolve!: (value: KbLanMcpStatus) => void
    api.status.mockReturnValue(
      new Promise<KbLanMcpStatus>((done) => {
        resolve = done
      }),
    )
    await act(async () => root.render(<KbLanMcpSettingsCard />))
    expect(button('开启共享').disabled).toBe(true)
    await act(async () => resolve(base))
    api.status.mockRejectedValue(new Error('network'))
    await click('刷新')
    expect(button('开启共享').disabled).toBe(true)
    expect(container.textContent).toContain('当前状态未知')
    api.status.mockResolvedValue(base)
    await click('刷新')
    expect(button('开启共享').disabled).toBe(false)
  })
  it('掩码默认显示；显示/隐藏/复制均显式，失焦清除明文', async () => {
    await mount(running)
    expect(container.textContent).not.toContain(secret)
    await click('显示')
    expect(api.reveal).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain(secret)
    await act(async () => window.dispatchEvent(new Event('blur')))
    expect(container.textContent).not.toContain(secret)
    await click('复制令牌')
    expect(clipboard).toHaveBeenCalledWith(secret)
    expect(container.textContent).not.toContain(secret)
    await click('显示')
    await click('隐藏')
    expect(container.textContent).not.toContain(secret)
  })
  it('异步 reveal 在隐藏或卸载后返回不会留下明文', async () => {
    await mount(running)
    let resolve!: (value: string) => void
    api.reveal.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done
      }),
    )
    await click('显示')
    await act(async () => window.dispatchEvent(new Event('blur')))
    await act(async () => resolve(secret))
    expect(container.textContent).not.toContain(secret)
    api.reveal.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done
      }),
    )
    await click('显示')
    act(() => root.unmount())
    root = createRoot(container)
    await act(async () => resolve(secret))
    expect(container.textContent).not.toContain(secret)
  })
  it('轮询不 reveal；服务端轮换后的掩码变化清除已显示令牌', async () => {
    vi.useFakeTimers()
    await mount(running)
    await click('显示')
    api.reveal.mockClear()
    api.status.mockResolvedValue({ ...running, tokenMasked: 'fskb_new…mask' })
    await act(async () => vi.advanceTimersByTimeAsync(4000))
    expect(api.reveal).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain(secret)
  })
  it('轮换确认、取消、成功后不自动显示新令牌', async () => {
    await mount(running)
    await click('轮换令牌')
    expect(container.textContent).toContain('所有已配置设备将断开')
    await click('取消')
    expect(api.rotate).not.toHaveBeenCalled()
    await click('轮换令牌')
    await click('确认轮换')
    expect(api.rotate).toHaveBeenCalledOnce()
    expect(api.reveal).not.toHaveBeenCalled()
  })
  it('停用可选作废令牌，完成后从权威状态隐藏连接信息', async () => {
    await mount(running)
    await click('停用共享')
    await act(async () =>
      (container.querySelector('input[type=checkbox]') as HTMLInputElement).click(),
    )
    api.status.mockResolvedValue(base)
    await click('确认停用')
    expect(api.disable).toHaveBeenCalledWith(true)
    expect(container.textContent).toContain('已停用')
    expect(container.querySelector('[aria-label="共享令牌掩码"]')).toBeNull()
  })
  it('服务返回的 .local URL 可复制，配置不包含明文且使用选定地址', async () => {
    await mount(running)
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="复制地址 http://studio.local:47391/mcp"]')!
        .click(),
    )
    expect(clipboard).toHaveBeenLastCalledWith(running.urls[1])
    const selects = container.querySelectorAll('select')
    await change(selects[1], running.urls[1])
    await click('复制 pi配置')
    const pi = clipboard.mock.calls.at(-1)![0] as string
    expect(pi).toContain('${FEISHU_KB_TOKEN}')
    expect(pi).toContain('studio.local')
    expect(pi).not.toContain(secret)
    expect(JSON.parse(pi).mcpServers['feishu-kb'].description).toContain('只读')
    await change(selects[0], 'claude')
    await click('复制 Claude Code配置')
    expect(JSON.parse(clipboard.mock.calls.at(-1)![0]).mcpServers['feishu-kb'].type).toBe('http')
    expect(api.reveal).not.toHaveBeenCalled()
  })
  it('回环监听时不误导复制 .local；异常状态的地址不得复制', async () => {
    const loopback = { ...running, bindAddress: '127.0.0.1', resolvedHost: '127.0.0.1', urls: ['http://127.0.0.1:47391/mcp', running.urls[1]] }
    await mount(loopback)
    expect(container.textContent).toContain('其他设备无法连接')
    expect(container.querySelector<HTMLButtonElement>('[aria-label="复制地址 http://studio.local:47391/mcp"]')!.disabled).toBe(true)
    expect((container.querySelectorAll('select')[1] as HTMLSelectElement).value).toBe(loopback.urls[0])
    expect((container.querySelectorAll('select')[1].options[1] as HTMLOptionElement).disabled).toBe(true)
    api.status.mockResolvedValue({ ...loopback, state: 'port_in_use' })
    await click('刷新')
    expect(container.textContent).toContain('服务未运行')
    expect(container.querySelector<HTMLButtonElement>('[aria-label="复制地址 http://127.0.0.1:47391/mcp"]')!.disabled).toBe(true)
    expect(button('复制 pi配置').disabled).toBe(true)
  })
  it('复制失败明确反馈，不将异常或令牌写入反馈', async () => {
    await mount(running)
    clipboard.mockRejectedValue(new Error(secret))
    await click('复制令牌')
    expect(container.textContent).toContain('令牌复制失败')
    expect(container.textContent).not.toContain(secret)
  })
  it('高级网卡双确认；应用走 settings PUT；轮询不覆盖未提交编辑', async () => {
    vi.useFakeTimers()
    await mount(running)
    const bind = container.querySelectorAll('select')[2]
    await change(bind, '0.0.0.0')
    expect(api.save).not.toHaveBeenCalled()
    expect(container.querySelector('[role=dialog]')!.textContent).toContain('虚拟机网桥')
    await click('取消')
    expect(bind.value).toBe('auto')
    await change(bind, '::')
    await click('确认所有网卡')
    expect(bind.value).toBe('::')
    const numbers = container.querySelectorAll<HTMLInputElement>('input[type=number]')
    await change(numbers[0], '50000')
    await change(numbers[1], '32')
    await change(container.querySelector('textarea')!, '192.168.1.0/24,::1')
    await act(async () => vi.advanceTimersByTimeAsync(4000))
    expect(numbers[0].value).toBe('50000')
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    expect(api.save).toHaveBeenCalledWith({
      bindAddress: '::',
      port: 50000,
      maxSessions: 32,
      allowCidrs: ['192.168.1.0/24', '::1'],
    })
    expect(api.enable).not.toHaveBeenCalled()
  })
  it('清空自定义 CIDR 后按完整资源提交省略值并按回读清空', async () => {
    api.settings.mockResolvedValueOnce({ kbLanMcp: { bindAddress: '127.0.0.1', port: 47391, maxSessions: 8, allowCidrs: ['127.0.0.0/8'] } })
      .mockResolvedValue({ kbLanMcp: { bindAddress: '127.0.0.1', port: 47391, maxSessions: 8 } })
    await mount()
    const textarea = container.querySelector('textarea')!
    expect(textarea.value).toBe('127.0.0.0/8')
    await change(textarea, '')
    await click('应用高级设置')
    expect(api.save).toHaveBeenCalledWith({ bindAddress: '127.0.0.1', port: 47391, maxSessions: 8, allowCidrs: undefined })
    expect(textarea.value).toBe('')
  })
  it('高级设置失败保留草稿，加载失败不伪装默认配置', async () => {
    api.settings.mockRejectedValue(new Error('network'))
    await mount()
    expect(container.textContent).toContain('高级配置读取失败')
    expect(container.querySelector('form')).toBeNull()
    api.settings.mockResolvedValue({})
    await click('重试配置')
    await change(container.querySelector('input[type=number]')!, '50000')
    api.save.mockRejectedValue(new Error('failure'))
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    expect((container.querySelector('input[type=number]') as HTMLInputElement).value).toBe('50000')
    expect(container.querySelector('[role=alert]')).not.toBeNull()
  })
  it('审计空/失败/20条限制，以及所有异常状态中文说明', async () => {
    api.audit.mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        time: '2026-10-29T08:00:00Z',
        event: 'tool_call',
        tool: `tool_${index}`,
        remote: '192.168.1.42',
        status: 'ok',
      })),
    )
    await mount(running)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(20)
    api.audit.mockRejectedValue(new Error('network'))
    await click('刷新')
    expect(container.textContent).toContain('审计读取失败')
    for (const state of [
      'starting',
      'port_in_use',
      'bind_unavailable',
      'no_private_interface',
      'artifact_missing',
      'failed',
    ] as const)
      expect(kbLanStateText({ ...base, state })).not.toContain(state)
  })
  it('确认框焦点圈定、Escape 取消并回到触发控件', async () => {
    await mount()
    button('开启共享').focus()
    await click('开启共享')
    button('确认开启').focus()
    await act(async () =>
      button('确认开启').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })),
    )
    expect(document.activeElement).toBe(button('取消'))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(container.querySelector('[role=dialog]')).toBeNull()
    expect(document.activeElement).toBe(button('开启共享'))
  })
  it('两种配置 JSON 都仅含环境引用', () => {
    for (const client of ['pi', 'claude'] as const)
      expect(
        JSON.parse(kbLanClientConfig(client, running.urls[0])).mcpServers['feishu-kb'].headers
          .Authorization,
      ).toBe('Bearer ${FEISHU_KB_TOKEN}')
  })
})
