/**
 * The CSS-to-Figma filter mappings, pinned against the measurements they came
 * from.
 *
 * Both are pinned to the observed native transfer functions, and both contain
 * behavior that arithmetic alone would have missed:
 *
 * **Contrast clamps at ±0.5.** Values of -1, -0.75 and -0.5 produce
 * byte-identical output, as do 0.5, 0.75 and 1. The old mapping wrote
 * `amount - 1`, so a strong CSS contrast produced a number Figma ignores past
 * half its range.
 *
 * **Contrast's reachable range is slope 0.767 to 1.115.** CSS `contrast(1.15)`
 * asks for slope 1.15 and Figma cannot reach it. That is a limit to respect, not
 * a target to scale toward.
 *
 * **Exposure is a tone curve, not a gain.** It lifts shadows and rolls
 * highlights off, so the per-tone multiplier spans 1.75 at exposure 0.5. No
 * single value matches a CSS brightness everywhere; the table anchors on
 * mid-tone, where photographic content sits.
 *
 * These tests exist because none of that was covered before — the mapping was a
 * guess for contrast and an uncalibrated table for exposure, and nothing would
 * have failed if either had been quietly wrong.
 */
import { describe, it, expect } from 'vitest';
import {
  BRIGHTNESS_TONE_REFINEMENT,
  contrastForCss,
  exposureForBrightness,
  toneAdjustmentsForBrightness,
  CONTRAST_CURVE,
  EXPOSURE_CURVE,
} from '../../lib/slides/handoff/element-dispatch.mjs';

describe('contrast', () => {
  it('is the identity at CSS contrast(1)', () => {
    expect(contrastForCss(1)).toBe(0);
  });

  it('never writes a value Figma ignores', () => {
    // Beyond ±0.5 nothing happens, so writing 0.8 is indistinguishable from 0.5
    // on screen and merely misleading in the file.
    for (const css of [0, 0.1, 0.5, 0.9, 1, 1.1, 1.5, 3, 10]) {
      const v = contrastForCss(css);
      expect(v, `contrast(${css}) -> ${v}`).toBeGreaterThanOrEqual(-0.5);
      expect(v, `contrast(${css}) -> ${v}`).toBeLessThanOrEqual(0.5);
    }
  });

  it('does not write the old naive amount - 1', () => {
    // The specific regression: contrast(1.15) was written as 0.15, whose
    // measured slope is about 1.058 against the 1.15 requested.
    expect(contrastForCss(1.15)).not.toBeCloseTo(0.15, 2);
  });

  it('increases with requested contrast, and saturates where Figma does', () => {
    const seq = [0.6, 0.8, 1, 1.05, 1.1].map(contrastForCss);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i], `not monotonic at index ${i}: ${seq}`).toBeGreaterThanOrEqual(seq[i - 1]);
    }
    // Anything asking for more slope than 1.115 lands on the same setting.
    expect(contrastForCss(1.2)).toBe(contrastForCss(5));
  });

  it('reduces contrast for CSS values below 1', () => {
    expect(contrastForCss(0.8)).toBeLessThan(0);
    expect(contrastForCss(0.5)).toBeLessThanOrEqual(contrastForCss(0.8));
  });
});

describe('exposure', () => {
  it('is the identity at CSS brightness(1)', () => {
    expect(exposureForBrightness(1)).toBe(0);
  });

  it('round-trips every measured sample back to its own exposure', () => {
    // The table is the inverse of a measurement; asking it for a response it
    // recorded must return the setting that produced it.
    for (const [exposure, response] of EXPOSURE_CURVE) {
      expect(exposureForBrightness(response), `response ${response}`).toBeCloseTo(exposure, 3);
    }
  });

  it('increases with requested brightness', () => {
    const seq = [0.3, 0.6, 1, 1.4, 1.8].map(exposureForBrightness);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i], `not monotonic at index ${i}: ${seq}`).toBeGreaterThan(seq[i - 1]);
    }
  });

  it('stays inside the range Figma accepts', () => {
    for (const css of [0, 0.01, 0.5, 1, 2, 5, 100]) {
      const v = exposureForBrightness(css);
      expect(v, `brightness(${css}) -> ${v}`).toBeGreaterThanOrEqual(-1);
      expect(v, `brightness(${css}) -> ${v}`).toBeLessThanOrEqual(1);
    }
  });

  it('is sampled finely enough that interpolation error stays small', () => {
    // The open question on the old seven-point table was whether a value landing
    // between samples inherited too much chord error. Checked by walking the
    // midpoint of every interval: the recovered response should sit close to the
    // average of its neighbours, which it only does if the curve is near-linear
    // at this spacing.
    for (let i = 0; i < EXPOSURE_CURVE.length - 1; i++) {
      const [, r0] = EXPOSURE_CURVE[i];
      const [, r1] = EXPOSURE_CURVE[i + 1];
      const mid = (r0 + r1) / 2;
      const e = exposureForBrightness(mid);
      expect(e).toBeGreaterThan(EXPOSURE_CURVE[i][0] - 1e-6);
      expect(e).toBeLessThan(EXPOSURE_CURVE[i + 1][0] + 1e-6);
    }
  });
});

describe('editable brightness tone refinement', () => {
  it('leaves brightness darkening on the calibrated Exposure curve', () => {
    for (const brightness of [0, 0.25, 0.5, 0.9, 1]) {
      expect(toneAdjustmentsForBrightness(brightness)).toEqual({
        exposure: exposureForBrightness(brightness),
      });
    }
  });

  it('reproduces both measured brightening fits', () => {
    expect(toneAdjustmentsForBrightness(1.18)).toEqual({
      exposure: 0.1,
      highlights: 0.55,
      shadows: -0.15,
    });
    expect(toneAdjustmentsForBrightness(1.55)).toEqual({
      exposure: 0.3292,
      highlights: 1,
      shadows: -0.75,
    });
  });

  it('interpolates monotonically and clamps the extra controls', () => {
    const seq = [1, 1.05, 1.18, 1.3, 1.55, 1.8, 5]
      .map(toneAdjustmentsForBrightness);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i].exposure).toBeGreaterThanOrEqual(seq[i - 1].exposure);
      expect(seq[i].highlights ?? 0).toBeGreaterThanOrEqual(
        seq[i - 1].highlights ?? 0,
      );
      expect(seq[i].shadows ?? 0).toBeLessThanOrEqual(seq[i - 1].shadows ?? 0);
    }
    expect(seq.at(-1)).toMatchObject({ highlights: 1, shadows: -0.75 });
    expect(seq.at(-1).exposure).toBeLessThanOrEqual(1);
  });

  it('records identity plus the two measured calibration anchors', () => {
    expect(BRIGHTNESS_TONE_REFINEMENT).toEqual([
      [1, 0, 0, 0],
      [1.18, -0.0034, 0.55, -0.15],
      [1.55, 0, 1, -0.75],
    ]);
  });
});

describe('the curves themselves', () => {
  it('are monotonic in response, or inversion is meaningless', () => {
    for (const [name, curve] of [['CONTRAST', CONTRAST_CURVE], ['EXPOSURE', EXPOSURE_CURVE]]) {
      for (let i = 1; i < curve.length; i++) {
        expect(curve[i][0], `${name} value at ${i}`).toBeGreaterThan(curve[i - 1][0]);
        expect(curve[i][1], `${name} response at ${i}`).toBeGreaterThan(curve[i - 1][1]);
      }
    }
  });

  it('record contrast as clamped at ±0.5 and exposure as full range', () => {
    expect(CONTRAST_CURVE[0][0]).toBe(-0.5);
    expect(CONTRAST_CURVE[CONTRAST_CURVE.length - 1][0]).toBe(0.5);
    expect(EXPOSURE_CURVE[0][0]).toBe(-1);
    expect(EXPOSURE_CURVE[EXPOSURE_CURVE.length - 1][0]).toBe(1);
  });
});
