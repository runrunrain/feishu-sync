/**
 * 数据根目录解析（单一事实源）。
 *
 * CLAUDE.md 契约：「环境变量 FEISHU_SYNC_HOME 可整体改根目录（server 与
 * desktop 共享）」。2026-10 复现「首次配置无法保存」问题时发现该契约
 * 只在 electron/main.ts（桌面 IPC）与 server/scripts/*（独立脚本）落地，
 * server 主进程的 config/db/operations/recovery/sync-errors 路径全部
 * 硬编码 os.homedir()/.feishu-sync，环境变量形同虚设——测试隔离与多实例
 * 场景被静默写穿到真实 ~/.feishu-sync。
 *
 * 所有数据落盘路径必须经 resolveDataRoot() 拼接，禁止再次硬编码。
 * lark-cli 可执行发现（lark-cli-client/manager 的 homeDir）是「在哪个用户
 * 环境找 CLI」的语义，不属于数据根，维持 os.homedir() 不变。
 */

import os from 'node:os';
import path from 'node:path';

/** 数据根目录：FEISHU_SYNC_HOME 显式优先，缺省 ~/.feishu-sync。 */
export function resolveDataRoot(): string {
  const override = process.env.FEISHU_SYNC_HOME?.trim();
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), '.feishu-sync');
}
