import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { gunzipSync } from 'zlib';
import { parse as parseHtml } from 'node-html-parser';
import cssParser from 'css';
import { convertHandoffBundle } from './handoff-converter.mjs';

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

function collectCssRules(doc) {
  const rules = [];
  for (const styleTag of doc.querySelectorAll('style')) {
    let ast;
    try { ast = cssParser.parse(styleTag.textContent); }
    catch { continue; }
    walkStylesheet(ast.stylesheet, rules);
  }
  return rules;
}

function walkStylesheet(ss, out) {
  for (const r of ss.rules ?? []) {
    if (r.type === 'rule') {
      for (const sel of r.selectors ?? []) {
        out.push({ selector: sel.trim(), declarations: r.declarations ?? [] });
      }
    } else if (r.type === 'media' || r.type === 'supports') {
      walkStylesheet(r, out);
    }
  }
}

function declsToObject(decls) {
  const o = {};
  for (const d of decls ?? []) {
    if (d.type === 'declaration') o[d.property] = d.value;
  }
  return o;
}

function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes = (sel.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(?!\()/g) || []).length;
  const tags = (sel.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return ids * 10000 + classes * 100 + tags;
}

function selectorMatches(el, sel, ancestry) {
  const parts = sel.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  if (!simpleMatches(el, parts[parts.length - 1])) return false;
  let cursor = ancestry.length - 1;
  for (let p = parts.length - 2; p >= 0; p--) {
    const part = parts[p];
    let matched = false;
    while (cursor >= 0) {
      if (simpleMatches(ancestry[cursor], part)) { matched = true; cursor--; break; }
      cursor--;
    }
    if (!matched) return false;
  }
  return true;
}

function simpleMatches(el, simple) {
  if (!el || el.nodeType !== 1) return false;
  const tagAndRest = simple.match(/^([a-z][\w-]*)?(.*)$/i);
  const tag = tagAndRest[1];
  const rest = tagAndRest[2] || '';
  if (tag && tag !== '*' && el.tagName?.toLowerCase() !== tag.toLowerCase()) return false;
  const classTokens = [...rest.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
  const elClasses = (el.classList?.value ?? []);
  for (const c of classTokens) {
    if (!elClasses.includes(c)) return false;
  }
  return true;
}

function resolveStyle(el, rules, ancestry) {
  const matched = [];
  for (const r of rules) {
    if (selectorMatches(el, r.selector, ancestry)) {
      matched.push({ spec: specificity(r.selector), decls: r.declarations, order: matched.length });
    }
  }
  matched.sort((a, b) => (a.spec - b.spec) || (a.order - b.order));
  const merged = {};
  for (const m of matched) Object.assign(merged, declsToObject(m.decls));
  const inline = el.getAttribute?.('style');
  if (inline) {
    for (const pair of inline.split(';')) {
      const i = pair.indexOf(':');
      if (i < 0) continue;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (k) merged[k] = v;
    }
  }
  return merged;
}

function px(v) {
  if (v == null) return undefined;
  const m = String(v).match(/(-?[\d.]+)\s*px/);
  if (m) return parseFloat(m[1]);
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseColor(v) {
  if (!v) return undefined;
  const s = v.trim();
  if (s === 'transparent' || s === 'none') return undefined;
  if (s.startsWith('#')) return s.length === 4
    ? '#' + [...s.slice(1)].map(c => c + c).join('').toUpperCase()
    : s.toUpperCase();
  const rgb = s.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const parts = rgb[1].split(',').map(t => parseFloat(t.trim()));
    const [r, g, b] = parts;
    const hex = '#' + [r, g, b].map(n => Math.round(n).toString(16).padStart(2, '0')).join('').toUpperCase();
    return hex;
  }
  return s;
}

function fontWeightNum(v) {
  if (!v) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === 'normal') return 400;
  if (s === 'bold') return 700;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseLineHeight(v, fontSize) {
  if (!v) return undefined;
  const s = String(v).trim();
  if (s === 'normal' || s === 'inherit') return undefined;
  if (s.endsWith('px')) return parseFloat(s);
  if (s.endsWith('%')) return (parseFloat(s) / 100) * (fontSize ?? 16);
  if (s.endsWith('em') || s.endsWith('rem')) return parseFloat(s) * (fontSize ?? 16);
  const n = parseFloat(s);
  if (Number.isFinite(n)) return n * (fontSize ?? 16);
  return undefined;
}

function resolveBox(style, ancestry, rulesAll) {
  const pos = style.position;
  let x = px(style.left);
  let y = px(style.top);
  let w = px(style.width);
  let h = px(style.height);
  const right = px(style.right);
  const bottom = px(style.bottom);
  let parentW = CANVAS_W, parentH = CANVAS_H;
  if (pos === 'absolute') {
    for (let i = ancestry.length - 1; i >= 0; i--) {
      const a = ancestry[i];
      if (!a.getAttribute) continue;
      const pStyle = resolveStyle(a, rulesAll, ancestry.slice(0, i));
      if (pStyle.position && pStyle.position !== 'static') {
        parentW = px(pStyle.width) ?? parentW;
        parentH = px(pStyle.height) ?? parentH;
        break;
      }
    }
  }
  if (x == null && right != null && w != null) x = parentW - right - w;
  if (y == null && bottom != null && h != null) y = parentH - bottom - h;
  if (w == null && x != null && right != null) w = parentW - x - right;
  if (h == null && y != null && bottom != null) h = parentH - y - bottom;
  return { x, y, width: w, height: h };
}

function elementIsTextOnly(el) {
  for (const c of el.childNodes ?? []) {
    if (c.nodeType === 1 && !['B', 'I', 'STRONG', 'EM', 'SPAN', 'BR', 'A'].includes(c.tagName?.toUpperCase?.())) {
      return false;
    }
  }
  return true;
}

function flattenText(el) {
  let s = '';
  for (const c of el.childNodes ?? []) {
    if (c.nodeType === 3) s += c.rawText ?? c.text ?? '';
    else if (c.nodeType === 1) {
      if (c.tagName?.toUpperCase() === 'BR') s += '\n';
      else s += flattenText(c);
    }
  }
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&(mdash|ndash);/g, (_, x) => x === 'mdash' ? '—' : '–')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…');
}

function textElement(el, style, box) {
  const size = px(style['font-size']);
  const weight = fontWeightNum(style['font-weight']);
  const fontStyleCss = (style['font-style'] || '').toLowerCase();
  const color = parseColor(style.color);
  const ls = px(style['letter-spacing']);
  const lineHeight = parseLineHeight(style['line-height'], size);
  const align = (style['text-align'] || '').toLowerCase() || undefined;
  const opacity = style.opacity != null ? parseFloat(style.opacity) : undefined;

  const out = {
    type: 'text',
    text: flattenText(el),
    x: box.x ?? 0,
    y: box.y ?? 0,
    width: box.width ?? CANVAS_W,
    font: style['font-family'],
    size,
    weight,
    style: fontStyleCss === 'italic' ? 'italic' : undefined,
    color,
  };
  if (box.height != null) out.height = box.height;
  if (ls != null) out.letterSpacing = ls;
  if (lineHeight != null) out.lineHeight = lineHeight;
  if (align && align !== 'start') out.align = align;
  if (opacity != null && opacity < 1) out.opacity = opacity;
  return out;
}

function imageElement(el, mediaMap, box) {
  const src = el.getAttribute('src');
  const asset = mediaMap[src];
  if (!asset) return null;
  return {
    type: 'image',
    src: `media/${asset.filename}`,
    x: box.x ?? 0, y: box.y ?? 0,
    width: box.width ?? 0, height: box.height ?? 0,
    objectFit: 'contain',
  };
}

function parseBorder(style) {
  const shorthand = style.border || style['border-top'] || '';
  const parts = String(shorthand).trim().split(/\s+/);
  let width, dashStyle, color;
  for (const p of parts) {
    if (/^\d/.test(p)) width = px(p);
    else if (p === 'dashed' || p === 'dotted' || p === 'solid') dashStyle = p;
    else if (/^#|rgb|[a-z]/i.test(p)) color = parseColor(p);
  }
  width = px(style['border-width']) ?? width;
  color = parseColor(style['border-color']) ?? color;
  dashStyle = style['border-style'] ?? dashStyle;
  if (!width && !color) return null;
  return { width, color, dashStyle };
}

function isEllipseDiv(style, box) {
  if (box.width == null || box.height == null) return false;
  const br = style['border-radius'];
  if (!br) return false;
  const ratio = Math.min(box.width, box.height) / Math.max(box.width, box.height);
  if (ratio < 0.8) return false;
  const s = String(br).trim();
  if (s.endsWith('%')) return parseFloat(s) >= 50;
  const n = px(s);
  if (n == null) return false;
  return n >= Math.min(box.width, box.height) / 2 - 0.5;
}

function ellipseElement(style, box) {
  const fill = parseColor(style.background) || parseColor(style['background-color']);
  const border = parseBorder(style);
  if (!fill && !border?.color) return null;
  const out = {
    type: 'ellipse',
    x: box.x ?? 0, y: box.y ?? 0,
    width: box.width, height: box.height,
  };
  if (fill) out.fill = fill;
  if (border?.color) {
    out.stroke = border.color;
    if (border.width) out.strokeWeight = border.width;
    if (border.dashStyle === 'dashed') out.dashPattern = [6, 4];
    else if (border.dashStyle === 'dotted') out.dashPattern = [2, 3];
  }
  return out;
}

function rectElement(style, box) {
  const fill = parseColor(style.background) || parseColor(style['background-color']);
  if (!fill) return null;
  if (box.width == null || box.height == null) return null;
  return {
    type: 'rect',
    x: box.x ?? 0, y: box.y ?? 0,
    width: box.width, height: box.height,
    fill,
  };
}

function svgElementManifest(el, box) {
  const w = box.width ?? px(el.getAttribute('width')) ?? CANVAS_W;
  const h = box.height ?? px(el.getAttribute('height')) ?? CANVAS_H;
  return {
    type: 'svg',
    x: box.x ?? 0,
    y: box.y ?? 0,
    width: w,
    height: h,
    viewBox: el.getAttribute('viewBox') || `0 0 ${w} ${h}`,
    inline: el.outerHTML,
  };
}

function estimateTextHeight(style, width, text) {
  const size = px(style['font-size']) ?? 16;
  const lineHeight = parseLineHeight(style['line-height'], size) ?? (size * 1.25);
  if (!text) return lineHeight;
  const avgCharW = size * 0.5;
  const charsPerLine = Math.max(1, Math.floor((width || CANVAS_W) / avgCharW));
  const lines = Math.max(1, Math.ceil(text.length / charsPerLine));
  return Math.ceil(lines * lineHeight);
}

function walkSection(section, rules, mediaMap, slideIdx) {
  const elements = [];
  function visit(el, ancestry, flowParent) {
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName?.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') return;
    const style = resolveStyle(el, rules, ancestry);
    let box = resolveBox(style, ancestry, rules);
    const pos = style.position;
    const isAbsolute = pos === 'absolute' || pos === 'fixed' || pos === 'relative';

    if (!isAbsolute && flowParent && (box.x == null || box.y == null)) {
      box.x = flowParent.x + (flowParent.paddingLeft ?? 0);
      box.y = flowParent.cursorY;
      if (box.width == null) box.width = Math.max(0, flowParent.width - (flowParent.paddingLeft ?? 0) - (flowParent.paddingRight ?? 0));
    }
    const marginTop = px(style['margin-top']) ?? 0;
    if (!isAbsolute && flowParent && marginTop) box.y += marginTop;

    let produced = false;

    if (tag === 'SVG') {
      // Children (text, circles, paths) are already captured via outerHTML and
      // re-parsed by parseSvgShapes downstream; walking them would duplicate.
      elements.push(svgElementManifest(el, box));
      return;
    } else if (tag === 'IMG') {
      const ie = imageElement(el, mediaMap, box);
      if (ie) { elements.push(ie); produced = true; }
    } else if (elementIsTextOnly(el)) {
      const txt = flattenText(el);
      if (txt && (style['font-size'] || flowParent)) {
        const t = textElement(el, style, box);
        const h = box.height ?? estimateTextHeight(style, box.width ?? CANVAS_W, txt);
        if (box.height == null) t.height = h;
        elements.push(t);
        if (!isAbsolute && flowParent) {
          const marginBottom = px(style['margin-bottom']) ?? 0;
          flowParent.cursorY = box.y + h + marginBottom;
        }
        return;
      }
      if (isEllipseDiv(style, box)) {
        const e = ellipseElement(style, box);
        if (e) { elements.push(e); produced = true; }
      } else {
        const r = rectElement(style, box);
        if (r) { elements.push(r); produced = true; }
      }
    } else {
      if (isEllipseDiv(style, box)) {
        const e = ellipseElement(style, box);
        if (e) { elements.push(e); produced = true; }
      } else {
        const r = rectElement(style, box);
        if (r) { elements.push(r); produced = true; }
      }
    }

    const childFlow = {
      x: box.x ?? 0,
      y: box.y ?? 0,
      width: box.width ?? CANVAS_W,
      paddingLeft: px(style['padding-left']) ?? px(style.padding) ?? 0,
      paddingRight: px(style['padding-right']) ?? px(style.padding) ?? 0,
      paddingTop: px(style['padding-top']) ?? px(style.padding) ?? 0,
      cursorY: (box.y ?? 0) + (px(style['padding-top']) ?? px(style.padding) ?? 0),
    };

    const nextAnc = [...ancestry, el];
    for (const c of el.childNodes ?? []) visit(c, nextAnc, childFlow);

    if (!isAbsolute && flowParent) {
      const consumed = Math.max(childFlow.cursorY, (box.y ?? 0) + (box.height ?? 0));
      const marginBottom = px(style['margin-bottom']) ?? 0;
      flowParent.cursorY = consumed + marginBottom;
    }
    void produced;
  }
  for (const c of section.childNodes ?? []) visit(c, [section], null);
  return elements;
}

function resolveSlideBackground(section, rules) {
  const style = resolveStyle(section, rules, []);
  return parseColor(style.background) || parseColor(style['background-color']);
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

  const doc = parseHtml(template, { lowerCaseTagName: false, comment: false });
  const rules = collectCssRules(doc);

  let speakerNotes = [];
  const snTag = doc.querySelector('script#speaker-notes');
  if (snTag) {
    try { speakerNotes = JSON.parse(snTag.textContent); } catch {}
  }

  const titleTag = doc.querySelector('title');
  const title = opts.title ?? titleTag?.textContent?.trim() ?? 'Untitled';

  const sections = doc.querySelectorAll('section');
  const manifestOut = {
    title,
    dimensions: { width: CANVAS_W, height: CANVAS_H },
    slides: [],
  };
  sections.forEach((sec, i) => {
    const bg = resolveSlideBackground(sec, rules);
    const elements = walkSection(sec, rules, mediaMap, i);
    const slide = {
      index: i + 1,
      label: sec.getAttribute('data-label') || `Slide ${i + 1}`,
      elements,
    };
    if (bg) slide.background = bg;
    if (speakerNotes[i]) slide.speakerNotes = speakerNotes[i];
    manifestOut.slides.push(slide);
  });

  writeFileSync(join(scratch, 'manifest.json'), JSON.stringify(manifestOut, null, 2));
  writeFileSync(join(scratch, 'template.html'), template);

  return await convertHandoffBundle(scratch, outDeckPath, { scratchDir: scratch, ...opts });
}
