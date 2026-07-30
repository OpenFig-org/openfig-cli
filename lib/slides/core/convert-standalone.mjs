/**
 * The converter core: a Claude Design standalone export in, a slide manifest
 * out. Environment-agnostic — no `node:*` imports, direct or transitive, and
 * no reach for `process`, `Buffer` or a filesystem. Everything that touches
 * the outside world goes through the host and its surface
 * (`./host-contract.mjs`).
 *
 * Node drives this from `../html-converter.mjs` via
 * `../node/node-conversion-host.mjs`; a browser drives it over an iframe.
 *
 * Guarded by `test/core/core-portability.test.mjs`, which walks this module's
 * import graph and bundles it for the browser.
 */
import { extractSlides } from '../browser-extract.mjs';
import { prepareForMeasurement } from './measurement-surface.mjs';
import { FIGMA_AVAILABLE_FONTS, normalizeFont } from '../font-normalize.mjs';

const CANVAS_W = 1920;
const CANVAS_H = 1080;

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'text/javascript': 'js',
  'application/javascript': 'js',
};

function extractScriptTag(src, type) {
  const re = new RegExp(`<script type="${type.replace(/\//g, '\\/')}">([\\s\\S]*?)<\\/script>`);
  const m = src.match(re);
  return m ? m[1] : null;
}

export const NOT_A_STANDALONE_EXPORT =
  'html-converter: input is not a Claude Design standalone HTML (missing __bundler/manifest or /template)';

/**
 * Does this text carry the two payloads a conversion needs?
 *
 * Exported so a host can answer the question *before* committing to a
 * conversion — in a browser, before the export is ever loaded into an iframe
 * and its scripts run. That ordering is a security property, not only a UX
 * one: arbitrary HTML never reaches a live realm. The core re-checks anyway,
 * so a host that forgets still cannot get past this point.
 *
 * @param {string} sourceHtml
 * @returns {{ok: boolean, reason: string|null}}
 */
export function checkStandaloneExport(sourceHtml) {
  if (typeof sourceHtml !== 'string' || sourceHtml === '') {
    return { ok: false, reason: NOT_A_STANDALONE_EXPORT };
  }
  const hasManifest = extractScriptTag(sourceHtml, '__bundler/manifest') != null;
  const hasTemplate = extractScriptTag(sourceHtml, '__bundler/template') != null;
  if (hasManifest && hasTemplate) return { ok: true, reason: null };
  return { ok: false, reason: NOT_A_STANDALONE_EXPORT };
}

// Decode every asset in the export's `__bundler/manifest` and hand it to the
// host, in manifest order. The filename is `<uuid>.<ext>`; `manifest.json`
// refers to assets as `media/<filename>`, so both are part of the contract
// with the handoff stage and neither may drift.
async function decodeAssets(assets, host) {
  const media = new Map();
  for (const [uuid, a] of Object.entries(assets)) {
    const ext = MIME_EXT[a.mime] ?? 'bin';
    const filename = `${uuid}.${ext}`;
    let bytes = host.bytesFromBase64(a.data);
    if (a.compressed) bytes = await host.gunzip(bytes);
    const ref = await host.putMedia(filename, bytes);
    media.set(uuid, { ...ref, mime: a.mime, bytes });
  }
  return media;
}

// Index the decoded assets by content hash so images the standalone's runtime
// resolved to blob: URLs can be matched back to a decoded asset. Hashing is
// the only reliable join: the runtime hands out opaque blob URLs that carry no
// trace of the manifest uuid they came from.
//
// Sequential, not Promise.all: on a hash collision the first asset in manifest
// order wins, and resolving out of order would flip which one that is.
async function indexAssetsBySha1(media, host) {
  const bySha = new Map();
  for (const asset of media.values()) {
    const sha = await host.sha1Hex(asset.bytes);
    if (!bySha.has(sha)) bySha.set(sha, asset);
  }
  return bySha;
}

// Hash every loaded <img> in the realm and pair it with its decoded asset.
// Returns a Map of the live src (blob: URL) → asset record.
//
// SVG `<image>` elements are scanned too, and for the same reason: the export
// writes `href="<asset uuid>"` and its own runtime swaps that for a `blob:`
// URL before anything measures the page, so the uuid is gone by the time the
// extractor serialises the markup. Hashing the bytes is the only join back to
// the decoded asset, exactly as for `<img>`.
//
// Those hrefs are restricted to `blob:` on purpose. An `<img>` src is fetched
// whatever its scheme — behaviour that predates this — but an `<image>` inside
// an inline SVG is new here, and the rule for new code is that nothing from an
// export leaves the machine. A `blob:` URL is the export's own bytes, already
// in memory; anything else is reported and skipped downstream instead.
async function mapImageSrcsToAssets(surface, sha1ToAsset) {
  const { hashed, seen, failed } = await surface.evaluate(async ({ realm }) => {
    const { document, window } = realm;
    const out = [];
    let seen = 0;
    let failed = 0;
    const sources = [];
    for (const img of document.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) continue;
      sources.push(src);
    }
    for (const image of document.querySelectorAll('image')) {
      const href = image.getAttribute('href') || image.getAttribute('xlink:href') || '';
      if (href.startsWith('blob:')) sources.push(href);
    }
    // The same asset referenced twice — slide 3 of the sample draws one photo
    // as a base and again through a mask — must not be counted or fetched
    // twice, or the "none of the images could be read" check below misreads
    // its own totals.
    for (const src of new Set(sources)) {
      seen++;
      try {
        // The realm's own fetch, so the request is made with the export's
        // origin and its blob: URLs resolve. The host page's would see a
        // foreign blob: URL it cannot read.
        const buf = await (await window.fetch(src)).arrayBuffer();
        const digest = await window.crypto.subtle.digest('SHA-1', buf);
        const sha = [...new Uint8Array(digest)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        out.push({ src, sha });
      } catch {
        // Unreachable asset: leave it alone so the handoff stage reports one
        // missing image rather than failing the whole build. Counted, because
        // a CSP that blocks `connect-src blob:` fails *every* image here and
        // the conversion would otherwise report success with none of them.
        failed++;
      }
    }
    return { hashed: out, seen, failed };
  });

  const bySrc = new Map();
  for (const { src, sha } of hashed) {
    const asset = sha1ToAsset.get(sha);
    if (asset) bySrc.set(src, asset);
  }
  return { bySrc, imagesSeen: seen, imagesUnreadable: failed };
}

// Swap SVG-backed <img> elements to data URLs *before* geometry extraction, so
// browser-extract's decodeSvgDataUrl path emits native Figma VECTOR nodes.
// Left as a blob: URL the logo is treated as a raster reference and bakes to
// pixels at display size, losing crispness on Figma zoom. Data URLs load
// in-place, so layout is unchanged.
async function inlineSvgImages(surface, srcToAsset, host) {
  const patches = [];
  for (const [src, asset] of srcToAsset) {
    if (asset.mime !== 'image/svg+xml') continue;
    patches.push({ src, dataUrl: `data:image/svg+xml;base64,${host.base64FromBytes(asset.bytes)}` });
  }
  if (!patches.length) return;
  await surface.evaluate(({ realm, arg: list }) => {
    const { document } = realm;
    for (const { src, dataUrl } of list) {
      for (const img of document.querySelectorAll('img')) {
        if (img.getAttribute('src') === src) img.setAttribute('src', dataUrl);
      }
    }
  }, patches);
}

// Repoint raster <img> srcs at the media artifacts. Runs *after* extraction:
// pointing the DOM at a relative path the page's own origin can't resolve
// would break the images and corrupt the geometry we came for. The extracted
// records and the serialized template are both rewritten from the same map.
function remapExtractedImageSrcs(slides, srcToAsset) {
  const walk = (els) => {
    for (const el of els ?? []) {
      if (el?.type === 'image' && typeof el.src === 'string') {
        const asset = srcToAsset.get(el.src);
        if (asset) el.src = `media/${asset.filename}`;
      }
      // An inline SVG carries its <image> references inside the serialised
      // markup rather than in a field of its own, so the same remap has to
      // reach into the string. It has to happen here and not in the DOM: the
      // extractor already took `outerHTML`, and pointing the live document at
      // a relative path its origin cannot resolve would only break the picture
      // without changing what was captured.
      if (el?.type === 'svg' && typeof el.inline === 'string' && el.inline.includes('blob:')) {
        for (const [src, asset] of srcToAsset) {
          if (!src.startsWith('blob:')) continue;
          el.inline = el.inline.split(src).join(`media/${asset.filename}`);
        }
      }
      if (Array.isArray(el?.children)) walk(el.children);
    }
  };
  for (const s of slides) walk(s.elements);
}

// A blob: href still in the markup after the remap is one the asset scan could
// not pair with a decoded asset. The handoff will refuse to read it — the
// scheme is on the wrong side of the never-fetch rule — so the image is
// missing from the deck, and nothing else in the pipeline is in a position to
// say so: `warnUnsupportedSvg` runs in the realm where the blob is still live
// and legitimate. Reported here, where the failed join is actually known.
function warnUnresolvedSvgImages(slides, collector) {
  for (const s of slides) {
    const walk = (els) => {
      for (const el of els ?? []) {
        if (el?.type === 'svg' && typeof el.inline === 'string') {
          const orphans = el.inline.match(/<image\b[^>]*\bhref\s*=\s*"blob:[^"]*"/gi);
          for (let i = 0; i < (orphans?.length ?? 0); i++) {
            collector.warn(
              s.index,
              'SVG <image> could not be matched to an asset in the export and was dropped',
            );
          }
        }
        if (Array.isArray(el?.children)) walk(el.children);
      }
    };
    walk(s.elements);
  }
}

async function rewriteDomImageSrcs(surface, srcToAsset) {
  const patches = [...srcToAsset]
    .filter(([, asset]) => asset.mime !== 'image/svg+xml')
    .map(([src, asset]) => ({ src, path: `media/${asset.filename}` }));
  if (!patches.length) return;
  await surface.evaluate(({ realm, arg: list }) => {
    const { document } = realm;
    for (const { src, path } of list) {
      for (const img of document.querySelectorAll('img')) {
        if (img.getAttribute('src') === src) img.setAttribute('src', path);
      }
      // template.html is the handoff's fallback when an element carries no
      // `inline` markup, so it has to name the same assets the extracted
      // records do or the two disagree about what a slide contains.
      for (const image of document.querySelectorAll('image')) {
        if (image.getAttribute('href') === src) image.setAttribute('href', path);
        if (image.getAttribute('xlink:href') === src) image.setAttribute('xlink:href', path);
      }
    }
  }, patches);
}

// Replace every `var(--name)` or `var(--name, fallback)` reference in `src`
// with the resolved value from `vars`. Applies repeatedly so nested var()
// indirection (e.g. `--brand: var(--accent)`) fully expands.
function resolveCssVars(src, vars) {
  const VAR_RE = /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g;
  let out = src;
  for (let i = 0; i < 8; i++) {
    let changed = false;
    out = out.replace(VAR_RE, (_, name, fallback) => {
      const v = vars[name];
      if (v != null && v !== '') { changed = true; return v; }
      if (fallback != null) { changed = true; return fallback.trim(); }
      return `var(${name})`;
    });
    if (!changed) break;
  }
  return out;
}

function parseColor(v) {
  if (!v) return undefined;
  const s = String(v).trim();
  if (s === 'transparent' || s === 'none') return undefined;
  if (s.startsWith('#')) {
    return s.length === 4
      ? '#' + [...s.slice(1)].map((c) => c + c).join('').toUpperCase()
      : s.toUpperCase();
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((t) => parseFloat(t.trim()));
    const [r, g, b, a] = parts;
    if (parts.length === 4 && a === 0) return undefined;
    return '#' + [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  return s;
}

// Invert an RGB color value. Returns the input unchanged if the format isn't
// recognized (so unusual literals fall through rather than corrupting the
// SVG). Handles #RGB, #RRGGBB, rgb()/rgba(), and the named colors "black" and
// "white" — enough to cover Claude Design's exports.
function invertCssColor(color) {
  const s = String(color).trim();
  if (s === 'none' || s === 'transparent' || s === 'currentColor') return s;
  if (s.startsWith('#')) {
    const hex = s.length === 4
      ? '#' + [...s.slice(1)].map((c) => c + c).join('')
      : s;
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return color;
    const r = 255 - parseInt(hex.slice(1, 3), 16);
    const g = 255 - parseInt(hex.slice(3, 5), 16);
    const b = 255 - parseInt(hex.slice(5, 7), 16);
    return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(',').map((t) => t.trim());
    const rgb = parts.slice(0, 3).map((t) => parseInt(t, 10));
    if (rgb.some((n) => Number.isNaN(n))) return color;
    const inv = rgb.map((n) => 255 - n);
    return parts.length === 4
      ? `rgba(${inv.join(', ')}, ${parts[3]})`
      : `rgb(${inv.join(', ')})`;
  }
  const lower = s.toLowerCase();
  if (lower === 'black') return '#ffffff';
  if (lower === 'white') return '#000000';
  return color;
}

// Rewrite every fill/stroke color in an SVG string. `mode` is either
// 'invert' (RGB complement) or 'forceWhite' (every visible color → #fff,
// used for the brightness(0) invert(1) "white mask" trick).
//
// Touches three forms of color declaration:
//   1. <… fill="X" stroke="Y" …>
//   2. <… style="fill: X; stroke: Y">
//   3. CSS rules inside <style> blocks
function transformSvgColors(svg, mode) {
  const transform = mode === 'forceWhite'
    ? (val) => {
        const v = String(val).trim();
        if (v === 'none' || v === 'transparent' || v === 'currentColor') return v;
        return '#ffffff';
      }
    : (val) => invertCssColor(val);

  // Attribute form: fill="..." / stroke="..." (single or double quotes)
  let out = svg.replace(
    /\b(fill|stroke)\s*=\s*(['"])([^'"]+)\2/gi,
    (_, attr, quote, val) => `${attr}=${quote}${transform(val)}${quote}`,
  );
  // Inline style attribute: style="fill: ...; stroke: ..."
  out = out.replace(/\bstyle\s*=\s*(['"])([^'"]*)\1/gi, (_, quote, css) => {
    const newCss = css.replace(
      /\b(fill|stroke)\s*:\s*([^;]+)/gi,
      (__, prop, val) => `${prop}: ${transform(val.trim())}`,
    );
    return `style=${quote}${newCss}${quote}`;
  });
  // CSS rules inside <style> blocks
  out = out.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_, attrs, body) => {
    const newBody = body.replace(
      /\b(fill|stroke)\s*:\s*([^;}\s]+)/gi,
      (__, prop, val) => `${prop}: ${transform(val)}`,
    );
    return `<style${attrs}>${newBody}</style>`;
  });
  return out;
}

// Parse the CSS `filter` values we can bake into image bytes at handoff time.
//
// Returns one of:
//   { forceWhite: true, raw }        `brightness(0) invert(1)` in that order —
//                                    every visible pixel becomes white. Kept as
//                                    its own case because it is a compositing
//                                    trick, not a colour transform.
//   { invert: 1, raw }               plain `invert(1)`.
//   { css, ops, raw }                a chain of colour transforms, in order.
//   null                             nothing we can apply; the caller warns.
//
// `css` is the original string retained for recovery metadata; `ops` is the
// same chain decomposed once so both image hosts apply identical arithmetic
// without either having to parse CSS.
const BAKEABLE_FILTERS = new Set(['grayscale', 'brightness', 'contrast', 'invert', 'sepia', 'saturate']);

// `50%` and `0.5` mean the same thing to CSS.
function filterAmount(arg, fallback) {
  if (arg === '') return fallback;
  const pct = /^(-?[\d.]+)%$/.exec(arg);
  const n = pct ? parseFloat(pct[1]) / 100 : parseFloat(arg);
  return Number.isFinite(n) ? n : null;
}

function parseImageFilter(raw) {
  if (!raw || raw === 'none') return null;
  const tokens = String(raw).match(/[a-z-]+\([^)]*\)/gi) || [];
  if (tokens.length === 0) return null;

  const ops = [];
  for (const tok of tokens) {
    const m = tok.match(/^([a-z-]+)\(\s*([^)]*)\s*\)$/i);
    if (!m) return null;
    const fn = m[1].toLowerCase();
    if (!BAKEABLE_FILTERS.has(fn)) return null;   // blur, hue-rotate, drop-shadow…
    const amount = filterAmount(m[2].trim(), 1);
    if (amount === null || amount < 0) return null;
    ops.push({ fn, amount });
  }

  // The two shapes that predate general support, preserved exactly so their
  // output bytes — and therefore their archive entry names — do not move.
  const invert = ops.some((o) => o.fn === 'invert' && o.amount === 1);
  if (
    ops.length === 2
    && ops[0].fn === 'brightness' && ops[0].amount === 0
    && ops[1].fn === 'invert' && ops[1].amount === 1
  ) return { forceWhite: true, raw };
  if (ops.length === 1 && invert) return { invert: 1, raw };

  return { css: String(raw), ops, raw };
}

function normalizeElement(el) {
  if (!el) return null;
  const out = { ...el };
  out.x = Math.round(el.x ?? 0);
  out.y = Math.round(el.y ?? 0);
  if (typeof el.width === 'number') out.width = Math.round(el.width);
  if (typeof el.height === 'number') out.height = Math.round(el.height);

  if (el.type === 'text') {
    out.color = parseColor(el.color);
    out.font = normalizeFont(el.font);
    if (el.size != null) out.size = Math.round(el.size * 100) / 100;
    if (el.lineHeight != null) out.lineHeight = Math.round(el.lineHeight * 100) / 100;
    if (el.letterSpacing != null) out.letterSpacing = Math.round(el.letterSpacing * 100) / 100;
    if (el.noWrap) out.noWrap = true;
    if (el.verticalAlign) out.verticalAlign = el.verticalAlign;
  }
  if (el.type === 'richText') {
    out.color = parseColor(el.color);
    out.font = normalizeFont(el.font);
    if (el.size != null) out.size = Math.round(el.size * 100) / 100;
    if (el.lineHeight != null) out.lineHeight = Math.round(el.lineHeight * 100) / 100;
    if (el.letterSpacing != null) out.letterSpacing = Math.round(el.letterSpacing * 100) / 100;
    if (el.verticalAlign) out.verticalAlign = el.verticalAlign;
    if (Array.isArray(el.runs)) {
      out.runs = el.runs.map((r) => {
        const rr = { text: r.text };
        if (r.color) rr.color = parseColor(r.color);
        if (r.weight) rr.weight = r.weight;
        if (r.style) rr.style = r.style;
        // A run can be in a different family from the paragraph around it — a
        // Space Grotesk unit suffix inside an Instrument Serif number. Carried
        // only when it actually differs, so the ordinary case is unchanged.
        const runFont = r.font ? normalizeFont(r.font) : null;
        if (runFont && runFont !== out.font) rr.font = runFont;
        return rr;
      });
    }
  }
  if (el.type === 'rect' || el.type === 'ellipse') {
    if (el.fill) out.fill = parseColor(el.fill);
    if (el.stroke) out.stroke = parseColor(el.stroke);
    if (el.strokeWidth != null) out.strokeWeight = el.strokeWidth;
    if (Array.isArray(el.backgroundLayers) && el.backgroundLayers.length) {
      out.backgroundLayers = el.backgroundLayers;
    }
    if (!out.fill && !out.stroke && !out.backgroundLayers) return null;
  }
  if (el.type === 'image' || el.type === 'rect' || el.type === 'ellipse') {
    if (el.opacity != null) {
      const op = parseFloat(el.opacity);
      if (!Number.isNaN(op) && op < 1) out.opacity = op;
      else delete out.opacity;
    }
  }
  if (el.type === 'image' && el.filter) {
    const parsed = parseImageFilter(el.filter);
    if (parsed) {
      out.filter = parsed;
    } else {
      // Keep raw so the warn pass downstream can report which CSS we skipped.
      out.unhandledFilter = el.filter;
      delete out.filter;
    }
  }
  if (el.type === 'svg' && el.filter) {
    const parsed = parseImageFilter(el.filter);
    if (parsed && typeof out.inline === 'string') {
      // Apply the filter by rewriting fill/stroke colors directly in the SVG
      // markup so the downstream vector pipeline emits already-corrected
      // colors — no raster trip, no Figma effect needed.
      // Only the two filters this rewrite can actually express. `parsed` used
      // to be null for anything else, so the `: 'invert'` fallback was
      // unreachable; widening the parser to understand grayscale/contrast/
      // brightness chains made it live, and every such filter began inverting
      // the artwork's colours instead — red rendered cyan, with the warning
      // suppressed on the way out.
      const mode = parsed.forceWhite ? 'forceWhite' : (parsed.invert ? 'invert' : null);
      if (mode) {
        out.inline = transformSvgColors(out.inline, mode);
        delete out.filter;
      } else {
        out.unhandledFilter = el.filter;
        delete out.filter;
      }
    } else if (!parsed) {
      out.unhandledFilter = el.filter;
      delete out.filter;
    }
  }
  if (el.type === 'layoutContainer') {
    out.children = normalizeElements(el.children ?? []);
  }
  return out;
}

function normalizeElements(elements) {
  const out = [];
  for (const el of elements) {
    const n = normalizeElement(el);
    if (n) out.push(n);
  }
  return out;
}

// Inventory distinct font names referenced by any emitted text / richText
// element. Returns an array of { name, slideIdx, sample } records for fonts
// outside FIGMA_AVAILABLE_FONTS, one entry per distinct name (keyed on the
// lowercased primary family).
function auditFonts(manifest) {
  const seen = new Map(); // lower → { name, slideIdx, sample }

  const note = (raw, slide, sample, type) => {
    if (!raw) return;
    const key = String(raw).toLowerCase();
    if (FIGMA_AVAILABLE_FONTS.has(key) || seen.has(key)) return;
    seen.set(key, {
      name: raw,
      slideIdx: slide.index - 1,
      sample: sample || `<${type}>`,
    });
  };

  // Recursive: text is routinely nested inside containers, and a flat pass
  // over `slide.elements` audited only the outermost layer — the deeper the
  // text, the less likely it was to be checked at all.
  const walk = (els, slide) => {
    for (const el of els ?? []) {
      if (el.type === 'text' || el.type === 'richText') {
        const sampleText = el.text
          ? el.text.slice(0, 40)
          : (el.runs ? el.runs.map((r) => r.text).join('').slice(0, 40) : '');
        note(el.font, slide, sampleText, el.type);
        // A run carries its own family when it differs from the paragraph's,
        // and that family is just as capable of being one Figma does not have.
        for (const r of el.runs ?? []) {
          note(r.font, slide, String(r.text ?? '').slice(0, 40), el.type);
        }
      }
      walk(el.children, slide);
    }
  };

  for (const slide of manifest.slides) walk(slide.elements, slide);
  return [...seen.values()];
}

function createWarnCollector() {
  const entries = new Map();
  function warn(slideIdx, msg, sample) {
    const key = `${slideIdx}\u0000${msg}`;
    let e = entries.get(key);
    if (!e) {
      e = { slideIdx, msg, count: 0, sample: null };
      entries.set(key, e);
    }
    e.count++;
    if (sample && !e.sample) e.sample = sample;
  }
  function report() {
    return [...entries.values()].sort((a, b) => a.slideIdx - b.slideIdx || b.count - a.count);
  }
  return { warn, report };
}

/**
 * Convert a Claude Design standalone export to a slide manifest.
 *
 * Note what is not in this signature: no input path, no output path, no
 * scratch directory. Path arithmetic is a host concern; everything this
 * produces leaves through `host.putMedia` / `host.putText`.
 *
 * @param {string} sourceHtml - The standalone export, as text.
 * @param {import('./host-contract.mjs').ConversionHost} host
 * @param {object} [opts]
 * @param {string} [opts.title] - Overrides the export's <title>.
 * @param {boolean} [opts.silent] - Suppress the warning transcript.
 * @param {(line: string) => void} [opts.warnLogger] - Overrides `host.log`.
 * @returns {Promise<{manifest: object, warnings: object[], template: string,
 *   media: Map<string, import('./host-contract.mjs').MediaRef>}>}
 */
/**
 * Stage timing, off unless a host asks for it.
 *
 * A conversion that stops making progress gives nothing away on its own: no
 * throw, no rejection, just a page that says "Converting" forever. Naming each
 * stage and how long it took turns that into one line of console output. Costs
 * nothing when `host.debug` is absent, which is the default.
 */
function makeStageLog(host) {
  if (typeof host.debug !== 'function') return () => {};
  let last = Date.now();
  const start = last;
  return (label) => {
    const now = Date.now();
    host.debug(`${label} +${now - last}ms (${now - start}ms total)`);
    last = now;
  };
}

export async function convertStandaloneCore(sourceHtml, host, opts = {}) {
  const stage = makeStageLog(host);
  stage('start');
  const manifestRaw = extractScriptTag(sourceHtml, '__bundler/manifest');
  const templateRaw = extractScriptTag(sourceHtml, '__bundler/template');
  if (!manifestRaw || !templateRaw) {
    throw new Error(NOT_A_STANDALONE_EXPORT);
  }
  const assets = JSON.parse(manifestRaw);
  const template = JSON.parse(templateRaw);

  const media = await decodeAssets(assets, host);
  stage('decodeAssets');

  const meta = host.readTemplateMeta(template);
  const title = opts.title ?? meta.title ?? 'Untitled';
  let speakerNotes = [];
  if (meta.speakerNotesJson != null) {
    try { speakerNotes = JSON.parse(meta.speakerNotesJson); } catch {}
  }

  // Load the standalone exactly as authored and let its own runtime rehydrate
  // the template and apply the saved tweak state. Replaying that mapping
  // outside a browser means re-implementing whatever classes and CSS vars a
  // given deck's controls script happens to use — which only ever holds for
  // the deck it was written against. The page is the authority on its own
  // tweaks.
  const collector = createWarnCollector();
  const sha1ToAsset = await indexAssetsBySha1(media, host);
  stage('indexAssetsBySha1');
  let browserTemplate;
  let raw;
  const surface = await host.openSurface({ viewport: { width: CANVAS_W, height: CANVAS_H } });
  stage('openSurface');
  try {
    await prepareForMeasurement(surface, host, { readySelector: 'section', fitSelector: 'section' });
    stage('prepareForMeasurement');
    const mapped = await mapImageSrcsToAssets(surface, sha1ToAsset);
    stage('mapImageSrcsToAssets');
    const srcToAsset = mapped.bySrc;
    // Every image failing to hash is the signature of a CSP that forbids
    // reading the export's own blob: URLs. Nothing else in the pipeline
    // notices: the join comes back empty, no src is remapped, and the
    // conversion succeeds with every image missing.
    if (mapped.imagesSeen > 0 && mapped.imagesUnreadable === mapped.imagesSeen) {
      collector.warn(
        -1,
        `none of the ${mapped.imagesSeen} image(s) in this export could be read back for hashing — ` +
        'images will be missing from the deck (a content-security policy blocking blob: URLs does this)',
      );
    } else if (mapped.imagesUnreadable > 0) {
      collector.warn(
        -1,
        `${mapped.imagesUnreadable} of ${mapped.imagesSeen} image(s) could not be read back for hashing and will be missing from the deck`,
      );
    }
    await inlineSvgImages(surface, srcToAsset, host);
    stage('inlineSvgImages');
    raw = await extractSlides(surface, { flexAutoLayout: host.flexAutoLayout });
    stage('extractSlides');
    remapExtractedImageSrcs(raw.slides, srcToAsset);
    warnUnresolvedSvgImages(raw.slides, collector);
    await rewriteDomImageSrcs(surface, srcToAsset);
    stage('rewriteDomImageSrcs');
    browserTemplate = await surface.content();
    stage('surface.content');
  } finally {
    await surface.close();
    stage('surface.close');
  }

  // The engine doesn't resolve var(--foo) references inside inline SVG
  // attributes like fill="var(--accent)" — it leaves the literal string
  // intact. getComputedStyle on the documentElement gave us the resolved
  // values for every declared :root --* property (collected in raw.cssVars).
  // Substitute those references back into the saved template.html so that
  // when the handoff stage re-reads this artifact to pull out SVG markup,
  // every color attribute is a plain resolvable value.
  let finalTemplate = browserTemplate;
  if (raw.cssVars && Object.keys(raw.cssVars).length > 0) {
    finalTemplate = resolveCssVars(browserTemplate, raw.cssVars);
    // The browser extractor captured svg.inline (outerHTML) before var()
    // resolution happens on the template artifact, so inline markup may still
    // contain raw var(--foo) references in fill/stroke attributes. Resolve
    // them here so downstream SVG shape parsing sees concrete colors.
    const resolveInlineVars = (els) => {
      for (const el of els ?? []) {
        if (el && typeof el.inline === 'string' && el.inline.includes('var(')) {
          el.inline = resolveCssVars(el.inline, raw.cssVars);
        }
        if (el && Array.isArray(el.children)) resolveInlineVars(el.children);
      }
    };
    for (const s of raw.slides) resolveInlineVars(s.elements);
  }
  await host.putText('template.html', finalTemplate);
  stage('putText:template');

  const manifestOut = {
    title,
    dimensions: { width: CANVAS_W, height: CANVAS_H },
    slides: [],
  };

  for (const s of raw.slides) {
    for (const w of s.warnings ?? []) {
      collector.warn(s.index, w.msg, w.sample);
    }
    const slide = {
      index: s.index + 1,
      label: s.dataLabel || `Slide ${s.index + 1}`,
      elements: normalizeElements(s.elements),
    };
    const bg = parseColor(s.background);
    if (bg) slide.background = bg;
    if (speakerNotes[s.index]) slide.speakerNotes = speakerNotes[s.index];
    manifestOut.slides.push(slide);
  }

  // Phase-2 font-resolution audit: warn once per font name that Figma is
  // unlikely to resolve without substitution. See FIGMA_AVAILABLE_FONTS.
  for (const f of auditFonts(manifestOut)) {
    collector.warn(
      f.slideIdx,
      `font "${f.name}" likely not available in Figma — output may use a substitute; install the font locally in Figma before opening`,
      f.sample,
    );
  }

  // Surface any CSS filters on <img> / inline-<svg> elements that we
  // recognised the shape of but don't apply yet (anything outside
  // parseImageFilter's allowlist). Strips the diagnostic field after
  // reporting so it never reaches the handoff stage.
  for (const slide of manifestOut.slides) {
    for (const el of slide.elements ?? []) {
      if ((el.type === 'image' || el.type === 'svg') && el.unhandledFilter) {
        const what = el.type === 'svg' ? '<svg>' : '<img>';
        collector.warn(
          slide.index - 1,
          `${what} filter not applied: ${el.unhandledFilter} (supported on images: grayscale, brightness, contrast, invert, sepia, saturate, alone or chained)`,
          el.src || (el.inline ? el.inline.slice(0, 40) : undefined),
        );
        delete el.unhandledFilter;
      }
    }
  }

  const warnings = collector.report();
  if (warnings.length && !opts.silent) {
    const logger = opts.warnLogger || ((s) => host.log(s));
    logger(`\nconvert-html: ${warnings.length} warning type(s) across ${manifestOut.slides.length} slides:`);
    for (const w of warnings) {
      const where = w.slideIdx < 0
        ? '(css)'
        : `slide ${w.slideIdx + 1} "${manifestOut.slides[w.slideIdx]?.label ?? w.slideIdx + 1}"`;
      const times = w.count > 1 ? ` ×${w.count}` : '';
      const sample = w.sample ? `\n      e.g. ${w.sample}` : '';
      logger(`  [${where}]${times} ${w.msg}${sample}`);
    }
  }

  await host.putText('manifest.json', JSON.stringify(manifestOut, null, 2));
  stage('putText:manifest');
  await host.putText('warnings.json', JSON.stringify(warnings, null, 2));
  stage('putText:warnings');

  stage('core done');
  return { manifest: manifestOut, warnings, template: finalTemplate, media };
}
