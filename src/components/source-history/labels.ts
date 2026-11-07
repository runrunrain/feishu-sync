/**
 * 时间展示纯函数；独立成文件便于单测锚定。formatTime 供移出记录
 * （move-out/labels）、移出记录区与节点详情等共用。
 */

/** 时间展示：ISO → 本地可读（失败回落原文）。 */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '时间未知';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
