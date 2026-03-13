/**
 * svg-builder.mjs — Convert a FigDeck slide node tree to an SVG string.
 *
 * Architecture: dispatcher pattern — each Figma node type maps to a render
 * function. Unknown types emit a magenta placeholder rect so renders never
 * crash. Add handlers incrementally as coverage grows.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { hashToHex } from '../image-helpers.mjs';
import { nid } from '../node-helpers.mjs';

export const SLIDE_W = 1920;
export const SLIDE_H = 1080;

// Per-slide ID counter — reset at the start of each slideToSvg call so IDs are unique within each SVG doc
let _svgIdSeq = 0;

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
  const rx = Math.min(node.cornerRadius ?? 0, w / 2, h / 2);
  const stroke = strokeSpec(node);
  const { defs, bg } = renderRoundedRectFillStack(deck, getFillPaints(node), w, h, rx);
  const fillSvg = bg ? `<g transform="translate(${x},${y})">\n${[defs, bg].filter(Boolean).join('\n')}\n</g>` : '';
  const strokeSvg = rectStrokeSvg(x, y, w, h, rx, stroke);
  return [fillSvg, strokeSvg].filter(Boolean).join('\n');
}

function renderEllipse(deck, node) {
  const { x, y } = pos(node);
  const { w, h } = size(node);
  const fill = resolveFill(getFillPaints(node)) ?? 'none';
  const stroke = strokeSpec(node);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const fillSvg = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"/>`;
  const strokeSvg = ellipseStrokeSvg(cx, cy, rx, ry, stroke);
  return [fillSvg, strokeSvg].filter(Boolean).join('\n');
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
  const { x, y } = pos(node);
  const chars = node.textData?.characters ?? '';
  if (!chars.trim()) return '';
  const dispChars = node.textCase === 'UPPER' ? chars.toUpperCase()
                  : node.textCase === 'LOWER' ? chars.toLowerCase()
                  : chars;

  const fontSize   = node.fontSize ?? 24;
  const fontFamily = node.fontName?.family ?? 'Inter';
  const fill       = resolveFill(getFillPaints(node)) ?? '#000000';
  // Letter spacing: PERCENT is % of fontSize, PIXELS is absolute
  const ls = node.letterSpacing;
  const letterSpacingPx = !ls ? 0
    : ls.units === 'PERCENT' ? (ls.value / 100) * fontSize
    : ls.units === 'PIXELS'  ? ls.value
    : 0;
  const baselines  = node.derivedTextData?.baselines;
  const glyphs     = node.derivedTextData?.glyphs;
  const styleIds   = node.textData?.characterStyleIDs;
  const styleTable = node.textData?.styleOverrideTable;
  if (!glyphs?.length) {
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

  const useGlyphLayout = !styleIds?.length && ((baselines?.length ?? 0) > 1 || letterSpacingPx !== 0);
  let tspans = '';
  if (baselines?.length && glyphs?.length && styleIds?.length) {
    // Mixed-style: group consecutive glyphs by styleID, emit per-run <tspan>
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
        const first = run.glyphs[0];
        const last  = run.glyphs[run.glyphs.length - 1];
        const endChar = last.firstCharacter + 1;
        const slice = dispChars.slice(first.firstCharacter, Math.min(endChar, b.endCharacter)).replace(/\n$/, '');
        const rx = x + first.position.x;
        const ry = y + first.position.y;
        tspans += `<tspan x="${rx}" y="${ry}" font-family="${fam}, sans-serif" font-weight="${w}" font-style="${it}">${esc(slice) || ' '}</tspan>`;
      }
    }
  } else if (useGlyphLayout) {
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i];
      const slice = glyphSlice(dispChars, glyphs, i).replace(/\n$/, '');
      if (!slice || /^\s+$/.test(slice)) continue;
      tspans += `<tspan x="${x + g.position.x}" y="${y + g.position.y}">${esc(slice)}</tspan>`;
    }
  } else if (baselines?.length) {
    tspans = baselines.map(b => {
      const slice = dispChars.slice(b.firstCharacter, b.endCharacter).replace(/\n$/, '');
      return `<tspan x="${x + b.position.x}" y="${y + b.position.y}">${esc(slice) || ' '}</tspan>`;
    }).join('');
  } else {
    throw new Error(`TEXT ${node.name ?? nid(node)} is missing derived baselines`);
  }

  const lsAttr = useGlyphLayout ? '' : (letterSpacingPx !== 0 ? ` letter-spacing="${letterSpacingPx.toFixed(3)}"` : '');
  const textEl = [
    `<text font-size="${fontSize}" font-family="${fontFamily}, sans-serif"`,
    `  font-weight="${defWeight}" font-style="${defItalic}" fill="${fill}"${lsAttr}`,
    `  text-rendering="geometricPrecision">${tspans}</text>`,
  ].join('\n');

  // Use Figma's pre-computed decoration rectangles (underline/strikethrough).
  // derivedTextData.decorations[].rects are relative to the node's top-left corner.
  const decorations = node.derivedTextData?.decorations ?? [];
  if (!decorations.length) return textEl;
  const decorationRects = decorations.flatMap(d =>
    (d.rects ?? []).map(r =>
      `<rect x="${(x + r.x).toFixed(2)}" y="${(y + r.y).toFixed(2)}" width="${r.w.toFixed(2)}" height="${r.h.toFixed(2)}" fill="${fill}"/>`
    )
  );
  return decorationRects.length ? textEl + '\n' + decorationRects.join('\n') : textEl;
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
    }
  }

  return { defs, bg: bgParts.join('\n') };
}

function renderFrame(deck, node) {
  const { x, y } = pos(node);
  const { w, h } = size(node);
  const rx = Math.min(node.cornerRadius ?? 0, w / 2, h / 2);
  const stroke = strokeSpec(node);
  const inner = childrenSvg(deck, node);
  let { defs, bg } = renderRoundedRectFillStack(deck, getFillPaints(node), w, h, rx);

  let clippedInner = inner;
  if (node.frameMaskDisabled === false && inner) {
    const clipId = `frame-clip-${++_svgIdSeq}`;
    const clipDef = `<clipPath id="${clipId}"><rect width="${w}" height="${h}" rx="${rx}" ry="${rx}"/></clipPath>`;
    defs = appendDefs(defs, clipDef);
    clippedInner = `<g clip-path="url(#${clipId})">\n${inner}\n</g>`;
  }

  const strokeSvg = rectStrokeSvg(0, 0, w, h, rx, stroke);

  const parts = [defs, bg, clippedInner, strokeSvg].filter(Boolean).join('\n');
  if (!parts) return '';
  return `<g transform="translate(${x},${y})">\n${parts}\n</g>`;
}

function renderGroup(deck, node) {
  const { x, y } = pos(node);
  const inner = childrenSvg(deck, node);
  if (!inner) return '';
  return `<g transform="translate(${x},${y})">\n${inner}\n</g>`;
}

/**
 * SHAPE_WITH_TEXT: pill/badge nodes — styling and text stored in nodeGenerationData.overrides.
 * overrides[0] = shape (fill, stroke, cornerRadius)
 * overrides[1] = text (textData.characters, fontName, fontSize, textCase)
 * Text position comes from derivedImmutableFrameData.overrides[1].
 */
function renderShapeWithText(deck, node) {
  const { x, y } = pos(node);
  const { w, h } = size(node);
  const genOvs  = node.nodeGenerationData?.overrides ?? [];
  const shapeOv = genOvs[0] ?? {};
  const textOv  = genOvs[1] ?? {};

  // Shape styling
  const rawRx = shapeOv.cornerRadius ?? 0;
  const rx = Math.min(rawRx, w / 2, h / 2);  // 1000000 → pill
  const fill   = resolveFill(shapeOv.fillPaints) ?? 'none';
  const sw     = shapeOv.strokeWeight ?? 0;
  const stroke = sw > 0 ? resolveFill(shapeOv.strokePaints) ?? 'none' : 'none';
  const strokeAttr = sw > 0 && stroke !== 'none' ? `stroke="${stroke}" stroke-width="${sw}"` : '';

  const rectSvg = `<rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="${fill}" ${strokeAttr}/>`;

  // Text
  const chars = textOv.textData?.characters ?? '';
  if (!chars.trim()) return `<g transform="translate(${x},${y})">${rectSvg}</g>`;

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
  if (!glyphs?.length) {
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
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

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

  const textSvg = [
    `<text font-size="${fontSize}" font-family="${fontFamily}, sans-serif"`,
    `  font-weight="${fontWeight}" font-style="${fontItalic}" fill="${textFill}"`,
    `  text-rendering="geometricPrecision">${tspan}</text>`,
  ].join('\n');

  return `<g transform="translate(${x},${y})">\n${rectSvg}\n${textSvg}\n</g>`;
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

  // Fill paths
  const fillColor = resolveFill(getFillPaints(node));
  if (fillColor && node.fillGeometry?.length && blobs) {
    for (const geo of node.fillGeometry) {
      const d = decodeCmdBlob(blobs, geo.commandsBlob);
      if (!d) continue;
      const rule = geo.windingRule === 'EVENODD' ? ' fill-rule="evenodd"' : '';
      parts.push(`<path d="${d}" fill="${fillColor}"${rule}/>`);
    }
  }

  // Stroke paths
  const strokeColor = resolveFill(node.strokePaints);
  const sw = node.strokeWeight ?? 0;
  if (strokeColor && sw > 0 && node.strokeGeometry?.length && blobs) {
    for (const geo of node.strokeGeometry) {
      const d = decodeCmdBlob(blobs, geo.commandsBlob);
      if (!d) continue;
      // strokeGeometry encodes the stroke outline as a fill shape
      const rule = geo.windingRule === 'EVENODD' ? ' fill-rule="evenodd"' : '';
      parts.push(`<path d="${d}" fill="${strokeColor}"${rule}/>`);
    }
  }

  if (!parts.length) return renderPlaceholder(deck, node);
  return `<g transform="matrix(${m00},${m10},${m01},${m11},${m02},${m12})">\n${parts.join('\n')}\n</g>`;
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

function renderPlaceholder(deck, node) {
  const { x, y } = pos(node);
  const { w, h } = size(node);
  const type = node.type ?? '?';
  return `<rect x="${x}" y="${y}" width="${w || 40}" height="${h || 40}" fill="none" stroke="#ff00ff" stroke-width="2" stroke-dasharray="6" opacity="0.5"/><!-- ${type} -->`;
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
  const { x, y } = pos(node);
  const symbolId = node.symbolData?.symbolID;
  if (!symbolId) return renderPlaceholder(deck, node);

  const symNid = `${symbolId.sessionID}:${symbolId.localID}`;
  const symbol = deck.getNode(symNid);
  if (!symbol) return renderPlaceholder(deck, node);

  // Temporarily apply symbolOverrides so rendered content reflects overrides.
  // Only single-level guidPath overrides are handled (covers the common case).
  const overrides = node.symbolData?.symbolOverrides ?? [];
  const restores = [];

  for (const ov of overrides) {
    const guids = ov.guidPath?.guids;
    if (!guids?.length || guids.length !== 1) continue;
    const targetId = `${guids[0].sessionID}:${guids[0].localID}`;
    const target = deck.getNode(targetId);
    if (!target) continue;

    // Text override — replace characters but keep derived glyph layout.
    // The glyph positions come from the original text, so this is approximate
    // when character count differs, but visually far better than a placeholder.
    if (ov.textData?.characters != null && target.textData) {
      const origChars = target.textData.characters;
      restores.push(() => { target.textData.characters = origChars; });
      target.textData.characters = ov.textData.characters;
    }

    // Fill override (image swaps, color changes)
    if (ov.fillPaints) {
      const origFill = target.fillPaints;
      restores.push(() => { target.fillPaints = origFill; });
      target.fillPaints = ov.fillPaints;
    }
  }

  const inner = childrenSvg(deck, symbol);

  // Restore mutations
  for (const fn of restores) fn();

  if (!inner) return '';
  return `<g transform="translate(${x},${y})">\n${inner}\n</g>`;
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
  BOOLEAN_OPERATION: renderGroup,
  VECTOR:            renderVector,
  LINE:              renderLine,
  STAR:              renderPlaceholder,
  POLYGON:           renderPlaceholder,
  INSTANCE:          renderInstance,
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
  _svgIdSeq = 0; // reset per-slide so IDs are unique within each SVG document
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
