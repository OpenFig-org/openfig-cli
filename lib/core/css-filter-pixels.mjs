/**
 * Apply the colour-only CSS filter functions OpenFig accepts to decoded RGBA
 * pixels.
 *
 * Both image hosts use this implementation. Sharp and Canvas still decode and
 * encode their own images, but the actual filter arithmetic is shared so a
 * generated deck does not change appearance according to which host built it.
 *
 * The array is mutated in place. Alpha is preserved.
 */

const clampByte = (value) => Math.max(0, Math.min(255, value));
const clampUnit = (value) => Math.max(0, Math.min(1, value));

/**
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {{fn: string, amount: number}[]} ops
 * @returns {Uint8Array|Uint8ClampedArray}
 */
export function applyCssFilterRgba(rgba, ops) {
  if (!ArrayBuffer.isView(rgba) || rgba.byteLength % 4 !== 0) {
    throw new Error('applyCssFilterRgba: expected an RGBA byte array');
  }
  if (!Array.isArray(ops)) {
    throw new Error('applyCssFilterRgba: expected an operation array');
  }

  for (const { fn, amount } of ops) {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`applyCssFilterRgba: invalid ${fn} amount ${amount}`);
    }
    if (!['brightness', 'contrast', 'grayscale', 'invert', 'sepia', 'saturate'].includes(fn)) {
      throw new Error(`applyCssFilterRgba: unsupported filter ${fn}`);
    }
  }

  for (let offset = 0; offset < rgba.length; offset += 4) {
    let r = rgba[offset];
    let g = rgba[offset + 1];
    let b = rgba[offset + 2];

    for (const { fn, amount } of ops) {
      if (fn === 'brightness') {
        r *= amount;
        g *= amount;
        b *= amount;
      } else if (fn === 'contrast') {
        const intercept = 127.5 * (1 - amount);
        r = r * amount + intercept;
        g = g * amount + intercept;
        b = b * amount + intercept;
      } else if (fn === 'grayscale') {
        const mix = clampUnit(amount);
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r += (luma - r) * mix;
        g += (luma - g) * mix;
        b += (luma - b) * mix;
      } else if (fn === 'invert') {
        const mix = clampUnit(amount);
        r += (255 - 2 * r) * mix;
        g += (255 - 2 * g) * mix;
        b += (255 - 2 * b) * mix;
      } else if (fn === 'sepia') {
        const mix = clampUnit(amount);
        const sr = 0.393 * r + 0.769 * g + 0.189 * b;
        const sg = 0.349 * r + 0.686 * g + 0.168 * b;
        const sb = 0.272 * r + 0.534 * g + 0.131 * b;
        r += (sr - r) * mix;
        g += (sg - g) * mix;
        b += (sb - b) * mix;
      } else if (fn === 'saturate') {
        const sr = (0.213 + 0.787 * amount) * r
          + (0.715 - 0.715 * amount) * g
          + (0.072 - 0.072 * amount) * b;
        const sg = (0.213 - 0.213 * amount) * r
          + (0.715 + 0.285 * amount) * g
          + (0.072 - 0.072 * amount) * b;
        const sb = (0.213 - 0.213 * amount) * r
          + (0.715 - 0.715 * amount) * g
          + (0.072 + 0.928 * amount) * b;
        r = sr;
        g = sg;
        b = sb;
      }

      // Chromium quantises after every authored primitive. Component-transfer
      // functions use byte truncation; colour-matrix functions round to the
      // nearest byte. Keeping that distinction is observable in long chains.
      const quantize = ['brightness', 'contrast', 'invert'].includes(fn)
        ? Math.floor
        : Math.round;
      r = quantize(clampByte(r));
      g = quantize(clampByte(g));
      b = quantize(clampByte(b));
    }

    rgba[offset] = r;
    rgba[offset + 1] = g;
    rgba[offset + 2] = b;
  }

  return rgba;
}
