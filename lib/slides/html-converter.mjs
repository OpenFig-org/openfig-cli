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

function collectCssRules(doc, warn) {
  const rules = [];
  let parseFailures = 0;
  const pseudoSelectors = new Set();
  for (const styleTag of doc.querySelectorAll('style')) {
    let ast;
    try { ast = cssParser.parse(styleTag.textContent); }
    catch { parseFailures++; continue; }
    walkStylesheet(ast.stylesheet, rules);
  }
  for (const r of rules) {
    if (/::(before|after|first-line|first-letter|marker|placeholder)\b/.test(r.selector)) {
      pseudoSelectors.add(r.selector);
    }
  }
  if (warn) {
    if (parseFailures) warn(-1, `${parseFailures} <style> block(s) failed to parse — rules dropped`);
    for (const sel of pseudoSelectors) {
      warn(-1, `pseudo-element rule "${sel}" — not rendered (::before/::after content is lost)`);
    }
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

function resolveBox(style, ancestry, rulesAll, hints = {}) {
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
  if (w == null && right != null && x == null && hints.intrinsicWidth != null) w = hints.intrinsicWidth;
  if (h == null && bottom != null && y == null && hints.intrinsicHeight != null) h = hints.intrinsicHeight;
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

function estimateTextWidth(style, text) {
  const size = px(style['font-size']) ?? 16;
  const ls = px(style['letter-spacing']) ?? 0;
  const avgCharW = size * 0.55;
  return Math.ceil((text?.length ?? 0) * (avgCharW + ls));
}

function parseGridColumns(template, totalWidth, gap) {
  if (!template) return null;
  const s = String(template).trim();
  const repeat = s.match(/^repeat\(\s*(\d+)\s*,\s*([^)]+)\s*\)$/);
  const tokens = repeat
    ? Array(parseInt(repeat[1], 10)).fill(repeat[2].trim())
    : s.split(/\s+/).filter(Boolean);
  const n = tokens.length;
  if (!n) return null;
  const gaps = gap * (n - 1);
  let frSum = 0;
  const fixed = tokens.map(t => {
    if (t.endsWith('fr')) { const f = parseFloat(t); frSum += f; return { fr: f }; }
    const px = parseFloat(t);
    return { px: Number.isFinite(px) ? px : 0 };
  });
  const leftover = Math.max(0, totalWidth - gaps - fixed.reduce((s, c) => s + (c.px ?? 0), 0));
  let offset = 0;
  return fixed.map((c, i) => {
    const w = c.px != null ? c.px : (frSum > 0 ? (c.fr / frSum) * leftover : leftover / n);
    const col = { offset, width: w };
    offset += w + gap;
    return col;
  });
}

function makeChildFlow(el, style, box) {
  const display = (style.display || '').trim();
  const paddingLeft = px(style['padding-left']) ?? px(style.padding) ?? 0;
  const paddingRight = px(style['padding-right']) ?? px(style.padding) ?? 0;
  const paddingTop = px(style['padding-top']) ?? px(style.padding) ?? 0;
  const gap = px(style.gap) ?? px(style['row-gap']) ?? 0;
  const colGap = px(style['column-gap']) ?? gap;
  const innerWidth = Math.max(0, (box.width ?? CANVAS_W) - paddingLeft - paddingRight);

  if (display === 'grid') {
    const cols = parseGridColumns(style['grid-template-columns'], innerWidth, colGap);
    if (cols) {
      return {
        type: 'grid',
        x: (box.x ?? 0) + paddingLeft,
        y: (box.y ?? 0) + paddingTop,
        columns: cols,
        rowGap: gap,
        nextCol: 0,
        columnCursors: cols.map(() => (box.y ?? 0) + paddingTop),
      };
    }
  }

  if (display === 'flex' || display === 'inline-flex') {
    const direction = (style['flex-direction'] || 'row').trim();
    const justify = (style['justify-content'] || 'flex-start').trim();
    const align = (style['align-items'] || 'stretch').trim();
    if (direction.startsWith('row')) {
      return {
        type: 'flex-row',
        x: (box.x ?? 0) + paddingLeft,
        y: (box.y ?? 0) + paddingTop,
        width: innerWidth,
        gap: colGap,
        cursorX: (box.x ?? 0) + paddingLeft,
        maxChildHeight: 0,
        justify,
        align,
      };
    }
  }

  return {
    type: 'block',
    x: (box.x ?? 0),
    y: (box.y ?? 0),
    width: box.width ?? CANVAS_W,
    paddingLeft, paddingRight, paddingTop,
    cursorY: (box.y ?? 0) + paddingTop,
  };
}

function placeChildInFlow(flowParent, box, style, textEstimatedWidth) {
  if (!flowParent) return;
  if (flowParent.type === 'grid') {
    const col = flowParent.nextCol;
    const colInfo = flowParent.columns[col];
    if (box.x == null) box.x = flowParent.x + colInfo.offset;
    if (box.y == null) box.y = flowParent.columnCursors[col];
    if (box.width == null) box.width = colInfo.width;
    return;
  }
  if (flowParent.type === 'flex-row') {
    if (box.x == null) box.x = flowParent.cursorX;
    if (box.y == null) box.y = flowParent.y;
    if (box.width == null && textEstimatedWidth != null) {
      box.width = Math.min(textEstimatedWidth, Math.max(0, flowParent.width - (flowParent.cursorX - flowParent.x)));
    }
    return;
  }
  if (box.x == null) box.x = flowParent.x + (flowParent.paddingLeft ?? 0);
  if (box.y == null) box.y = flowParent.cursorY;
  if (box.width == null) box.width = Math.max(0, flowParent.width - (flowParent.paddingLeft ?? 0) - (flowParent.paddingRight ?? 0));
}

function advanceFlow(flowParent, box, consumedY, marginBottom) {
  if (!flowParent) return;
  if (flowParent.type === 'grid') {
    const col = flowParent.nextCol;
    flowParent.columnCursors[col] = Math.max(flowParent.columnCursors[col], consumedY) + marginBottom;
    flowParent.nextCol = (col + 1) % flowParent.columns.length;
    return;
  }
  if (flowParent.type === 'flex-row') {
    const w = box.width ?? 0;
    const h = (consumedY - (box.y ?? 0));
    flowParent.cursorX += w + flowParent.gap;
    if (h > flowParent.maxChildHeight) flowParent.maxChildHeight = h;
    return;
  }
  flowParent.cursorY = Math.max(flowParent.cursorY, consumedY) + marginBottom;
}

const SUPPORTED_DISPLAYS = new Set(['', 'block', 'inline', 'grid', 'flex', 'inline-flex', 'none']);
const SUPPORTED_POSITIONS = new Set(['', 'static', 'absolute', 'fixed', 'relative']);

function createWarnCollector() {
  const entries = new Map();
  function warn(slideIdx, msg, sample) {
    const key = `${slideIdx}\u0000${msg}`;
    let e = entries.get(key);
    if (!e) { e = { slideIdx, msg, count: 0, sample: null }; entries.set(key, e); }
    e.count++;
    if (sample && !e.sample) e.sample = sample;
  }
  function report() {
    return [...entries.values()].sort(
      (a, b) => a.slideIdx - b.slideIdx || b.count - a.count);
  }
  return { warn, report };
}

function elPath(el) {
  const tag = (el.tagName || '').toLowerCase();
  const id = el.getAttribute?.('id');
  const cls = (el.classList?.value ?? []).slice(0, 2).join('.');
  let s = tag;
  if (id) s += `#${id}`;
  else if (cls) s += `.${cls}`;
  return s;
}

function hasCssFunction(v, fn) {
  return v != null && new RegExp(`\\b${fn}\\s*\\(`, 'i').test(String(v));
}

function resolveChildSpanStyles(el, rules, ancestry) {
  const out = [];
  for (const c of el.childNodes ?? []) {
    if (c.nodeType !== 1) continue;
    const tag = c.tagName?.toUpperCase();
    if (!['SPAN', 'B', 'I', 'STRONG', 'EM', 'A'].includes(tag)) continue;
    out.push(resolveStyle(c, rules, [...ancestry, el]));
  }
  return out;
}

function hasDivergentInlineChildren(el, rules, ancestry) {
  const styles = resolveChildSpanStyles(el, rules, ancestry);
  if (styles.length < 2) return false;
  const sizes = new Set(styles.map(s => s['font-size']).filter(Boolean));
  const colors = new Set(styles.map(s => s.color).filter(Boolean));
  const weights = new Set(styles.map(s => s['font-weight']).filter(Boolean));
  return sizes.size > 1 || colors.size > 1 || weights.size > 1;
}

function parseBorderSide(style, side) {
  const shorthand = style[`border-${side}`] ?? (side === 'all' ? style.border : null);
  if (!shorthand) return null;
  const s = String(shorthand).trim();
  if (/^(0|none|transparent)(\s|$)/i.test(s)) return null;
  const parts = s.split(/\s+/);
  let width, dashStyle, color;
  for (const p of parts) {
    if (/^-?\d/.test(p)) width = px(p);
    else if (p === 'dashed' || p === 'dotted' || p === 'solid' || p === 'none') dashStyle = p;
    else if (/^#|^rgba?\(|^[a-z]/i.test(p)) color = parseColor(p);
  }
  if (!color || color === 'transparent') return null;
  return { width: width ?? 1, color, dashStyle: dashStyle ?? 'solid' };
}

function emitBorderRects(elements, style, box, height) {
  if (box.width == null || height == null || box.x == null || box.y == null) return;
  const all = parseBorderSide(style, 'all');
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const b = parseBorderSide(style, side) || all;
    if (!b) continue;
    const w = b.width;
    let rect;
    if (side === 'top') rect = { type: 'rect', x: box.x, y: box.y, width: box.width, height: w, fill: b.color };
    else if (side === 'bottom') rect = { type: 'rect', x: box.x, y: box.y + height - w, width: box.width, height: w, fill: b.color };
    else if (side === 'left') rect = { type: 'rect', x: box.x, y: box.y, width: w, height, fill: b.color };
    else if (side === 'right') rect = { type: 'rect', x: box.x + box.width - w, y: box.y, width: w, height, fill: b.color };
    if (rect) elements.push(rect);
  }
}

function walkSection(section, rules, mediaMap, slideIdx, warn) {
  const elements = [];
  function visit(el, ancestry, flowParent) {
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName?.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') return;
    const style = resolveStyle(el, rules, ancestry);

    const display = (style.display || '').trim();
    if (display === 'none') return;
    if (display && !SUPPORTED_DISPLAYS.has(display)) {
      warn(slideIdx, `display:${display} on <${tag.toLowerCase()}> — treating as block`);
    }
    const pos = (style.position || '').trim();
    if (pos && !SUPPORTED_POSITIONS.has(pos)) {
      warn(slideIdx, `position:${pos} on <${tag.toLowerCase()}> — treating as static`);
    }
    if (style.transform) warn(slideIdx, `transform:${style.transform} on <${tag.toLowerCase()}> — ignored`);
    if (style.float && style.float !== 'none') warn(slideIdx, `float:${style.float} on <${tag.toLowerCase()}> — ignored`);
    if (style['background-image']) warn(slideIdx, `background-image on <${tag.toLowerCase()}> — ignored (only solid color supported)`);

    for (const p of ['min-width', 'max-width', 'min-height', 'max-height']) {
      if (style[p]) warn(slideIdx, `${p} — ignored (no constraint layout)`, `${elPath(el)} ${p}:${style[p]}`);
    }
    for (const k of ['width', 'height', 'left', 'top', 'right', 'bottom', 'padding', 'margin', 'gap', 'font-size', 'letter-spacing', 'line-height']) {
      const v = style[k];
      if (hasCssFunction(v, 'calc')) warn(slideIdx, `calc() in ${k} — not evaluated`, `${elPath(el)} ${k}:${v}`);
      if (hasCssFunction(v, 'var')) warn(slideIdx, `var() in ${k} — not resolved`, `${elPath(el)} ${k}:${v}`);
    }
    if (display === 'flex' || display === 'inline-flex') {
      const ai = (style['align-items'] || '').trim();
      if (ai && !['stretch', 'flex-start', 'start', ''].includes(ai)) {
        warn(slideIdx, `flex align-items:${ai} — not implemented (all items aligned to row top)`, elPath(el));
      }
      const jc = (style['justify-content'] || '').trim();
      if (jc && !['flex-start', 'start', 'normal', ''].includes(jc)) {
        warn(slideIdx, `flex justify-content:${jc} — not implemented (items packed from start)`, elPath(el));
      }
      const fd = (style['flex-direction'] || 'row').trim();
      if (fd !== 'row' && !fd.startsWith('row')) {
        warn(slideIdx, `flex-direction:${fd} — only row/row-reverse layouts supported`, elPath(el));
      }
    }
    if (display === 'grid') {
      if (style['grid-template-rows']) warn(slideIdx, `grid-template-rows — ignored (row sizes auto)`, elPath(el));
      if (style['grid-auto-flow'] && style['grid-auto-flow'] !== 'row') {
        warn(slideIdx, `grid-auto-flow:${style['grid-auto-flow']} — only row flow supported`, elPath(el));
      }
    }
    if (style['grid-row'] || style['grid-column']) {
      warn(slideIdx, `grid-row/grid-column on child — ignored (children placed in declaration order)`, elPath(el));
    }
    if (style['object-fit'] && style['object-fit'] !== 'contain') {
      warn(slideIdx, `object-fit:${style['object-fit']} — forced to 'contain'`, elPath(el));
    }

    const textOnly = elementIsTextOnly(el);
    const mergeInline = textOnly && !hasDivergentInlineChildren(el, rules, ancestry);
    const txt = mergeInline ? flattenText(el) : '';
    let textEstWidth = txt ? estimateTextWidth(style, txt) : null;

    let box = resolveBox(style, ancestry, rules, { intrinsicWidth: textEstWidth });
    const isAbsolute = pos === 'absolute' || pos === 'fixed' || pos === 'relative';
    const minW = px(style['min-width']);
    if (minW != null) {
      textEstWidth = textEstWidth != null ? Math.max(textEstWidth, minW) : minW;
    }
    if (!isAbsolute && flowParent) placeChildInFlow(flowParent, box, style, textEstWidth);
    if (minW != null && box.width != null && box.width < minW) box.width = minW;
    const marginTop = px(style['margin-top']) ?? 0;
    if (!isAbsolute && flowParent && marginTop) box.y = (box.y ?? 0) + marginTop;

    if (tag === 'SVG') {
      elements.push(svgElementManifest(el, box));
      if (!isAbsolute && flowParent) {
        const h = box.height ?? 0;
        const marginBottom = px(style['margin-bottom']) ?? 0;
        advanceFlow(flowParent, box, (box.y ?? 0) + h, marginBottom);
      }
      return;
    }
    if (tag === 'IMG') {
      const ie = imageElement(el, mediaMap, box);
      if (ie) elements.push(ie);
      else {
        const src = el.getAttribute?.('src') || '';
        const snippet = src.startsWith('data:') ? `data:${src.slice(5, 25)}…` : src.slice(0, 60);
        warn(slideIdx, `<img> src not in __bundler/manifest — element dropped`, snippet);
      }
      if (!isAbsolute && flowParent) {
        const h = box.height ?? 0;
        const marginBottom = px(style['margin-bottom']) ?? 0;
        advanceFlow(flowParent, box, (box.y ?? 0) + h, marginBottom);
      }
      return;
    }
    if (mergeInline) {
      if (txt && (style['font-size'] || flowParent)) {
        const t = textElement(el, style, box);
        const h = box.height ?? estimateTextHeight(style, box.width ?? CANVAS_W, txt);
        if (box.height == null) t.height = h;
        elements.push(t);
        if (!isAbsolute && flowParent) {
          const marginBottom = px(style['margin-bottom']) ?? 0;
          advanceFlow(flowParent, box, (box.y ?? 0) + h, marginBottom);
        }
        return;
      }
    }
    const shape = isEllipseDiv(style, box) ? ellipseElement(style, box) : rectElement(style, box);
    if (shape) elements.push(shape);

    const childFlow = makeChildFlow(el, style, box);
    const nextAnc = [...ancestry, el];
    for (const c of el.childNodes ?? []) visit(c, nextAnc, childFlow);

    let contentHeight = 0;
    if (childFlow.type === 'grid') {
      contentHeight = Math.max(0, ...childFlow.columnCursors) - (childFlow.y ?? 0);
    } else if (childFlow.type === 'flex-row') {
      contentHeight = childFlow.maxChildHeight;
    } else {
      contentHeight = childFlow.cursorY - (childFlow.y ?? 0);
    }
    const paddingBottom = px(style['padding-bottom']) ?? px(style.padding) ?? 0;
    const ownHeight = (box.height != null)
      ? box.height
      : contentHeight + (px(style['padding-top']) ?? px(style.padding) ?? 0) + paddingBottom;

    emitBorderRects(elements, style, box, ownHeight);

    if (!isAbsolute && flowParent) {
      const marginBottom = px(style['margin-bottom']) ?? 0;
      advanceFlow(flowParent, box, (box.y ?? 0) + ownHeight, marginBottom);
    }
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
  const collector = createWarnCollector();
  const rules = collectCssRules(doc, collector.warn);

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
    const elements = walkSection(sec, rules, mediaMap, i, collector.warn);
    const slide = {
      index: i + 1,
      label: sec.getAttribute('data-label') || `Slide ${i + 1}`,
      elements,
    };
    if (bg) slide.background = bg;
    if (speakerNotes[i]) slide.speakerNotes = speakerNotes[i];
    manifestOut.slides.push(slide);
  });

  const warnings = collector.report();
  if (warnings.length && !opts.silent) {
    const logger = opts.warnLogger || ((s) => process.stderr.write(s + '\n'));
    logger(`\nconvert-html: ${warnings.length} warning type(s) across ${sections.length} slides:`);
    for (const w of warnings) {
      const where = w.slideIdx < 0
        ? '(css)'
        : `slide ${w.slideIdx + 1} "${sections[w.slideIdx]?.getAttribute?.('data-label') || w.slideIdx + 1}"`;
      const times = w.count > 1 ? ` ×${w.count}` : '';
      const sample = w.sample ? `\n      e.g. ${w.sample}` : '';
      logger(`  [${where}]${times} ${w.msg}${sample}`);
    }
  }

  writeFileSync(join(scratch, 'manifest.json'), JSON.stringify(manifestOut, null, 2));
  writeFileSync(join(scratch, 'template.html'), template);
  writeFileSync(join(scratch, 'warnings.json'), JSON.stringify(warnings, null, 2));

  const result = await convertHandoffBundle(scratch, outDeckPath, { scratchDir: scratch, ...opts });
  return { ...result, warnings };
}
