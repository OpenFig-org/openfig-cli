/**
 * svg-builder.mjs — Convert a FigDeck slide node tree to an SVG string.
 *
 * Architecture: dispatcher pattern — each Figma node type maps to a render
 * function. Unknown types emit a magenta placeholder rect so renders never
 * crash. Add handlers incrementally as coverage grows.
 *
 * TODO: Symbol instance resolution (INSTANCE → SYMBOL + apply overrides).
 * Until that is implemented, INSTANCE nodes render as placeholders.
 * For slides that use direct nodes (not template instances), this works fully.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { nid } from '../node-helpers.mjs';

export const SLIDE_W = 1920;
export const SLIDE_H = 1080;

// Per-slide ID counter — reset at the start of each slideToSvg call so IDs are unique within each SVG doc
let _imgIdSeq = 0;

// ── Color helpers ─────────────────────────────────────────────────────────────

function cssColor(color, opacity = 1) {
  const r = Math.round((color.r ?? 0) * 255);
  const g = Math.round((color.g ?? 0) * 255);
  const b = Math.round((color.b ?? 0) * 255);
  const a = ((color.a ?? 1) * opacity).toFixed(4);
  return `rgba(${r},${g},${b},${a})`;
}

function resolveFill(fillPaints) {
  if (!fillPaints?.length) return null;
  const p = fillPaints.find(p => p.visible !== false && p.type === 'SOLID');
  if (!p) return null;
  return cssColor(p.color ?? {}, p.opacity ?? 1);
}

/** Get effective fillPaints for any node type. */
function getFillPaints(node) {
  if (node.fillPaints?.length) return node.fillPaints;
  // SHAPE_WITH_TEXT stores fill in nodeGenerationData.overrides[0].fillPaints
  return node.nodeGenerationData?.overrides?.[0]?.fillPaints ?? null;
}

function strokeAttrs(node) {
  if (!node.strokeWeight || node.strokeWeight === 0) return '';
  const c = resolveFill(node.strokePaints) ?? 'none';
  return `stroke="${c}" stroke-width="${node.strokeWeight}"`;
}

// ── Transform helpers ─────────────────────────────────────────────────────────

function pos(node) {
  return { x: node.transform?.m02 ?? 0, y: node.transform?.m12 ?? 0 };
}

function size(node) {
  return { w: node.size?.x ?? 0, h: node.size?.y ?? 0 };
}

// ── Node renderers ────────────────────────────────────────────────────────────

function renderRect(deck, node) {
  const { x, y } = pos(node);
  const { w, h } = size(node);
  const rx = node.cornerRadius ?? 0;
  const fill = resolveFill(getFillPaints(node)) ?? 'none';
  const stroke = strokeAttrs(node);
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="${fill}" ${stroke}/>`;
}

function renderEllipse(deck, node) {
  const { x, y } = pos(node);
  const { w, h } = size(node);
  const fill = resolveFill(getFillPaints(node)) ?? 'none';
  const stroke = strokeAttrs(node);
  return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}" ${stroke}/>`;
}

function resolveLineHeight(lh, fontSize) {
  if (!lh) return fontSize * 1.2;
  switch (lh.units) {
    case 'RAW':     return lh.value * fontSize;
    case 'PERCENT': return (lh.value / 100) * fontSize;
    case 'PIXELS':  return lh.value;
    default:        return fontSize * 1.2;
  }
}

function renderText(deck, node) {
  const { x, y } = pos(node);
  const { w, h } = size(node);
  const chars = node.textData?.characters ?? '';
  if (!chars.trim()) return '';

  const fontSize = node.fontSize ?? node.textData?.fontSize ?? 24;
  const fontFamily = node.fontName?.family ?? node.textData?.fontFamily ?? 'Inter';
  const fontStyle = node.fontName?.style ?? 'Regular';
  const fill = resolveFill(getFillPaints(node)) ?? '#000000';

  const fontWeight = /bold/i.test(fontStyle) ? 'bold' : 'normal';
  const fontItalic = /italic/i.test(fontStyle) ? 'italic' : 'normal';

  function escLine(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Use Figma's pre-computed baselines when available — exact positions, no guessing
  const baselines = node.derivedTextData?.baselines;
  let tspans;
  if (baselines?.length) {
    tspans = baselines.map(b => {
      const slice = chars.slice(b.firstCharacter, b.endCharacter).replace(/\n$/, '');
      return `<tspan x="${x + b.position.x}" y="${y + b.position.y}">${escLine(slice) || ' '}</tspan>`;
    }).join('');
  } else {
    // Fallback: split on \n, use lineHeight field
    const lh = resolveLineHeight(node.lineHeight, fontSize);
    tspans = chars.split('\n').map((line, i) =>
      `<tspan x="${x}" dy="${i === 0 ? 0 : lh}">${escLine(line) || ' '}</tspan>`
    ).join('');
  }

  return [
    `<text font-size="${fontSize}" font-family="${fontFamily}, sans-serif"`,
    `  font-weight="${fontWeight}" font-style="${fontItalic}" fill="${fill}">${tspans}</text>`,
  ].join('\n');
}

/**
 * Resolve an IMAGE-type fillPaint to inline SVG defs + bg element.
 * Supports FILL (cover), FIT (contain), and TILE scale modes.
 * Returns null if the image file cannot be read.
 */
function resolveImageFillSvg(deck, imgFill, w, h, rx) {
  const hash = imgFill.image?.name;
  if (!hash || !deck.imagesDir) return null;
  let buf;
  try { buf = readFileSync(join(deck.imagesDir, hash)); } catch { return null; }

  const mime = (buf[0] === 0xFF && buf[1] === 0xD8) ? 'image/jpeg' : 'image/png';
  const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
  const id = ++_imgIdSeq;
  const clipId = `img-clip-${id}`;
  const clipDef = `<clipPath id="${clipId}"><rect width="${w}" height="${h}" rx="${rx}" ry="${rx}"/></clipPath>`;
  const mode = imgFill.imageScaleMode ?? 'FILL';

  if (mode === 'TILE') {
    const tw = (imgFill.originalImageWidth  ?? 100) * (imgFill.scale ?? 1);
    const th = (imgFill.originalImageHeight ?? 100) * (imgFill.scale ?? 1);
    const patId = `img-pat-${id}`;
    return {
      defs: `<defs>${clipDef}<pattern id="${patId}" x="0" y="0" width="${tw}" height="${th}" patternUnits="userSpaceOnUse"><image href="${dataUri}" width="${tw}" height="${th}"/></pattern></defs>`,
      bg:   `<rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="url(#${patId})" clip-path="url(#${clipId})"/>`,
    };
  }

  // FILL (cover) or FIT (contain)
  const par = mode === 'FIT' ? 'xMidYMid meet' : 'xMidYMid slice';
  return {
    defs: `<defs>${clipDef}</defs>`,
    bg:   `<image href="${dataUri}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="${par}" clip-path="url(#${clipId})"/>`,
  };
}

function renderFrame(deck, node) {
  const { x, y } = pos(node);
  const { w, h } = size(node);
  const rx = node.cornerRadius ?? 0;
  const stroke = strokeAttrs(node);
  const inner = childrenSvg(deck, node);

  // IMAGE fill takes precedence over SOLID fill
  const imgFill = getFillPaints(node)?.find(p => p.visible !== false && p.type === 'IMAGE');
  let defs = '';
  let bg = '';

  if (imgFill) {
    const result = resolveImageFillSvg(deck, imgFill, w, h, rx);
    if (result) { defs = result.defs; bg = result.bg; }
  } else {
    const fill = resolveFill(getFillPaints(node)) ?? 'none';
    const hasBg = fill !== 'none' || (node.strokeWeight && node.strokeWeight > 0 && resolveFill(node.strokePaints));
    if (hasBg) bg = `<rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="${fill}" ${stroke}/>`;
  }

  const parts = [defs, bg, inner].filter(Boolean).join('\n');
  if (!parts) return '';
  return `<g transform="translate(${x},${y})">\n${parts}\n</g>`;
}

function renderGroup(deck, node) {
  const { x, y } = pos(node);
  const inner = childrenSvg(deck, node);
  if (!inner) return '';
  return `<g transform="translate(${x},${y})">\n${inner}\n</g>`;
}

function renderLine(deck, node) {
  // LINE uses full transform matrix: direction = (m00, m10), origin = (m02, m12)
  const x1 = node.transform?.m02 ?? 0;
  const y1 = node.transform?.m12 ?? 0;
  const m00 = node.transform?.m00 ?? 1;
  const m10 = node.transform?.m10 ?? 0;
  const len = node.size?.x ?? 0;
  const x2 = x1 + len * m00;
  const y2 = y1 + len * m10;
  const stroke = resolveFill(node.strokePaints) ?? '#000000';
  const sw = node.strokeWeight ?? 1;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"/>`;
}

function renderPlaceholder(deck, node) {
  const { x, y } = pos(node);
  const { w, h } = size(node);
  const type = node.type ?? '?';
  return `<rect x="${x}" y="${y}" width="${w || 40}" height="${h || 40}" fill="none" stroke="#ff00ff" stroke-width="2" stroke-dasharray="6" opacity="0.5"/><!-- ${type} -->`;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

const RENDERERS = {
  ROUNDED_RECTANGLE: renderRect,
  RECTANGLE:         renderRect,
  SHAPE_WITH_TEXT:   renderRect,  // renders fill+stroke; text inside is a child TEXT node
  ELLIPSE:           renderEllipse,
  TEXT:              renderText,
  FRAME:             renderFrame,
  GROUP:             renderGroup,
  SECTION:           renderGroup,
  BOOLEAN_OPERATION: renderGroup,
  // Stubs — add full implementations over time:
  VECTOR:            renderPlaceholder,
  LINE:              renderLine,
  STAR:              renderPlaceholder,
  POLYGON:           renderPlaceholder,
  // TODO: INSTANCE → resolve symbol + apply overrides, then recurse
  INSTANCE:          renderPlaceholder,
};

function renderNode(deck, node) {
  if (node.phase === 'REMOVED') return '';
  const fn = RENDERERS[node.type] ?? renderPlaceholder;
  return fn(deck, node);
}

function childrenSvg(deck, node) {
  return deck.getChildren(nid(node))
    .map(child => renderNode(deck, child))
    .filter(Boolean)
    .join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert a single slide node and its subtree to an SVG string.
 *
 * @param {import('../fig-deck.mjs').FigDeck} deck
 * @param {object} slideNode  - The SLIDE node object
 * @returns {string}          - Complete SVG string (1920×1080)
 */
export function slideToSvg(deck, slideNode) {
  _imgIdSeq = 0; // reset per-slide so IDs are unique within each SVG document
  const bg = resolveFill(getFillPaints(slideNode)) ?? 'white';
  const body = childrenSvg(deck, slideNode);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" \
width="${SLIDE_W}" height="${SLIDE_H}" viewBox="0 0 ${SLIDE_W} ${SLIDE_H}">
  <defs>
    <clipPath id="slide-clip"><rect width="${SLIDE_W}" height="${SLIDE_H}"/></clipPath>
  </defs>
  <rect width="${SLIDE_W}" height="${SLIDE_H}" fill="${bg}"/>
  <g clip-path="url(#slide-clip)">
${body}
  </g>
</svg>`;
}
