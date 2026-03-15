/**
 * svg-builder.mjs — Convert a Figma node tree to an SVG string.
 *
 * Architecture: dispatcher pattern — each Figma node type maps to a render
 * function. Unknown types emit a magenta placeholder rect so renders never
 * crash. Add handlers incrementally as coverage grows.
 *
 * Parameter naming — two entry points, one shared engine:
 *
 *   slideToSvg(deck, slideNode)  — Slides entry point (.deck files)
 *     "deck" = a parsed .deck file. Expects SLIDE nodes, 1920×1080 viewport.
 *
 *   frameToSvg(fig, node)        — Design entry point (.fig files)
 *     "fig" = a parsed .fig file. Uses the node's own size as viewport.
 *
 *   Internal render functions all accept "deck" for historical reasons,
 *   but they are format-agnostic — they work on any Figma node tree
 *   regardless of whether it came from a .deck or .fig file.
 *   Both formats share the same binary codec (canvas.fig inside a ZIP).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { hashToHex } from '../core/image-helpers.mjs';
import { nid } from '../core/node-helpers.mjs';

export const SLIDE_W = 1920;
export const SLIDE_H = 1080;

// Per-slide ID counter — reset at the start of each slideToSvg call so IDs are unique within each SVG doc
let _svgIdSeq = 0;

// Depth counter for SYMBOL rendering context. When > 0 we're inside a component
// tree and frame clipping is suppressed — Figma doesn't enforce child frame clips
// inside components whose root allows overflow (frameMaskDisabled=true).
let _symbolDepth = 0;

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

/** Generate an SVG gradient definition for a GRADIENT_LINEAR or GRADIENT_RADIAL paint.
 *  w, h = element dimensions in pixels (needed for userSpaceOnUse coordinates).
 *  Returns { defs: string, fill: string } where fill is 'url(#grad-N)'. */
function resolveGradientSvg(paint, w, h) {
  const id = `grad-${++_svgIdSeq}`;
  const stops = (paint.stops ?? []).map(s => {
    const color = cssColor(s.color ?? {});
    return `<stop offset="${s.position}" stop-color="${color}"/>`;
  }).join('');
  const opacityAttr = (paint.opacity ?? 1) !== 1 ? ` opacity="${paint.opacity}"` : '';

  // Figma's paint.transform maps from NODE space to GRADIENT space.
  // We need the inverse: gradient space → node normalized space → pixels.
  const t = paint.transform ?? {};
  const ga = t.m00 ?? 1, gc = t.m01 ?? 0, ge = t.m02 ?? 0;
  const gb = t.m10 ?? 0, gd = t.m11 ?? 1, gf = t.m12 ?? 0;
  const det = ga * gd - gb * gc;
  // Inverse affine: paint.transform maps node→gradient; we need gradient→node
  const ia = gd / det, ic = -gc / det, ie = (gc * gf - gd * ge) / det;
  const ib = -gb / det, iid = ga / det, iif = (gb * ge - ga * gf) / det;
  const tx = (gx, gy) => (ia * gx + ic * gy + ie) * w;
  const ty = (gx, gy) => (ib * gx + iid * gy + iif) * h;
  const f = v => +v.toFixed(2);

  if (paint.type === 'GRADIENT_LINEAR') {
    // Linear gradient line: (0, 0.5) → (1, 0.5) in gradient space
    return {
      defs: `<linearGradient id="${id}" x1="${f(tx(0,0.5))}" y1="${f(ty(0,0.5))}" x2="${f(tx(1,0.5))}" y2="${f(ty(1,0.5))}" gradientUnits="userSpaceOnUse">${stops}</linearGradient>`,
      fill: `url(#${id})`,
      opacityAttr,
    };
  }
  if (paint.type === 'GRADIENT_RADIAL') {
    // Radial gradient: center (0.5, 0.5), radius mapped through transform
    const cx = f(tx(0.5, 0.5)), cy = f(ty(0.5, 0.5));
    // Radius along the gradient's x-axis: distance from center to (1, 0.5)
    const rx = f(Math.hypot(tx(1, 0.5) - tx(0.5, 0.5), ty(1, 0.5) - ty(0.5, 0.5)));
    const ry = f(Math.hypot(tx(0.5, 1) - tx(0.5, 0.5), ty(0.5, 1) - ty(0.5, 0.5)));
    // Rotation angle from the transform
    const angle = f(Math.atan2(ty(1, 0.5) - ty(0.5, 0.5), tx(1, 0.5) - tx(0.5, 0.5)) * 180 / Math.PI);
    return {
      defs: `<radialGradient id="${id}" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" gradientUnits="userSpaceOnUse" gradientTransform="rotate(${angle},${cx},${cy})">${stops}</radialGradient>`,
      fill: `url(#${id})`,
      opacityAttr,
    };
  }
  return null;
}

function appendDefs(defs, extra) {
  if (!extra) return defs;
  return defs
    ? defs.replace('</defs>', `${extra}</defs>`)
    : `<defs>${extra}</defs>`;
}

/** Get effective fillPaints for any node type. */
function getFillPaints(node) {
  if (node.fillPaints?.length) return node.fillPaints;
  // SHAPE_WITH_TEXT stores fill in nodeGenerationData.overrides[0].fillPaints
  return node.nodeGenerationData?.overrides?.[0]?.fillPaints ?? null;
}

function strokeSpec(node) {
  if (!node.strokeWeight || node.strokeWeight === 0) return null;
  const color = resolveFill(node.strokePaints) ?? 'none';
  if (color === 'none') return null;
  return {
    color,
    width: node.strokeWeight,
    align: node.strokeAlign ?? 'CENTER',
  };
}

/** Render strokeGeometry blobs as filled <path> elements (Figma's pre-expanded stroke outlines).
 *  Returns SVG string or '' if no strokeGeometry is available. */
function strokeGeometrySvg(deck, node) {
  const strokeColor = resolveFill(node.strokePaints);
  const sw = node.strokeWeight ?? 0;
  const blobs = deck.message?.blobs;
  if (!strokeColor || sw <= 0 || !node.strokeGeometry?.length || !blobs) return '';
  const segments = [];
  let hasEvenOdd = false;
  for (const geo of node.strokeGeometry) {
    const d = decodeCmdBlob(blobs, geo.commandsBlob);
    if (d) segments.push(d);
    if (geo.windingRule === 'EVENODD') hasEvenOdd = true;
  }
  if (!segments.length) return '';
  const rule = (segments.length > 1 || hasEvenOdd) ? ' fill-rule="evenodd"' : '';
  return `<path d="${segments.join('')}" fill="${strokeColor}"${rule}/>`;
}

function rectStrokeSvg(x, y, w, h, rx, stroke) {
  if (!stroke) return '';
  let sx = x;
  let sy = y;
  let sw = w;
  let sh = h;
  let srx = Math.min(rx, w / 2, h / 2);

  if (stroke.align === 'INSIDE') {
    sx += stroke.width / 2;
    sy += stroke.width / 2;
    sw -= stroke.width;
    sh -= stroke.width;
    srx = Math.max(0, srx - stroke.width / 2);
  } else if (stroke.align === 'OUTSIDE') {
    sx -= stroke.width / 2;
    sy -= stroke.width / 2;
    sw += stroke.width;
    sh += stroke.width;
    srx += stroke.width / 2;
  }

  if (sw <= 0 || sh <= 0) return '';
  return `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${srx}" ry="${srx}" fill="none" stroke="${stroke.color}" stroke-width="${stroke.width}"/>`;
}

function ellipseStrokeSvg(cx, cy, rx, ry, stroke) {
  if (!stroke) return '';
  let srx = rx;
  let sry = ry;

  if (stroke.align === 'INSIDE') {
    srx -= stroke.width / 2;
    sry -= stroke.width / 2;
  } else if (stroke.align === 'OUTSIDE') {
    srx += stroke.width / 2;
    sry += stroke.width / 2;
  }

  if (srx <= 0 || sry <= 0) return '';
  return `<ellipse cx="${cx}" cy="${cy}" rx="${srx}" ry="${sry}" fill="none" stroke="${stroke.color}" stroke-width="${stroke.width}"/>`;
}

// ── Transform helpers ─────────────────────────────────────────────────────────

/** Return the full SVG transform attribute value for a node.
 *  Uses `translate(x,y)` for pure translations, `matrix(a,b,c,d,e,f)` when
 *  rotation or scale is present. */
function svgTransform(node) {
  const t = node.transform;
  if (!t) return 'translate(0,0)';
  const m00 = t.m00 ?? 1, m01 = t.m01 ?? 0, m02 = t.m02 ?? 0;
  const m10 = t.m10 ?? 0, m11 = t.m11 ?? 1, m12 = t.m12 ?? 0;
  // Pure translation — no rotation or scale
  if (Math.abs(m00 - 1) < 1e-6 && Math.abs(m01) < 1e-6 &&
      Math.abs(m10) < 1e-6 && Math.abs(m11 - 1) < 1e-6) {
    return `translate(${m02},${m12})`;
  }
  // Use high precision for rotation/scale — 2dp on a 2000px element = ~8px error
  const h = v => +v.toFixed(6);
  return `matrix(${h(m00)},${h(m10)},${h(m01)},${h(m11)},${f(m02)},${f(m12)})`;
}

function size(node) {
  return { w: node.size?.x ?? 0, h: node.size?.y ?? 0 };
}

// ── Node renderers ────────────────────────────────────────────────────────────

function renderRect(deck, node) {
  const { w, h } = size(node);
  const rx = Math.min(node.cornerRadius ?? 0, w / 2, h / 2);
  const { defs, bg } = renderRoundedRectFillStack(deck, getFillPaints(node), w, h, rx);
  const fillSvg = bg ? `${[defs, bg].filter(Boolean).join('\n')}` : '';
  // Prefer strokeGeometry (Figma's pre-computed outline) for matching anti-aliasing.
  // strokeGeometry is CENTER-aligned — render underneath fill so fill covers inner half.
  const geoStroke = strokeGeometrySvg(deck, node);
  const strokeSvg = geoStroke || rectStrokeSvg(0, 0, w, h, rx, strokeSpec(node));
  // Stroke underneath, fill on top (hides inner half for OUTSIDE strokes)
  const inner = geoStroke
    ? [strokeSvg, fillSvg].filter(Boolean).join('\n')
    : [fillSvg, strokeSvg].filter(Boolean).join('\n');
  if (!inner) return '';
  return `<g transform="${svgTransform(node)}">\n${inner}\n</g>`;
}

function renderEllipse(deck, node) {
  const { w, h } = size(node);
  const fill = resolveFill(getFillPaints(node)) ?? 'none';
  // Local coordinates — svgTransform handles position + rotation
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const fillSvg = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"/>`;
  // Prefer strokeGeometry (Figma's pre-computed outline) for matching anti-aliasing.
  // strokeGeometry is CENTER-aligned — render underneath fill so fill covers inner half.
  const geoStroke = strokeGeometrySvg(deck, node);
  const strokeSvg = geoStroke || ellipseStrokeSvg(cx, cy, rx, ry, strokeSpec(node));
  // Stroke underneath, fill on top (hides inner half for OUTSIDE strokes)
  const inner = geoStroke
    ? [strokeSvg, fillSvg].filter(Boolean).join('\n')
    : [fillSvg, strokeSvg].filter(Boolean).join('\n');
  return `<g transform="${svgTransform(node)}">\n${inner}\n</g>`;
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

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Detect stale derivedTextData: text was edited outside Figma but glyph layout
 * wasn't recomputed. Returns true when the layout clearly doesn't match the text.
 */
function isStaleLayout(chars, baselines, glyphs) {
  if (!chars) return false;
  const len = chars.length;

  if (baselines?.length) {
    const lastEnd = baselines[baselines.length - 1]?.endCharacter;
    // baselines endCharacter should match chars length (±1 for trailing newline)
    if (lastEnd != null && Math.abs(lastEnd - len) > 1) return true;
  }

  if (glyphs?.length) {
    const maxFirstChar = glyphs.reduce((max, g) =>
      Math.max(max, g.firstCharacter ?? 0), 0);
    if (maxFirstChar >= len) return true;        // glyphs point beyond new text
    if (len > maxFirstChar + 3) return true;     // new text much longer than glyph coverage
  }

  return false;
}

/**
 * Fallback text layout for stale derivedTextData.
 * Emits line-level <tspan> elements and lets resvg handle per-glyph layout.
 * Uses original baseline metrics (line height, ascent, position) where available
 * since those are style-dependent, not content-dependent.
 * Auto-scales font size down when new text is longer than the original.
 * Returns { tspans, fontSize } so the caller can use the adjusted size.
 */
function fallbackTextTspans(dispChars, fontSize, node) {
  const baselines = node.derivedTextData?.baselines;
  const lines = dispChars.split('\n');
  // Drop trailing empty line from trailing newline
  if (lines.length > 1 && !lines[lines.length - 1]) lines.pop();

  // Use original baseline metrics for spacing (style property, still valid)
  let lineHeightPx = baselines?.[0]?.lineHeight ?? fontSize * 1.2;
  let lineAscent   = baselines?.[0]?.lineAscent ?? fontSize * 0.8;

  // Auto-fit: scale font size down when new text is longer than original.
  // Uses character count ratio per line as a proxy for width ratio.
  const nodeW = node.size?.x ?? 1920;
  const nodeH = node.size?.y ?? 0;
  let scale = 1;
  if (baselines?.length) {
    const maxOrigCharsPerLine = Math.max(...baselines.map(b =>
      Math.max(0, (b.endCharacter ?? 0) - (b.firstCharacter ?? 0))));
    const maxNewCharsPerLine = Math.max(...lines.map(l => l.length));

    // Scale down if widest new line has more chars than widest original line
    if (maxNewCharsPerLine > maxOrigCharsPerLine && maxOrigCharsPerLine > 0) {
      scale = Math.min(scale, maxOrigCharsPerLine / maxNewCharsPerLine);
    }

    // Also scale down if more lines than original (would overflow vertically)
    if (lines.length > baselines.length && nodeH > 0) {
      scale = Math.min(scale, baselines.length / lines.length);
    }

    scale = Math.max(scale, 0.15); // don't shrink below 15%
  }

  const adjFontSize    = fontSize * scale;
  const adjLineHeight  = lineHeightPx * scale;
  const adjLineAscent  = lineAscent * scale;

  // Horizontal alignment → text-anchor + x position
  const align  = node.textAlignHorizontal ?? 'LEFT';
  const anchor = align === 'CENTER' ? 'middle' : align === 'RIGHT' ? 'end' : 'start';
  const anchorX = align === 'CENTER' ? nodeW / 2 : align === 'RIGHT' ? nodeW : 0;

  // Use first baseline position if available (preserves Figma's padding/offset),
  // otherwise compute from vertical alignment
  let startX, startY;
  if (baselines?.[0]?.position) {
    startX = align === 'LEFT' ? baselines[0].position.x : anchorX;
    // Scale startY relative to the baseline position for auto-fit
    startY = baselines[0].position.y * scale;
  } else {
    startX = anchorX;
    const totalH = lines.length * adjLineHeight;
    const nodeH  = node.size?.y ?? totalH;
    const vAlign = node.textAlignVertical ?? 'TOP';
    startY = vAlign === 'CENTER' ? (nodeH - totalH) / 2 + adjLineAscent
           : vAlign === 'BOTTOM' ? nodeH - totalH + adjLineAscent
           : adjLineAscent;
  }

  const tspans = lines.map((line, i) => {
    const y = startY + i * adjLineHeight;
    return `<tspan x="${startX}" y="${y.toFixed(2)}" text-anchor="${anchor}">${esc(line) || ' '}</tspan>`;
  }).join('');

  return { tspans, fontSize: adjFontSize };
}

function styleAttrsFromFontName(fontName, derivedFontWeight) {
  const style = fontName?.style ?? 'Regular';
  const weight = derivedFontWeight
    ? String(derivedFontWeight)
    : /semibold/i.test(style) ? '600'
    : /bold/i.test(style) ? '700'
    : /medium/i.test(style) ? '500'
    : '400';
  const italic = /italic/i.test(style) ? 'italic' : 'normal';
  return { weight, italic };
}

function glyphSlice(chars, glyphs, index) {
  const g = glyphs[index];
  if (g.firstCharacter == null) {
    throw new Error('Unexpected glyph without firstCharacter');
  }
  let nextChar = null;
  for (let j = index + 1; j < glyphs.length; j++) {
    const fc = glyphs[j].firstCharacter;
    if (fc != null && fc > g.firstCharacter) {
      nextChar = fc;
      break;
    }
  }
  return chars.slice(g.firstCharacter, nextChar ?? (g.firstCharacter + 1));
}

function renderText(deck, node) {
  const chars = node.textData?.characters ?? '';
  if (!chars.trim()) return '';
  const dispChars = node.textCase === 'UPPER' ? chars.toUpperCase()
                  : node.textCase === 'LOWER' ? chars.toLowerCase()
                  : chars;

  let   fontSize   = node.derivedTextData?.glyphs?.[0]?.fontSize ?? node.fontSize ?? 24;
  const fontFamily = node.fontName?.family ?? 'Inter';
  const fill       = resolveFill(getFillPaints(node)) ?? '#000000';
  // Letter spacing: PERCENT is % of fontSize, PIXELS is absolute
  const ls = node.letterSpacing;
  let   letterSpacingPx = !ls ? 0
    : ls.units === 'PERCENT' ? (ls.value / 100) * fontSize
    : ls.units === 'PIXELS'  ? ls.value
    : 0;
  const baselines  = node.derivedTextData?.baselines;
  const glyphs     = node.derivedTextData?.glyphs;
  const styleIds   = node.textData?.characterStyleIDs;
  const styleTable = node.textData?.styleOverrideTable;
  const stale = isStaleLayout(chars, baselines, glyphs);
  if (!glyphs?.length && !stale) {
    throw new Error(`TEXT ${node.name ?? nid(node)} is missing derived glyph layout`);
  }

  // Build styleID → {weight, italic, decoration, family} map
  const styleMap = {};
  if (styleIds && styleTable) {
    for (const ov of styleTable) {
      // Only override weight/italic/family if fontName is explicitly set in this style run
      const hasFontName = ov.fontName?.family || ov.fontName?.style;
      const { weight, italic } = hasFontName ? styleAttrsFromFontName(ov.fontName, null) : {};
      styleMap[ov.styleID] = {
        family:     hasFontName ? (ov.fontName?.family ?? fontFamily) : null,
        weight:     hasFontName ? weight : null,  // null → fall through to defWeight
        italic:     hasFontName ? italic : null,  // null → fall through to defItalic
        decoration: ov.textDecoration === 'UNDERLINE' ? 'underline' : 'none',
      };
    }
  }

  // Node-level defaults
  const { weight: defWeight, italic: defItalic } = styleAttrsFromFontName(
    node.fontName, node.derivedTextData?.fontMetaData?.[0]?.fontWeight
  );

  // Per-glyph positioning with ligature merging: each character gets its own
  // <tspan> with Figma's x,y, EXCEPT known ligature sequences (fi, fl, ff,
  // ffi, ffl) which are merged into a single <tspan> positioned at the first
  // glyph so the font engine can substitute the ligature glyph.
  const LIGATURES = ['ffl', 'ffi', 'ff', 'fi', 'fl'];

  /** Check if a ligature starts at position i in the display string.
   *  Returns the ligature length or 0. */
  function ligatureAt(i) {
    for (const lig of LIGATURES) {
      if (dispChars.slice(i, i + lig.length) === lig) return lig.length;
    }
    return 0;
  }

  let tspans = '';
  if (stale || !glyphs?.length) {
    // Fallback: derivedTextData is stale (text was edited outside Figma).
    // Emit line-level tspans and let resvg handle per-glyph layout.
    const origFontSize = fontSize;
    const fb = fallbackTextTspans(dispChars, fontSize, node);
    tspans = fb.tspans;
    fontSize = fb.fontSize;                              // auto-fit may have scaled down
    if (origFontSize > 0) letterSpacingPx *= fontSize / origFontSize;
  } else if (baselines?.length && glyphs?.length && styleIds?.length) {
    // Mixed-style: group consecutive glyphs by styleID, emit per-glyph with ligature merge
    for (const b of baselines) {
      const lineGlyphs = glyphs.filter(g => g.firstCharacter >= b.firstCharacter && g.firstCharacter < b.endCharacter);
      if (!lineGlyphs.length) continue;

      const runs = [];
      let curRun = null;
      for (const g of lineGlyphs) {
        const sid = styleIds[g.firstCharacter] ?? 0;
        if (!curRun || sid !== curRun.sid) {
          curRun = { sid, glyphs: [] };
          runs.push(curRun);
        }
        curRun.glyphs.push(g);
      }

      for (const run of runs) {
        const st = styleMap[run.sid] ?? {};
        const w  = st.weight  ?? defWeight;
        const it = st.italic  ?? defItalic;
        const fam = st.family ?? fontFamily;
        for (let gi = 0; gi < run.glyphs.length; gi++) {
          const g = run.glyphs[gi];
          const ligLen = ligatureAt(g.firstCharacter);
          const span = ligLen > 1 ? ligLen : 1;
          const endIdx = gi + span < run.glyphs.length
            ? run.glyphs[gi + span].firstCharacter
            : Math.min((run.glyphs[run.glyphs.length - 1].firstCharacter + 1), b.endCharacter);
          const slice = dispChars.slice(g.firstCharacter, endIdx).replace(/\n$/, '');
          if (!slice || /^\s+$/.test(slice)) continue;
          tspans += `<tspan x="${g.position.x}" y="${g.position.y}" font-family="${fam}, sans-serif" font-weight="${w}" font-style="${it}">${esc(slice)}</tspan>`;
          if (span > 1) gi += span - 1; // skip merged glyphs
        }
      }
    }
  } else if (glyphs?.length) {
    // Per-glyph positioning with ligature merging
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i];
      const ligLen = ligatureAt(g.firstCharacter);
      const span = ligLen > 1 ? ligLen : 1;
      const endIdx = i + span < glyphs.length
        ? glyphs[i + span].firstCharacter
        : chars.length;
      const slice = dispChars.slice(g.firstCharacter, endIdx).replace(/\n$/, '');
      if (!slice || /^\s+$/.test(slice)) { continue; }
      tspans += `<tspan x="${g.position.x}" y="${g.position.y}">${esc(slice)}</tspan>`;
      if (span > 1) i += span - 1; // skip merged glyphs
    }
  } else if (baselines?.length) {
    tspans = baselines.map(b => {
      const slice = dispChars.slice(b.firstCharacter, b.endCharacter).replace(/\n$/, '');
      return `<tspan x="${b.position.x}" y="${b.position.y}">${esc(slice) || ' '}</tspan>`;
    }).join('');
  } else {
    throw new Error(`TEXT ${node.name ?? nid(node)} is missing derived baselines`);
  }

  const lsAttr = letterSpacingPx === 0 ? '' : ` letter-spacing="${letterSpacingPx.toFixed(3)}"`;

  const textEl = [
    `<text font-size="${fontSize}" font-family="${fontFamily}, sans-serif"`,
    `  font-weight="${defWeight}" font-style="${defItalic}" fill="${fill}"${lsAttr}`,
    `  text-rendering="geometricPrecision">${tspans}</text>`,
  ].join('\n');

  // Use Figma's pre-computed decoration rectangles (underline/strikethrough).
  // derivedTextData.decorations[].rects are relative to the node's local origin.
  const decorations = node.derivedTextData?.decorations ?? [];
  if (!decorations.length) return `<g transform="${svgTransform(node)}">\n${textEl}\n</g>`;
  const decorationRects = decorations.flatMap(d =>
    (d.rects ?? []).map(r =>
      `<rect x="${r.x.toFixed(2)}" y="${r.y.toFixed(2)}" width="${r.w.toFixed(2)}" height="${r.h.toFixed(2)}" fill="${fill}"/>`
    )
  );
  const inner = decorationRects.length ? textEl + '\n' + decorationRects.join('\n') : textEl;
  return `<g transform="${svgTransform(node)}">\n${inner}\n</g>`;
}

/**
 * Resolve an IMAGE-type fillPaint to inline SVG defs + bg element.
 * Supports FILL (cover), FIT (contain), and TILE scale modes.
 * Throws if the image file cannot be read.
 */
function resolveImageFillSvg(deck, imgFill, w, h, rx) {
  const hashBytes = imgFill.image?.hash;
  const hash = hashBytes?.length ? hashToHex(hashBytes) : imgFill.image?.name;
  if (!hash) throw new Error('Visible IMAGE fill is missing its asset hash');
  if (!deck.imagesDir) throw new Error(`Deck is missing imagesDir for visible IMAGE fill ${hash}`);
  let buf;
  try {
    buf = readFileSync(join(deck.imagesDir, hash));
  } catch (err) {
    throw new Error(`Missing image fill asset ${hash} in ${deck.imagesDir}: ${err.message}`);
  }

  const mime = (buf[0] === 0xFF && buf[1] === 0xD8) ? 'image/jpeg' : 'image/png';
  const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
  const id = ++_svgIdSeq;
  const clipId = `img-clip-${id}`;
  const clipDef = `<clipPath id="${clipId}"><rect width="${w}" height="${h}" rx="${rx}" ry="${rx}"/></clipPath>`;
  const mode = imgFill.imageScaleMode ?? 'FILL';
  const opacityAttr = (imgFill.opacity ?? 1) !== 1 ? ` opacity="${imgFill.opacity}"` : '';

  if (mode === 'TILE') {
    const tw = (imgFill.originalImageWidth  ?? 100) * (imgFill.scale ?? 1);
    const th = (imgFill.originalImageHeight ?? 100) * (imgFill.scale ?? 1);
    const patId = `img-pat-${id}`;
    return {
      defs: `${clipDef}<pattern id="${patId}" x="0" y="0" width="${tw}" height="${th}" patternUnits="userSpaceOnUse"><image href="${dataUri}" width="${tw}" height="${th}"${opacityAttr}/></pattern>`,
      bg:   `<rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="url(#${patId})" clip-path="url(#${clipId})"/>`,
    };
  }

  // FILL (cover) or FIT (contain)
  const par = mode === 'FIT' ? 'xMidYMid meet' : 'xMidYMid slice';
  return {
    defs: clipDef,
    bg:   `<image href="${dataUri}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="${par}" clip-path="url(#${clipId})"${opacityAttr}/>`,
  };
}

function renderRoundedRectFillStack(deck, fillPaints, w, h, rx) {
  const visibleFills = fillPaints?.filter(p => p.visible !== false) ?? [];
  let defs = '';
  const bgParts = [];

  for (const fill of visibleFills) {
    if (fill.type === 'SOLID') {
      bgParts.push(`<rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="${cssColor(fill.color ?? {}, fill.opacity ?? 1)}"/>`);
      continue;
    }
    if (fill.type === 'IMAGE') {
      const result = resolveImageFillSvg(deck, fill, w, h, rx);
      defs = appendDefs(defs, result.defs);
      bgParts.push(result.bg);
      continue;
    }
    if (fill.type === 'GRADIENT_LINEAR' || fill.type === 'GRADIENT_RADIAL') {
      const grad = resolveGradientSvg(fill, w, h);
      if (grad) {
        defs = appendDefs(defs, grad.defs);
        bgParts.push(`<rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="${grad.fill}"${grad.opacityAttr}/>`);
      }
    }
  }

  return { defs, bg: bgParts.join('\n') };
}

function renderFrame(deck, node) {
  const { w, h } = size(node);
  const rx = Math.min(node.cornerRadius ?? 0, w / 2, h / 2);
  const stroke = strokeSpec(node);
  const inner = childrenSvg(deck, node);
  let { defs, bg } = renderRoundedRectFillStack(deck, getFillPaints(node), w, h, rx);

  // Frame clipping: Figma frames clip children when "Clip content" is ON,
  // stored as frameMaskDisabled === false (explicit). Clipping is suppressed:
  //   - inside SYMBOL trees (Figma doesn't enforce child frame clips in components)
  //   - on frames with no visible fill (grouping containers, not visual viewports)
  const hasFill = getFillPaints(node)?.some(p => p.visible !== false);
  let clippedInner = inner;
  if (inner && node.frameMaskDisabled === false && _symbolDepth === 0 && hasFill) {
    const clipId = `frame-clip-${++_svgIdSeq}`;
    defs += `<clipPath id="${clipId}"><rect width="${w}" height="${h}" rx="${rx}" ry="${rx}"/></clipPath>`;
    clippedInner = `<g clip-path="url(#${clipId})">${inner}</g>`;
  }

  const strokeSvg = rectStrokeSvg(0, 0, w, h, rx, stroke);

  const parts = [defs, bg, clippedInner, strokeSvg].filter(Boolean).join('\n');
  if (!parts) return '';
  return `<g transform="${svgTransform(node)}">\n${parts}\n</g>`;
}

function renderGroup(deck, node) {
  const inner = childrenSvg(deck, node);
  if (!inner) return '';
  return `<g transform="${svgTransform(node)}">\n${inner}\n</g>`;
}

/**
 * SHAPE_WITH_TEXT: pill/badge nodes — styling and text stored in nodeGenerationData.overrides.
 * overrides[0] = shape (fill, stroke, cornerRadius)
 * overrides[1] = text (textData.characters, fontName, fontSize, textCase)
 * Text position comes from derivedImmutableFrameData.overrides[1].
 */
function renderShapeWithText(deck, node) {
  const { w, h } = size(node);
  const genOvs  = node.nodeGenerationData?.overrides ?? [];
  const shapeOv = genOvs[0] ?? {};
  const textOv  = genOvs[1] ?? {};

  // Shape styling
  const rawRx = shapeOv.cornerRadius ?? 0;
  const rx = Math.min(rawRx, w / 2, h / 2);  // 1000000 → pill
  const fill   = resolveFill(shapeOv.fillPaints) ?? 'none';

  // Prefer strokeGeometry (pre-computed filled outlines) over manual SVG strokes
  const geoStroke = strokeGeometrySvg(deck, node);
  let strokeAttr = '';
  if (!geoStroke) {
    const sw     = shapeOv.strokeWeight ?? 0;
    const stroke = sw > 0 ? resolveFill(shapeOv.strokePaints) ?? 'none' : 'none';
    strokeAttr = sw > 0 && stroke !== 'none' ? `stroke="${stroke}" stroke-width="${sw}"` : '';
  }

  const fillSvg = `<rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="${fill}" ${strokeAttr}/>`;
  // Stroke-under-fill compositing: strokeGeometry underneath, fill on top
  const rectSvg = geoStroke ? `${geoStroke}\n${fillSvg}` : fillSvg;

  // Text
  const chars = textOv.textData?.characters ?? '';
  if (!chars.trim()) return `<g transform="${svgTransform(node)}">${rectSvg}</g>`;

  const textCase  = textOv.textCase ?? 'ORIGINAL';
  const dispChars = textCase === 'UPPER' ? chars.toUpperCase()
                  : textCase === 'LOWER' ? chars.toLowerCase()
                  : chars;


  // Text offset + authoritative font metrics from derivedImmutableFrameData
  const derivedOvs  = node.derivedImmutableFrameData?.overrides ?? [];
  const textDerived = derivedOvs.find(o => o.derivedTextData) ?? {};
  const textBoxX    = textDerived.transform?.m02 ?? 0;
  const textBoxY    = textDerived.transform?.m12 ?? 0;
  const derivedText = textDerived.derivedTextData ?? {};
  const glyphs      = derivedText.glyphs;
  const truncationStartIndex = derivedText.truncationStartIndex >= 0
    ? derivedText.truncationStartIndex
    : null;
  const swtStale = isStaleLayout(chars, derivedText.baselines, glyphs);
  if (!glyphs?.length && !swtStale) {
    throw new Error(`SHAPE_WITH_TEXT ${node.name ?? nid(node)} is missing derived glyph layout`);
  }

  // derivedTextData is authoritative — nodeGenerationData can have stale/wrong values
  const derivedFont  = textDerived.derivedTextData?.fontMetaData?.[0]?.key;
  const fontSize     = textDerived.derivedTextData?.glyphs?.[0]?.fontSize ?? textOv.fontSize ?? 24;
  const fontFamily   = derivedFont?.family ?? textOv.fontName?.family ?? 'Inter';
  const fontStyle    = derivedFont?.style  ?? textOv.fontName?.style  ?? 'Regular';
  const fontWeight   = /semibold|bold/i.test(fontStyle) ? 'bold'
                     : /medium/i.test(fontStyle) ? '500' : 'normal';
  const fontItalic   = /italic/i.test(fontStyle) ? 'italic' : 'normal';
  const textFill     = resolveFill(textOv.fillPaints) ?? '#000000';

  let tspan;

  if (swtStale || !glyphs?.length) {
    // Fallback: stale layout — center text in shape using textBox offset
    const swtBaselines = derivedText.baselines;
    const lineHeightPx = swtBaselines?.[0]?.lineHeight ?? fontSize * 1.2;
    const lineAscent   = swtBaselines?.[0]?.lineAscent ?? fontSize * 0.8;
    const lines = dispChars.split('\n').filter((l, i, a) => i < a.length - 1 || l);
    const totalH = lines.length * lineHeightPx;
    // Center vertically in the text box area
    const textBoxH = textDerived.size?.y ?? h;
    const startY = textBoxY + (textBoxH - totalH) / 2 + lineAscent;
    const textBoxW = textDerived.size?.x ?? w;
    const cx = textBoxX + textBoxW / 2;
    tspan = lines.map((line, i) => {
      const y = startY + i * lineHeightPx;
      return `<tspan x="${cx}" y="${y.toFixed(2)}" text-anchor="middle">${esc(line) || ' '}</tspan>`;
    }).join('');
  } else {
    const spans = [];
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i];
      if (truncationStartIndex != null && g.firstCharacter != null && g.firstCharacter >= truncationStartIndex) continue;

      let slice = '';
      let stopAfter = false;
      if (g.firstCharacter == null) {
        if (truncationStartIndex == null) continue;
        slice = '…';
        stopAfter = true;
      } else {
        let nextChar = null;
        for (let j = i + 1; j < glyphs.length; j++) {
          const fc = glyphs[j].firstCharacter;
          if (fc != null && fc > g.firstCharacter) {
            nextChar = fc;
            break;
          }
        }
        slice = dispChars.slice(g.firstCharacter, nextChar ?? (g.firstCharacter + 1));
      }

      if (!slice) continue;
      spans.push(`<tspan x="${textBoxX + g.position.x}" y="${textBoxY + g.position.y}">${esc(slice)}</tspan>`);
      if (stopAfter) break;
    }
    tspan = spans.join('');
  }

  const textSvg = [
    `<text font-size="${fontSize}" font-family="${fontFamily}, sans-serif"`,
    `  font-weight="${fontWeight}" font-style="${fontItalic}" fill="${textFill}"`,
    `  text-rendering="geometricPrecision">${tspan}</text>`,
  ].join('\n');

  return `<g transform="${svgTransform(node)}">\n${rectSvg}\n${textSvg}\n</g>`;
}

function renderLine(deck, node) {
  // Prefer strokeGeometry (filled path outline) — gives better anti-aliasing
  // than SVG <line> for near-horizontal/vertical angled lines.
  const geoSvg = strokeGeometrySvg(deck, node);
  if (geoSvg) {
    return `<g transform="${svgTransform(node)}">\n${geoSvg}\n</g>`;
  }
  // Fallback: LINE uses full transform matrix: direction = (m00, m10), origin = (m02, m12)
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

/**
 * VECTOR — decode fillGeometry/strokeGeometry commandsBlob binary to SVG paths.
 *
 * Blob format: [cmdByte][float32LE params...]
 *   0x01 = moveTo (x, y)
 *   0x02 = lineTo (x, y)
 *   0x04 = cubicTo (c1x, c1y, c2x, c2y, x, y)
 *   0x00 = close
 *
 * Coordinates are in node-size space. The full affine transform matrix is used
 * to position, scale, and rotate the vector in the slide.
 */
function renderVector(deck, node) {
  const t = node.transform ?? {};
  const m00 = t.m00 ?? 1, m01 = t.m01 ?? 0, m02 = t.m02 ?? 0;
  const m10 = t.m10 ?? 0, m11 = t.m11 ?? 1, m12 = t.m12 ?? 0;
  const blobs = deck.message?.blobs;
  const parts = [];

  // Collect fill paths — each fillGeometry entry is an independent fill region.
  // Sub-paths *within* one entry interact via fill-rule (e.g. QR codes, letter cutouts),
  // but entries are never combined — otherwise nesting causes evenodd to cut holes.
  const fillColor = resolveFill(getFillPaints(node));
  const fillEntries = []; // { d, color, rule }
  if (node.fillGeometry?.length && blobs) {
    // Build styleID → fill color map from per-path overrides
    const styleMap = new Map();
    if (node.vectorData?.styleOverrideTable?.length) {
      for (const s of node.vectorData.styleOverrideTable) {
        if (s.styleID != null && s.fillPaints) {
          styleMap.set(s.styleID, resolveFill(s.fillPaints));
        }
      }
    }

    for (const geo of node.fillGeometry) {
      const color = (geo.styleID && styleMap.has(geo.styleID))
        ? styleMap.get(geo.styleID)
        : fillColor;
      if (!color) continue;
      const d = decodeCmdBlob(blobs, geo.commandsBlob);
      if (!d) continue;
      const rule = geo.windingRule === 'EVENODD' ? ' fill-rule="evenodd"' : '';
      fillEntries.push({ d, color, rule });
    }
  }

  // Stroke handling — depends on strokeAlign:
  //   OUTSIDE: strokeGeometry is always CENTER-aligned in the blob data, regardless of
  //            the node's strokeAlign setting. For OUTSIDE, we use SVG native strokes at
  //            2× width underneath the fill — the fill covers the inner half, leaving
  //            only the outer portion visible.
  //   CENTER:  strokeGeometry blobs are pre-expanded filled outlines (correct as-is).
  //   INSIDE:  strokeGeometry + clip (TODO — falls back to CENTER for now).
  const strokeColor = resolveFill(node.strokePaints);
  const sw = node.strokeWeight ?? 0;
  const strokeAlign = node.strokeAlign ?? 'CENTER';

  if (strokeAlign === 'OUTSIDE' && strokeColor && sw > 0 && fillEntries.length) {
    // Stroke layer underneath (2× width, centered = sw outside + sw inside)
    for (const { d, rule } of fillEntries) {
      parts.push(`<path d="${d}" fill="none" stroke="${strokeColor}" stroke-width="${sw * 2}" stroke-linejoin="miter"${rule}/>`);
    }
    // Fill layer on top — covers inner half of stroke
    for (const { d, color, rule } of fillEntries) {
      parts.push(`<path d="${d}" fill="${color}"${rule}/>`);
    }
  } else {
    // Emit fill paths
    for (const { d, color, rule } of fillEntries) {
      parts.push(`<path d="${d}" fill="${color}"${rule}/>`);
    }
    // CENTER/INSIDE: use pre-computed strokeGeometry outlines as filled paths
    if (strokeColor && sw > 0 && node.strokeGeometry?.length && blobs) {
      const segments = [];
      let hasEvenOdd = false;
      for (const geo of node.strokeGeometry) {
        const d = decodeCmdBlob(blobs, geo.commandsBlob);
        if (d) segments.push(d);
        if (geo.windingRule === 'EVENODD') hasEvenOdd = true;
      }
      if (segments.length) {
        const rule = (segments.length > 1 || hasEvenOdd) ? ' fill-rule="evenodd"' : '';
        parts.push(`<path d="${segments.join('')}" fill="${strokeColor}"${rule}/>`);
      }
    }
  }

  // Fallback: decode vectorNetworkBlob when no pre-computed fill/strokeGeometry
  if (!parts.length && node.vectorData?.vectorNetworkBlob != null && blobs) {
    const vnbD = decodeVnb(blobs, node.vectorData.vectorNetworkBlob, node.vectorData.normalizedSize, node.size);
    if (vnbD) {
      const color = fillColor ?? resolveFill(node.strokePaints) ?? '#000000';
      parts.push(`<path d="${vnbD}" fill="${color}" fill-rule="evenodd"/>`);
    }
  }

  if (!parts.length) return renderPlaceholder(deck, node);
  return `<g transform="matrix(${m00},${m10},${m01},${m11},${m02},${m12})">\n${parts.join('\n')}\n</g>`;
}

/** BOOLEAN_OPERATION — render the pre-computed boolean result shape.
 *  fillGeometry contains the merged boolean result; children are shape operands
 *  baked into fillGeometry. However, the compound path may have winding-direction
 *  holes that need filling. Children are re-rendered with the PARENT's fill color
 *  (not their own) to fill these gaps — Figma applies the boolean node's fill
 *  to all content uniformly. */
function renderBooleanOp(deck, node) {
  const ownSvg = renderVector(deck, node);

  // For UNION booleans: re-render children using the parent's fill color to
  // fill winding-direction holes. XOR/SUBTRACT/INTERSECT fillGeometry is
  // self-contained — children are pure shape operands.
  let inner = '';
  if (node.booleanOperation === 'UNION') {
    const parentFill = resolveFill(getFillPaints(node));
    if (parentFill) {
      const children = deck.getChildren(nid(node));
      const childParts = [];
      for (const child of children) {
        if (child.phase === 'REMOVED') continue;
        const origFills = child.fillPaints;
        child.fillPaints = getFillPaints(node);
        childParts.push(renderNode(deck, child));
        child.fillPaints = origFills;
      }
      inner = childParts.filter(Boolean).join('\n');
    }
  }

  if (!ownSvg && !inner) return '';
  if (!inner) return ownSvg;
  if (!ownSvg) {
    const t = node.transform ?? {};
    const m00 = t.m00 ?? 1, m01 = t.m01 ?? 0, m02 = t.m02 ?? 0;
    const m10 = t.m10 ?? 0, m11 = t.m11 ?? 1, m12 = t.m12 ?? 0;
    return `<g transform="matrix(${m00},${m10},${m01},${m11},${m02},${m12})">\n${inner}\n</g>`;
  }
  const closeIdx = ownSvg.lastIndexOf('</g>');
  return ownSvg.slice(0, closeIdx) + inner + '\n</g>';
}

/** Decode a commandsBlob index into an SVG path d-string. */
function decodeCmdBlob(blobs, blobIdx) {
  if (blobIdx == null || !blobs?.[blobIdx]) return null;
  const raw = blobs[blobIdx].bytes ?? blobs[blobIdx];
  if (!raw) return null;

  // Convert indexed object to Buffer if needed
  let buf;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    buf = Buffer.from(raw);
  } else {
    const len = Object.keys(raw).length;
    buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = raw[i];
  }

  const cmds = [];
  let off = 0;
  while (off < buf.length) {
    const cmd = buf[off++];
    if (cmd === 0x01) { // moveTo
      const x = buf.readFloatLE(off); off += 4;
      const y = buf.readFloatLE(off); off += 4;
      cmds.push(`M${f(x)},${f(y)}`);
    } else if (cmd === 0x02) { // lineTo
      const x = buf.readFloatLE(off); off += 4;
      const y = buf.readFloatLE(off); off += 4;
      cmds.push(`L${f(x)},${f(y)}`);
    } else if (cmd === 0x04) { // cubicTo
      const c1x = buf.readFloatLE(off); off += 4;
      const c1y = buf.readFloatLE(off); off += 4;
      const c2x = buf.readFloatLE(off); off += 4;
      const c2y = buf.readFloatLE(off); off += 4;
      const x = buf.readFloatLE(off); off += 4;
      const y = buf.readFloatLE(off); off += 4;
      cmds.push(`C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(x)},${f(y)}`);
    } else if (cmd === 0x00) { // close
      cmds.push('Z');
    } else {
      break; // unknown command — stop
    }
  }
  return cmds.length ? cmds.join('') : null;
}

function f(v) { return +v.toFixed(2); }

/**
 * Decode vectorNetworkBlob into an SVG path d-string.
 * VNB stores vertices, segments (lines/cubics), and regions (loops of segment indices).
 * Coordinates are in normalizedSize space and must be scaled to nodeSize.
 *
 * Binary layout (all little-endian):
 *   Header: numVertices(u32), numSegments(u32), numRegions(u32), numStyles(u32)
 *   Vertices: x(f32), y(f32), handleMirroring(u32)  — 12 bytes each
 *   Segments: startVertex(u32), tangentStartX(f32), tangentStartY(f32),
 *             endVertex(u32), tangentEndX(f32), tangentEndY(f32), segType(u32) — 28 bytes each
 *   Regions: numLoops(u32), per loop: segCount(u32) + segIndices(u32[segCount]), windingRule(u32)
 */
function decodeVnb(blobs, blobIdx, normalizedSize, nodeSize) {
  const buf = blobToBuffer(blobs, blobIdx);
  if (!buf || buf.length < 16) return null;

  const scaleX = (nodeSize?.x ?? 1) / (normalizedSize?.x ?? 1);
  const scaleY = (nodeSize?.y ?? 1) / (normalizedSize?.y ?? 1);

  let off = 0;
  const numVerts = buf.readUInt32LE(off); off += 4;
  const numSegs  = buf.readUInt32LE(off); off += 4;
  const numRegions = buf.readUInt32LE(off); off += 4;
  off += 4; // numStyles

  // Parse vertices
  const verts = [];
  for (let i = 0; i < numVerts; i++) {
    const x = buf.readFloatLE(off) * scaleX; off += 4;
    const y = buf.readFloatLE(off) * scaleY; off += 4;
    off += 4; // handleMirroring
    verts.push({ x, y });
  }

  // Parse segments
  const segs = [];
  for (let i = 0; i < numSegs; i++) {
    const sv = buf.readUInt32LE(off); off += 4;
    const tsx = buf.readFloatLE(off) * scaleX; off += 4;
    const tsy = buf.readFloatLE(off) * scaleY; off += 4;
    const ev = buf.readUInt32LE(off); off += 4;
    const tex = buf.readFloatLE(off) * scaleX; off += 4;
    const tey = buf.readFloatLE(off) * scaleY; off += 4;
    const type = buf.readUInt32LE(off); off += 4;
    segs.push({ sv, tsx, tsy, ev, tex, tey, type });
  }

  // Parse regions → build SVG paths
  const cmds = [];
  for (let r = 0; r < numRegions; r++) {
    if (off + 4 > buf.length) break;
    const numLoops = buf.readUInt32LE(off); off += 4;
    for (let loop = 0; loop < numLoops; loop++) {
      if (off + 4 > buf.length) break;
      const segCount = buf.readUInt32LE(off); off += 4;
      for (let s = 0; s < segCount; s++) {
        if (off + 4 > buf.length) break;
        const segIdx = buf.readUInt32LE(off); off += 4;
        if (segIdx >= segs.length) continue;
        const seg = segs[segIdx];
        const start = verts[seg.sv];
        const end = verts[seg.ev];
        if (!start || !end) continue;

        if (s === 0) cmds.push(`M${f(start.x)},${f(start.y)}`);

        if (seg.type === 0) {
          // Line
          cmds.push(`L${f(end.x)},${f(end.y)}`);
        } else {
          // Cubic bezier — tangents are relative to their vertex
          const c1x = start.x + seg.tsx;
          const c1y = start.y + seg.tsy;
          const c2x = end.x + seg.tex;
          const c2y = end.y + seg.tey;
          cmds.push(`C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(end.x)},${f(end.y)}`);
        }
      }
      cmds.push('Z');
    }
    off += 4; // windingRule
  }

  return cmds.length ? cmds.join('') : null;
}

function blobToBuffer(blobs, blobIdx) {
  if (blobIdx == null || !blobs?.[blobIdx]) return null;
  const raw = blobs[blobIdx].bytes ?? blobs[blobIdx];
  if (!raw) return null;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return Buffer.from(raw);
  const len = Object.keys(raw).length;
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = raw[i];
  return buf;
}

function renderPlaceholder(deck, node) {
  const { w, h } = size(node);
  const type = node.type ?? '?';
  return `<g transform="${svgTransform(node)}"><rect x="0" y="0" width="${w || 40}" height="${h || 40}" fill="none" stroke="#ff00ff" stroke-width="2" stroke-dasharray="6" opacity="0.5"/><!-- ${type} --></g>`;
}

/**
 * INSTANCE → SYMBOL resolution.
 *
 * Figma templates use INSTANCE nodes that reference a SYMBOL definition.
 * The SYMBOL's children (TEXT, shapes, frames, etc.) define the visual content.
 * The INSTANCE may carry symbolOverrides that modify specific child properties
 * (text content, fills, etc.).
 *
 * Strategy:
 * - Resolve the SYMBOL via symbolData.symbolID
 * - Render the SYMBOL's children tree (they live in the normal node hierarchy)
 * - Apply symbolOverrides: text and fill overrides are temporarily applied
 *   to the target nodes, rendered, then restored.
 */
function renderInstance(deck, node) {
  const symbolId = node.symbolData?.symbolID;
  if (!symbolId) return renderPlaceholder(deck, node);

  const symNid = `${symbolId.sessionID}:${symbolId.localID}`;
  const symbol = deck.getNode(symNid);
  if (!symbol) return renderPlaceholder(deck, node);

  // Figma-parity: reject instances of symbols with invalid variant specs.
  // Figma Desktop silently shows blank slides for these. We match that behavior
  // deliberately so our preview catches invalid decks instead of hiding them.
  // Root cause: older tooling created SYMBOL variants with names (e.g.
  // "Size=Wide") that don't exist in the component set's variantPropSpecs.
  if (symbol.componentKey && symbol.variantPropSpecs) {
    const specValues = new Set(symbol.variantPropSpecs.map(s => s.value));
    const nameValues = (symbol.name || '').split(', ').map(p => p.split('=')[1]).filter(Boolean);
    const invalid = nameValues.some(v => !specValues.has(v));
    if (invalid) {
      const nid = `${node.guid.sessionID}:${node.guid.localID}`;
      console.warn(`⚠️  Skipping INSTANCE ${nid}: symbol ${symNid} "${symbol.name}" has invalid variant specs — Figma would show blank`);
      return renderPlaceholder(deck, node);
    }
  }

  // Temporarily apply symbolOverrides so rendered content reflects overrides.
  // Override guidPaths may reference library-original IDs (e.g. 100:656) rather
  // than local node IDs (e.g. 1:1131). Nodes expose their library ID via the
  // `overrideKey` property, so we build a lookup from overrideKey → local node.
  const overrides = node.symbolData?.symbolOverrides ?? [];
  const restores = [];

  // Build overrideKey → node map for all SYMBOL descendants
  const okMap = new Map();
  function buildOkMap(nid) {
    for (const child of deck.getChildren(nid)) {
      const ok = child.overrideKey;
      if (ok) okMap.set(`${ok.sessionID}:${ok.localID}`, child);
      buildOkMap(`${child.guid.sessionID}:${child.guid.localID}`);
    }
  }
  buildOkMap(symNid);

  // Build derivedSymbolData lookup: guidPath ID → entry.
  // Contains Figma-computed layout (size, transform, derivedTextData) for child
  // nodes as they appear in this INSTANCE, accounting for auto-layout resizing.
  const dsdMap = new Map();
  for (const entry of node.derivedSymbolData ?? []) {
    const guids = entry.guidPath?.guids;
    if (!guids?.length) continue;
    // Use the last guid in the path for single-level lookups
    const g = guids[guids.length - 1];
    dsdMap.set(`${g.sessionID}:${g.localID}`, entry);
  }

  // Apply symbolOverrides (symbol swaps, text characters, fill paints).
  // overriddenSymbolID entries swap which SYMBOL a nested INSTANCE renders —
  // e.g. swapping a body pose or head style in a character component.
  // These must be processed first so okMap gets extended with the new symbol's
  // descendants before text/fill overrides are applied.
  for (const ov of overrides) {
    const guids = ov.guidPath?.guids;
    if (!guids?.length || guids.length !== 1) continue;
    const targetId = `${guids[0].sessionID}:${guids[0].localID}`;
    const target = deck.getNode(targetId) ?? okMap.get(targetId);
    if (!target) continue;

    if (ov.overriddenSymbolID && target.symbolData) {
      const origSymbolID = target.symbolData.symbolID;
      restores.push(() => { target.symbolData.symbolID = origSymbolID; });
      target.symbolData.symbolID = ov.overriddenSymbolID;
      // Extend okMap with the new symbol's descendants so downstream
      // overrides and derivedSymbolData can find them by overrideKey.
      const newSymNid = `${ov.overriddenSymbolID.sessionID}:${ov.overriddenSymbolID.localID}`;
      buildOkMap(newSymNid);
    }

    if (ov.textData?.characters != null && target.textData) {
      const origChars = target.textData.characters;
      restores.push(() => { target.textData.characters = origChars; });
      target.textData.characters = ov.textData.characters;
    }

    if (ov.fillPaints) {
      const origFill = target.fillPaints;
      restores.push(() => { target.fillPaints = origFill; });
      target.fillPaints = ov.fillPaints;
    }
  }

  // Apply derivedSymbolData to matching nodes.
  // Auto-layout symbols (stackMode set): Figma re-positions/resizes children,
  // so apply size + transform + derivedTextData and skip global scale.
  // Non-auto-layout symbols: children scale proportionally, so only apply
  // derivedTextData (glyph re-layout) and use global scale for positioning.
  const isAutoLayout = !!symbol.stackMode;
  for (const [dsdId, dsd] of dsdMap) {
    const target = deck.getNode(dsdId) ?? okMap.get(dsdId);
    if (!target) continue;

    if (dsd.derivedTextData) {
      const orig = target.derivedTextData;
      restores.push(() => { target.derivedTextData = orig; });
      target.derivedTextData = dsd.derivedTextData;
    }
    if (isAutoLayout && dsd.size) {
      const orig = target.size;
      restores.push(() => { target.size = orig; });
      target.size = dsd.size;
    }
    if (isAutoLayout && dsd.transform) {
      const orig = target.transform;
      restores.push(() => { target.transform = orig; });
      target.transform = dsd.transform;
    }
  }

  // Scale when INSTANCE size differs from SYMBOL size.
  // Auto-layout symbols have per-node layout from derivedSymbolData, so skip scale.
  const instSize = size(node);
  const symSize = size(symbol.size ? symbol : node);
  const sx = symSize.w ? instSize.w / symSize.w : 1;
  const sy = symSize.h ? instSize.h / symSize.h : 1;
  const needsScale = !isAutoLayout && (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001);

  // Render SYMBOL's own fill as background (e.g. dark-blue cover slide)
  // Use INSTANCE size when auto-layout provides per-node layout
  const bgW = isAutoLayout ? instSize.w : symSize.w;
  const bgH = isAutoLayout ? instSize.h : symSize.h;
  const rx = Math.min(symbol.cornerRadius ?? 0, bgW / 2, bgH / 2);
  let { defs, bg } = renderRoundedRectFillStack(deck, getFillPaints(symbol), bgW, bgH, rx);

  // Render stroke. Use the INSTANCE's strokeGeometry (already computed for
  // INSTANCE dimensions) when borders are independent; fall back to SYMBOL rect.
  let strokeSvg = '';
  const strokeSrc = node.strokePaints ? node : symbol;
  const strokeColor = resolveFill(strokeSrc.strokePaints);
  if (strokeColor && (strokeSrc.strokeWeight ?? 0) > 0) {
    if (strokeSrc.borderStrokeWeightsIndependent && strokeSrc.strokeGeometry?.length) {
      const blobs = deck.message?.blobs;
      if (blobs) {
        const segs = [];
        for (const geo of strokeSrc.strokeGeometry) {
          const d = decodeCmdBlob(blobs, geo.commandsBlob);
          if (d) segs.push(d);
        }
        if (segs.length) {
          // Clip stroke to frame bounds — Figma's INSIDE-aligned stroke geometry
          // extends ±strokeWeight outside the frame edge (symmetric expansion).
          // A clipPath matching the frame bounds shows only the inside portion.
          const scId = `stroke-clip-${++_svgIdSeq}`;
          strokeSvg = `<clipPath id="${scId}"><rect width="${bgW}" height="${bgH}"/></clipPath>`
            + `<path d="${segs.join('')}" fill="${strokeColor}" clip-path="url(#${scId})"/>`;
        }
      }
    } else {
      const stroke = strokeSpec(strokeSrc);
      strokeSvg = rectStrokeSvg(0, 0, bgW, bgH, rx, stroke);
    }
  }

  _symbolDepth++;
  const inner = childrenSvg(deck, symbol);
  _symbolDepth--;

  // Restore mutations
  for (const fn of restores) fn();

  let content = [defs, bg, inner, strokeSvg].filter(Boolean).join('\n');
  if (!content) return '';
  if (needsScale) {
    content = `<g transform="scale(${sx},${sy})">\n${content}\n</g>`;
  }
  return `<g transform="${svgTransform(node)}">\n${content}\n</g>`;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

const RENDERERS = {
  ROUNDED_RECTANGLE: renderRect,
  RECTANGLE:         renderRect,
  SHAPE_WITH_TEXT:   renderShapeWithText,
  ELLIPSE:           renderEllipse,
  TEXT:              renderText,
  FRAME:             renderFrame,
  GROUP:             renderGroup,
  SECTION:           renderGroup,
  BOOLEAN_OPERATION: renderBooleanOp,
  VECTOR:            renderVector,
  LINE:              renderLine,
  STAR:              renderVector,
  REGULAR_POLYGON:   renderVector,
  POLYGON:           renderVector,
  INSTANCE:          renderInstance,
};

/** Build an SVG 1.1 <filter> for DROP_SHADOW effects.
 *  Uses feGaussianBlur + feOffset + feFlood + feComposite + feMerge (SVG 1.1)
 *  instead of feDropShadow (SVG 2) for broad renderer compatibility. */
function buildEffectFilter(node) {
  const effects = node.effects?.filter(e => e.visible !== false);
  if (!effects?.length) return null;

  const shadows = effects.filter(e => e.type === 'DROP_SHADOW');
  if (!shadows.length) return null;

  const id = `fx-${++_svgIdSeq}`;
  const parts = [];
  const mergeNodes = [];

  for (let i = 0; i < shadows.length; i++) {
    const s = shadows[i];
    const c = s.color ?? {};
    const r = Math.round((c.r ?? 0) * 255);
    const g = Math.round((c.g ?? 0) * 255);
    const b = Math.round((c.b ?? 0) * 255);
    const a = (c.a ?? 1).toFixed(4);
    const dx = s.offset?.x ?? 0;
    const dy = s.offset?.y ?? 0;
    const stdDev = (s.radius ?? 0) / 2;
    const sid = `s${i}`;
    parts.push(
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${stdDev}" result="${sid}b"/>`,
      `<feOffset in="${sid}b" dx="${dx}" dy="${dy}" result="${sid}o"/>`,
      `<feFlood flood-color="rgb(${r},${g},${b})" flood-opacity="${a}" result="${sid}c"/>`,
      `<feComposite in="${sid}c" in2="${sid}o" operator="in" result="${sid}"/>`,
    );
    mergeNodes.push(`<feMergeNode in="${sid}"/>`);
  }
  mergeNodes.push(`<feMergeNode in="SourceGraphic"/>`);
  parts.push(`<feMerge>${mergeNodes.join('')}</feMerge>`);

  // SVG default filter region: 10% padding. Sufficient for typical drop shadows
  // (radius ≤ 20px, offset ≤ 20px on elements > 100px).
  const defs = `<filter id="${id}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">${parts.join('')}</filter>`;
  return { defs, attr: `filter="url(#${id})"` };
}

function renderNode(deck, node) {
  if (node.phase === 'REMOVED') return '';
  const fn = RENDERERS[node.type] ?? renderPlaceholder;
  let svg = fn(deck, node);
  if (!svg) return '';

  // Apply effects (drop shadows)
  const fx = buildEffectFilter(node);
  if (fx) {
    svg = `<defs>${fx.defs}</defs>\n<g ${fx.attr}>${svg}</g>`;
  }

  const op = node.opacity;
  if (op != null && op < 1) {
    svg = `<g opacity="${op}">${svg}</g>`;
  }
  return svg;
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
  _svgIdSeq = 0;
  _symbolDepth = 0;
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

/**
 * Render any node (FRAME, GROUP, etc.) to SVG using its own size as the viewport.
 * Works for Design file frames, standalone components, or any node with a size field.
 *
 * Note: Figma's export expands bounds to include overflow content when a frame has
 * When frameMaskDisabled=true (clip content OFF), Figma's export expands the
 * bounds to include overflowing children.  We replicate this by computing the
 * content bounding box and expanding the SVG viewport accordingly.
 *
 * @param {FigDeck} fig - Parsed Figma file (works with both .deck and .fig)
 * @param {object} node - The node to render (typically a FRAME)
 */
export function frameToSvg(fig, node) {
  _svgIdSeq = 0;
  _symbolDepth = 0;
  const fw = Math.round(node.size?.x ?? 100);
  const fh = Math.round(node.size?.y ?? 100);
  const body = childrenSvg(fig, node);

  // Build background fill (supports solid, gradient, and image fills)
  const { defs: bgDefs, bg: bgSvg } = renderRoundedRectFillStack(fig, getFillPaints(node), fw, fh, 0);
  // Fallback to white rect if no visible fills
  const bgContent = bgSvg || `<rect x="0" y="0" width="${fw}" height="${fh}" fill="white"/>`;
  const defsBlock = bgDefs ? `${bgDefs}\n` : '';

  // When clip content is OFF, expand viewport to include overflow.
  // Use fractional viewBox origin for exact positioning; ceil the total
  // coordinate range for pixel dimensions (matches Figma's export sizing).
  let vx = 0, vy = 0, w = fw, h = fh;
  if (node.frameMaskDisabled === true) {
    const bounds = _contentBounds(fig, node);
    vx = bounds.minX;
    vy = bounds.minY;
    w = Math.ceil(bounds.maxX - bounds.minX);
    h = Math.ceil(bounds.maxY - bounds.minY);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" \
width="${w}" height="${h}" viewBox="${vx} ${vy} ${w} ${h}">
${defsBlock}${bgContent}
${body}
</svg>`;
}

/** Compute content bounding box of a node's children in the node's local space.
 *  Recurses into INSTANCE→SYMBOL to catch overflow from scaled symbol children. */
function _contentBounds(deck, node, depth = 2) {
  const fw = node.size?.x ?? 0;
  const fh = node.size?.y ?? 0;
  let minX = 0, minY = 0, maxX = fw, maxY = fh;

  for (const child of deck.getChildren(nid(node))) {
    if (child.phase === 'REMOVED' || child.visible === false) continue;

    const cx = child.transform?.m02 ?? 0;
    const cy = child.transform?.m12 ?? 0;
    const cw = child.size?.x ?? 0;
    const ch = child.size?.y ?? 0;

    minX = Math.min(minX, cx);
    minY = Math.min(minY, cy);
    maxX = Math.max(maxX, cx + cw);
    maxY = Math.max(maxY, cy + ch);

    // For INSTANCE nodes, check if symbol children overflow (scaled)
    if (depth > 0 && child.type === 'INSTANCE' && child.symbolData?.symbolID) {
      const symId = child.symbolData.symbolID;
      const sym = deck.getNode(`${symId.sessionID}:${symId.localID}`);
      if (sym) {
        const sw = sym.size?.x || cw;
        const sh = sym.size?.y || ch;
        const sx = cw / sw;
        const sy = ch / sh;
        const symBounds = _contentBounds(deck, sym, depth - 1);
        minX = Math.min(minX, cx + symBounds.minX * sx);
        minY = Math.min(minY, cy + symBounds.minY * sy);
        maxX = Math.max(maxX, cx + symBounds.maxX * sx);
        maxY = Math.max(maxY, cy + symBounds.maxY * sy);
      }
    }
  }

  return { minX, minY, maxX, maxY };
}
