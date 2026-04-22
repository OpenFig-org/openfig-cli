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

function normalizeFont(family) {
  if (!family) return undefined;
  return String(family).split(',')[0].trim().replace(/^['"]|['"]$/g, '');
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
  }
  if (el.type === 'richText') {
    out.color = parseColor(el.color);
    out.font = normalizeFont(el.font);
    if (el.size != null) out.size = Math.round(el.size * 100) / 100;
    if (el.lineHeight != null) out.lineHeight = Math.round(el.lineHeight * 100) / 100;
    if (el.letterSpacing != null) out.letterSpacing = Math.round(el.letterSpacing * 100) / 100;
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
    if (!out.fill && !out.stroke) return null;
  }
  if (el.type === 'image') {
    if (el.opacity != null) {
      const op = parseFloat(el.opacity);
      if (!Number.isNaN(op) && op < 1) out.opacity = op;
      else delete out.opacity;
    }
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

  const result = await convertHandoffBundle(scratch, outDeckPath, { scratchDir: scratch, ...opts });
  return { ...result, warnings };
}
