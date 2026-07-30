import { describe, it, expect } from 'vitest';
import { applyCssFilterRgba } from '../../lib/core/css-filter-pixels.mjs';

const pixel = (rgba, ops) => {
  const bytes = Uint8Array.from(rgba);
  applyCssFilterRgba(bytes, ops);
  return [...bytes];
};

describe('CSS filter pixel arithmetic', () => {
  it('matches the measured 50% grayscale sample and preserves alpha', () => {
    expect(pixel([255, 0, 0, 73], [{ fn: 'grayscale', amount: 0.5 }]))
      .toEqual([155, 27, 27, 73]);
  });

  it('applies operations in authored order with clipping between primitives', () => {
    const input = [100, 150, 200, 255];
    const brightnessThenContrast = pixel(input, [
      { fn: 'brightness', amount: 1.5 },
      { fn: 'contrast', amount: 0.5 },
    ]);
    const contrastThenBrightness = pixel(input, [
      { fn: 'contrast', amount: 0.5 },
      { fn: 'brightness', amount: 1.5 },
    ]);

    expect(brightnessThenContrast).toEqual([138, 176, 191, 255]);
    expect(contrastThenBrightness).toEqual([169, 207, 244, 255]);
  });

  it('supports partial invert, sepia and saturation rather than dropping them', () => {
    expect(pixel([20, 100, 220, 91], [{ fn: 'invert', amount: 0.5 }]))
      .toEqual([127, 127, 127, 91]);
    expect(pixel([20, 100, 220, 91], [{ fn: 'sepia', amount: 0 }]))
      .toEqual([20, 100, 220, 91]);
    expect(pixel([20, 100, 220, 91], [{ fn: 'saturate', amount: 0 }]))
      .toEqual([92, 92, 92, 91]);
  });

  it('rejects malformed input and unsupported operations', () => {
    expect(() => applyCssFilterRgba(Uint8Array.of(1, 2, 3), []))
      .toThrow(/RGBA byte array/);
    expect(() => pixel([1, 2, 3, 4], [{ fn: 'blur', amount: 1 }]))
      .toThrow(/unsupported filter blur/);
  });

  it('matches Chromium quantisation at component-transfer boundaries', () => {
    expect(pixel([0, 1, 254, 255], [{ fn: 'contrast', amount: 0.5 }]))
      .toEqual([63, 64, 190, 255]);
    expect(pixel([116, 1, 0, 255], [{ fn: 'brightness', amount: 1.55 }]))
      .toEqual([179, 1, 0, 255]);
  });
});
