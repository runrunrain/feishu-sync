/** Desktop uses the restricted native bridge; web keeps the browser permission model. */
export async function writeClipboardText(value: string): Promise<void> {
  if (window.desktop?.writeClipboardText) {
    await window.desktop.writeClipboardText(value);
    return;
  }
  await navigator.clipboard.writeText(value);
}
