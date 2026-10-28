/**
 * 白板旁路导出共享函数（P0-S6 交付 / P0-S8 提炼复用）。
 *
 * 设计依据：lark-cli-newcaps-P0.md §5.1–§5.3 + §10 裁定 1（P0-S1 HP-4）：
 * - svg 主产物（文字为真实 <text>/<tspan> 节点）→ 失败/超时/校验不过
 *   降级 raw（nodes[i].text.text / connector.captions 抽取路径）；
 * - 双失败仅告警（whiteboard_svg_unavailable），永不抛错、永不阻断
 *   正文提交（缺 PNG 阻断、缺旁路降级——§5.1 不变量）；
 * - 命名（§5.2）：与 PNG 同主干 <stem>.wb.svg / <stem>.wb.raw.json，
 *   不被 md 引用、不进 feishu_sync 头，构建侧按命名约定寻址。
 *
 * 消费方（同一导出链，勿复制分叉）：
 * - SyncEngine.downloadImages（结构树同步，S6）；
 * - SyncEngine.backfillWhiteboardBypass（存量补齐，S8——先落到 staging
 *   镜像路径再经 atomic-commit 入位，见该方法注释）；
 * - custom-doc-sync.downloadMediaReferences（归档文档同步，S8 接入）。
 *
 * 本模块自 S8 起从 sync-engine.ts 方法体提炼为纯函数：调用方自行注入
 * client 与 options（配置解析见 resolveWhiteboardExportOptionsFromConfig），
 * 导出目标路径由 pngPath 主干派生（pngPath 本身从不被读取，只用于命名）。
 */

import fs from 'node:fs';

/** 旁路文件体积上限（设计 §5.3：8 MiB，超限视为不可用，不入库）。 */
export const WHITEBOARD_BYPASS_MAX_BYTES = 8 * 1024 * 1024;

export interface WhiteboardBypassOptions {
  enabled: boolean;
  svgTimeoutMs?: number;
}

/** 导出产物：type 对应设计 §5.2 的两种旁路形态。 */
export interface WhiteboardBypassFile {
  type: 'svg' | 'raw';
  path: string;
}

/**
 * lark-cli 客户端契约（LarkCliClient.exportWhiteboard 子集；可选方法与
 * 实际客户端/测试替身同形：缺失 → 调用方先守卫，本函数内亦降级跳过）。
 */
export interface WhiteboardExportClient {
  exportWhiteboard?(
    whiteboardToken: string,
    opts: { outputType: 'svg' | 'raw'; outputPath: string; timeoutMs?: number },
  ): Promise<string>;
}

/**
 * 读取 sync.whiteboardExport 配置。缺省开启（设计 §5.3：additive，缺省
 * true）——旧配置无 sync 段、测试替身 config、字段缺失部一律回落默认；
 * 仅显式 enabled:false 关闭。svgTimeoutMs 仅接受正有限数。
 */
export function resolveWhiteboardExportOptionsFromConfig(
  config: unknown,
): WhiteboardBypassOptions {
  const segment = (
    config as {
      sync?: { whiteboardExport?: { enabled?: unknown; svgTimeoutMs?: unknown } } | undefined;
    } | null | undefined
  )?.sync?.whiteboardExport;
  if (segment?.enabled === false) return { enabled: false };
  const timeout = segment?.svgTimeoutMs;
  return {
    enabled: true,
    ...(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
      ? { svgTimeoutMs: timeout }
      : {}),
  };
}

/**
 * 白板旁路导出（永不抛错）：svg 主产物 → 失败/超时/校验不过降级 raw →
 * 双失败仅告警（whiteboard_svg_unavailable），返回 undefined。
 *
 * 校验链（设计 §5.3）：非空、≤ 8 MiB；svg 额外要求开头 2 KiB 内含
 * "<svg"（防错误页/空壳被当作产物入库）。校验不过删 staging 残留。
 */
export async function exportWhiteboardBypassFile(
  client: WhiteboardExportClient,
  pngPath: string,
  whiteboardToken: string,
  options: WhiteboardBypassOptions,
): Promise<WhiteboardBypassFile | undefined> {
  if (!options.enabled) return undefined;
  // 旧客户端/测试替身无 +export 封装 → 跳过不告警（与 slides 截图链
  // 容错先例一致；主要守卫在调用方，此处兑底）。
  if (typeof client?.exportWhiteboard !== 'function') return undefined;

  const exporter = client.exportWhiteboard.bind(client);
  const stem = pngPath.replace(/\.[^./\\]+$/, '');
  const svgTarget = `${stem}.wb.svg`;
  const rawTarget = `${stem}.wb.raw.json`;
  const discard = (target: string): void => {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // 残留清理失败不升级：文件在 staging 内，不入库即无害。
    }
  };
  const validate = (filePath: string, kind: 'svg' | 'raw'): boolean => {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size === 0) return false;
      if (stat.size > WHITEBOARD_BYPASS_MAX_BYTES) return false;
      if (kind === 'svg') {
        const head = fs.readFileSync(filePath).subarray(0, 2048).toString('utf-8');
        if (!head.includes('<svg')) return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  let svgFailure: unknown;
  try {
    const svgPath = await exporter(whiteboardToken, {
      outputType: 'svg',
      outputPath: svgTarget,
      timeoutMs: options.svgTimeoutMs,
    });
    if (!validate(svgPath, 'svg')) {
      discard(svgPath);
      throw new Error('svg 形态校验不过（非空 / ≤ 8 MiB / 开头 2 KiB 内含 <svg）');
    }
    return { type: 'svg', path: svgPath };
  } catch (error) {
    svgFailure = error;
    // 设计 §5.3：失败/校验不过 → 删 staging 残留再降级。
    discard(svgTarget);
  }

  try {
    const rawPath = await exporter(whiteboardToken, {
      outputType: 'raw',
      outputPath: rawTarget,
    });
    if (!validate(rawPath, 'raw')) {
      discard(rawPath);
      throw new Error('raw 形态校验不过（非空 / ≤ 8 MiB）');
    }
    return { type: 'raw', path: rawPath };
  } catch (rawError) {
    discard(rawTarget);
    // 双失败：仅告警不阻断（§5.1：缺 PNG 阻断、缺旁路降级）。
    console.warn(
      `[whiteboard-bypass] whiteboard_svg_unavailable(token=${whiteboardToken}, ` +
        `svg=${svgFailure instanceof Error ? svgFailure.message : String(svgFailure)}, ` +
        `raw=${rawError instanceof Error ? rawError.message : String(rawError)}); ` +
        `白板旁路导出失败`,
    );
    return undefined;
  }
}
