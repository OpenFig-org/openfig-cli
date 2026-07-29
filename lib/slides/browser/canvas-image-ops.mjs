/**
 * The browser implementation of `../../core/image-ops.mjs`, over Canvas.
 *
 * Decoding goes through an `<img>` rather than `createImageBitmap`, because
 * `createImageBitmap` rejects an SVG blob in Chromium and SVG is the one
 * source format that needs special handling here. Encoding goes through
 * `OffscreenCanvas.convertToBlob`, which never leaves premultiplied space —
 * `getImageData` is deliberately not used anywhere in this file, since reading
 * pixels back would unpremultiply and re-premultiply them and quietly cost a
 * bit of precision per round trip.
 *
 * Known, deliberate divergences from `sharp` (see `../../core/image-ops.mjs` for
 * why byte parity is not a goal):
 *
 *   - resampling kernel and PNG encoder differ, so bytes differ for identical
 *     pixels; dimensions do not;
 *   - an ICC-tagged asset is converted into the canvas colour space here and
 *     passed through untouched by `sharp`;
 *   - an SVG with no intrinsic size reports Chromium's 300x150 fallback;
 *   - `imageOrientation: 'none'` is *not* available on `<img>`, so an EXIF-
 *     rotated JPEG is decoded rotated here and unrotated by `sharp`. Only
 *     reachable through `thumbnailPng`/`imageSize`, never through the
 *     full-size asset, which both hosts pass through byte-for-byte.
 */
import { isSvgSource, svgDensityFor, THUMBNAIL_WIDTH } from '../../core/image-ops.mjs';

function bytesOf(src) {
  if (ArrayBuffer.isView(src)) return src;
  if (src && typeof src === 'object' && src.bytes) return src.bytes;
  throw new Error('canvas-image-ops: expected image bytes or a { bytes } record');
}

// Chromium will not decode a blob typed `application/octet-stream` through an
// <img>, and — the part that hurts — `img.decode()` does not reject for it
// either. It simply never settles, so a correct JPEG stalled the conversion
// with no error until a timeout was added. sharp sniffs the bytes itself and
// never needed to be told, which is why the Node path was unaffected.
function sniffImageMime(src) {
  const b = bytesOf(src);
  if (!b || b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  // RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

function mimeOf(src) {
  if (src && typeof src === 'object' && !ArrayBuffer.isView(src) && src.mime) return src.mime;
  if (isSvgSource(src)) return 'image/svg+xml';
  // A wrong type is worse than a missing one: with no type at all the browser
  // sniffs, whereas `application/octet-stream` is an assertion it obeys.
  return sniffImageMime(src) ?? '';
}

/**
 * Decode to an `<img>`, optionally at an explicit raster size.
 *
 * The size only does anything for SVG: a vector source rasterises at whatever
 * dimensions the element is given, which is how `bakeFilter` reaches the
 * density `sharp` gets from its `density` option. For raster sources the
 * intrinsic size wins and `width`/`height` are ignored.
 */
// One image must not be able to stall a whole conversion. Generous enough that
// a large raster on a slow machine still decodes, short enough that a source
// which never settles is reported rather than waited on.
const DECODE_TIMEOUT_MS = 15_000;

async function decode(src, size) {
  const blob = new Blob([bytesOf(src)], { type: mimeOf(src) });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    img.src = url;
    if (size) {
      img.width = Math.max(1, Math.round(size.width));
      img.height = Math.max(1, Math.round(size.height));
    }
    // `load`, not `decode()`. `img.decode()` resolves when the image is ready to
    // *paint*, and Chromium suspends rasterisation in a tab that is not
    // rendering — so in a backgrounded tab it never settles, neither resolving
    // nor rejecting. A conversion started and then switched away from would
    // stop dead with no error and eventually wedge the tab. Measured in a
    // hidden tab: `decode()` did not return within 6s on an 8x8 PNG, while
    // `load` fired in under a millisecond on the same image.
    //
    // The timeout stays as a backstop for a source that genuinely never loads.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`image load timed out after ${DECODE_TIMEOUT_MS}ms`)),
        DECODE_TIMEOUT_MS,
      );
      const done = (err) => { clearTimeout(timer); err ? reject(err) : resolve(); };
      if (img.complete && img.naturalWidth) return done();
      img.addEventListener('load', () => done(), { once: true });
      img.addEventListener('error', () => done(new Error('image failed to load')), { once: true });
    });
    return {
      img,
      width: img.naturalWidth || img.width || 1,
      height: img.naturalHeight || img.height || 1,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function surface(width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

async function toPngBytes(canvas) {
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((resolve, reject) => canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas-image-ops: PNG encoding failed'))),
      'image/png',
    ));
  return new Uint8Array(await blob.arrayBuffer());
}

export const canvasImageOps = {
  async imageSize(src) {
    const d = await decode(src);
    try {
      return { width: d.width, height: d.height };
    } finally {
      d.release();
    }
  },

  async thumbnailPng(src) {
    const d = await decode(src);
    try {
      // `withoutEnlargement`: a source narrower than 320 is copied at its own
      // size. The height is `round(h * 320 / w)` — arithmetic, not resampling,
      // so both implementations must agree on it exactly.
      const scale = d.width > THUMBNAIL_WIDTH ? THUMBNAIL_WIDTH / d.width : 1;
      const w = Math.round(d.width * scale);
      const h = Math.round(d.height * scale);
      const canvas = surface(w, h);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(d.img, 0, 0, w, h);
      return await toPngBytes(canvas);
    } finally {
      d.release();
    }
  },

  async bakeFilter(src, filter, opts = {}) {
    const isSvg = isSvgSource(src);
    let d = await decode(src);
    let w = d.width;
    let h = d.height;
    if (isSvg) {
      // The Canvas analogue of sharp's `density`: re-decode the vector at the
      // pixel size that density would have produced, rather than at its
      // intrinsic size.
      const scale = svgDensityFor(opts.displayWidth) / 72;
      d.release();
      w = Math.max(1, Math.round(d.width * scale));
      h = Math.max(1, Math.round(d.height * scale));
      d = await decode(src, { width: w, height: h });
    }
    try {
      const canvas = surface(w, h);
      const ctx = canvas.getContext('2d');
      if (filter.forceWhite) {
        // brightness(0) invert(1): every pixel the source painted becomes
        // opaque white, with the source's alpha preserved. `source-in` scales
        // the white plate by the destination alpha, which is exactly sharp's
        // `dest-in` composite with the operands the other way round.
        ctx.drawImage(d.img, 0, 0, w, h);
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
      } else {
        // A Canvas applies CSS filters natively, so the authored string is
        // handed straight through — no reimplementation, and no risk of
        // diverging from what the browser rendered. `invert` keeps its own
        // branch only so its bytes stay identical to before.
        ctx.filter = filter.css ?? 'invert(1)';
        ctx.drawImage(d.img, 0, 0, w, h);
        ctx.filter = 'none';
      }
      return await toPngBytes(canvas);
    } finally {
      d.release();
    }
  },

  async rasterizeSvg(svg, size) {
    const width = Math.max(1, Math.round(size?.width ?? 1));
    const height = Math.max(1, Math.round(size?.height ?? 1));
    // Decoded at the requested size rather than at the document's intrinsic
    // one: `decode(src, size)` sets width/height on the <img>, which is the
    // only lever a vector source has here, and it is the same lever
    // `bakeFilter` uses to reach sharp's density.
    const src = { bytes: new TextEncoder().encode(svg), mime: 'image/svg+xml' };
    const d = await decode(src, { width, height });
    try {
      const canvas = surface(width, height);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(d.img, 0, 0, width, height);
      return await toPngBytes(canvas);
    } finally {
      d.release();
    }
  },
};
