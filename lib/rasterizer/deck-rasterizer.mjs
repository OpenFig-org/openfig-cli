/**
 * deck-rasterizer.mjs — Render FigDeck slides to PNG via WASM (resvg).
 *
 * WASM is initialized once per process. Fonts are loaded at init time and
 * can be hot-plugged via registerFont() before or after initialization.
 *
 * Usage:
 *   import { renderDeck, registerFont } from './deck-rasterizer.mjs';
 *   await registerFont('/path/to/CustomFont.ttf');
 *   const pngs = await renderDeck(deck);  // Map<slideIndex, Uint8Array>
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { slideToSvg } from './svg-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '../../node_modules/@resvg/resvg-wasm/index_bg.wasm');

// ── Font registry ─────────────────────────────────────────────────────────────

/**
 * Try to load a font file from a path — returns Buffer or null (never throws).
 * Tries the given path variants in order, returning the first that exists.
 */
function tryFont(...paths) {
  for (const p of paths) {
    try { return readFileSync(p); } catch { /* not found */ }
  }
  return null;
}

/**
 * Load all available weights of a font from @fontsource, trying WOFF2 then TTF.
 * Silently skips missing files/packages.
 * @param {string} pkg  e.g. '@fontsource/darker-grotesque'
 * @param {string} slug e.g. 'darker-grotesque'
 * @param {number[]} weights e.g. [400, 500, 600, 700]
 */
function tryFontsourceFamily(pkg, slug, weights = [400, 500, 600, 700]) {
  const base = join(__dirname, `../../node_modules/${pkg}/files`);
  const bufs = [];
  for (const w of weights) {
    const buf = tryFont(
      `${base}/${slug}-latin-${w}-normal.woff2`,
      `${base}/${slug}-latin-${w}-normal.woff`,
      `${base}/${slug}-latin-${w}-normal.ttf`,
      `${base}/${slug}-all-${w}-normal.woff2`,
    );
    if (buf) bufs.push(buf);
  }
  return bufs;
}

// ── Inter font loading with version warning ────────────────────────────────────
//
// Figma bundles Inter v3.015 (variable font, wght+slnt axes) inside its app.
// @fontsource/inter ships v4.x — italic glyph shapes (e.g. "a") differ visibly.
//
// Run  node lib/rasterizer/extract-figma-fonts.mjs  once to generate the v3
// static WOFF2 files in lib/rasterizer/fonts/inter-v3-*.woff2.
//
// KNOWN_FIGMA_INTER_VERSION is the nameID 5 string from Figma's bundled font.
const KNOWN_FIGMA_INTER_VERSION = 'Version 3.015;git-7f5c04026';

function loadInterFonts() {
  const v3Meta = join(__dirname, 'fonts/inter-v3-meta.json');
  const v3Instances = ['400-normal', '500-normal', '600-normal', '700-normal', '400-italic', '700-italic'];
  const bufs = v3Instances.map(s => tryFont(join(__dirname, `fonts/inter-v3-${s}.woff2`))).filter(Boolean);

  if (bufs.length === v3Instances.length) {
    // All v3 static fonts present — check version matches expectation
    try {
      const meta = JSON.parse(readFileSync(v3Meta, 'utf8'));
      if (meta.version !== KNOWN_FIGMA_INTER_VERSION) {
        process.stderr.write(
          `[openfig] Inter version warning: fonts/inter-v3-*.woff2 reports "${meta.version}", ` +
          `expected "${KNOWN_FIGMA_INTER_VERSION}". Renders may differ.\n`
        );
      }
    } catch { /* meta missing — skip version check */ }
    return bufs;
  }

  // Fallback: @fontsource/inter (v4.x)
  process.stderr.write(
    `[openfig] Inter version warning: Figma uses Inter "${KNOWN_FIGMA_INTER_VERSION}" but ` +
    `local v3 fonts not found. Falling back to @fontsource/inter (v4.x) — ` +
    `italic glyphs (e.g. "a") may differ. ` +
    `Run: node lib/rasterizer/extract-figma-fonts.mjs\n`
  );
  return [
    ...tryFontsourceFamily('@fontsource/inter', 'inter', [400, 500, 600, 700]),
    ...['400', '700'].flatMap(w => {
      const buf = tryFont(join(__dirname, `../../node_modules/@fontsource/inter/files/inter-latin-${w}-italic.woff2`));
      return buf ? [buf] : [];
    }),
  ];
}

const fontBuffers = [
  ...loadInterFonts(),
  // Darker Grotesque — patched WOFF2 with family name "Darker Grotesque" so resvg can match it
  ...['400', '500', '600', '700'].flatMap(w => {
    const buf = tryFont(join(__dirname, `fonts/darker-grotesque-patched-${w}-normal.woff2`));
    return buf ? [buf] : [];
  }),
  // Irish Grover — internal name already matches, load directly from @fontsource
  ...tryFontsourceFamily('@fontsource/irish-grover', 'irish-grover', [400]),
  // Avenir Next — extracted from macOS TTC, family names patched to "Avenir Next"
  ...['regular', 'medium', 'demibold', 'bold', 'italic', 'medium-italic', 'demibold-italic', 'bold-italic'].flatMap(s => {
    const buf = tryFont(join(__dirname, `fonts/avenir-next-${s}.ttf`));
    return buf ? [buf] : [];
  }),
];

/**
 * Register an additional font for rendering.
 * Can be called at any time — takes effect on the next render call.
 * @param {string|Buffer|Uint8Array} source  File path or raw buffer.
 */
export function registerFont(source) {
  const buf = typeof source === 'string'
    ? readFileSync(source)
    : Buffer.isBuffer(source) ? source : Buffer.from(source);
  fontBuffers.push(buf);
}

/**
 * Register all fonts in a directory (recursively scans .ttf/.otf/.woff/.woff2).
 * Call this before rendering if slides use custom fonts.
 * @param {string} dir  Directory path to scan.
 */
export function registerFontDir(dir) {
  const scan = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) { scan(full); continue; }
      if (/\.(ttf|otf|woff2?)$/i.test(entry)) registerFont(full);
    }
  };
  scan(dir);
}

// ── WASM init (lazy, once) ────────────────────────────────────────────────────

let wasmReady = false;
let wasmInitPromise = null;

async function ensureWasm() {
  if (wasmReady) return;
  if (!wasmInitPromise) {
    wasmInitPromise = initWasm(readFileSync(WASM_PATH)).then(() => {
      wasmReady = true;
    });
  }
  await wasmInitPromise;
}

// ── Core render ───────────────────────────────────────────────────────────────

const SLIDE_W = 1920;
const SLIDE_H = 1080;

const DEFAULT_OPTS = {
  scale: 1,          // 1 = 1920×1080, 0.5 = 960×540 — capped at 1
  background: '#ffffff',
};

/**
 * Resolve scale from opts. Accepts:
 *   scale (float)   — direct multiplier, capped at 1
 *   width (px)      — fit to width, preserving aspect ratio
 *   height (px)     — fit to height, preserving aspect ratio
 * Never upscales beyond native 1920×1080.
 */
function resolveScale(opts) {
  if (opts.width)  return opts.width  / SLIDE_W;
  if (opts.height) return opts.height / SLIDE_H;
  return opts.scale ?? 1;
}

/**
 * Render a single SVG string to PNG.
 * @param {string} svg
 * @param {object} opts
 * @returns {Promise<Uint8Array>} PNG bytes
 */
export async function svgToPng(svg, opts = {}) {
  await ensureWasm();
  const { background } = { ...DEFAULT_OPTS, ...opts };
  const scale = resolveScale(opts);

  const resvg = new Resvg(svg, {
    background,
    fitTo: scale !== 1 ? { mode: 'zoom', value: scale } : { mode: 'original' },
    font: {
      fontBuffers: fontBuffers.map(b => new Uint8Array(b)),
      loadSystemFonts: false,
      sansSerifFamily: 'Inter',
      defaultFontFamily: 'Inter',
    },
  });

  const rendered = resvg.render();
  const png = rendered.asPng();
  rendered.free();
  resvg.free();
  return png;
}

/**
 * Render all active slides in a deck to PNG.
 * @param {import('../fig-deck.mjs').FigDeck} deck
 * @param {object} opts
 * @param {number} [opts.scale=1]  Zoom factor (e.g. 0.5 for thumbnails)
 * @returns {Promise<Array<{index: number, slideId: string, png: Uint8Array}>>}
 */
export async function renderDeck(deck, opts = {}) {
  const slides = deck.getActiveSlides();
  const results = [];
  for (let i = 0; i < slides.length; i++) {
    const slide = deck.getSlide(i + 1);
    const svg = slideToSvg(deck, slide);
    const png = await svgToPng(svg, opts);
    results.push({ index: i, slideId: slide.guid
      ? `${slide.guid.sessionID}:${slide.guid.localID}`
      : String(i), png });
  }
  return results;
}
