// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  exportPortableKb: vi.fn(), previewPortableKb: vi.fn(), importPortableKb: vi.fn(),
  getPortableKbRestore: vi.fn(), restorePreviousLocalKb: vi.fn(),
}));
vi.mock('../../api/client', () => api);
vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { KbTransferPanel } from './KbTransferPanel';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const preview = {
  releaseId: 'r_shared', docCount: 12, sourceCount: 8, fileCount: 30,
  archiveBytes: 1024, unpackedBytes: 2048, currentReleaseId: 'r_local', alreadyInstalled: false,
};
const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent?.includes(label))!;

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.clearAllMocks();
  api.getPortableKbRestore.mockResolvedValue({ previousReleaseId: null });
  api.previewPortableKb.mockResolvedValue(preview);
  api.importPortableKb.mockResolvedValue({ ...preview, previousReleaseId: 'r_local' });
  Object.defineProperty(window, 'desktop', { configurable: true, value: {
    chooseKbExportPath: vi.fn().mockResolvedValue('/tmp/share.fskb'),
    chooseKbImportPath: vi.fn().mockResolvedValue('/tmp/shared.fskb'),
    revealInFolder: vi.fn(),
  } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('previews the package, discloses source snapshots, and imports only after confirmation', async () => {
  const changed = vi.fn();
  await act(async () => root.render(<KbTransferPanel releaseId="r_local" activeBuild={false} onChanged={changed} />));
  expect(host.textContent).toContain('来源快照、证据图片和治理记录');
  await act(async () => button('导入共享包').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(api.previewPortableKb).toHaveBeenCalledWith('/tmp/shared.fskb');
  expect(api.importPortableKb).not.toHaveBeenCalled();
  expect(host.textContent).toContain('12 篇');
  expect(host.textContent).toContain('r_local');
  await act(async () => button('校验并导入').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(api.importPortableKb).toHaveBeenCalledWith('/tmp/shared.fskb', 'r_local');
  expect(changed).toHaveBeenCalledOnce();
});

it('blocks import while a build is running but still permits export of the formal release', async () => {
  await act(async () => root.render(<KbTransferPanel releaseId="r_local" activeBuild onChanged={vi.fn()} />));
  await act(async () => button('导入共享包').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(button('校验并导入').disabled).toBe(true);
  expect(button('导出标准库').disabled).toBe(false);
});
