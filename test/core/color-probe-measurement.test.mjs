/**
 * The color-probe instrument checked against images with known chroma.
 *
 * These tests establish that the reader and classifier can distinguish full
 * desaturation from residual color before a reference is trusted.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import {
  PATCHES,
  SLIDE,
  patchRect,
} from '../../scripts/paint-filter-color-probe-shared.mjs';
import {
  classifyDesaturation,
  readPatches,
  summarizePage,
} from '../../scripts/measure-paint-filter-color-probe.mjs';

async function syntheticSlide(directory, name, colors) {
  const pixels = Buffer.alloc(SLIDE.w * SLIDE.h * 3, 255);
  for (const [index, rgb] of colors.entries()) {
    const rect = patchRect(index);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const offset = (y * SLIDE.w + x) * 3;
        pixels[offset] = rgb[0];
        pixels[offset + 1] = rgb[1];
        pixels[offset + 2] = rgb[2];
      }
    }
  }
  const path = join(directory, name);
  await sharp(pixels, {
    raw: { width: SLIDE.w, height: SLIDE.h, channels: 3 },
  }).png().toFile(path);
  return path;
}

const gray = ([r, g, b]) => {
  const value = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  return [value, value, value];
};

const partlyDesaturate = ([r, g, b], amount = 0.2) => {
  const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r, g, b].map((channel) => Math.round(value + amount * (channel - value)));
};

describe('the paint-filter color-probe instrument', () => {
  it('reads every patch RGB from the expected slide position', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'color-probe-t-'));
    try {
      const path = await syntheticSlide(directory, 'reference.png', PATCHES.map((patch) => patch.rgb));
      const readings = await readPatches(path);
      expect(readings).toHaveLength(PATCHES.length);
      for (const [index, reading] of readings.entries()) {
        for (let channel = 0; channel < 3; channel++) {
          expect(reading.rgb[channel]).toBeCloseTo(PATCHES[index].rgb[channel], 1);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('classifies genuinely gray output as full desaturation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'color-probe-t-'));
    try {
      const reference = await readPatches(await syntheticSlide(
        directory,
        'reference.png',
        PATCHES.map((patch) => patch.rgb),
      ));
      const desaturated = await readPatches(await syntheticSlide(
        directory,
        'gray.png',
        PATCHES.map((patch) => gray(patch.rgb)),
      ));
      const summary = summarizePage(reference, desaturated);
      expect(summary.chromaRatio).toBe(0);
      expect(classifyDesaturation(summary).status).toBe('PASS');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('detects residual color instead of calling it grayscale', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'color-probe-t-'));
    try {
      const reference = await readPatches(await syntheticSlide(
        directory,
        'reference.png',
        PATCHES.map((patch) => patch.rgb),
      ));
      const stillColored = await readPatches(await syntheticSlide(
        directory,
        'partial.png',
        PATCHES.map((patch) => partlyDesaturate(patch.rgb)),
      ));
      const summary = summarizePage(reference, stillColored);
      expect(summary.chromaRatio).toBeGreaterThan(0.15);
      expect(classifyDesaturation(summary).status).toBe('FAIL');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
