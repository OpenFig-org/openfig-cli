/**
 * The Node implementation of `./image-ops.mjs`, over sharp.
 *
 * This is the reference implementation and the one every recorded `.deck`
 * baseline was produced with: `Slide.addImage` names each `images/*` entry
 * after the sha1 of the bytes these functions return, so changing anything in
 * here renames archive entries and rewrites `canvas.fig`, which embeds those
 * names. The filter code was moved verbatim out of
 * `../slides/handoff/element-dispatch.mjs` for exactly that reason.
 *
 * `getImageDimensions` / `generateThumbnail` stay as they were for the callers
 * that predate the contract.
 */
import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { isSvgSource, svgDensityFor, THUMBNAIL_WIDTH } from './image-ops.mjs';

/** sharp takes a path or a buffer; a media record carries its bytes. */
function input(src) {
  if (src && typeof src === 'object' && !ArrayBuffer.isView(src) && src.bytes) return src.bytes;
  return src;
}

/** @type {import('./image-ops.mjs').ImageOps} */
export const sharpImageOps = {
  async imageSize(src) {
    const meta = await sharp(input(src)).metadata();
    return { width: meta.width ?? 0, height: meta.height ?? 0 };
  },

  async thumbnailPng(src) {
    return sharp(input(src))
      .resize(THUMBNAIL_WIDTH, null, { withoutEnlargement: true })
      .png()
      .toBuffer();
  },

  async bakeFilter(src, filter, opts = {}) {
    // SVGs need an explicit density to rasterize crisply. Pick ~4× the target
    // display width so the resulting PNG holds up under typical Figma zoom.
    const isSvg = isSvgSource(src);
    const density = isSvg ? svgDensityFor(opts.displayWidth) : 72;
    const from = input(src);
    const pipeline = isSvg ? sharp(from, { density }) : sharp(from);

    if (filter.forceWhite) {
      // brightness(0) invert(1) → every pixel becomes opaque-white where the
      // source had any color, with the source's alpha channel preserved.
      // Implemented as: composite a solid white plate using the source as a
      // `dest-in` mask, which keeps the white only where the source has alpha.
      const meta = await pipeline.metadata();
      const white = sharp({
        create: {
          width: meta.width,
          height: meta.height,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
      });
      // Re-read the source through a fresh pipeline as a composite input —
      // sharp doesn't let us reuse the existing `pipeline` reference.
      const sourceForMask = isSvg
        ? await sharp(from, { density }).png().toBuffer()
        : await sharp(from).png().toBuffer();
      return white
        .composite([{ input: sourceForMask, blend: 'dest-in' }])
        .png()
        .toBuffer();
    }
    if (filter.ops) {
      // Applied in the authored order, because CSS filters compose in
      // sequence and grayscale-then-contrast is not contrast-then-grayscale.
      let out = pipeline;
      for (const { fn, amount } of filter.ops) {
        if (fn === 'grayscale') {
          // Partial grayscale has no direct sharp equivalent; full desaturation
          // covers what exports actually use, and a partial amount is closer to
          // the intent than dropping the filter entirely.
          if (amount > 0) out = out.grayscale();
        } else if (fn === 'brightness') {
          out = out.linear(amount, 0);
        } else if (fn === 'contrast') {
          // out = c*in + 127.5*(1-c) — the 0..255 form of CSS's midpoint pivot.
          out = out.linear(amount, 127.5 * (1 - amount));
        } else if (fn === 'invert') {
          if (amount === 1) out = out.negate({ alpha: false });
        } else if (fn === 'sepia' || fn === 'saturate') {
          // Recognised by the parser so the conversion proceeds, but sharp has
          // no faithful equivalent; leaving the pixels alone beats a wrong one.
          continue;
        }
      }
      return out.png().toBuffer();
    }

    // Plain invert(1): flip RGB, preserve alpha.
    return pipeline.negate({ alpha: false }).png().toBuffer();
  },
};

/**
 * Get pixel dimensions of an image.
 * @param {string|Uint8Array} input - file path or bytes
 * @returns {Promise<{width: number, height: number}>}
 */
export async function getImageDimensions(input) {
  return sharpImageOps.imageSize(input);
}

/**
 * Generate a thumbnail (~320px wide) and write to a temp file.
 * @param {string|Uint8Array} input - file path or bytes
 * @param {string} outPath - destination file path
 * @returns {Promise<void>}
 */
export async function generateThumbnail(input, outPath) {
  writeFileSync(outPath, await sharpImageOps.thumbnailPng(input));
}
