const SERIF = 'Georgia';
const SANS = 'Inter';
const BORDER = '#E8EAEE';

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

function isPortableFontToken(token) {
  if (!token) return false;
  if (token.startsWith('-')) return false;
  return !NON_PORTABLE_FONT_TOKENS.has(token.toLowerCase());
}

function drawLine(slide, x1, y1, x2, y2, opts = {}) {
  const out = { name: 'Line' };
  if (opts.stroke ?? opts.color) out.stroke = opts.stroke ?? opts.color;
  if (opts.strokeWeight ?? opts.weight) out.strokeWeight = opts.strokeWeight ?? opts.weight;
  if (opts.strokeCap) out.strokeCap = opts.strokeCap;
  if (opts.dashPattern) out.dashPattern = opts.dashPattern;
  return slide.addPath(`M ${x1} ${y1} L ${x2} ${y2}`, out);
}

function mapFont(family) {
  // Pass the designer's chosen font through to the deck. The convert-time
  // font-unavailability audit (html-converter.mjs auditFonts) warns when a
  // font is unlikely to resolve in Figma. Coercing serifs to Georgia here
  // was a pre-warning shortcut that destroyed the designer's intent and
  // masked real font-substitution bugs — see openspec Phase 2 §font
  // resolution.
  if (!family) return SANS;
  // Raw SVG font-family attrs can be a CSS stack (`"Inter, sans-serif"` or
  // `"-apple-system, system-ui, Helvetica Neue, sans-serif"`). html-converter
  // strips the stack for HTML text, but SVG text reaches us unnormalized.
  // Walk past tokens Figma cannot resolve so we don't hand it `-apple-system`
  // and trigger a wider Inter fallback.
  if (typeof family === 'string' && family.includes(',')) {
    const entries = family.split(',').map((t) => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    if (entries.length === 0) return SANS;
    return entries.find(isPortableFontToken) ?? entries[0];
  }
  return family;
}

function mapFontStyle(weight, style) {
  const heavy = typeof weight === 'number' ? weight >= 600 : false;
  const italic = style === 'italic';
  if (heavy && italic) return 'Bold Italic';
  if (heavy) return 'Bold';
  if (italic) return 'Italic';
  return 'Regular';
}

function textOpts(el, ctx = {}) {
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
  if (el.verticalAlign === 'middle') opts.verticalAlign = 'CENTER';
  else if (el.verticalAlign === 'bottom') opts.verticalAlign = 'BOTTOM';
  // Text autoresize strategy:
  // - Single-line noWrap (labels, pill chips): WIDTH_AND_HEIGHT. Width may be
  //   tight (e.g. 112px pill) so we need Figma to grow width to stay on one
  //   line instead of wrapping.
  // - Large multi-line noWrap (titles split by explicit \n): HEIGHT. The
  //   browser-measured height (e.g. 275) reflects Chrome's rendering, but
  //   Figma positions glyphs differently when lineHeight < fontSize —
  //   descenders overflow the browser-measured height and dip into the next
  //   absolute sibling. Letting Figma auto-grow the frame fits its own
  //   descender placement; siblings have enough buffer in practice.
  // - Small multi-line noWrap captions: WIDTH_AND_HEIGHT. They need the same
  //   width freedom as labels, and the large-title descender issue does not
  //   apply at caption scale.
  // - Wrapping text: HEIGHT so Figma can reflow vertically.
  const isMultiLineNoWrap = el.noWrap
    && typeof el.text === 'string'
    && el.text.includes('\n');
  const needsLargeTitleAutoHeight = isMultiLineNoWrap && el.size >= 48;
  if (el.noWrap && !needsLargeTitleAutoHeight) {
    opts.autoresize = 'WIDTH_AND_HEIGHT';
    // Figma Slides enforces an implicit wrap boundary at
    // (slide_right − text_x) even for WIDTH_AND_HEIGHT. Setting
    // size.x = 16384 does NOT override it — the slide-edge boundary
    // wins. This is Slides-specific: open-pencil's reference Figma
    // text layout returns 1e6 for WIDTH_AND_HEIGHT, so regular Figma
    // Design never wraps these. Slides treats the SLIDE node as a
    // 1920×1080 clipping container.
    //
    // Narrowly-scoped guard: a multi-character large right-anchored token
    // (e.g. a divider numeral "11" at fontSize 420 placed via
    // CSS right:56px) can fit in Chromium's measured width but
    // overflow Slides' boundary by a few pixels and wrap. Shift x
    // leftward by an absolute, fontSize-scaled buffer to absorb the
    // few-pixel divergence. Body text and any string with whitespace
    // is excluded — they're never the failure mode.
    const slideWidth = ctx.slideWidth ?? 1920;
    const text = el.text || el.runs?.map(r => r.text || '').join('') || '';
    const slack = slideWidth - (el.x + (el.width ?? 0));
    const gateSize = el.size >= 96;
    const gateText = text.length > 0 && !/\s/.test(text);
    const gateSlack = slack <= 80;
    const isLargeRightEdgeToken = gateSize && gateText && gateSlack;
    let shift = 0;
    let buffer = 0;
    if (isLargeRightEdgeToken) {
      buffer = Math.max(12, Math.min(96, el.size * 0.20));
      const need = (el.width ?? 0) + buffer;
      const available = slideWidth - el.x;
      if (need > available) {
        shift = need - available;
        opts.x = Math.max(0, el.x - shift);
      }
    }
    if (ctx.noWrapDiagnostics) {
      ctx.noWrapDiagnostics.push({
        slide: ctx.slideIndex,
        x: el.x, y: el.y, width: el.width, fontSize: el.size,
        text: text.slice(0, 60),
        slack,
        gates: { size: gateSize, text: gateText, slack: gateSlack },
        fired: isLargeRightEdgeToken && shift > 0,
        buffer: isLargeRightEdgeToken ? buffer : 0,
        shift,
        xAfter: opts.x,
      });
    }
  } else {
    opts.autoresize = 'HEIGHT';
  }
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

async function handleText(slide, el, ctx) {
  slide.addText(el.text ?? '', textOpts(el, ctx));
}

async function handleRichText(slide, el, ctx) {
  slide.addText(richTextRuns(el.runs ?? []), textOpts(el, ctx));
}

// Render a flex / single-axis grid container from `browser-extract.mjs` as a
// Figma Auto Layout frame. The container's outer size is FIXED (we trust the
// authored rect); children are HUG (their intrinsic size). When Figma
// re-measures a child text leaf 1% wider than Chromium did, the re-flow
// happens inside this frame — siblings shift together instead of a single
// leaf crossing a pre-computed divider at slide coords.
async function handleLayoutContainer(target, el, ctx) {
  if (el.fallbackToAbsolute) {
    for (const child of el.children ?? []) {
      await applyElement(target, child, ctx);
    }
    return;
  }
  const frame = target.addFrame(el.x, el.y, el.width, el.height, {
    direction: el.direction === 'COLUMN' ? 'VERTICAL' : 'HORIZONTAL',
    spacing: el.gap ?? 0,
    name: 'FlexContainer',
  });
  styleAutoLayoutFrame(frame?._node, {
    paddingLeft: el.paddingLeft ?? 0,
    paddingRight: el.paddingRight ?? 0,
    paddingTop: el.paddingTop ?? 0,
    paddingBottom: el.paddingBottom ?? 0,
  });
  if (frame?._node) {
    // FIXED outer size: the slide layout depends on the container keeping its
    // authored dimensions. Children remain HUG (default after
    // styleAutoLayoutFrame) so they size to their own content and re-flow on
    // Chromium↔Figma metric drift.
    frame._node.stackPrimarySizing = 'FIXED';
    frame._node.stackCounterSizing = 'FIXED';
    if (el.primaryAxisAlignItems) {
      frame._node.stackPrimaryAlignItems = el.primaryAxisAlignItems;
    }
    if (el.counterAxisAlignItems) {
      frame._node.stackCounterAlignItems = el.counterAxisAlignItems;
    }
  }
  for (const child of el.children ?? []) {
    // Inside an Auto Layout frame, HTML stack relationships are preserved:
    // if a text child wraps one extra line because Figma's glyph metrics are
    // wider than Chromium's, the container re-flows its siblings. The flat
    // path's "preserve browser-measured height" trick (textOpts setting
    // autoresize NONE when el.height is present) no longer applies — clear
    // el.height so textOpts picks HEIGHT and the text frame grows vertically.
    let dispatched = child;
    if ((child.type === 'text' || child.type === 'richText') && !child.noWrap && child.height) {
      dispatched = { ...child, height: undefined };
    }
    await applyElement(frame, dispatched, ctx);
  }
}

function styleAutoLayoutFrame(node, opts = {}) {
  if (!node) return;
  const framePaint = (paint) => {
    if (!paint || paint.type !== 'SOLID') return paint;
    const alpha = paint.opacity ?? 1;
    return {
      ...paint,
      opacity: 1,
      color: { ...paint.color, a: alpha },
    };
  };
  node.frameMaskDisabled = true;
  node.stackPrimarySizing = 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE';
  node.stackCounterSizing = 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE';
  node.stackHorizontalPadding = opts.paddingLeft ?? 0;
  node.stackVerticalPadding = opts.paddingTop ?? 0;
  node.stackPaddingRight = opts.paddingRight ?? opts.paddingLeft ?? 0;
  node.stackPaddingBottom = opts.paddingBottom ?? opts.paddingTop ?? 0;
  node.fillPaints = opts.fill ? [framePaint(opts.fill)] : [{
    type: 'SOLID',
    color: { r: 0, g: 0, b: 0, a: 1 },
    opacity: 0,
    visible: true,
    blendMode: 'NORMAL',
  }];
  node.strokePaints = opts.stroke ? [opts.stroke] : [];
  node.strokeWeight = opts.stroke ? (opts.strokeWeight ?? 1) : 0;
  if (opts.cornerRadius) {
    node.cornerRadius = opts.cornerRadius;
    node.rectangleTopLeftCornerRadius = opts.cornerRadius;
    node.rectangleTopRightCornerRadius = opts.cornerRadius;
    node.rectangleBottomLeftCornerRadius = opts.cornerRadius;
    node.rectangleBottomRightCornerRadius = opts.cornerRadius;
  }
}

async function handlePillRow(slide, el) {
  const row = slide.addFrame(el.x, el.y, el.width, el.height, {
    direction: 'HORIZONTAL',
    spacing: el.gap,
    name: 'PillRow',
  });
  styleAutoLayoutFrame(row?._node);
  for (const item of el.items ?? []) {
    const rect = item.rect;
    const text = item.text;
    const pillFill = blendSolidPaintOver(
      rect.fill,
      typeof rect.opacity === 'number' ? rect.opacity : 1,
      '#080808',
    );
    const pill = row.addFrame(0, 0, rect.width, rect.height, {
      direction: 'HORIZONTAL',
      spacing: 0,
      name: 'Pill',
    });
    const topPad = Math.max(0, Math.round(text.y - rect.y) + 2);
    const bottomPad = Math.max(0, Math.round(rect.y + rect.height - (text.y + text.height)) - 2);
    styleAutoLayoutFrame(pill?._node, {
      fill: pillFill,
      stroke: buildSolidPaint(rect.stroke),
      strokeWeight: rect.strokeWeight ?? 1,
      cornerRadius: rect.cornerRadius,
      paddingLeft: Math.max(0, Math.round(text.x - rect.x)),
      paddingTop: topPad,
      paddingRight: Math.max(0, Math.round(rect.x + rect.width - (text.x + text.width))),
      paddingBottom: bottomPad,
    });
    pill.addText(text.text ?? '', textOpts(text));
  }
}

async function handleTextWithPillRow(slide, el) {
  const outer = slide.addFrame(el.x, el.y, el.width, el.height, {
    direction: 'VERTICAL',
    spacing: el.gap,
    name: 'TextWithPillRow',
  });
  styleAutoLayoutFrame(outer?._node);

  const textBlock = { ...el.textBlock };
  delete textBlock.height;
  const textValue = textBlock.type === 'richText'
    ? richTextRuns(textBlock.runs ?? [])
    : (textBlock.text ?? '');
  outer.addText(textValue, textOpts(textBlock));

  const row = outer.addFrame(0, 0, el.row.width, el.row.height, {
    direction: 'HORIZONTAL',
    spacing: el.row.gap,
    name: 'PillRow',
  });
  styleAutoLayoutFrame(row?._node);

  for (const item of el.row.items ?? []) {
    const rect = item.rect;
    const text = item.text;
    const pillFill = blendSolidPaintOver(
      rect.fill,
      typeof rect.opacity === 'number' ? rect.opacity : 1,
      '#080808',
    );
    const pill = row.addFrame(0, 0, rect.width, rect.height, {
      direction: 'HORIZONTAL',
      spacing: 0,
      name: 'Pill',
    });
    const topPad = Math.max(0, Math.round(text.y - rect.y) + 2);
    const bottomPad = Math.max(0, Math.round(rect.y + rect.height - (text.y + text.height)) - 2);
    styleAutoLayoutFrame(pill?._node, {
      fill: pillFill,
      stroke: buildSolidPaint(rect.stroke),
      strokeWeight: rect.strokeWeight ?? 1,
      cornerRadius: rect.cornerRadius,
      paddingLeft: Math.max(0, Math.round(text.x - rect.x)),
      paddingTop: topPad,
      paddingRight: Math.max(0, Math.round(rect.x + rect.width - (text.x + text.width))),
      paddingBottom: bottomPad,
    });
    pill.addText(text.text ?? '', textOpts(text));
  }
}

async function handleStatWithRing(slide, el, ctx) {
  const lineHeight = Math.round(el.label.lineHeight ?? 0);
  const measuredLines = lineHeight > 0
    ? Math.max(1, Math.round((el.label.height ?? 0) / lineHeight))
    : 0;
  const boost = measuredLines > 0 && measuredLines <= 3 ? lineHeight : 0;

  if (el.divider) {
    const extendedBottom = el.ring.y + boost + el.ring.height;
    await handleRect(slide, {
      ...el.divider,
      height: Math.max(el.divider.height, extendedBottom - el.divider.y),
    });
  }

  await handleRichText(slide, el.number, ctx);
  await handleText(slide, {
    ...el.label,
    height: el.label.height + boost,
  }, ctx);
  await handleSvg(slide, {
    ...el.ring,
    y: el.ring.y + boost,
  }, ctx);
  await handleText(slide, {
    ...el.caption,
    y: el.caption.y + boost,
  }, ctx);
}

// Map CSS `filter: blur(Npx)` (captured by browser-extract as
// `el.filter = { blur: N }`) onto a Figma FOREGROUND_BLUR effect.
// No-op when the element has no filter.
function applyFilter(node, el) {
  if (!node || !el?.filter) return;
  if (typeof el.filter.blur === 'number' && el.filter.blur > 0) {
    const existing = Array.isArray(node.effects) ? node.effects : [];
    node.effects = [
      ...existing,
      { type: 'FOREGROUND_BLUR', radius: el.filter.blur, visible: true, blendMode: 'NORMAL' },
    ];
  }
}

async function handleImage(slide, el, ctx) {
  const path = ctx.resolveMedia(el.src);
  const opts = { x: el.x, y: el.y, width: el.width, height: el.height };
  opts.scaleMode = el.objectFit === 'contain' ? 'FIT' : 'FILL';
  const node = await slide.addImage(path, opts);
  applyFilter(node, el);
}

async function handleRect(slide, el) {
  const opts = {};
  // If the element has CSS gradient layers, fold the solid fill (if any)
  // plus each gradient into a single fillPaints stack. Solid on bottom,
  // gradients layered on top in reverse CSS order so the FIRST CSS layer
  // ends up topmost (matching how browsers paint stacked background-image).
  const gradientPaints = buildCssBackgroundPaints(el.backgroundLayers);
  if (gradientPaints.length > 0) {
    if (el.stroke) { opts.stroke = el.stroke; opts.strokeWeight = el.strokeWeight ?? 1; }
    if (el.cornerRadius) opts.cornerRadius = el.cornerRadius;
    if (el.dashPattern) opts.dashPattern = el.dashPattern;
    opts.fill = el.fill || '#000000'; // placeholder; overwritten below
    const node = slide.addRectangle(el.x, el.y, el.width, el.height, opts);
    const paints = [];
    if (el.fill) {
      const solid = buildSolidPaint(el.fill);
      if (solid) {
        if (el.opacity != null && el.opacity < 1) solid.opacity *= el.opacity;
        paints.push(solid);
      }
    }
    for (let i = gradientPaints.length - 1; i >= 0; i--) paints.push(gradientPaints[i]);
    if (paints.length > 0) node.fillPaints = paints;
    applyFilter(node, el);
    return node;
  }
  if (el.fill) opts.fill = el.fill;
  if (el.stroke) { opts.stroke = el.stroke; opts.strokeWeight = el.strokeWeight ?? 1; }
  if (el.cornerRadius) opts.cornerRadius = el.cornerRadius;
  if (el.dashPattern) opts.dashPattern = el.dashPattern;
  const node = slide.addRectangle(el.x, el.y, el.width, el.height, opts);
  // Apply fill alpha to the fill paint only, not the node. Node-level opacity
  // would drag the stroke down with it (e.g. a 10% translucent pill would get
  // a 10% translucent outline), which never matches the CSS intent.
  if (el.opacity != null && el.opacity < 1 && el.fill && node?.fillPaints?.[0]) {
    node.fillPaints[0].opacity = el.opacity;
  }
  applyFilter(node, el);
  return node;
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
    const node = slide.addPath(d, opts);
    applyFilter(node, el);
    return;
  }
  const opts = {};
  if (el.fill) opts.fill = el.fill;
  if (el.stroke) { opts.stroke = el.stroke; opts.strokeWeight = el.strokeWeight ?? 1; }
  const node = slide.addEllipse(el.x, el.y, el.width, el.height, opts);
  applyFilter(node, el);
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

// Parse a CSS color string (#rrggbb / #rgb / rgb(...) / rgba(...) / named) into
// an { r, g, b, a } record with each channel in 0..1. Returns null for
// unparseable values so callers can skip the stop.
function parseColorRgba(c) {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  if (s === 'none' || s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = s.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (m) {
    return {
      r: parseInt(m[1] + m[1], 16) / 255,
      g: parseInt(m[2] + m[2], 16) / 255,
      b: parseInt(m[3] + m[3], 16) / 255,
      a: 1,
    };
  }
  m = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/);
  if (m) {
    return {
      r: parseInt(m[1], 16) / 255,
      g: parseInt(m[2], 16) / 255,
      b: parseInt(m[3], 16) / 255,
      a: m[4] != null ? parseInt(m[4], 16) / 255 : 1,
    };
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(',').map(p => p.trim());
    if (parts.length < 3) return null;
    const r = parseFloat(parts[0]) / 255;
    const g = parseFloat(parts[1]) / 255;
    const b = parseFloat(parts[2]) / 255;
    const a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
    if ([r, g, b, a].some(n => !Number.isFinite(n))) return null;
    return { r, g, b, a };
  }
  return null;
}

// Build a Figma fillPaint (GRADIENT_LINEAR or GRADIENT_RADIAL) from a parsed
// SVG gradient entry. `bbox` is the shape's bounding box in SVG user space,
// required when the gradient uses gradientUnits="userSpaceOnUse".
function buildGradientPaint(g, bbox) {
  const stops = g.stops
    .map(s => {
      const rgba = parseColorRgba(s.color);
      if (!rgba) return null;
      return {
        position: Math.max(0, Math.min(1, s.position)),
        color: { r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.a * (s.opacity ?? 1) },
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.position - b.position);
  if (stops.length === 0) return null;

  // Convert a point from gradient-space to shape-local 0..1 coords. For
  // objectBoundingBox, gradient space IS 0..1; we only apply gradientTransform.
  // For userSpaceOnUse we apply the transform then divide by the shape bbox.
  const toLocal = (x, y) => {
    let [tx, ty] = g.transform ? applyAffine(g.transform, x, y) : [x, y];
    if (g.units === 'userSpaceOnUse') {
      if (!bbox || !bbox.w || !bbox.h) return null;
      tx = (tx - bbox.x) / bbox.w;
      ty = (ty - bbox.y) / bbox.h;
    }
    return [tx, ty];
  };

  if (g.type === 'linear') {
    const p1 = toLocal(g.x1, g.y1);
    const p2 = toLocal(g.x2, g.y2);
    if (!p1 || !p2) return null;
    const [x1, y1] = p1;
    const [x2, y2] = p2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const det = dx * dx + dy * dy;
    if (det === 0) return null;
    const m00 = dx / det;
    const m01 = dy / det;
    const m02 = -(dx * x1 + dy * y1) / det;
    const m10 = -dy / det;
    const m11 = dx / det;
    const m12 = 0.5 + (dy * x1 - dx * y1) / det;
    return {
      type: 'GRADIENT_LINEAR',
      visible: true,
      opacity: 1,
      blendMode: 'NORMAL',
      transform: { m00, m01, m02, m10, m11, m12 },
      stops,
    };
  }

  // Radial with optional gradientTransform: build two basis vectors
  // e1 = (r, 0) and e2 = (0, r) in gradient space, transform them, then
  // invert the resulting basis to produce Figma's 2x3 paint transform.
  const { cx, cy, r } = g;
  if (!r) return null;
  const center = toLocal(cx, cy);
  if (!center) return null;
  const e1end = toLocal(cx + r, cy);
  const e2end = toLocal(cx, cy + r);
  if (!e1end || !e2end) return null;
  const bx = e1end[0] - center[0];
  const by = e1end[1] - center[1];
  const cxv = e2end[0] - center[0];
  const cyv = e2end[1] - center[1];
  const det2 = bx * cyv - by * cxv;
  if (!det2) return null;
  const inv00 = cyv / det2;
  const inv01 = -cxv / det2;
  const inv10 = -by / det2;
  const inv11 = bx / det2;
  const m00 = 0.5 * inv00;
  const m01 = 0.5 * inv01;
  const m02 = 0.5 - 0.5 * (inv00 * center[0] + inv01 * center[1]);
  const m10 = 0.5 * inv10;
  const m11 = 0.5 * inv11;
  const m12 = 0.5 - 0.5 * (inv10 * center[0] + inv11 * center[1]);
  return {
    type: 'GRADIENT_RADIAL',
    visible: true,
    opacity: 1,
    blendMode: 'NORMAL',
    transform: { m00, m01, m02, m10, m11, m12 },
    stops,
  };
}

function buildSolidPaint(cssColor) {
  const rgba = parseColorRgba(cssColor);
  if (!rgba || rgba.a === 0) return null;
  return {
    type: 'SOLID',
    visible: true,
    opacity: rgba.a,
    blendMode: 'NORMAL',
    color: { r: rgba.r, g: rgba.g, b: rgba.b, a: 1 },
  };
}

function blendSolidPaintOver(cssColor, opacity = 1, bgColor = '#000000') {
  const fg = parseColorRgba(cssColor);
  const bg = parseColorRgba(bgColor);
  if (!fg) return null;
  if (!bg) return buildSolidPaint(cssColor);
  const a = Math.max(0, Math.min(1, (fg.a ?? 1) * opacity));
  return {
    type: 'SOLID',
    visible: true,
    opacity: 1,
    blendMode: 'NORMAL',
    color: {
      r: fg.r * a + bg.r * (1 - a),
      g: fg.g * a + bg.g * (1 - a),
      b: fg.b * a + bg.b * (1 - a),
      a: 1,
    },
  };
}

// Translate CSS gradient layer descriptors (from browser-extract) into
// Figma gradient paints.
function buildCssBackgroundPaints(layers) {
  if (!Array.isArray(layers) || layers.length === 0) return [];
  const out = [];
  for (const layer of layers) {
    const paint = layer.kind === 'linear'
      ? buildCssLinearPaint(layer)
      : layer.kind === 'radial'
        ? buildCssRadialPaint(layer)
        : null;
    if (paint) out.push(paint);
  }
  return out;
}

function mapCssStops(stops) {
  const out = [];
  for (const s of stops) {
    const rgba = parseColorRgba(s.color);
    if (!rgba) continue;
    out.push({
      position: Math.max(0, Math.min(1, s.pos)),
      color: { r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.a },
    });
  }
  out.sort((a, b) => a.position - b.position);
  return out;
}

function buildCssLinearPaint(layer) {
  const stops = mapCssStops(layer.stops);
  if (stops.length === 0) return null;
  const theta = (layer.angleDeg ?? 180) * Math.PI / 180;
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  const half = (Math.abs(s) + Math.abs(c)) / 2;
  const x1 = 0.5 - half * s;
  const y1 = 0.5 + half * c;
  const x2 = 0.5 + half * s;
  const y2 = 0.5 - half * c;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const det = dx * dx + dy * dy;
  if (det === 0) return null;
  const m00 = dx / det;
  const m01 = dy / det;
  const m02 = -(dx * x1 + dy * y1) / det;
  const m10 = -dy / det;
  const m11 = dx / det;
  const m12 = 0.5 + (dy * x1 - dx * y1) / det;
  return {
    type: 'GRADIENT_LINEAR',
    visible: true,
    opacity: 1,
    blendMode: 'NORMAL',
    transform: { m00, m01, m02, m10, m11, m12 },
    stops,
  };
}

function buildCssRadialPaint(layer) {
  const stops = mapCssStops(layer.stops);
  if (stops.length === 0) return null;
  const { cx, cy, rx, ry } = layer;
  if (!(rx > 0) || !(ry > 0)) return null;
  const m00 = 1 / rx / 2;
  const m02 = 0.5 - cx / rx / 2;
  const m11 = 1 / ry / 2;
  const m12 = 0.5 - cy / ry / 2;
  return {
    type: 'GRADIENT_RADIAL',
    visible: true,
    opacity: 1,
    blendMode: 'NORMAL',
    transform: { m00, m01: 0, m02, m10: 0, m11, m12 },
    stops,
  };
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
  const gradients = parseSvgGradients(stripped);
  const tagRe = /<(circle|line|path|text|rect|ellipse|polyline|polygon)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1\s*>)/gi;
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
        opacity: numAttr(attrsChunk, 'opacity'),
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
        opacity: numAttr(attrsChunk, 'opacity'),
      });
    } else if (tag === 'path') {
      shapes.push({
        type: 'path',
        d: attr(attrsChunk, 'd'),
        fill: attr(attrsChunk, 'fill'),
        stroke: attr(attrsChunk, 'stroke'),
        strokeWidth: numAttr(attrsChunk, 'stroke-width'),
        strokeLinecap: attr(attrsChunk, 'stroke-linecap'),
        strokeLinejoin: attr(attrsChunk, 'stroke-linejoin'),
        strokeDasharray: attr(attrsChunk, 'stroke-dasharray'),
        opacity: numAttr(attrsChunk, 'opacity'),
      });
    } else if (tag === 'polyline' || tag === 'polygon') {
      const pts = (attr(attrsChunk, 'points') || '').trim();
      const nums = pts.split(/[\s,]+/).filter(Boolean).map(Number);
      if (nums.length < 4 || nums.length % 2 !== 0) continue;
      const parts = [];
      for (let i = 0; i < nums.length; i += 2) {
        parts.push(`${i === 0 ? 'M' : 'L'} ${nums[i]} ${nums[i + 1]}`);
      }
      if (tag === 'polygon') parts.push('Z');
      shapes.push({
        type: 'path',
        d: parts.join(' '),
        fill: attr(attrsChunk, 'fill'),
        stroke: attr(attrsChunk, 'stroke'),
        strokeWidth: numAttr(attrsChunk, 'stroke-width'),
        strokeLinecap: attr(attrsChunk, 'stroke-linecap'),
        strokeLinejoin: attr(attrsChunk, 'stroke-linejoin'),
        opacity: numAttr(attrsChunk, 'opacity'),
      });
    } else if (tag === 'rect') {
      shapes.push({
        type: 'rect',
        x: numAttr(attrsChunk, 'x') ?? 0,
        y: numAttr(attrsChunk, 'y') ?? 0,
        width: numAttr(attrsChunk, 'width') ?? 0,
        height: numAttr(attrsChunk, 'height') ?? 0,
        rx: numAttr(attrsChunk, 'rx'),
        ry: numAttr(attrsChunk, 'ry'),
        fill: attr(attrsChunk, 'fill'),
        stroke: attr(attrsChunk, 'stroke'),
        strokeWidth: numAttr(attrsChunk, 'stroke-width'),
        opacity: numAttr(attrsChunk, 'opacity'),
      });
    } else if (tag === 'ellipse') {
      shapes.push({
        type: 'ellipse',
        cx: numAttr(attrsChunk, 'cx') ?? 0,
        cy: numAttr(attrsChunk, 'cy') ?? 0,
        rx: numAttr(attrsChunk, 'rx') ?? 0,
        ry: numAttr(attrsChunk, 'ry') ?? 0,
        fill: attr(attrsChunk, 'fill'),
        stroke: attr(attrsChunk, 'stroke'),
        strokeWidth: numAttr(attrsChunk, 'stroke-width'),
        opacity: numAttr(attrsChunk, 'opacity'),
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
  return { shapes, gradients };
}

// Parse <linearGradient> / <radialGradient> defs, keyed by id.
// Returns a Map<id, { type, x1, y1, x2, y2, cx, cy, r, units, transform, stops }>.
// `units` is 'objectBoundingBox' (default) or 'userSpaceOnUse'.
// `transform` is a 2x3 affine [a,b,c,d,e,f] from gradientTransform, or null.
function parseSvgGradients(markup) {
  const out = new Map();
  const gradRe = /<(linearGradient|radialGradient)\b([^>]*?)>([\s\S]*?)<\/\1\s*>/gi;
  let gm;
  while ((gm = gradRe.exec(markup)) !== null) {
    const kind = gm[1].toLowerCase();
    const attrsChunk = `<x ${gm[2]}>`;
    const id = attr(attrsChunk, 'id');
    if (!id) continue;
    const body = gm[3];
    const stopRe = /<stop\b([^>]*?)(?:\/>|>[\s\S]*?<\/stop\s*>)/gi;
    const stops = [];
    let sm;
    while ((sm = stopRe.exec(body)) !== null) {
      const sAttrs = `<x ${sm[1]}>`;
      const offsetRaw = attr(sAttrs, 'offset');
      const offset = offsetRaw
        ? (offsetRaw.endsWith('%') ? parseFloat(offsetRaw) / 100 : parseFloat(offsetRaw))
        : 0;
      const color = attr(sAttrs, 'stop-color') || '#000';
      const op = attr(sAttrs, 'stop-opacity');
      const opacity = op != null ? parseFloat(op) : 1;
      stops.push({ position: offset, color, opacity });
    }
    if (stops.length === 0) continue;
    const unitsRaw = attr(attrsChunk, 'gradientUnits');
    const units = unitsRaw === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'objectBoundingBox';
    const transformRaw = attr(attrsChunk, 'gradientTransform');
    const transform = transformRaw ? parseSvgTransform(transformRaw) : null;
    // kind was lowercased above, so compare lowercase.
    const entry = { type: kind === 'lineargradient' ? 'linear' : 'radial', stops, units, transform };
    const defaultEnd = units === 'userSpaceOnUse' ? 0 : 1;
    if (entry.type === 'linear') {
      entry.x1 = numAttr(attrsChunk, 'x1') ?? 0;
      entry.y1 = numAttr(attrsChunk, 'y1') ?? 0;
      entry.x2 = numAttr(attrsChunk, 'x2') ?? defaultEnd;
      entry.y2 = numAttr(attrsChunk, 'y2') ?? 0;
    } else {
      entry.cx = numAttr(attrsChunk, 'cx') ?? 0.5;
      entry.cy = numAttr(attrsChunk, 'cy') ?? 0.5;
      entry.r = numAttr(attrsChunk, 'r') ?? 0.5;
    }
    out.set(id, entry);
  }
  return out;
}

// Parse an SVG gradientTransform string into a 2x3 affine [a,b,c,d,e,f]
// encoding [[a,c,e],[b,d,f],[0,0,1]]. Primitives compose left-to-right.
function parseSvgTransform(str) {
  const mul = (A, B) => [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
  let m = [1, 0, 0, 1, 0, 0];
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let tm;
  while ((tm = re.exec(str)) !== null) {
    const name = tm[1].toLowerCase();
    const nums = tm[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    let T;
    if (name === 'matrix') {
      if (nums.length < 6) continue;
      T = nums.slice(0, 6);
    } else if (name === 'translate') {
      T = [1, 0, 0, 1, nums[0] ?? 0, nums[1] ?? 0];
    } else if (name === 'scale') {
      const sx = nums[0] ?? 1;
      const sy = nums.length >= 2 ? nums[1] : sx;
      T = [sx, 0, 0, sy, 0, 0];
    } else if (name === 'rotate') {
      const a = ((nums[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(a), sin = Math.sin(a);
      const cx = nums[1] ?? 0, cy = nums[2] ?? 0;
      if (cx === 0 && cy === 0) {
        T = [cos, sin, -sin, cos, 0, 0];
      } else {
        T = mul([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]);
        T = mul(T, [1, 0, 0, 1, -cx, -cy]);
      }
    } else if (name === 'skewx') {
      T = [1, 0, Math.tan(((nums[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    } else if (name === 'skewy') {
      T = [1, Math.tan(((nums[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    } else {
      continue;
    }
    m = mul(m, T);
  }
  return m;
}

function applyAffine(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// Bounding box of a parsed SVG shape in its own user space. Used to
// normalize userSpaceOnUse gradients against the referencing shape.
function shapeBBoxSvg(sh) {
  if (!sh) return null;
  if (sh.type === 'rect') {
    return { x: sh.x ?? 0, y: sh.y ?? 0, w: sh.width ?? 0, h: sh.height ?? 0 };
  }
  if (sh.type === 'circle') {
    const r = sh.r ?? 0;
    return { x: (sh.cx ?? 0) - r, y: (sh.cy ?? 0) - r, w: r * 2, h: r * 2 };
  }
  if (sh.type === 'ellipse') {
    const rx = sh.rx ?? 0, ry = sh.ry ?? 0;
    return { x: (sh.cx ?? 0) - rx, y: (sh.cy ?? 0) - ry, w: rx * 2, h: ry * 2 };
  }
  if (sh.type === 'path' && sh.d) {
    const cmds = pathDToAbsoluteCmds(sh.d);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of cmds) {
      if (c.cmd === 'Z' || !c.pts) continue;
      for (const [x, y] of c.pts) {
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return null;
}

// Convert one SVG elliptical arc segment to a sequence of cubic bezier
// curves (≤90° per piece). Implements the center-parameterization conversion
// from SVG 1.1 Appendix F.6. Returns an array of [cp1, cp2, end] triples in
// absolute coordinates; each triple corresponds to a single C command.
function arcToCubicBeziers(x1, y1, rx, ry, phiDeg, fA, fS, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  if (!rx || !ry) return [[[x2, y2], [x2, y2], [x2, y2]]];
  const absRx = Math.abs(rx);
  const absRy = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  let rxAdj = absRx;
  let ryAdj = absRy;
  const lambda = x1p2 / (rxAdj * rxAdj) + y1p2 / (ryAdj * ryAdj);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rxAdj *= s;
    ryAdj *= s;
  }
  const rx2 = rxAdj * rxAdj;
  const ry2 = ryAdj * ryAdj;
  const sign = fA === fS ? -1 : 1;
  const num = rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2;
  const den = rx2 * y1p2 + ry2 * x1p2;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = coef * (rxAdj * y1p) / ryAdj;
  const cyp = coef * -(ryAdj * x1p) / rxAdj;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const fSEff = fS;
  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rxAdj, (y1p - cyp) / ryAdj);
  let deltaTheta = angle(
    (x1p - cxp) / rxAdj, (y1p - cyp) / ryAdj,
    (-x1p - cxp) / rxAdj, (-y1p - cyp) / ryAdj,
  );
  if (!fSEff && deltaTheta > 0) deltaTheta -= 2 * Math.PI;
  else if (fSEff && deltaTheta < 0) deltaTheta += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(deltaTheta) / (Math.PI / 6)));
  const dtheta = deltaTheta / segments;
  const k = (4 / 3) * Math.tan(dtheta / 4);
  const project = (lx, ly) => {
    const x = lx * rxAdj;
    const y = ly * ryAdj;
    return [cosPhi * x - sinPhi * y + cx, sinPhi * x + cosPhi * y + cy];
  };
  const out = [];
  let th = theta1;
  for (let i = 0; i < segments; i++) {
    const th2 = th + dtheta;
    const cos1 = Math.cos(th), sin1 = Math.sin(th);
    const cos2 = Math.cos(th2), sin2 = Math.sin(th2);
    const cp1 = project(cos1 - k * sin1, sin1 + k * cos1);
    const cp2 = project(cos2 + k * sin2, sin2 - k * cos2);
    const end = project(cos2, sin2);
    out.push([cp1, cp2, end]);
    th = th2;
  }
  return out;
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
        // Arc (A/a): rx ry x-axis-rotation large-arc-flag sweep-flag x y
        const [rx, ry, rot, fA, fS, xn, yn] = take(7);
        const endX = abs ? xn : cx + xn;
        const endY = abs ? yn : cy + yn;
        const beziers = arcToCubicBeziers(cx, cy, rx, ry, rot, !!fA, !!fS, endX, endY);
        if (beziers.length === 0) {
          out.push({ cmd: 'L', pts: [[endX, endY]] });
        } else {
          for (const [p1, p2, p3] of beziers) out.push({ cmd: 'C', pts: [p1, p2, p3] });
        }
        cx = endX; cy = endY;
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
  // Inherited CSS group opacity from ancestors (e.g. `.s1-deco { opacity: 0.12 }`).
  // Applied as node-level opacity to every emitted shape so decorative SVGs
  // render at the designer-intended weight.
  const svgOpacity = (typeof el.opacity === 'number' && el.opacity < 1) ? el.opacity : null;
  // Multiply ancestor group-opacity by each shape's own `opacity` attribute so
  // a partially-transparent <path> inside a dimmed group renders at the
  // product of the two values (matches CSS/SVG compositing semantics).
  const applyOpacity = (node, sh) => {
    if (!node) return;
    const shapeOp = (typeof sh?.opacity === 'number' && sh.opacity < 1) ? sh.opacity : null;
    const combined = svgOpacity != null && shapeOp != null
      ? svgOpacity * shapeOp
      : (svgOpacity ?? shapeOp);
    if (combined != null && combined < 1) node.opacity = combined;
  };

  let shapes = el.shapes;
  let gradients = el.gradients instanceof Map ? el.gradients : new Map();
  if (!shapes) {
    // Prefer the per-element inline markup captured by the browser extractor
    // (el.outerHTML). Falling back to regex-matching ctx.html by viewBox is
    // ambiguous when multiple <svg> blocks on different slides share the
    // same viewBox (e.g. a progress ring on one slide and a donut chart on
    // another both use viewBox="-50 -50 100 100"); .match() picks the first
    // occurrence and the later SVG gets the wrong shapes.
    let markup = null;
    if (typeof el.inline === 'string' && el.inline.length > 0) {
      const innerMatch = el.inline.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i);
      markup = innerMatch ? innerMatch[1] : el.inline;
    }
    if (!markup) {
      if (!ctx.html) {
        throw new Error(`svg element "${el.id}" (slide ${ctx.slideIndex}) has no shapes[] and bundle has no HTML source to extract from`);
      }
      markup = findSvgBlock(ctx.html, el.viewBox ?? '0 0 600 600');
      if (!markup) {
        throw new Error(`svg element "${el.id}" (slide ${ctx.slideIndex}): no <svg viewBox="${el.viewBox}"> found in bundle HTML`);
      }
    }
    const parsed = parseSvgShapes(markup);
    shapes = parsed.shapes;
    gradients = parsed.gradients;
  }

  // Resolve `fill="url(#id)"` into either a Figma GRADIENT_LINEAR / _RADIAL
  // paint (returned as { gradient: paintObj }) or null if the ref is unknown
  // or the gradient has no stops. Solid fills come back as a hex string
  // via normalizeColor() as before.
  const resolveFill = (raw, shape) => {
    if (!raw) return { fill: null };
    const m = /^url\(#([^)]+)\)$/.exec(raw.trim());
    if (!m) return { fill: normalizeColor(raw) };
    const g = gradients.get(m[1]);
    if (!g) return { fill: null };
    const bbox = g.units === 'userSpaceOnUse' ? shapeBBoxSvg(shape) : null;
    return { gradient: buildGradientPaint(g, bbox) };
  };

  const applyGradient = (node, gradientPaint) => {
    if (node && gradientPaint) node.fillPaints = [gradientPaint];
  };

  for (const sh of shapes) {
    if (sh.type === 'circle') {
      const { fill, gradient } = resolveFill(sh.fill, sh);
      const stroke = normalizeColor(sh.stroke);
      const strokeWeight = (sh.strokeWidth ?? 1) * S;
      if (fill || gradient || stroke) {
        const d = circleBezierPath(X(sh.cx), Y(sh.cy), sh.r * S);
        const opts = { name: 'Circle' };
        if (fill) opts.fill = fill;
        else if (gradient) opts.fill = '#000000'; // placeholder so addPath emits fill geometry
        if (stroke) { opts.stroke = stroke; opts.strokeWeight = strokeWeight; }
        else opts.strokeWeight = 0;
        const node = slide.addPath(d, opts);
        if (gradient) applyGradient(node, gradient);
        applyOpacity(node, sh);
      }
    } else if (sh.type === 'ellipse') {
      const { fill, gradient } = resolveFill(sh.fill, sh);
      const stroke = normalizeColor(sh.stroke);
      const strokeWeight = (sh.strokeWidth ?? 1) * S;
      const rx = (sh.rx ?? 0) * sx;
      const ry = (sh.ry ?? 0) * sy;
      const opts = {};
      if (fill) opts.fill = fill;
      if (stroke) { opts.stroke = stroke; opts.strokeWeight = strokeWeight; }
      const node = slide.addEllipse(X(sh.cx) - rx, Y(sh.cy) - ry, 2 * rx, 2 * ry, opts);
      if (gradient) applyGradient(node, gradient);
      applyOpacity(node, sh);
    } else if (sh.type === 'line') {
      const stroke = normalizeColor(sh.stroke);
      if (!stroke) continue;
      const lineOpts = {
        name: 'Line',
        stroke,
        strokeWeight: (sh.strokeWidth ?? 1) * S,
      };
      const cap = sh.strokeLinecap?.toUpperCase();
      if (cap === 'ROUND' || cap === 'SQUARE') lineOpts.strokeCap = cap;
      if (sh.strokeDasharray) lineOpts.dashPattern = sh.strokeDasharray.split(/[,\s]+/).map(Number).filter(n => Number.isFinite(n));
      const node = slide.addPath(`M ${X(sh.x1)} ${Y(sh.y1)} L ${X(sh.x2)} ${Y(sh.y2)}`, lineOpts);
      applyOpacity(node, sh);
    } else if (sh.type === 'rect') {
      const { fill, gradient } = resolveFill(sh.fill, sh);
      const stroke = normalizeColor(sh.stroke);
      const opts = {};
      if (fill) opts.fill = fill;
      if (stroke) { opts.stroke = stroke; opts.strokeWeight = (sh.strokeWidth ?? 1) * S; }
      const radius = Math.max(sh.rx ?? 0, sh.ry ?? 0);
      if (radius > 0) opts.cornerRadius = radius * S;
      const node = slide.addRectangle(X(sh.x ?? 0), Y(sh.y ?? 0), (sh.width ?? 0) * sx, (sh.height ?? 0) * sy, opts);
      if (gradient) applyGradient(node, gradient);
      applyOpacity(node, sh);
    } else if (sh.type === 'path') {
      if (!sh.d) continue;
      const stroke = normalizeColor(sh.stroke);
      const { fill, gradient } = resolveFill(sh.fill, sh);
      const d = transformPathD(sh.d, X, Y);
      const opts = { name: 'Curve' };
      if (stroke) { opts.stroke = stroke; opts.strokeWeight = (sh.strokeWidth ?? 1) * S; }
      else opts.strokeWeight = 0;
      if (sh.strokeLinecap) opts.strokeCap = sh.strokeLinecap.toUpperCase();
      if (sh.strokeLinejoin) opts.strokeJoin = sh.strokeLinejoin.toUpperCase();
      if (sh.strokeDasharray) opts.dashPattern = sh.strokeDasharray.split(/[,\s]+/).map(Number).filter(n => Number.isFinite(n));
      if (fill) opts.fill = fill;
      else if (gradient) opts.fill = '#000000'; // placeholder to request fill geometry
      const node = slide.addPath(d, opts);
      if (gradient) applyGradient(node, gradient);
      applyOpacity(node, sh);
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
  textWithPillRow: handleTextWithPillRow,
  pillRow: handlePillRow,
  statWithRing: handleStatWithRing,
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
  layoutContainer: handleLayoutContainer,
};

export async function applyElement(slide, el, ctx) {
  const handler = HANDLERS[el.type];
  if (!handler) {
    throw new Error(`handoff converter: unsupported element type "${el.type}" (slide ${ctx.slideIndex}, id=${el.id ?? '?'})`);
  }
  await handler(slide, el, ctx);
}
