/**
 * The calibration instrument itself, checked against transforms whose answer is
 * known in advance.
 *
 * This exists because of how the last calibration went wrong. Exposure was
 * measured by mean luminance and came out usable; contrast was measured with the
 * same instrument and came out as noise — 69.8, 68.0, 61.3, 62.0, 62.2 across a
 * full sweep — because contrast moves the spread of a histogram and barely
 * touches its mean. The instrument was wrong for the quantity, and nothing said
 * so; the numbers simply looked unhelpful.
 *
 * The instrument is therefore checked against ramps with an exactly known
 * slope. If it cannot recover a slope it was given, it cannot be trusted to
 * discover one.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { readBands, fitLinear, inputLevel, BANDS } from '../../scripts/measure-paint-filter-probe.mjs';

const SLIDE = { w: 1920, h: 1080 };
const RAMP = { x: 160, y: 380, w: 1600, h: 500 };

/**
 * Render a slide-sized PNG holding the probe's ramp, with `transform` applied to
 * every band's level. Mirrors build-paint-filter-probe.mjs's geometry.
 */
async function slideWithRamp(dir, name, transform = (v) => v) {
  const px = Buffer.alloc(SLIDE.w * SLIDE.h * 3, 255);
  const bandW = RAMP.w / BANDS;
  for (let b = 0; b < BANDS; b++) {
    const level = Math.max(0, Math.min(255, Math.round(transform(inputLevel(b)))));
    const x0 = Math.round(RAMP.x + b * bandW);
    const x1 = Math.round(RAMP.x + (b + 1) * bandW);
    for (let y = RAMP.y; y < RAMP.y + RAMP.h; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * SLIDE.w + x) * 3;
        px[i] = level; px[i + 1] = level; px[i + 2] = level;
      }
    }
  }
  const out = join(dir, name);
  await sharp(px, { raw: { width: SLIDE.w, height: SLIDE.h, channels: 3 } }).png().toFile(out);
  return out;
}

const inputs = Array.from({ length: BANDS }, (_, i) => inputLevel(i));

describe('the calibration instrument', () => {
  it('reads back an unmodified ramp as itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-t-'));
    try {
      const bands = await readBands(await slideWithRamp(dir, 'plain.png'));
      expect(bands).toHaveLength(BANDS);
      for (const [i, v] of bands.entries()) {
        expect(Math.abs(v - inputs[i]), `band ${i}: read ${v}, painted ${inputs[i]}`).toBeLessThan(2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers a slope and pivot it was given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-t-'));
    try {
      for (const [slope, pivot] of [[1.5, 127.5], [0.6, 127.5], [1.25, 100]]) {
        const path = await slideWithRamp(dir, `s${slope}-${pivot}.png`,
          (v) => slope * (v - pivot) + pivot);
        const fit = fitLinear(inputs, await readBands(path));
        expect(fit, 'no fit produced').toBeTruthy();
        expect(fit.slope, `slope for ${slope}/${pivot}`).toBeCloseTo(slope, 1);
        // Within a couple of levels, not exact: band levels are integers, so
        // every sample carries up to half a level of quantisation error and the
        // pivot is an extrapolation from them. 1.25/100 recovers as 99.4. That
        // is far finer than anything the calibration needs — the difference
        // being chased is 13% of a luminance, not half a level.
        expect(Math.abs(fit.pivot - pivot), `pivot for ${slope}/${pivot}: got ${fit.pivot}`)
          .toBeLessThan(2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores clipped bands rather than letting them flatten the fit', async () => {
    // A strong stretch drives the ends to 0 and 255. Those bands carry no slope
    // information, and averaging them in pulls the answer toward 1.0 — which is
    // exactly the reading that would make a real effect look like no effect.
    const dir = mkdtempSync(join(tmpdir(), 'probe-t-'));
    try {
      const path = await slideWithRamp(dir, 'clipped.png', (v) => 2.5 * (v - 127.5) + 127.5);
      const bands = await readBands(path);
      const clipped = bands.filter((b) => b <= 3 || b >= 252).length;
      expect(clipped, 'the fixture should actually clip').toBeGreaterThan(4);
      const fit = fitLinear(inputs, bands);
      expect(fit.slope).toBeCloseTo(2.5, 1);
      expect(fit.used, 'clipped bands were included').toBeLessThan(BANDS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes a contrast change that mean luminance cannot see', async () => {
    // The point of the whole instrument. Both of these have almost the same mean
    // and very different slopes; the old measurement could not tell them apart.
    const dir = mkdtempSync(join(tmpdir(), 'probe-t-'));
    try {
      const flat = await readBands(await slideWithRamp(dir, 'flat.png', (v) => 0.6 * (v - 127.5) + 127.5));
      const steep = await readBands(await slideWithRamp(dir, 'steep.png', (v) => 1.6 * (v - 127.5) + 127.5));
      const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
      expect(Math.abs(mean(flat) - mean(steep)), 'means should be close, hence the old failure')
        .toBeLessThan(12);
      expect(fitLinear(inputs, flat).slope).toBeLessThan(0.8);
      expect(fitLinear(inputs, steep).slope).toBeGreaterThan(1.3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
