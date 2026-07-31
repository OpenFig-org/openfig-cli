import { describe, expect, it } from 'vitest';
import {
  SOURCE_COLOR_RISK_RANGE,
  SOURCE_DARK_COLOR_RISK_RANGE,
  sourceColorAnalysisSize,
  sourceDarkColorRisk,
  sourceColorProfileFromRgba,
  sourceColorRisk,
} from '../../lib/core/image-analysis.mjs';

const profile = (...pixels) =>
  sourceColorProfileFromRgba(Uint8ClampedArray.from(pixels.flat()));

describe('source colour analysis', () => {
  it('preserves aspect ratio without enlarging small images', () => {
    expect(sourceColorAnalysisSize(1920, 1080)).toEqual({
      width: 64,
      height: 36,
    });
    expect(sourceColorAnalysisSize(24, 12)).toEqual({
      width: 24,
      height: 12,
    });
  });

  it('reports no gamma-vs-linear difference for neutral pixels', () => {
    const out = profile(
      [0, 0, 0, 255],
      [64, 64, 64, 255],
      [180, 180, 180, 255],
      [255, 255, 255, 255],
    );
    expect(out.cssLinearLumaDelta).toBeCloseTo(0, 10);
    expect(out.highlightCssLinearLumaDelta).toBeCloseTo(0, 10);
    expect(sourceColorRisk(out)).toBe(0);
    expect(sourceDarkColorRisk(out)).toBe(0);
  });

  it('detects saturated source colour without treating every hue as a highlight', () => {
    const red = profile([255, 0, 0, 255]);
    const blue = profile([0, 0, 255, 255]);
    const magenta = profile([255, 0, 255, 255]);
    for (const out of [red, blue, magenta]) {
      expect(out.cssLinearLumaDelta).toBeGreaterThan(0);
    }
    // These encoded colours are all below the highlight fade-in at level 96.
    expect(sourceColorRisk(red)).toBe(0);
    expect(sourceColorRisk(blue)).toBe(0);
    expect(sourceColorRisk(magenta)).toBe(0);
    expect(sourceDarkColorRisk(red)).toBe(1);
    expect(sourceDarkColorRisk(blue)).toBe(1);
    expect(sourceDarkColorRisk(magenta)).toBe(1);
  });

  it('finds bright saturated colour where Highlights can amplify it', () => {
    const orange = profile([255, 128, 0, 255]);
    expect(orange.cssLinearLumaDelta).toBeGreaterThan(
      SOURCE_COLOR_RISK_RANGE.full,
    );
    expect(orange.highlightCssLinearLumaDelta).toBeGreaterThan(
      SOURCE_COLOR_RISK_RANGE.full,
    );
    expect(sourceColorRisk(orange)).toBe(1);
    expect(sourceDarkColorRisk(orange)).toBe(0);
  });

  it('weights partial alpha and ignores invisible RGB', () => {
    const visible = profile([255, 0, 0, 255]);
    const withInvisibleBlue = profile(
      [255, 0, 0, 255],
      [0, 0, 255, 0],
    );
    expect(withInvisibleBlue.cssLinearLumaDelta)
      .toBeCloseTo(visible.cssLinearLumaDelta, 10);
    expect(withInvisibleBlue.highlightCssLinearLumaDelta)
      .toBeCloseTo(visible.highlightCssLinearLumaDelta, 10);
    expect(withInvisibleBlue.sampleWeight).toBe(1);
  });

  it('uses a continuous risk band rather than a binary threshold', () => {
    const { safe, full } = SOURCE_COLOR_RISK_RANGE;
    expect(sourceColorRisk({ highlightCssLinearLumaDelta: safe })).toBe(0);
    expect(sourceColorRisk({
      highlightCssLinearLumaDelta: (safe + full) / 2,
    }))
      .toBeCloseTo(0.5, 10);
    expect(sourceColorRisk({ highlightCssLinearLumaDelta: full })).toBe(1);
    expect(sourceColorRisk(null)).toBe(0);
  });

  it('uses a separate continuous band for divergence below highlights', () => {
    const { safe, full } = SOURCE_DARK_COLOR_RISK_RANGE;
    expect(sourceDarkColorRisk({
      cssLinearLumaDelta: safe,
      highlightCssLinearLumaDelta: 0,
    })).toBe(0);
    expect(sourceDarkColorRisk({
      cssLinearLumaDelta: (safe + full) / 2,
      highlightCssLinearLumaDelta: 0,
    })).toBeCloseTo(0.5, 10);
    expect(sourceDarkColorRisk({
      cssLinearLumaDelta: full,
      highlightCssLinearLumaDelta: 0,
    })).toBe(1);
    expect(sourceDarkColorRisk({
      cssLinearLumaDelta: full,
      highlightCssLinearLumaDelta: SOURCE_COLOR_RISK_RANGE.full,
    })).toBe(0);
    expect(sourceDarkColorRisk(null)).toBe(0);
  });

  it('rejects malformed pixel buffers and dimensions', () => {
    expect(() => sourceColorProfileFromRgba(new Uint8Array(3)))
      .toThrow('expected an RGBA byte array');
    expect(() => sourceColorAnalysisSize(0, 20))
      .toThrow('expected positive image dimensions');
  });
});
