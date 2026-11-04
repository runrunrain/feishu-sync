/**
 * A slow, sparse diagram can exhaust a vision request even when its file is
 * small. In Electron, crop its occupied area and split that area into readable
 * tiles before retrying. The original bytes remain the cache identity.
 */
import type { VisionImageMime, VisionRequest } from './vision-channel.js';

export interface VisionTileRect { x: number; y: number; width: number; height: number }
export interface VisionImageTile { bytes: Buffer; mime: VisionImageMime }

type ImagePort = { on(name: string, handler: (event: { data: Record<string, unknown> }) => void): void; postMessage(data: unknown): void };
const imagePort = (process as NodeJS.Process & { parentPort?: ImagePort }).parentPort;
let nextTileRequest = 0;
const tileRequests = new Map<number, (tiles: VisionImageTile[]) => void>();
imagePort?.on('message', ({ data }) => {
  if (data.type !== 'vision_tiles_result' || typeof data.id !== 'number') return;
  const finish = tileRequests.get(data.id); if (!finish) return;
  const tiles: VisionImageTile[] = [];
  if (Array.isArray(data.tiles)) for (const value of data.tiles as unknown[]) {
    const tile = value as { bytes?: unknown; mime?: unknown } | null;
    if (tile?.bytes instanceof Uint8Array && ['image/png', 'image/jpeg', 'image/webp'].includes(String(tile.mime))) {
      tiles.push({ bytes: Buffer.from(tile.bytes), mime: tile.mime as VisionImageMime });
    }
  }
  finish(tiles);
});

/** The bitmap is BGRA on Electron's supported desktop platforms. */
export function occupiedImageBounds(bitmap: Buffer, width: number, height: number): VisionTileRect {
  const full = { x: 0, y: 0, width, height };
  if (width <= 0 || height <= 0 || bitmap.length < width * height * 4) return full;
  let left = width; let top = height; let right = -1; let bottom = -1;
  // Two-pixel sampling keeps this bounded for large screenshots. Padding below
  // preserves thin strokes that fall between sample points.
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const offset = (y * width + x) * 4;
      if (bitmap[offset + 3] < 16) continue;
      if (bitmap[offset] >= 245 && bitmap[offset + 1] >= 245 && bitmap[offset + 2] >= 245) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return full;
  const padX = Math.max(24, Math.ceil(width * 0.015));
  const padY = Math.max(24, Math.ceil(height * 0.015));
  left = Math.max(0, left - padX); top = Math.max(0, top - padY);
  right = Math.min(width, right + padX + 1); bottom = Math.min(height, bottom + padY + 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function planVisionImageTiles(bounds: VisionTileRect, imageWidth: number, imageHeight: number): VisionTileRect[] {
  if (bounds.width <= 0 || bounds.height <= 0) return [];
  const columns = Math.ceil(bounds.width / 1600);
  const rows = Math.ceil(bounds.height / 1600);
  // Avoid multiplying one failed request into a large storm of model calls.
  if (columns * rows > 6) return [];
  const tiles: VisionTileRect[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x0 = bounds.x + Math.floor(column * bounds.width / columns);
      const x1 = bounds.x + Math.ceil((column + 1) * bounds.width / columns);
      const y0 = bounds.y + Math.floor(row * bounds.height / rows);
      const y1 = bounds.y + Math.ceil((row + 1) * bounds.height / rows);
      // Overlap neighboring tiles so labels and arrows at a seam stay intact.
      const left = Math.max(0, x0 - (column ? 64 : 0));
      const top = Math.max(0, y0 - (row ? 64 : 0));
      const right = Math.min(imageWidth, x1 + (column < columns - 1 ? 64 : 0));
      const bottom = Math.min(imageHeight, y1 + (row < rows - 1 ? 64 : 0));
      tiles.push({ x: left, y: top, width: right - left, height: bottom - top });
    }
  }
  const only = tiles[0];
  if (tiles.length === 1 && only.x === 0 && only.y === 0 && only.width === imageWidth && only.height === imageHeight) return [];
  return tiles;
}

export async function createVisionImageTiles(request: VisionRequest): Promise<VisionImageTile[]> {
  if (!process.versions.electron || request.mime === 'image/gif') return [];
  if (imagePort) return new Promise((resolve) => {
    const id = ++nextTileRequest;
    const timer = setTimeout(() => { tileRequests.delete(id); resolve([]); }, 15_000);
    tileRequests.set(id, (tiles) => { clearTimeout(timer); tileRequests.delete(id); resolve(tiles); });
    imagePort.postMessage({ type: 'vision_tiles', id, bytes: request.bytes, mime: request.mime });
  });
  try {
    const electron = await import('electron');
    const nativeImage = electron.nativeImage ?? electron.default?.nativeImage;
    if (!nativeImage) return [];
    const image = nativeImage.createFromBuffer(request.bytes);
    if (image.isEmpty()) return [];
    const { width, height } = image.getSize();
    if (width * height > 24_000_000) return [];
    const bounds = occupiedImageBounds(image.getBitmap(), width, height);
    const rects = planVisionImageTiles(bounds, width, height);
    return rects.map((rect) => ({ bytes: image.crop(rect).toJPEG(88), mime: 'image/jpeg' as const }));
  } catch {
    // Image decode/crop failure must not hide the original provider failure.
    return [];
  }
}
