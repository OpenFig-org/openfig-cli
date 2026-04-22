const SERIF = 'Georgia';
const SANS = 'Inter';
const BORDER = '#E8EAEE';

function drawLine(slide, x1, y1, x2, y2, opts = {}) {
  const out = { name: 'Line' };
  if (opts.stroke ?? opts.color) out.stroke = opts.stroke ?? opts.color;
  if (opts.strokeWeight ?? opts.weight) out.strokeWeight = opts.strokeWeight ?? opts.weight;
  if (opts.strokeCap) out.strokeCap = opts.strokeCap;
  if (opts.dashPattern) out.dashPattern = opts.dashPattern;
  return slide.addPath(`M ${x1} ${y1} L ${x2} ${y2}`, out);
}

function mapFont(family) {
  if (!family) return SANS;
  const f = family.toLowerCase();
  if (f.includes('garamond') || f.includes('georgia') || f.includes('serif')) return SERIF;
  return SANS;
}

function mapFontStyle(weight, style) {
  const heavy = typeof weight === 'number' ? weight >= 600 : false;
  const italic = style === 'italic';
  if (heavy && italic) return 'Bold Italic';
  if (heavy) return 'Bold';
  if (italic) return 'Italic';
  return 'Regular';
}

function textOpts(el) {
  const opts = {
    x: el.x, y: el.y,
    width: el.width,
    fontSize: el.size,
    font: mapFont(el.font),
    fontStyle: mapFontStyle(el.weight, el.style),
  };
  if (el.color) opts.color = el.color;
  if (el.height) opts.height = el.height;
  if (typeof el.letterSpacing === 'number') opts.letterSpacing = el.letterSpacing;
  if (typeof el.lineHeight === 'number') opts.lineHeight = el.lineHeight;
  if (typeof el.opacity === 'number') opts.opacity = el.opacity;
  if (el.align) opts.align = el.align.toUpperCase();
  if (el.noWrap) opts.autoresize = 'WIDTH_AND_HEIGHT';
  return opts;
}

function richTextRuns(runs) {
  return runs.map(r => {
    const out = { text: r.text };
    if (r.color) out.color = r.color;
    if (r.weight && r.weight >= 600) out.bold = true;
    if (r.style === 'italic') out.italic = true;
    if (r.bullet) out.bullet = true;
    if (r.number) out.number = true;
    return out;
  });
}

async function handleText(slide, el) {
  slide.addText(el.text ?? '', textOpts(el));
}

async function handleRichText(slide, el) {
  slide.addText(richTextRuns(el.runs ?? []), textOpts(el));
}

async function handleImage(slide, el, ctx) {
  const path = ctx.resolveMedia(el.src);
  const opts = { x: el.x, y: el.y, width: el.width, height: el.height };
  opts.scaleMode = el.objectFit === 'contain' ? 'FIT' : 'FILL';
  await slide.addImage(path, opts);
}

async function handleRect(slide, el) {
  const opts = {};
  if (el.fill) opts.fill = el.fill;
  if (el.stroke) { opts.stroke = el.stroke; opts.strokeWeight = el.strokeWeight ?? 1; }
  if (el.cornerRadius) opts.cornerRadius = el.cornerRadius;
  if (el.dashPattern) opts.dashPattern = el.dashPattern;
  slide.addRectangle(el.x, el.y, el.width, el.height, opts);
}

async function handleEllipse(slide, el) {
  // addEllipse (SHAPE_WITH_TEXT) doesn't support dashPattern, so dashed
  // ellipses go through addPath using a bezier approximation of the ring.
  if (el.dashPattern) {
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const rx = el.width / 2;
    const ry = el.height / 2;
    const k = 0.5522847498;
    const kx = k * rx, ky = k * ry;
    const d = `M ${cx + rx} ${cy} ` +
      `C ${cx + rx} ${cy + ky} ${cx + kx} ${cy + ry} ${cx} ${cy + ry} ` +
      `C ${cx - kx} ${cy + ry} ${cx - rx} ${cy + ky} ${cx - rx} ${cy} ` +
      `C ${cx - rx} ${cy - ky} ${cx - kx} ${cy - ry} ${cx} ${cy - ry} ` +
      `C ${cx + kx} ${cy - ry} ${cx + rx} ${cy - ky} ${cx + rx} ${cy} Z`;
    const opts = { name: 'Ellipse' };
    if (el.stroke) { opts.stroke = el.stroke; opts.strokeWeight = el.strokeWeight ?? 1; }
    if (el.fill) opts.fill = el.fill;
    opts.dashPattern = el.dashPattern;
    slide.addPath(d, opts);
    return;
  }
  const opts = {};
  if (el.fill) opts.fill = el.fill;
  if (el.stroke) { opts.stroke = el.stroke; opts.strokeWeight = el.strokeWeight ?? 1; }
  slide.addEllipse(el.x, el.y, el.width, el.height, opts);
}

async function handleBulletList(slide, el) {
  const runs = (el.items ?? []).map((t, i, arr) => ({
    text: t + (i < arr.length - 1 ? '\n' : ''),
    bullet: true,
  }));
  slide.addText(runs, {
    x: el.x + 34, y: el.y, width: el.width - 34,
    fontSize: el.size ?? 24,
    font: mapFont(el.font),
    color: el.color,
    list: 'UNORDERED',
  });
}

async function handleBlockquote(slide, el) {
  slide.addRectangle(el.x, el.y, 4, 140, { fill: el.borderColor ?? '#DC241F' });
  slide.addText(el.text, {
    x: el.x + 28, y: el.y,
    width: el.width - 28,
    fontSize: el.size ?? 22,
    font: mapFont(el.font ?? 'EB Garamond'),
    fontStyle: mapFontStyle(el.weight, el.style ?? 'italic'),
    color: el.color,
  });
}

async function handleCard(slide, el) {
  slide.addRectangle(el.x, el.y, el.width, el.height, {
    fill: el.background ?? '#FFFFFF',
    stroke: el.border ?? BORDER,
    strokeWeight: 1,
  });
  if (el.accentColor) {
    slide.addRectangle(el.x, el.y, el.accentWidth ?? 12, el.height, { fill: el.accentColor });
  }
  if (el.number) {
    slide.addText(el.number, {
      x: el.x + 44, y: el.y + 36, width: el.width - 88,
      fontSize: 24, font: SANS, fontStyle: 'Bold',
      color: el.accentColor ?? '#0B1B33',
    });
  }
  if (el.title) {
    slide.addText(el.title, {
      x: el.x + 44, y: el.y + 80, width: el.width - 88,
      fontSize: 42, font: SERIF, fontStyle: 'Bold',
      color: '#0B1B33',
    });
  }
  if (el.body) {
    slide.addText(el.body, {
      x: el.x + 44, y: el.y + 168, width: el.width - 88,
      fontSize: 24, font: SANS, color: '#5A6B82',
    });
  }
}

async function handleFactRow(slide, el) {
  const n = el.facts.length;
  const gap = 48;
  const colW = (el.width - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const fx = el.x + i * (colW + gap);
    slide.addText(el.facts[i].label, {
      x: fx, y: el.y, width: colW,
      fontSize: el.labelSize ?? 22, font: SANS, fontStyle: 'Bold',
      color: el.labelColor ?? '#DC241F',
    });
    slide.addText(el.facts[i].text, {
      x: fx, y: el.y + 38, width: colW,
      fontSize: el.textSize ?? 22, font: SANS,
      color: el.textColor ?? '#C9D4E8',
    });
  }
}

async function handleImageRow(slide, el, ctx) {
  const gap = el.gap ?? 0;
  let cx = el.x;
  for (const img of el.images) {
    await slide.addImage(ctx.resolveMedia(img.src), {
      x: cx, y: el.y, width: img.width, height: img.height, scaleMode: 'FIT',
    });
    cx += img.width + gap;
  }
}

async function handleTable(slide, el) {
  const columns = el.columns ?? [];
  const rows = el.rows ?? [];
  const headerRow = columns.slice();
  const dataRows = rows.map(r => columns.map(c => {
    const v = r[c];
    if (v && typeof v === 'object' && v.type === 'color-swatch') return `■ ${v.color}`;
    return String(v ?? '');
  }));
  slide.addTable(el.x, el.y, [headerRow, ...dataRows], { width: el.width, height: 720 });
}

async function handleTimeline(slide, el) {
  const steps = el.steps ?? [];
  const CARD_W = 320, GAP = 40, HEAD_H = 60, BODY_H = el.height - HEAD_H - 20;
  for (let i = 0; i < steps.length; i++) {
    const cx = el.x + i * (CARD_W + GAP);
    slide.addRectangle(cx, el.y, CARD_W, HEAD_H, { fill: steps[i].color });
    slide.addText(steps[i].year, {
      x: cx, y: el.y + 14, width: CARD_W,
      fontSize: 26, font: SANS, fontStyle: 'Bold', color: '#FFFFFF', align: 'CENTER',
    });
    slide.addRectangle(cx, el.y + HEAD_H, CARD_W, BODY_H, {
      fill: '#FFFFFF', stroke: BORDER, strokeWeight: 1,
    });
    slide.addText(steps[i].event, {
      x: cx + 18, y: el.y + HEAD_H + 20, width: CARD_W - 36,
      fontSize: 34, font: SERIF, fontStyle: 'Bold', color: '#0B1B33',
    });
    slide.addText(steps[i].description, {
      x: cx + 18, y: el.y + HEAD_H + 80, width: CARD_W - 36,
      fontSize: 22, font: SANS, color: '#5A6B82',
    });
    if (i < steps.length - 1) {
      slide.addText('→', {
        x: cx + CARD_W + 6, y: el.y + 38, width: GAP - 12,
        fontSize: 32, font: SANS, color: '#B0B8C4', align: 'CENTER',
      });
    }
  }
}

async function handleChart(slide, el) {
  const X0 = el.x + 100, X1 = el.x + el.width - 62;
  const Y0 = el.y + 30, Y1 = el.y + el.height - 200;
  slide.addRectangle(X0, Y0, 2, Y1 - Y0, { fill: BORDER });
  slide.addRectangle(X0, Y1, X1 - X0, 2, { fill: BORDER });
  const ticks = el.yAxis?.ticks ?? [];
  const yMax = el.yAxis?.max ?? 1;
  for (const t of ticks) {
    const ty = Y1 - (t / yMax) * (Y1 - Y0);
    drawLine(slide, X0, ty, X1, ty, { stroke: BORDER, strokeWeight: 1, dashPattern: [6, 4] });
    const label = t >= 1000 ? `${Math.round(t / 1000)}k` : `${t}`;
    slide.addText(label, {
      x: X0 - 90, y: ty - 16, width: 80,
      fontSize: 22, font: SANS, color: '#5A6B82', align: 'RIGHT',
    });
  }
  const xs = el.xAxis?.values ?? [];
  const series = el.series?.[0]?.data ?? [];
  const seriesColor = el.series?.[0]?.color ?? '#0B1B33';
  const points = series.map((v, i) => {
    const px = X0 + ((i + 0.5) / xs.length) * (X1 - X0);
    const py = Y1 - (v / yMax) * (Y1 - Y0);
    return { x: px, y: py };
  });
  for (let i = 0; i < points.length - 1; i++) {
    drawLine(slide, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, {
      color: seriesColor, weight: 4,
    });
  }
  const annotations = el.annotations ?? [];
  const redIdx = annotations[0]?.x;
  for (let i = 0; i < points.length; i++) {
    const red = i === redIdx;
    slide.addEllipse(points[i].x - 7, points[i].y - 7, 14, 14, {
      fill: red ? (annotations[0].color ?? '#DC241F') : seriesColor,
    });
  }
  for (let i = 0; i < xs.length; i++) {
    const px = X0 + ((i + 0.5) / xs.length) * (X1 - X0);
    const red = i === redIdx;
    slide.addText(xs[i], {
      x: px - 80, y: Y1 + 18, width: 160,
      fontSize: 22, font: SANS,
      color: red ? (annotations[0].color ?? '#DC241F') : '#5A6B82',
      fontStyle: red ? 'Bold' : 'Regular',
      align: 'CENTER',
    });
  }
  if (el.xAxis?.label) {
    slide.addText(el.xAxis.label, {
      x: el.x, y: Y1 + 72, width: el.width,
      fontSize: 22, font: SANS, fontStyle: 'Italic', color: '#5A6B82', align: 'CENTER',
    });
  }
  if (redIdx !== undefined) {
    const rx = X0 + ((redIdx + 0.5) / xs.length) * (X1 - X0);
    const annoColor = annotations[0].color ?? '#DC241F';
    drawLine(slide, rx, Y0 + 20, rx, Y1, { stroke: annoColor, strokeWeight: 2, dashPattern: [8, 5] });
    slide.addRectangle(rx - 165, Y0, 330, 54, { fill: annoColor, cornerRadius: 4 });
    slide.addText(annotations[0].label, {
      x: rx - 165, y: Y0 + 12, width: 330,
      fontSize: 22, font: SANS, fontStyle: 'Bold', color: '#FFFFFF', align: 'CENTER',
    });
  }
  if (el.note) {
    slide.addText(el.note, {
      x: el.x, y: el.y + el.height - 30, width: el.width,
      fontSize: 22, font: SANS, fontStyle: 'Italic', color: '#5A6B82', align: 'CENTER',
    });
  }
}

function normalizeColor(c) {
  if (!c || c === 'none' || c === 'transparent') return null;
  const s = c.trim().toLowerCase();
  const m = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toUpperCase();
  return c.toUpperCase().startsWith('#') ? c.toUpperCase() : c;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : undefined;
}

function numAttr(tag, name) {
  const v = attr(tag, name);
  return v === undefined ? undefined : Number(v);
}

function findSvgBlock(html, viewBox) {
  const re = new RegExp(`<svg\\b[^>]*viewBox\\s*=\\s*"${viewBox.replace(/\s+/g, '\\s+')}"[^>]*>([\\s\\S]*?)<\\/svg>`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

function svgContainerClass(html, viewBox) {
  const svgRe = new RegExp(`<svg\\b[^>]*viewBox\\s*=\\s*"${viewBox.replace(/\s+/g, '\\s+')}"`, 'i');
  const svgMatch = html.match(svgRe);
  if (!svgMatch) return null;
  const stopAt = svgMatch.index;
  const tagRe = /<(\/?)div\b([^>]*)>/gi;
  const stack = [];
  let t;
  while ((t = tagRe.exec(html)) !== null) {
    if (t.index >= stopAt) break;
    if (t[1] === '/') { stack.pop(); continue; }
    const cm = t[2].match(/class\s*=\s*"([^"]+)"/i);
    stack.push(cm ? cm[1].split(/\s+/)[0] : null);
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]) return stack[i];
  }
  return null;
}

function parseCssBlock(html, className) {
  const re = new RegExp(`\\.${className.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\{([^}]*)\\}`);
  const m = html.match(re);
  if (!m) return null;
  const rules = {};
  for (const decl of m[1].split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    rules[decl.slice(0, idx).trim()] = decl.slice(idx + 1).trim();
  }
  return rules;
}

function parsePx(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '0') return 0;
  const m = s.match(/^(-?\d+(?:\.\d+)?)px$/);
  return m ? parseFloat(m[1]) : null;
}

function parsePadding(v) {
  const parts = (v ?? '').trim().split(/\s+/).map(p => parsePx(p) ?? 0);
  if (parts.length === 1) return { t: parts[0], r: parts[0], b: parts[0], l: parts[0] };
  if (parts.length === 2) return { t: parts[0], r: parts[1], b: parts[0], l: parts[1] };
  if (parts.length === 3) return { t: parts[0], r: parts[1], b: parts[2], l: parts[1] };
  return { t: parts[0] ?? 0, r: parts[1] ?? 0, b: parts[2] ?? 0, l: parts[3] ?? 0 };
}

function computeContainerBox(rules, slideW, slideH) {
  const top = parsePx(rules.top);
  const right = parsePx(rules.right);
  const bottom = parsePx(rules.bottom);
  const left = parsePx(rules.left);
  const width = parsePx(rules.width);
  const height = parsePx(rules.height);
  let x = null, y = null, w = null, h = null;
  if (width != null) w = width;
  else if (left != null && right != null) w = slideW - left - right;
  if (height != null) h = height;
  else if (top != null && bottom != null) h = slideH - top - bottom;
  if (left != null) x = left;
  else if (right != null && w != null) x = slideW - right - w;
  if (top != null) y = top;
  else if (bottom != null && h != null) y = slideH - bottom - h;
  if (x == null || y == null || w == null || h == null) return null;
  return { x, y, w, h };
}

function fitViewBoxMeet(contentBox, vbW, vbH) {
  const scale = Math.min(contentBox.w / vbW, contentBox.h / vbH);
  const renderW = vbW * scale;
  const renderH = vbH * scale;
  return {
    x: contentBox.x + (contentBox.w - renderW) / 2,
    y: contentBox.y + (contentBox.h - renderH) / 2,
    w: renderW,
    h: renderH,
  };
}

function resolveSvgBounds(el, ctx) {
  if (!ctx.html || !el.viewBox) return null;
  const cls = svgContainerClass(ctx.html, el.viewBox);
  if (!cls) return null;
  const rules = parseCssBlock(ctx.html, cls);
  if (!rules || rules.position !== 'absolute') return null;
  const slideW = 1920, slideH = 1080;
  const container = computeContainerBox(rules, slideW, slideH);
  if (!container) return null;
  const pad = parsePadding(rules.padding);
  const content = {
    x: container.x + pad.l,
    y: container.y + pad.t,
    w: container.w - pad.l - pad.r,
    h: container.h - pad.t - pad.b,
  };
  const vb = el.viewBox.split(/\s+/).map(Number);
  return fitViewBoxMeet(content, vb[2], vb[3]);
}

function parseSvgShapes(innerMarkup) {
  const shapes = [];
  const stripped = innerMarkup.replace(/<!--[\s\S]*?-->/g, '');
  const tagRe = /<(circle|line|path|text|rect|ellipse)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1\s*>)/gi;
  let m;
  while ((m = tagRe.exec(stripped)) !== null) {
    const tag = m[1].toLowerCase();
    const attrsChunk = `<x ${m[2]}>`;
    const body = m[4];
    if (tag === 'circle') {
      shapes.push({
        type: 'circle',
        cx: numAttr(attrsChunk, 'cx'),
        cy: numAttr(attrsChunk, 'cy'),
        r: numAttr(attrsChunk, 'r'),
        fill: attr(attrsChunk, 'fill'),
        stroke: attr(attrsChunk, 'stroke'),
        strokeWidth: numAttr(attrsChunk, 'stroke-width'),
        strokeLinecap: attr(attrsChunk, 'stroke-linecap'),
      });
    } else if (tag === 'line') {
      shapes.push({
        type: 'line',
        x1: numAttr(attrsChunk, 'x1'),
        y1: numAttr(attrsChunk, 'y1'),
        x2: numAttr(attrsChunk, 'x2'),
        y2: numAttr(attrsChunk, 'y2'),
        stroke: attr(attrsChunk, 'stroke'),
        strokeWidth: numAttr(attrsChunk, 'stroke-width'),
        strokeLinecap: attr(attrsChunk, 'stroke-linecap'),
        strokeDasharray: attr(attrsChunk, 'stroke-dasharray'),
      });
    } else if (tag === 'path') {
      shapes.push({
        type: 'path',
        d: attr(attrsChunk, 'd'),
        fill: attr(attrsChunk, 'fill'),
        stroke: attr(attrsChunk, 'stroke'),
        strokeWidth: numAttr(attrsChunk, 'stroke-width'),
        strokeLinecap: attr(attrsChunk, 'stroke-linecap'),
      });
    } else if (tag === 'text') {
      shapes.push({
        type: 'text',
        x: numAttr(attrsChunk, 'x'),
        y: numAttr(attrsChunk, 'y'),
        fill: attr(attrsChunk, 'fill'),
        fontSize: numAttr(attrsChunk, 'font-size'),
        fontFamily: attr(attrsChunk, 'font-family'),
        fontStyle: attr(attrsChunk, 'font-style'),
        fontWeight: attr(attrsChunk, 'font-weight'),
        textAnchor: attr(attrsChunk, 'text-anchor'),
        text: (body ?? '').trim(),
      });
    }
  }
  return shapes;
}

function circleBezierPath(cx, cy, r) {
  const k = 0.5522847498 * r;
  return `M ${cx + r} ${cy} ` +
    `C ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} ` +
    `C ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} ` +
    `C ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} ` +
    `C ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} Z`;
}

// Parse an SVG path `d` string into an array of { cmd, nums } commands.
// Handles implicit repeated commands and concatenated numbers like `h38m0 0l-10-9`.
function tokenizePathD(d) {
  const NUM_RE = /[+-]?(?:\d+\.\d+|\.\d+|\d+)(?:[eE][+-]?\d+)?/g;
  const tokens = [];
  const cmdRe = /[MmLlHhVvCcSsQqTtAaZz]/g;
  let m;
  const marks = [];
  while ((m = cmdRe.exec(d)) !== null) marks.push({ cmd: m[0], start: m.index });
  for (let i = 0; i < marks.length; i++) {
    const { cmd, start } = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1].start : d.length;
    const segment = d.slice(start + 1, end);
    const nums = [];
    let nm;
    NUM_RE.lastIndex = 0;
    while ((nm = NUM_RE.exec(segment)) !== null) nums.push(parseFloat(nm[0]));
    tokens.push({ cmd, nums });
  }
  return tokens;
}

// Convert tokenized path into absolute M/L/C/Q/Z commands with resolved
// coordinates. Tracks pen position and last moveto for Z. Implicit commands
// after M become L; after m become l; multiple coord groups are handled.
function pathDToAbsoluteCmds(d) {
  const tokens = tokenizePathD(d);
  let cx = 0, cy = 0;        // current pen
  let sx = 0, sy = 0;        // last moveto (subpath start)
  let lastCx = null, lastCy = null; // last control point (for S/T smoothing)
  const out = [];
  for (const { cmd, nums } of tokens) {
    const abs = cmd === cmd.toUpperCase();
    const lc = cmd.toLowerCase();
    if (lc === 'z') { out.push({ cmd: 'Z' }); cx = sx; cy = sy; lastCx = lastCy = null; continue; }
    let i = 0;
    const take = (n) => { const r = nums.slice(i, i + n); i += n; return r; };
    const firstOfPolyline = { m: true };
    let isFirstPair = true;
    while (i < nums.length) {
      if (lc === 'm') {
        const [x, y] = take(2);
        cx = abs ? x : cx + x; cy = abs ? y : cy + y;
        if (isFirstPair) { sx = cx; sy = cy; out.push({ cmd: 'M', pts: [[cx, cy]] }); isFirstPair = false; }
        else out.push({ cmd: 'L', pts: [[cx, cy]] }); // subsequent pairs become L
        lastCx = lastCy = null;
      } else if (lc === 'l') {
        const [x, y] = take(2);
        cx = abs ? x : cx + x; cy = abs ? y : cy + y;
        out.push({ cmd: 'L', pts: [[cx, cy]] });
        lastCx = lastCy = null;
      } else if (lc === 'h') {
        const [x] = take(1);
        cx = abs ? x : cx + x;
        out.push({ cmd: 'L', pts: [[cx, cy]] });
        lastCx = lastCy = null;
      } else if (lc === 'v') {
        const [y] = take(1);
        cy = abs ? y : cy + y;
        out.push({ cmd: 'L', pts: [[cx, cy]] });
        lastCx = lastCy = null;
      } else if (lc === 'c') {
        const [x1, y1, x2, y2, x, y] = take(6);
        const p1 = [abs ? x1 : cx + x1, abs ? y1 : cy + y1];
        const p2 = [abs ? x2 : cx + x2, abs ? y2 : cy + y2];
        cx = abs ? x : cx + x; cy = abs ? y : cy + y;
        out.push({ cmd: 'C', pts: [p1, p2, [cx, cy]] });
        lastCx = p2[0]; lastCy = p2[1];
      } else if (lc === 's') {
        const [x2, y2, x, y] = take(4);
        const p1 = (lastCx !== null) ? [2 * cx - lastCx, 2 * cy - lastCy] : [cx, cy];
        const p2 = [abs ? x2 : cx + x2, abs ? y2 : cy + y2];
        cx = abs ? x : cx + x; cy = abs ? y : cy + y;
        out.push({ cmd: 'C', pts: [p1, p2, [cx, cy]] });
        lastCx = p2[0]; lastCy = p2[1];
      } else if (lc === 'q') {
        const [x1, y1, x, y] = take(4);
        const p1 = [abs ? x1 : cx + x1, abs ? y1 : cy + y1];
        cx = abs ? x : cx + x; cy = abs ? y : cy + y;
        out.push({ cmd: 'Q', pts: [p1, [cx, cy]] });
        lastCx = p1[0]; lastCy = p1[1];
      } else if (lc === 't') {
        const [x, y] = take(2);
        const p1 = (lastCx !== null) ? [2 * cx - lastCx, 2 * cy - lastCy] : [cx, cy];
        cx = abs ? x : cx + x; cy = abs ? y : cy + y;
        out.push({ cmd: 'Q', pts: [p1, [cx, cy]] });
        lastCx = p1[0]; lastCy = p1[1];
      } else {
        // Arc (A/a) not supported — consume 7 numbers per segment and emit a line to the endpoint.
        const [, , , , , x, y] = take(7);
        cx = abs ? x : cx + x; cy = abs ? y : cy + y;
        out.push({ cmd: 'L', pts: [[cx, cy]] });
        lastCx = lastCy = null;
      }
    }
  }
  return out;
}

function transformPathD(d, X, Y) {
  const cmds = pathDToAbsoluteCmds(d);
  const parts = [];
  for (const c of cmds) {
    if (c.cmd === 'Z') { parts.push('Z'); continue; }
    const coords = c.pts.map(([x, y]) => `${X(x).toFixed(3)} ${Y(y).toFixed(3)}`).join(' ');
    parts.push(`${c.cmd} ${coords}`);
  }
  return parts.join(' ');
}

async function handleSvg(slide, el, ctx) {
  const vb = (el.viewBox ?? '0 0 600 600').split(/\s+/).map(Number);
  const vbX = vb[0] ?? 0;
  const vbY = vb[1] ?? 0;
  const vbW = vb[2] ?? 600;
  const vbH = vb[3] ?? 600;
  const htmlBounds = resolveSvgBounds(el, ctx);
  const boxX = htmlBounds?.x ?? el.x;
  const boxY = htmlBounds?.y ?? el.y;
  const boxW = htmlBounds?.w ?? el.width;
  const boxH = htmlBounds?.h ?? el.height;
  const sx = boxW / vbW;
  const sy = boxH / vbH;
  const X = x => boxX + (x - vbX) * sx;
  const Y = y => boxY + (y - vbY) * sy;
  const S = Math.min(sx, sy);

  let shapes = el.shapes;
  if (!shapes) {
    if (!ctx.html) {
      throw new Error(`svg element "${el.id}" (slide ${ctx.slideIndex}) has no shapes[] and bundle has no HTML source to extract from`);
    }
    const markup = findSvgBlock(ctx.html, el.viewBox ?? '0 0 600 600');
    if (!markup) {
      throw new Error(`svg element "${el.id}" (slide ${ctx.slideIndex}): no <svg viewBox="${el.viewBox}"> found in bundle HTML`);
    }
    shapes = parseSvgShapes(markup);
  }

  for (const sh of shapes) {
    if (sh.type === 'circle') {
      const fill = normalizeColor(sh.fill);
      const stroke = normalizeColor(sh.stroke);
      const strokeWeight = (sh.strokeWidth ?? 1) * S;
      if (fill || stroke) {
        const d = circleBezierPath(X(sh.cx), Y(sh.cy), sh.r * S);
        const opts = { name: 'Circle' };
        if (fill) opts.fill = fill;
        if (stroke) { opts.stroke = stroke; opts.strokeWeight = strokeWeight; }
        slide.addPath(d, opts);
      }
    } else if (sh.type === 'ellipse') {
      const fill = normalizeColor(sh.fill);
      const stroke = normalizeColor(sh.stroke);
      const strokeWeight = (sh.strokeWidth ?? 1) * S;
      const rx = (sh.rx ?? 0) * sx;
      const ry = (sh.ry ?? 0) * sy;
      const opts = {};
      if (fill) opts.fill = fill;
      if (stroke) { opts.stroke = stroke; opts.strokeWeight = strokeWeight; }
      slide.addEllipse(X(sh.cx) - rx, Y(sh.cy) - ry, 2 * rx, 2 * ry, opts);
    } else if (sh.type === 'line') {
      const stroke = normalizeColor(sh.stroke);
      if (!stroke) continue;
      const d = `M ${X(sh.x1)} ${Y(sh.y1)} L ${X(sh.x2)} ${Y(sh.y2)}`;
      const lineOpts = {
        name: 'Line',
        stroke,
        strokeWeight: (sh.strokeWidth ?? 1) * S,
      };
      const cap = sh.strokeLinecap?.toUpperCase();
      if (cap === 'ROUND' || cap === 'SQUARE') lineOpts.strokeCap = cap;
      if (sh.strokeDasharray) lineOpts.dashPattern = sh.strokeDasharray.split(/[,\s]+/).map(Number).filter(n => Number.isFinite(n));
      slide.addPath(d, lineOpts);
    } else if (sh.type === 'rect') {
      const fill = normalizeColor(sh.fill);
      const stroke = normalizeColor(sh.stroke);
      const opts = {};
      if (fill) opts.fill = fill;
      if (stroke) { opts.stroke = stroke; opts.strokeWeight = (sh.strokeWidth ?? 1) * S; }
      slide.addRectangle(X(sh.x ?? 0), Y(sh.y ?? 0), (sh.width ?? 0) * sx, (sh.height ?? 0) * sy, opts);
    } else if (sh.type === 'path') {
      if (!sh.d) continue;
      const stroke = normalizeColor(sh.stroke);
      const fill = normalizeColor(sh.fill);
      const d = transformPathD(sh.d, X, Y);
      const opts = { name: 'Curve' };
      if (stroke) { opts.stroke = stroke; opts.strokeWeight = (sh.strokeWidth ?? 1) * S; }
      if (sh.strokeLinecap) opts.strokeCap = sh.strokeLinecap.toUpperCase();
      if (fill) opts.fill = fill;
      slide.addPath(d, opts);
    } else if (sh.type === 'text') {
      if (!sh.text) continue;
      const fontSize = (sh.fontSize ?? 16) * S;
      const align = sh.textAnchor === 'middle' ? 'CENTER' : sh.textAnchor === 'end' ? 'RIGHT' : 'LEFT';
      const width = boxW;
      let x = X(sh.x);
      if (align === 'CENTER') x = X(sh.x) - width / 2;
      else if (align === 'RIGHT') x = X(sh.x) - width;
      const opts = {
        x,
        y: Y(sh.y) - fontSize,
        width,
        fontSize,
        align,
        font: mapFont(sh.fontFamily),
        fontStyle: mapFontStyle(Number(sh.fontWeight) || 400, sh.fontStyle),
      };
      const color = normalizeColor(sh.fill);
      if (color) opts.color = color;
      slide.addText(sh.text, opts);
    }
  }
}

const HANDLERS = {
  text: handleText,
  richText: handleRichText,
  image: handleImage,
  rect: handleRect,
  ellipse: handleEllipse,
  bulletList: handleBulletList,
  blockquote: handleBlockquote,
  card: handleCard,
  factRow: handleFactRow,
  imageRow: handleImageRow,
  table: handleTable,
  timeline: handleTimeline,
  chart: handleChart,
  svg: handleSvg,
};

export async function applyElement(slide, el, ctx) {
  const handler = HANDLERS[el.type];
  if (!handler) {
    throw new Error(`handoff converter: unsupported element type "${el.type}" (slide ${ctx.slideIndex}, id=${el.id ?? '?'})`);
  }
  await handler(slide, el, ctx);
}
