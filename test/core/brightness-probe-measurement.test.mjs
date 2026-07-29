/**
 * Validate the brightness isolation instrument before trusting its Figma
 * result. The synthetic images exercise only the reader and effect arithmetic;
 * the actual probe deliberately uses the real slide 7 photograph.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import {
  PHOTO,
  SLIDE,
} from '../../scripts/paint-filter-brightness-probe-shared.mjs';
import {
  effectErrorPct,
  readPhotoRegion,
  summarizeLuminance,
} from '../../scripts/measure-paint-filter-brightness-probe.mjs';

async function slideWithBand(directory, name, pixelAt) {
  const pixels = Buffer.alloc(SLIDE.w * SLIDE.h * 3, 255);
  for (let y = PHOTO.y; y < PHOTO.y + PHOTO.h; y++) {
    for (let x = PHOTO.x; x < PHOTO.x + PHOTO.w; x++) {
      const value = pixelAt(x, y);
      const offset = (y * SLIDE.w + x) * 3;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
    }
  }
  const path = join(directory, name);
  await sharp(pixels, {
    raw: { width: SLIDE.w, height: SLIDE.h, channels: 3 },
  }).png().toFile(path);
  return path;
}

describe('the brightness isolation instrument', () => {
  it('reads only the photo band rather than the white slide around it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'brightness-probe-t-'));
    try {
      const path = await slideWithBand(directory, 'flat.png', () => 100);
      const region = await readPhotoRegion(path);
      expect(region.width).toBe(PHOTO.w);
      expect(region.height).toBe(PHOTO.h);
      expect(region.mean).toBeCloseTo(100, 4);
      expect(region.stdev).toBeCloseTo(0, 4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recovers a known histogram spread', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'brightness-probe-t-'));
    try {
      const path = await slideWithBand(
        directory,
        'split.png',
        (x) => (x < PHOTO.w / 2 ? 50 : 150),
      );
      const region = await readPhotoRegion(path);
      expect(region.mean).toBeCloseTo(100, 4);
      expect(region.stdev).toBeCloseTo(50, 4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('normalizes static host differences out of the filter effect', () => {
    // Figma is 10% brighter at baseline and after filtering, so direct means
    // differ while the filter effect is identical.
    expect(effectErrorPct(165, 110, 150, 100)).toBeCloseTo(0, 10);
    // Figma's spread grows 1.2x while CSS grows 1.5x.
    expect(effectErrorPct(60, 50, 75, 50)).toBeCloseTo(-20, 10);
  });

  it('reports clipping as part of the CSS/exposure distinction', () => {
    const stats = summarizeLuminance([10, 100, 254, 255]);
    expect(stats.clippedHighPct).toBe(50);
  });
});
