/**
 * A handoff bundle held in memory, in the shape `handoff/bundle-loader.mjs`
 * produces from a directory.
 *
 * Node's converter writes `manifest.json`, `template.html` and `media/*` to a
 * scratch directory and the deck-emission tail reads them straight back off
 * disk. A browser has no disk, and none of the loader's apparatus —
 * `realpathDeep`, `isContained`, `findManifestRoot`, `unzipToTemp` — has a
 * browser analogue *or* a browser purpose: there is no filesystem to escape
 * into. What survives the crossing is the small object the dispatcher actually
 * consumes.
 *
 * `element-dispatch.mjs` reads exactly five fields off its context —
 * `html`, `resolveMedia`, `slideIndex`, `slideWidth`, `noWrapDiagnostics` —
 * and `handoff-converter.mjs` supplies the last three itself. `rootDir` and
 * `tempRoot` are returned by the loader and read by nobody.
 *
 * The one difference that matters: `resolveMedia` returns `{filename, bytes,
 * mime}` instead of a path. `bakeImageFilter` used to detect SVG by testing
 * the path for a `.svg` suffix, which is `false` for bytes, so an SVG would
 * have rasterised at default density and come out blurry — hence the `mime`,
 * and hence the mime-first branch in the dispatcher.
 */

const EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

function mimeForName(filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

function decodeDataUrl(src) {
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(src);
  if (!m) throw new Error('resolveMedia: malformed data URL');
  const [, mime, b64, payload] = m;
  let bytes;
  if (b64) {
    const bin = atob(payload.replace(/\s+/g, ''));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  // The loader writes these to a content-addressed file whose name never
  // leaves that function, so there is nothing to reproduce here.
  return { filename: null, bytes, mime: mime.toLowerCase() };
}

/**
 * @param {object} init
 * @param {object} init.manifest - The manifest object, already parsed.
 * @param {string|null} [init.html] - `template.html`, for SVG markup lookup.
 * @param {Iterable<{filename: string, bytes: Uint8Array, mime?: string}>|Map} [init.media]
 *   Either the `media` Map the converter core returns (keyed by asset uuid) or
 *   any iterable of media records.
 * @returns {{manifest: object, html: string|null,
 *   resolveMedia: (src: string) => {filename: string|null, bytes: Uint8Array, mime: string}}}
 */
export function createMemoryBundle({ manifest, html = null, media }) {
  const byName = new Map();
  const records = media instanceof Map ? media.values() : (media ?? []);
  for (const ref of records) {
    if (!ref || !ref.filename) continue;
    byName.set(ref.filename, {
      filename: ref.filename,
      bytes: ref.bytes,
      mime: ref.mime ?? mimeForName(ref.filename),
    });
  }

  function resolveMedia(src) {
    if (!src || typeof src !== 'string') {
      throw new Error(`resolveMedia: invalid src ${JSON.stringify(src)}`);
    }
    if (src.startsWith('data:')) return decodeDataUrl(src);
    // The manifest refers to assets as `media/<filename>`; the loader also
    // accepts a bare name and a name relative to the bundle root, so the same
    // three forms resolve here.
    const name = src.split(/[\\/]/).pop();
    const hit = byName.get(name);
    if (!hit) {
      throw new Error(`Media asset not found: ${src} (bundle holds ${byName.size} asset(s))`);
    }
    return hit;
  }

  return { manifest, html, resolveMedia };
}
