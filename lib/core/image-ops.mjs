/**
 * The three raster operations the deck-emission tail needs, as a contract.
 *
 * Documentation plus two tiny helpers — no image library is imported here, on
 * purpose. Node implements this over `sharp` (`sharpImageOps` in
 * `./image-utils.mjs`); a browser implements it over Canvas
 * (`../slides/browser/canvas-image-ops.mjs`).
 *
 * `sharp` is not in the converter core's import graph — it sits in the deck
 * writer — so this is a fourth capability group beside `ConversionHost`
 * rather than part of it, and a Node conversion that passes no `imageOps`
 * keeps using `sharp` exactly as before.
 *
 * **The two implementations cannot be byte-identical and must not be asserted
 * to be.** `sharp` resamples with Lanczos3 and encodes PNG with libspng;
 * Canvas resamples with Skia's kernel and encodes with SkPngEncoder. Identical
 * input pixels produce different output bytes, and `Slide.addImage` names the
 * archive entry after the sha1 of those bytes — so a thumbnail recode renames
 * an `images/*` entry and rewrites `canvas.fig`, which embeds the name. The
 * parity check for this change compares thumbnail *dimensions*, not bytes.
 *
 * @typedef {string|Uint8Array|{filename?: string, bytes: Uint8Array, mime?: string}} ImageSource
 *   A path (Node only), raw bytes, or a media record. The record form is what
 *   `../browser/memory-bundle.mjs` hands out, and it is the only one that
 *   carries a mime type — which is the only reliable SVG signal once there is
 *   no filename to inspect.
 *
 * @typedef {object} ImageOps
 * @property {(src: ImageSource) => Promise<{width: number, height: number}>} imageSize
 *   Intrinsic pixel dimensions. An SVG with no intrinsic size reports its real
 *   size under `sharp` and Chromium's 300x150 fallback under Canvas.
 * @property {(src: ImageSource) => Promise<Uint8Array>} thumbnailPng
 *   PNG, 320px wide, aspect preserved, never enlarged.
 * @property {(src: ImageSource, filter: {invert?: number, forceWhite?: boolean},
 *   opts?: {displayWidth?: number}) => Promise<Uint8Array>} bakeFilter
 *   PNG with the parsed CSS filter baked in. Always PNG, so alpha survives
 *   both `invert(1)` and the `brightness(0) invert(1)` white-mask trick.
 */

/** Longest side of a thumbnail. `./image-utils.mjs` is the reference encoder. */
export const THUMBNAIL_WIDTH = 320;

/**
 * Is this source an SVG?
 *
 * Mime first, filename second. `bakeImageFilter` used to answer this by
 * testing the source *path* for a `.svg` suffix, which silently became `false`
 * the moment the source became bytes — and an SVG rasterised without an
 * explicit density comes out blurry rather than wrong, so nothing downstream
 * notices.
 *
 * @param {ImageSource} src
 */
export function isSvgSource(src) {
  if (typeof src === 'string') return /\.svg$/i.test(src);
  if (src && typeof src === 'object' && !ArrayBuffer.isView(src)) {
    if (src.mime) return String(src.mime).toLowerCase().startsWith('image/svg');
    if (src.filename) return /\.svg$/i.test(src.filename);
  }
  return false;
}

/**
 * The rasterisation density an SVG needs to hold up at `displayWidth` under
 * typical Figma zoom: ~4x the target width, floored so tiny glyphs still get
 * a usable bitmap. Shared so both implementations scale identically.
 *
 * @param {number} [displayWidth]
 */
export function svgDensityFor(displayWidth) {
  return Math.max(192, Math.round((displayWidth || 256) * 4 * 72 / 256));
}
