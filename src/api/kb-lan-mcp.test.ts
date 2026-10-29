import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enableKbLanMcp,
  disableKbLanMcp,
  getKbLanMcpAudit,
  getKbLanMcpStatus,
  getKbLanMcpSettings,
  saveKbLanMcpSettings,
  revealKbLanMcpToken,
  rotateKbLanMcpToken,
} from './client'
afterEach(() => vi.unstubAllGlobals())
describe('冻结内网 MCP 管理契约 §13.8.2', () => {
  it('路径、方法、启用字段与 settings PUT 分离', async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await enableKbLanMcp({ bindAddress: 'auto', port: 47391, maxSessions: 32 } as {
      bindAddress: string
      port: number
    })
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/kb-lan-mcp/enable',
      expect.objectContaining({ method: 'POST', body: '{"bindAddress":"auto","port":47391}' }),
    )
    await disableKbLanMcp(true)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/kb-lan-mcp/disable',
      expect.objectContaining({ method: 'POST', body: '{"revokeToken":true}' }),
    )
    const settings = {
      bindAddress: '192.168.1.23',
      port: 47391,
      maxSessions: 32,
      allowCidrs: ['192.168.1.0/24'],
    }
    await saveKbLanMcpSettings({ ...settings, enabled: true } as typeof settings)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/kb-lan-mcp/settings',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(settings) }),
    )
    await rotateKbLanMcpToken()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/kb-lan-mcp/token/rotate',
      expect.objectContaining({ method: 'POST' }),
    )
    await getKbLanMcpStatus()
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/kb-lan-mcp/status')
    await getKbLanMcpSettings()
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/config')
    await getKbLanMcpAudit()
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/kb-lan-mcp/audit?limit=20')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('reveal'))).toBe(false)
  })
  it('显式 reveal 使用不可缓存 POST，空响应拒绝而非假成功', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(revealKbLanMcpToken()).rejects.toThrow('服务未返回令牌')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/kb-lan-mcp/token/reveal',
      expect.objectContaining({ method: 'POST', cache: 'no-store' }),
    )
  })
})
