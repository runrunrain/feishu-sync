/** Utility-process execPath is a Helper executable; exported CLI/MCP commands should use the desktop launcher. */
export function runtimeExecutable(): string {
  return process.versions.electron && process.env.FEISHU_SYNC_DESKTOP_EXECUTABLE
    ? process.env.FEISHU_SYNC_DESKTOP_EXECUTABLE : process.execPath;
}
