import type { IpcMainInvokeEvent, WebContents } from 'electron';

export const MAX_CLIPBOARD_BYTES = 1024 * 1024;

/** Only the current main window's main frame may write text. Never include the value in errors. */
export function writeClipboardText(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  trusted: WebContents | null,
  value: unknown,
  write: (text: string) => void,
): void {
  if (!trusted || trusted.isDestroyed() || event.sender !== trusted || !event.senderFrame || event.senderFrame !== trusted.mainFrame) {
    throw new Error('Clipboard access denied');
  }
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_CLIPBOARD_BYTES) {
    throw new Error('Invalid clipboard text');
  }
  try { write(value); } catch { throw new Error('Clipboard write failed'); }
}
