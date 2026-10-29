// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceNodeMenu } from './SourceNodeMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('source node context menu', () => {
  let container: HTMLDivElement | undefined;
  let root: ReturnType<typeof createRoot> | undefined;
  afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = undefined; container = undefined; });

  it('routes sync and folder actions to the right-clicked node', () => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    const onSyncNode = vi.fn(), onOpenFolder = vi.fn(), onClose = vi.fn();
    const props = { target: { objToken: 'clicked', title: '节点', x: 20, y: 20, localPath: 'folder/doc.md', canSync: true },
      onClose, onDelete: vi.fn(), onSyncNode, onOpenFolder };
    act(() => root!.render(<SourceNodeMenu {...props} />));
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    act(() => buttons.find((b) => b.textContent === '同步此节点')!.click());
    expect(onSyncNode).toHaveBeenCalledWith('clicked'); expect(onClose).toHaveBeenCalledTimes(1);
    act(() => buttons.find((b) => b.textContent === '在文件夹中打开')!.click());
    expect(onOpenFolder).toHaveBeenCalledWith('folder/doc.md');
  });

  it('keeps synchronization disabled for an unchanged node', () => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    act(() => root!.render(<SourceNodeMenu target={{ objToken: 'unchanged', title: '节点', x: 0, y: 0, canSync: false }} onClose={vi.fn()} onDelete={vi.fn()} onSyncNode={vi.fn()} />));
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === '同步此节点');
    expect(button?.disabled).toBe(true);
  });

  it.each([1, 3])('keeps delete without block or cloud move entries (selection: %s)', (count) => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    const onDelete = vi.fn();
    const target = { objToken: 'doc', title: '文档', x: 20, y: 20 };
    act(() => root!.render(<SourceNodeMenu target={target} count={count} onClose={vi.fn()} onDelete={onDelete} />));
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(buttons.map((button) => button.textContent)).toEqual([count > 1 ? `删除所选 ${count} 篇…` : '删除文档…']);
    act(() => buttons[0].click());
    expect(onDelete).toHaveBeenCalledWith(target);
  });
});
