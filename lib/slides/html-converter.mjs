import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import { parse as parseHtml } from 'node-html-parser';
import { convertHandoffBundle } from './handoff-converter.mjs';
import { withChromiumPage } from './playwright-layout.mjs';
import { extractSlides } from './browser-extract.mjs';

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

function decodeAssets(manifest, mediaDir) {
  mkdirSync(mediaDir, { recursive: true });
  const map = {};
  for (const [uuid, a] of Object.entries(manifest)) {
    const ext = MIME_EXT[a.mime] ?? 'bin';
    const fname = `${uuid}.${ext}`;
    const outPath = join(mediaDir, fname);
    let buf = Buffer.from(a.data, 'base64');
    if (a.compressed) buf = gunzipSync(buf);
    writeFileSync(outPath, buf);
    map[uuid] = { mime: a.mime, path: outPath, filename: fname };
  }
  return map;
}

function rewriteTemplateForBrowser(template, mediaMap) {
  const doc = parseHtml(template, { lowerCaseTagName: false, comment: true });
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (!src) continue;
    const asset = mediaMap[src];
    if (asset) img.setAttribute('src', `media/${asset.filename}`);
  }
  return doc.toString();
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

// Tokens in a CSS font stack that Figma cannot resolve to a real typeface.
// Walking past them lets us pick the first portable fallback — e.g. for
// `-apple-system, system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif`
// we land on `Helvetica Neue`, whose metrics match Mac browser rendering
// far better than Figma's `-apple-system` → Inter substitution.
const NON_PORTABLE_FONT_TOKENS = new Set([
  'blinkmacsystemfont',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'emoji',
  'math',
  'fangsong',
]);

function stripFontToken(raw) {
  return String(raw).trim().replace(/^['"]|['"]$/g, '');
}

function isPortableFontToken(token) {
  if (!token) return false;
  if (token.startsWith('-')) return false; // -apple-system and vendor prefixes
  return !NON_PORTABLE_FONT_TOKENS.has(token.toLowerCase());
}

function normalizeFont(family) {
  if (!family) return undefined;
  const entries = String(family).split(',').map(stripFontToken).filter(Boolean);
  if (entries.length === 0) return undefined;
  const portable = entries.find(isPortableFontToken);
  return portable ?? entries[0];
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

// Fonts Figma Slides is expected to resolve by name at render time without
// substitution. This is the committed allowlist used by the font-unavailability
// audit (§fix-html-converter-figma-fidelity Phase 2 task 2.6). Keep the list
// small and conservative; extend via PR when a new font has been verified to
// render identically in Figma and Chromium.
//
// Match is case-insensitive and compares the first (primary) family name, so
// `'EB Garamond', Georgia, serif` is checked against `eb garamond` alone.
const FIGMA_DEFAULT_FONTS = new Set([
  // Figma's own ship-default UI face
  'inter',
  // Widely-available system faces Figma resolves on macOS/Windows
  'arial', 'helvetica', 'helvetica neue',
  'times', 'times new roman',
  'courier', 'courier new',
  'georgia', 'verdana', 'tahoma', 'trebuchet ms',
  'sf pro', 'sf pro display', 'sf pro text',
  'menlo', 'monaco', 'consolas',
  // Google Fonts that Figma loads in the standard picker
  'roboto', 'roboto mono', 'roboto condensed', 'roboto slab',
  'open sans', 'noto sans', 'noto serif',
  'lato', 'montserrat', 'poppins', 'nunito',
  'source sans pro', 'source serif pro', 'source code pro',
  'source sans 3', 'source serif 4', 'source code pro',
  'work sans', 'fira sans', 'fira code', 'fira mono',
  'ibm plex sans', 'ibm plex serif', 'ibm plex mono',
  'jetbrains mono',
  // CSS-generic families — Figma treats them as system fallbacks
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
]);

// Inventory distinct font names referenced by any emitted text / richText
// element. Returns an array of { name, slideIdx, sample } records for fonts
// outside FIGMA_DEFAULT_FONTS, one entry per distinct name (keyed on the
// lowercased primary family).
function auditFonts(manifest) {
  const seen = new Map(); // lower → { name, slideIdx, sample }
  for (const slide of manifest.slides) {
    for (const el of slide.elements ?? []) {
      if (el.type !== 'text' && el.type !== 'richText') continue;
      const raw = el.font;
      if (!raw) continue;
      const key = String(raw).toLowerCase();
      if (FIGMA_DEFAULT_FONTS.has(key)) continue;
      if (seen.has(key)) continue;
      const sampleText = el.text
        ? el.text.slice(0, 40)
        : (el.runs ? el.runs.map(r => r.text).join('').slice(0, 40) : '');
      seen.set(key, {
        name: raw,
        slideIdx: slide.index - 1,
        sample: sampleText || `<${el.type}>`,
      });
    }
  }
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

export async function convertStandaloneHtml(htmlPath, outDeckPath, opts = {}) {
  const src = readFileSync(htmlPath, 'utf8');

  const manifestRaw = extractScriptTag(src, '__bundler/manifest');
  const templateRaw = extractScriptTag(src, '__bundler/template');
  if (!manifestRaw || !templateRaw) {
    throw new Error('html-converter: input is not a Claude Design standalone HTML (missing __bundler/manifest or /template)');
  }
  const assets = JSON.parse(manifestRaw);
  const template = JSON.parse(templateRaw);

  const scratch = opts.scratchDir ?? (outDeckPath.replace(/\.deck$/, '') + '-html-build');
  mkdirSync(scratch, { recursive: true });
  const mediaDir = join(scratch, 'media');
  const mediaMap = decodeAssets(assets, mediaDir);

  const nodeDoc = parseHtml(template, { lowerCaseTagName: false, comment: false });
  const titleTag = nodeDoc.querySelector('title');
  const title = opts.title ?? titleTag?.textContent?.trim() ?? 'Untitled';
  let speakerNotes = [];
  const snTag = nodeDoc.querySelector('script#speaker-notes');
  if (snTag) {
    try { speakerNotes = JSON.parse(snTag.textContent); } catch {}
  }

  const browserTemplate = rewriteTemplateForBrowser(template, mediaMap);
  const browserHtmlPath = join(scratch, 'template.html');
  writeFileSync(browserHtmlPath, browserTemplate);

  const collector = createWarnCollector();
  const raw = await withChromiumPage(
    browserHtmlPath,
    { width: CANVAS_W, height: CANVAS_H },
    (page) => extractSlides(page),
  );

  // Chromium doesn't resolve var(--foo) references inside inline SVG
  // attributes like fill="var(--accent)" — it leaves the literal string
  // intact. getComputedStyle on the documentElement gave us the resolved
  // values for every declared :root --* property (collected in raw.cssVars).
  // Substitute those references back into the saved template.html so that
  // when the handoff stage re-reads this file to pull out SVG markup, every
  // color attribute is a plain resolvable value.
  if (raw.cssVars && Object.keys(raw.cssVars).length > 0) {
    const resolvedTemplate = resolveCssVars(browserTemplate, raw.cssVars);
    if (resolvedTemplate !== browserTemplate) {
      writeFileSync(browserHtmlPath, resolvedTemplate);
    }
    // The browser extractor captured svg.inline (outerHTML) before var()
    // resolution happens on the template file, so inline markup may still
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
  // unlikely to resolve without substitution. See FIGMA_DEFAULT_FONTS above.
  for (const f of auditFonts(manifestOut)) {
    collector.warn(
      f.slideIdx,
      `font "${f.name}" likely not available in Figma — output may use a substitute; install the font locally in Figma before opening`,
      f.sample,
    );
  }

  const warnings = collector.report();
  if (warnings.length && !opts.silent) {
    const logger = opts.warnLogger || ((s) => process.stderr.write(s + '\n'));
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

  writeFileSync(join(scratch, 'manifest.json'), JSON.stringify(manifestOut, null, 2));
  writeFileSync(join(scratch, 'warnings.json'), JSON.stringify(warnings, null, 2));

  // Dry-run: skip the .deck emission. Returns the intermediate geometry so
  // callers can inspect Chromium's wrap points without paying the full
  // handoff-bundle conversion cost. Used by Phase 2 font-metric experiments.
  if (opts.dryRun) {
    return { manifest: manifestOut, warnings, scratchDir: scratch };
  }

  const result = await convertHandoffBundle(scratch, outDeckPath, { scratchDir: scratch, ...opts });
  return { ...result, warnings };
}
