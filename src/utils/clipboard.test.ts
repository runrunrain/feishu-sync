// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { writeClipboardText as nativeWrite, MAX_CLIPBOARD_BYTES } from '../../electron/clipboard-service';
import { writeClipboardText } from './clipboard';

afterEach(() => vi.restoreAllMocks());

describe('clipboard bridge', () => {
  it('authorizes only the current live main frame and checks UTF-8 bytes', () => {
    const frame = {};
    const trusted = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents;
    const event = { sender: trusted, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    const write = vi.fn();
    nativeWrite(event, trusted, '测'.repeat(MAX_CLIPBOARD_BYTES / 3 | 0), write);
    nativeWrite(event, trusted, 'a'.repeat(MAX_CLIPBOARD_BYTES), write);
    expect(write).toHaveBeenCalledTimes(2);
    for (const value of [undefined, null, 123, {}, [], new Uint8Array(), 'a'.repeat(MAX_CLIPBOARD_BYTES + 1), '测'.repeat(Math.floor(MAX_CLIPBOARD_BYTES / 3) + 1)]) {
      expect(() => nativeWrite(event, trusted, value, write)).toThrow('Invalid clipboard text');
    }
    expect(() => nativeWrite({ ...event, senderFrame: {} } as IpcMainInvokeEvent, trusted, 'x', write)).toThrow('denied');
    expect(() => nativeWrite({ ...event, senderFrame: null } as unknown as IpcMainInvokeEvent, trusted, 'x', write)).toThrow('denied');
    expect(() => nativeWrite({ ...event, sender: {} } as IpcMainInvokeEvent, trusted, 'x', write)).toThrow('denied');
    expect(() => nativeWrite(event, null, 'x', write)).toThrow('denied');
    const destroyed = { mainFrame: frame, isDestroyed: () => true } as unknown as WebContents;
    expect(() => nativeWrite({ sender: destroyed, senderFrame: frame } as unknown as IpcMainInvokeEvent, destroyed, 'x', write)).toThrow('denied');
    expect(() => nativeWrite(event, trusted, 'sensitive', () => { throw new Error('sensitive'); })).toThrow('Clipboard write failed');
    expect(write).toHaveBeenCalledTimes(2);
  });
  it('prefers native, propagates failure without falling back, and uses web otherwise', async () => {
    const native = vi.fn().mockResolvedValue(undefined);
    const browser = vi.fn().mockResolvedValue(undefined);
    const previousDesktop = window.desktop;
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: browser } });
    try {
      window.desktop = { writeClipboardText: native } as unknown as typeof window.desktop;
      await writeClipboardText('synthetic');
      expect(native).toHaveBeenCalledWith('synthetic'); expect(browser).not.toHaveBeenCalled();
      native.mockRejectedValueOnce(new Error('failure'));
      await expect(writeClipboardText('synthetic')).rejects.toThrow('failure'); expect(browser).not.toHaveBeenCalled();
      window.desktop = undefined;
      await writeClipboardText('web'); expect(browser).toHaveBeenCalledWith('web');
      browser.mockRejectedValueOnce(new Error('denied'));
      await expect(writeClipboardText('web')).rejects.toThrow('denied');
    } finally {
      window.desktop = previousDesktop;
      if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});
