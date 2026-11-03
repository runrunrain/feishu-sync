import { describe, expect, it } from 'vitest';
import { occupiedImageBounds, planVisionImageTiles } from '../src/agent/vision/vision-image-tiles.js';

describe('vision image timeout fallback', () => {
  it('crops wide blank margins and splits a tall sparse diagram into two readable regions', () => {
    const width = 2560; const height = 2560;
    const bitmap = Buffer.alloc(width * height * 4, 255);
    for (let y = 20; y < 2500; y += 2) {
      for (let x = 600; x < 1010; x += 2) {
        const offset = (y * width + x) * 4;
        bitmap[offset] = 80; bitmap[offset + 1] = 100; bitmap[offset + 2] = 150;
      }
    }
    const bounds = occupiedImageBounds(bitmap, width, height);
    expect(bounds.x).toBeGreaterThan(500);
    expect(bounds.width).toBeLessThan(550);
    const tiles = planVisionImageTiles(bounds, width, height);
    expect(tiles).toHaveLength(2);
    expect(tiles[0].y).toBe(0);
    expect(tiles[0].y + tiles[0].height).toBeGreaterThan(tiles[1].y);
    expect(tiles[1].y + tiles[1].height).toBe(bounds.y + bounds.height);
    expect(tiles.every((tile) => tile.width < 600 && tile.height < 1600)).toBe(true);
  });

  it('does not create a duplicate request for a fully occupied small image', () => {
    const width = 800; const height = 600;
    const bitmap = Buffer.alloc(width * height * 4, 0);
    for (let offset = 3; offset < bitmap.length; offset += 4) bitmap[offset] = 255;
    const bounds = occupiedImageBounds(bitmap, width, height);
    expect(planVisionImageTiles(bounds, width, height)).toEqual([]);
  });

  it('keeps transparent pixels out of the occupied area', () => {
    const width = 200; const height = 200;
    const bitmap = Buffer.alloc(width * height * 4, 0);
    const offset = (80 * width + 60) * 4;
    bitmap[offset + 3] = 255;
    expect(occupiedImageBounds(bitmap, width, height)).toEqual({ x: 36, y: 56, width: 49, height: 49 });
  });

  it('caps the number of fallback model calls', () => {
    expect(planVisionImageTiles({ x: 0, y: 0, width: 8000, height: 8000 }, 8000, 8000)).toEqual([]);
  });
});
