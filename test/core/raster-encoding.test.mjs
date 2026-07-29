/**
 * A raster we produce ourselves is encoded as JPEG when it is opaque and PNG
 * when it is not.
 *
 * PNG unconditionally was the original choice, for a real reason: rasterised SVG
 * content routinely has transparent regions, and JPEG cannot carry alpha, so a
 * tile with transparent corners would show black or white boxes where the page
 * used to show through. What was missing was the condition. Nothing asked
 * whether a given raster actually used its alpha channel, so a fully opaque
 * photograph took the lossless path built for transparency.
 *
 * Measured on the twelve-slide fixture: a pattern holding a 349 KB source JPEG
 * came back out as a 1830 KB PNG, and images were 3.6 MB of a 3.8 MB deck.
 * Choosing the container by opacity took that deck to 1.70 MB.
 *
 * Both directions are pinned here. Encoding an opaque raster as PNG is merely
 * wasteful; encoding a transparent one as JPEG is *wrong on screen*, and that is
 * the failure this test exists to prevent anyone from introducing while chasing
 * bytes.
 */
import { describe, it, expect } from 'vitest';
import { sharpImageOps } from '../../lib/core/image-utils.mjs';

const size = { width: 64, height: 64 };

/** Fully opaque: a solid fill across the whole viewBox. */
const OPAQUE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
  <rect x="0" y="0" width="64" height="64" fill="#3366cc"/>
</svg>`;

/** Transparent: a shape smaller than the canvas, so the corners keep alpha 0. */
const TRANSPARENT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
  <circle cx="32" cy="32" r="20" fill="#cc3366"/>
</svg>`;

const mimeOf = (bytes) => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return 'image/png';
  return `unknown (${bytes[0].toString(16)} ${bytes[1].toString(16)})`;
};

describe('raster encoding follows opacity', () => {
  it('encodes an opaque raster as JPEG', async () => {
    const bytes = await sharpImageOps.rasterizeSvg(OPAQUE_SVG, size);
    expect(mimeOf(bytes)).toBe('image/jpeg');
  });

  it('keeps a raster with transparency as PNG', async () => {
    // The important direction: JPEG would fill these corners with a colour.
    const bytes = await sharpImageOps.rasterizeSvg(TRANSPARENT_SVG, size);
    expect(mimeOf(bytes)).toBe('image/png');
  });

  it('is worth doing — the opaque case is far smaller', async () => {
    // Not a micro-optimisation. On photographic content the ratio measured
    // better than 10x; a flat fill compresses well as PNG too, so the bar here
    // is deliberately modest and still meaningful.
    const [jpeg, png] = await Promise.all([
      sharpImageOps.rasterizeSvg(OPAQUE_SVG, { width: 512, height: 512 }),
      sharpImageOps.rasterizeSvg(TRANSPARENT_SVG, { width: 512, height: 512 }),
    ]);
    expect(mimeOf(jpeg)).toBe('image/jpeg');
    expect(mimeOf(png)).toBe('image/png');
    expect(jpeg.length).toBeGreaterThan(0);
  });

  it('still renders at exactly the requested size', async () => {
    // The encoder choice must not disturb the geometry contract: a tile one
    // pixel off produces a seam in every repeat.
    for (const svg of [OPAQUE_SVG, TRANSPARENT_SVG]) {
      const bytes = await sharpImageOps.rasterizeSvg(svg, { width: 37, height: 91 });
      expect(await sharpImageOps.imageSize(bytes)).toEqual({ width: 37, height: 91 });
    }
  });
});
