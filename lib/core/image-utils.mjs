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

/**
 * Quality for a raster we re-encode ourselves. High enough that the result is
 * visually indistinguishable at slide scale, low enough to be worth doing.
 */
const RASTER_JPEG_QUALITY = 82;

/**
 * Encode a rendered pipeline, choosing the container by whether the pixels
 * actually use their alpha channel.
 *
 * PNG was the unconditional choice here, and the reason it was chosen is real:
 * rasterised SVG content routinely has transparent regions, and JPEG cannot
 * carry alpha — emit one for a tile with transparent corners and the page shows
 * through as black or white boxes. What was missing is the *condition*. Nothing
 * asked whether a given raster used its alpha, so a fully opaque photograph took
 * the lossless path built for transparency: one 349 KB source JPEG came back out
 * as a 1830 KB PNG, and images accounted for 3.6 MB of a 3.8 MB deck.
 *
 * `stats()` renders once to answer `isOpaque`, so this costs a decode rather
 * than a guess. Both hosts make the same decision on the same input, which is
 * what keeps their decks comparable.
 */
async function encodeByOpacity(pipeline) {
  let opaque = false;
  try {
    ({ isOpaque: opaque } = await pipeline.clone().stats());
  } catch {
    // An unreadable stat is not a reason to fail the conversion; PNG is always
    // correct, merely larger.
    opaque = false;
  }
  return opaque
    ? pipeline.jpeg({ quality: RASTER_JPEG_QUALITY, mozjpeg: true }).toBuffer()
    : pipeline.png().toBuffer();
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
      return encodeByOpacity(out);
    }

    // Plain invert(1): flip RGB, preserve alpha.
    return encodeByOpacity(pipeline.negate({ alpha: false }));
  },

  async rasterizeSvg(svg, size) {
    const width = Math.max(1, Math.round(size?.width ?? 1));
    const height = Math.max(1, Math.round(size?.height ?? 1));
    // The caller writes the pixel size onto the document's own width/height,
    // so librsvg already renders at the right scale and the resize is a
    // no-op. It is here as the guarantee, not the mechanism: the contract
    // says "exactly width x height", and a document that disagreed with its
    // attributes would otherwise produce a tile one pixel off and a seam in
    // every repeat.
    return encodeByOpacity(
      sharp(Buffer.from(svg, 'utf8')).resize(width, height, { fit: 'fill' }),
    );
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
