// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { NodeDetailCard } from './NodeDetailCard';
import type { MappingNode } from '../types';
import { externalNavigationUrl, normalizeExternalUrl } from '../utils/external-url';

const url = 'https://example.feishu.cn/wiki/abc?source=share#section';
const node = { obj_token: 'a', title: '示例', obj_type: 'docx', local_path: 'a.md', status: 'synced', original_link: `"${url}"`, cloud_match: 'synced' } as MappingNode;
afterEach(() => { vi.unstubAllGlobals(); });

it('strips matching legacy quotes, preserves URL parts, and rejects unsafe addresses', () => {
  expect(normalizeExternalUrl(`  '${url}' `)).toBe(url);
  expect(normalizeExternalUrl('javascript:alert(1)')).toBeNull();
  expect(normalizeExternalUrl('file:///local')).toBeNull();
  expect(normalizeExternalUrl('"https://example.feishu.cn/wiki/a')).toBeNull();
  expect(externalNavigationUrl('http://127.0.0.1:3001/internal', 'http://127.0.0.1:3001')).toBeNull();
  expect(externalNavigationUrl(url, 'http://127.0.0.1:3001')).toBe(url);
});

it('opens the normalized source link through the desktop bridge and shows failures', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const openExternal = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('desktop', { openExternal });
  const container = document.createElement('div'); const root = createRoot(container);
  try {
    await act(async () => root.render(<NodeDetailCard node={node} />));
    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(url);
    expect(link.textContent).toBe(url);
    await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(openExternal).toHaveBeenCalledWith(url);
    openExternal.mockResolvedValueOnce({ ok: false });
    await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法打开浏览器');
  } finally { act(() => root.unmount()); }
});
