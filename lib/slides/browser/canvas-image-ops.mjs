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

function mimeOf(src) {
  if (src && typeof src === 'object' && !ArrayBuffer.isView(src) && src.mime) return src.mime;
  return isSvgSource(src) ? 'image/svg+xml' : 'application/octet-stream';
}

/**
 * Decode to an `<img>`, optionally at an explicit raster size.
 *
 * The size only does anything for SVG: a vector source rasterises at whatever
 * dimensions the element is given, which is how `bakeFilter` reaches the
 * density `sharp` gets from its `density` option. For raster sources the
 * intrinsic size wins and `width`/`height` are ignored.
 */
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
    await img.decode();
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
};
