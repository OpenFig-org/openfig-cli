import { normalizeFont } from '../font-normalize.mjs';

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
  return normalizeFont(family) ?? SANS;
}

function mapFontStyle(weight, style) {
  const heavy = typeof weight === 'number' ? weight >= 600 : false;
  const italic = style === 'italic';
  if (heavy && italic) return 'Bold Italic';
  if (heavy) return 'Bold';
  if (italic) return 'Italic';
  return 'Regular';
}

// The OpenType 'wght' tag, packed big-endian into the uint Figma's schema
// stores it as: 0x77676874.
const WGHT_AXIS_TAG = 2003265652;

/**
 * The weight a style name from `mapFontStyle` actually conveys: Regular and
 * Italic say 400, Bold and Bold Italic say 700, and there is nothing in
 * between because the vocabulary is deliberately that narrow (a family's named
 * instances live in its `fvar` table and no metadata API exposes them, so
 * widening it would name faces that do not exist).
 */
function namedStyleWeight(weight) {
  return typeof weight === 'number' && weight >= 600 ? 700 : 400;
}

const wghtVariation = (value) => ({ axisTag: WGHT_AXIS_TAG, axisName: 'Weight', value });

/**
 * The `wght` variation a run needs to render at its authored weight, or null
 * when the style name already says it.
 *
 * Figma applies a weight variation continuously along a family's axis and
 * ignores it on a family that has none — both measured — so writing one costs
 * nothing where it cannot help and restores the authored weight where it can.
 * The style name stays the safety net: it is what renders on a family with no
 * axis, and it never names a face that is absent.
 */
function weightVariations(weight) {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return null;
  if (weight === namedStyleWeight(weight)) return null;
  return [wghtVariation(weight)];
}

function textOpts(el, ctx = {}) {
  const opts = {
    x: el.x, y: el.y,
    width: el.width,
    fontSize: el.size,
    font: mapFont(el.font),
    fontStyle: mapFontStyle(el.weight, el.style),
  };
  const variations = weightVariations(el.weight);
  if (variations) opts.fontVariations = variations;
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

/**
 * @param {Array} runs
 * @param {number} [baseWeight] the paragraph's own weight, which every run
 *   inherits unless it overrides it
 */
function richTextRuns(runs, baseWeight) {
  // A variation on the node overrides its style name outright, in both
  // directions — `Bold` + wght 400 renders identically to plain `Regular`.
  // That is what makes name and variation independently choosable, and it is
  // also why a run at a different weight from a paragraph that carries one
  // must state its own: inheriting silently would render a bold run inside a
  // 500 paragraph at 500.
  const baseCarriesVariation = weightVariations(baseWeight) != null;
  return runs.map(r => {
    const out = { text: r.text };
    if (r.font) out.font = mapFont(r.font);
    if (r.color) out.color = r.color;
    if (r.weight && r.weight >= 600) out.bold = true;
    if (r.style === 'italic') out.italic = true;
    if (r.bullet) out.bullet = true;
    if (r.number) out.number = true;
    if (typeof r.weight === 'number' && r.weight !== baseWeight) {
      const own = weightVariations(r.weight);
      if (own) out.fontVariations = own;
      else if (baseCarriesVariation) out.fontVariations = [wghtVariation(namedStyleWeight(r.weight))];
    }
    return out;
  });
}

/**
 * Apply `el.rotate` (degrees clockwise) to a freshly added node.
 *
 * The extractor emits this for vertical writing modes, having already placed
 * `x`/`y` at the corner the rotation pivots about, so only the 2×2 part of the
 * transform changes here — `m02`/`m12` are left exactly as `addText` set them.
 */
function applyRotation(node, el) {
  const deg = el.rotate;
  if (!deg || !node?.transform) return;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const t = node.transform;
  t.m00 = cos; t.m01 = -sin;
  t.m10 = sin; t.m11 = cos;
}

async function handleText(slide, el, ctx) {
  applyRotation(slide.addText(el.text ?? '', textOpts(el, ctx)), el);
}

async function handleRichText(slide, el, ctx) {
  applyRotation(slide.addText(richTextRuns(el.runs ?? [], el.weight), textOpts(el, ctx)), el);
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
    ? richTextRuns(textBlock.runs ?? [], textBlock.weight)
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

// Baked filter variants, keyed by (source, filter). Was a `<stem>.<key>.png`
// file written next to the source; that filename never reached the archive —
// `Slide.addImage` names the entry after the sha1 of the bytes — so it was
// only ever a cache key, and an in-memory Map serves the same purpose without
// `node:fs` / `node:path`.
//
// Bounded, unlike the on-disk sidecar it replaced: that lived in a
// per-conversion scratch directory, whereas this is module state shared by
// every conversion in the process. The MCP server is long-lived, so an
// unbounded map of full PNG buffers would grow for its lifetime. Oldest
// entries are evicted first; a cache miss only costs a re-bake.
const BAKED_FILTER_CACHE_MAX = 64;
const bakedFilterCache = new Map();

function rememberBakedFilter(key, value) {
  if (bakedFilterCache.size >= BAKED_FILTER_CACHE_MAX) {
    bakedFilterCache.delete(bakedFilterCache.keys().next().value);
  }
  bakedFilterCache.set(key, value);
}

// Bake a parsed CSS image filter into the raster bytes, returning the filtered
// PNG bytes. Returns the source unchanged if the filter is empty or one we
// don't know how to apply here.
//
// The raster work itself lives behind `core/image-ops.mjs` so the browser path
// can supply a Canvas implementation. `imageOps` is required rather than
// defaulted to `sharpImageOps`: a module-scope import of that reaches `sharp`
// and `node:fs` and lands in the browser bundle whether or not this branch
// ever runs, which is exactly the case design.md rejected. The caller supplies
// it — the Node `convertHandoffBundle` defaults it to `sharpImageOps`, the
// implementation every recorded baseline was produced with.
//
// Output is always PNG so alpha is preserved for both invert and forceWhite
// (the "brightness(0) invert(1)" white-mask trick).
// Figma's exposure control, measured — and it is a tone curve, not a gain.
//
// This matters more than the numbers. CSS `brightness(m)` multiplies every
// channel by m, so its effect is the same at every tone. Figma's `exposure`
// lifts shadows hard and rolls highlights off against the ceiling: at exposure
// 0.5, an input level of 8 comes out at 23 (2.9x) while 247 comes out at 254
// (1.03x). Measured across a 32-band ramp the per-band multiplier spans a range
// of 1.75 at that setting, and 6.08 at exposure 1.
//
// So no single exposure value reproduces a CSS brightness at every tone, and the
// residual error is inherent rather than a calibration that has not converged
// yet. What can be chosen is *where* the two agree. This table anchors on the
// mid-tone (input 124 of 255), because that is where photographic content
// concentrates and where a mean-luminance comparison is dominated.
//
// The previous table described "resulting luminance as a multiple of the
// unadjusted image", taken as the mean over a photograph. That conflated the
// curve's shape with the histogram of whatever was measured, and it read low
// because clipped highlights drag a mean down: it had exposure 1 at 2.259 where
// the mid-tone response is 2.024 and the whole-ramp mean is 1.821.
//
// Measured from a compatibility-reference output of scripts/build-paint-filter-probe.mjs.
// Each entry is (exposure, output/input at mid-tone).
export const EXPOSURE_CURVE = [
  [-1, 0.129], [-0.75, 0.2258], [-0.5, 0.379], [-0.25, 0.629], [0, 1],
  [0.125, 1.2177], [0.25, 1.4274], [0.375, 1.621], [0.5, 1.7742],
  [0.75, 1.9516], [1, 2.0242],
];

/**
 * Figma's contrast control, measured — and it is far weaker than it looks.
 *
 * Two findings, both from a ramp export:
 *
 * **It clamps at ±0.5.** Values of -1, -0.75 and -0.5 produce byte-identical
 * output, as do 0.5, 0.75 and 1. Writing anything beyond ±0.5 achieves nothing.
 *
 * **Its reachable range is slope 0.767 to 1.115** about a pivot near 100 for
 * positive values and 112 for negative — not the 127.5 midpoint CSS pivots on.
 * CSS `contrast(1.15)` asks for slope 1.15, which Figma cannot reach at all. The
 * old mapping of `amount - 1` therefore looked plausible and was doubly wrong:
 * it wrote 0.15 where the measured slope at 0.15 is about 1.058, and it would
 * have written values up to 1 that do nothing beyond 0.5.
 *
 * Each entry is (contrast, measured slope).
 */
export const CONTRAST_CURVE = [
  [-0.5, 0.7672], [-0.25, 0.8068], [0, 1], [0.25, 1.0973], [0.5, 1.115],
];

/** Interpolate a curve of (figmaValue, measuredResponse) backwards. */
function invertCurve(curve, response) {
  if (response <= curve[0][1]) return curve[0][0];
  if (response >= curve[curve.length - 1][1]) return curve[curve.length - 1][0];
  for (let i = 0; i < curve.length - 1; i++) {
    const [v0, r0] = curve[i];
    const [v1, r1] = curve[i + 1];
    if (response >= r0 && response <= r1) {
      return v0 + ((response - r0) / (r1 - r0)) * (v1 - v0);
    }
  }
  return 0;
}

/**
 * The Figma contrast that comes closest to CSS `contrast(amount)`.
 *
 * CSS contrast is a slope: `contrast(1.15)` stretches about 127.5 with slope
 * 1.15. Figma tops out at 1.115, so strong values are clamped to the closest
 * reachable setting rather than scaled — being 3% short of the requested slope
 * beats writing a number that does nothing.
 */
export function contrastForCss(amount) {
  return +invertCurve(CONTRAST_CURVE, amount).toFixed(4);
}

export function exposureForBrightness(multiplier) {
  return +invertCurve(EXPOSURE_CURVE, multiplier).toFixed(4);
}

/**
 * A CSS image filter expressed as Figma's own paint adjustments.
 *
 * Figma applies these live on the paint, so the image keeps its original bytes
 * and a designer can still open the fill and change them. Baking the filter
 * into pixels hands over a dead raster, makes the two hosts encode different
 * bytes for the same picture, and inflates the file.
 *
 * Which field does what was measured, not assumed, and the obvious reading was
 * wrong in two ways. `paintFilter.brightness` is inert at every value from -1
 * to 1 — it is not in Figma's UI either, where the control is called Exposure.
 * And `filterColorAdjust` is ignored entirely; `paintFilter` is the field read.
 * Mapping brightness onto `brightness` therefore produced an image that never
 * brightened, which only became visible once a multiply blend darkened it.
 *
 * `vibrance` is Saturation in the UI. Its effect on mean luminance is almost
 * nil, so a flat luminance reading is not evidence that it does nothing.
 *
 * Returns null when nothing here can express the filter, leaving the caller to
 * bake as a last resort.
 */
function paintFilterFromCss(filter) {
  if (!filter || filter.invert || filter.forceWhite) return null;
  const ops = filter.ops;
  if (!Array.isArray(ops) || !ops.length) return null;

  const out = {};
  for (const { fn, amount } of ops) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
    if (fn === 'grayscale') out.vibrance = -Math.max(0, Math.min(1, amount));
    else if (fn === 'saturate') out.vibrance = Math.max(-1, Math.min(1, amount - 1));
    // Contrast responds but weakly, and mean luminance is the wrong instrument
    // to calibrate it with — it changes spread, not average. Passed through as
    // the offset CSS implies, which is the right sign and order of magnitude.
    else if (fn === 'contrast') out.contrast = contrastForCss(amount);
    else if (fn === 'brightness') out.exposure = exposureForBrightness(amount);
    else return null; // sepia and the rest have no equivalent here
  }
  return Object.keys(out).length ? out : null;
}

async function bakeImageFilter(src, filter, displayWidth, imageOps) {
  if (!filter || (!filter.invert && !filter.forceWhite)) return src;
  if (!imageOps) throw new Error('bakeImageFilter: imageOps is required (ctx.imageOps was not set)');

  const key = filter.forceWhite ? 'forceWhite' : 'invert';
  // Only a path identifies a source cheaply and uniquely. A media record would
  // stringify to "[object Object]" and collide with every other record, so an
  // in-memory source is simply re-baked; a cache miss costs one filter pass.
  const cacheKey = typeof src === 'string' ? `${src}\u0000${key}` : null;
  if (cacheKey) {
    const cached = bakedFilterCache.get(cacheKey);
    if (cached) return cached;
  }

  const out = await imageOps.bakeFilter(src, filter, { displayWidth });

  if (cacheKey) rememberBakedFilter(cacheKey, out);
  return out;
}

async function handleImage(slide, el, ctx) {
  // A path while unfiltered, PNG bytes once baked — `addImage` takes either,
  // and takes a `{ bytes, mime }` media record too, which is what an in-memory
  // bundle hands out.
  let source = ctx.resolveMedia(el.src);
  // Native first. Only invert and forceWhite have no paint-filter equivalent,
  // and only those are baked. Everything else keeps its original bytes and
  // stays adjustable in Figma.
  const paintFilter = paintFilterFromCss(el.filter);
  if (el.filter && !paintFilter && (el.filter.invert || el.filter.forceWhite)) {
    source = await bakeImageFilter(source, el.filter, el.width, ctx.imageOps);
  } else if (el.filter && !paintFilter && (el.filter.css || el.filter.ops?.length)) {
    // Parsed, but nothing here can express it and nothing baked it either —
    // which is how a desaturated photo previously reached a deck in full
    // colour without a word said about it.
    ctx.warn?.(`image filter "${el.filter.css ?? ''}" could not be applied`);
  }
  const opts = { x: el.x, y: el.y, width: el.width, height: el.height, imageOps: ctx.imageOps };
  opts.scaleMode = el.objectFit === 'contain' ? 'FIT' : 'FILL';
  const node = await slide.addImage(source, opts);
  if (node?.fillPaints?.length) {
    for (const p of node.fillPaints) {
      if (p.type !== 'IMAGE') continue;
      if (paintFilter) p.paintFilter = { ...paintFilter };
      // CSS and Figma name the same blend operations, so `mix-blend-mode`
      // converts rather than being dropped. Without it a photo the design
      // multiplied into its background rendered as an opaque rectangle — the
      // largest single difference on its slide against the source.
      if (el.blendMode) p.blendMode = el.blendMode;
    }
  }
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
      imageOps: ctx.imageOps,
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

// XML character references, which attribute values carry and every consumer
// here assumes away.
//
// A path `d` written by a vector editor with `xml:space="preserve"` contains
// `&#xA;` between commands. Returned raw, the `A` in that entity is read as an
// arc command by the path tokenizer, which then consumes the following numbers
// as arc parameters. One logo in the sample fixture carried fourteen of them:
// the tokenizer found fourteen arcs in a path with none, and emitted geometry
// 744x737 at (341,341) where the browser measured 250x47 at (835,341) — silently,
// with no warning, as scattered fragments across three neighbouring cards.
//
// The same applies to `transform`, `points`, and any other attribute.
function decodeXmlEntities(value) {
  if (!value.includes('&')) return value;
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last: decoding it first would let `&amp;#xA;` become a newline
    // rather than the literal text `&#xA;` the author wrote.
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? decodeXmlEntities(m[1]) : undefined;
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

// Span of the element whose opening `<` sits at `start`: the tag name, its
// attribute chunk, its inner markup and the offset just past its close. Same
// flat-regex idiom as everything else here — enough for the well-formed markup
// a browser hands us, and it tolerates same-named nesting (<g> inside <g>).
function elementSpanAt(markup, start) {
  const head = /^<([A-Za-z_][\w.:-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/.exec(markup.slice(start));
  if (!head) return null;
  const tag = head[1];
  const attrs = head[2];
  const openEnd = start + head[0].length;
  if (head[3] === '/') return { tag, attrs, inner: '', start, end: openEnd };
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${esc}\\b(?:"[^"]*"|[^>"])*?(\\/?)>|<\\/${esc}\\s*>`, 'gi');
  re.lastIndex = openEnd;
  let depth = 1;
  let m;
  while ((m = re.exec(markup)) !== null) {
    if (m[0].startsWith('</')) {
      if (--depth === 0) return { tag, attrs, inner: markup.slice(openEnd, m.index), start, end: re.lastIndex };
    } else if (m[1] !== '/') {
      depth++;
    }
  }
  // Unclosed: treat the rest of the markup as the body rather than dropping it.
  return { tag, attrs, inner: markup.slice(openEnd), start, end: markup.length };
}

// id -> element span, for the whole markup. First definition wins, which is
// what a browser does with duplicate ids.
function buildSvgIdIndex(markup) {
  const out = new Map();
  const re = /<[A-Za-z_][\w.:-]*\b(?:"[^"]*"|[^>"])*?\bid\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(markup)) !== null) {
    if (out.has(m[1])) continue;
    const span = elementSpanAt(markup, m.index);
    // Carry the source text, not just the span: a nested expansion works on a
    // copied fragment whose offsets have nothing to do with these.
    if (span) out.set(m[1], { ...span, source: markup.slice(span.start, span.end) });
  }
  return out;
}

// Replace a range with spaces. Length-preserving on purpose: every offset
// collected from the original markup stays valid after a blank, which is what
// lets the <use> spans below be located once and spliced later.
function blankRange(str, start, end) {
  return str.slice(0, start) + ' '.repeat(end - start) + str.slice(end);
}

// The <use> element's own presentation attributes cascade into the copy, but
// only where the copied shape does not set the property itself. A sprite sheet
// recoloured per use site — <use href="#icon" fill="#fff"/> — is the whole
// point of the construct, and without this the copy inherits nothing and the
// shape branches drop it for having no paint at all.
const USE_INHERITED = ['fill', 'stroke', 'stroke-width', 'opacity'];

function cascadeUseAttrs(fragment, useAttrsChunk) {
  const inherited = [];
  for (const name of USE_INHERITED) {
    const v = attr(useAttrsChunk, name);
    if (v !== undefined) inherited.push([name, v]);
  }
  if (!inherited.length) return fragment;
  return fragment.replace(
    /<(path|rect|circle|ellipse|line|polyline|polygon|text)\b((?:"[^"]*"|[^>"])*?)(\/?)>/gi,
    (whole, tag, attrs, selfClose) => {
      let extra = '';
      for (const [name, v] of inherited) {
        if (attr(`<x ${attrs}>`, name) === undefined) extra += ` ${name}="${v}"`;
      }
      return extra ? `<${tag}${attrs}${extra}${selfClose}>` : whole;
    },
  );
}

// How deep a <use> chain may go before we stop following it. Cycles are caught
// by the two checks at the use site; this is the last belt, against a chain
// that is acyclic but pathological (each level multiplies the markup).
const MAX_USE_DEPTH = 8;

// Resolve <use> and <symbol> by rewriting the markup, before anything reads it.
//
// A <use> paints a copy of the element it names; a <symbol> is a definition
// that is never painted where it stands. The shape scan below is flat — it
// walks a regex over the markup and never descends a tree — so it cannot
// follow a reference, and threading a symbol table through every shape branch
// would put reference resolution in eight places. Rewriting first leaves the
// parser untouched.
//
// It also has to happen *here*, before scanSvgGroupSpans. That scan records
// <g> spans by character offset and svgCtmAt composes whichever spans enclose a
// shape's offset; expanding a <use> moves every offset after it. Expand later,
// or scan the original markup, and the copied geometry is silently composed
// against the wrong transforms — geometry that lands somewhere plausible but
// wrong is exactly the failure this change exists to stop.
//
// Returns the rewritten markup plus the references that could not be resolved,
// so a caller can report them. Markup with neither construct is returned
// unchanged, byte for byte.
export function expandSvgUse(markup) {
  const unresolved = [];
  if (!/<use\b/i.test(markup) && !/<symbol\b/i.test(markup)) return { markup, unresolved };
  const index = buildSvgIdIndex(markup);
  return { markup: expandUseIn(markup, index, new Set(), 0, unresolved), unresolved };
}

function expandUseIn(src, index, active, depth, unresolved) {
  // A <symbol> renders only through a <use>. The flat scan would otherwise
  // paint its contents once where they are defined and once per use site.
  let work = src;
  const symRe = /<symbol\b/gi;
  let sm;
  while ((sm = symRe.exec(src)) !== null) {
    const span = elementSpanAt(src, sm.index);
    if (!span) continue;
    work = blankRange(work, span.start, span.end);
    symRe.lastIndex = span.end;
  }

  // Collect the edits first, then splice: the offsets come from `work`, and
  // splicing as we go would invalidate every later one.
  const edits = [];
  const useRe = /<use\b/gi;
  let um;
  while ((um = useRe.exec(work)) !== null) {
    const span = elementSpanAt(work, um.index);
    if (!span) continue;
    useRe.lastIndex = span.end;
    const attrsChunk = `<x ${span.attrs}>`;
    // `\bhref` matches xlink:href too, so one lookup covers both spellings.
    const href = attr(attrsChunk, 'href');
    const id = href && href.startsWith('#') ? href.slice(1) : null;
    // An external reference (`other.svg#icon`) would mean fetching a second
    // document; nothing from the export may leave the machine. Skip and report,
    // as for an id that simply is not there.
    const target = id ? index.get(id) : null;
    if (!target) {
      unresolved.push(href ?? '');
      edits.push({ start: span.start, end: span.end, text: '' });
      continue;
    }
    // Two ways a chain eats itself. The <use> may sit *inside* the element it
    // names, which SVG calls an error and does not render — comparable by
    // offset only at the top level, where `work` is the markup the index was
    // built from and the blanking above is length-preserving. Or the cycle may
    // be longer than one hop, which the set of ids already being expanded
    // catches. The depth cap is the third belt, for a chain that is acyclic but
    // doubles the markup at every level.
    const selfContained = depth === 0 && span.start > target.start && span.end <= target.end;
    if (selfContained || active.has(id) || depth >= MAX_USE_DEPTH) {
      edits.push({ start: span.start, end: span.end, text: '' });
      continue;
    }
    // A <symbol> (or <svg>) wrapper is not itself geometry — take its contents.
    // Its viewBox, which would scale the contents into the use's width/height,
    // is not honoured; see the notes on partial support.
    const t = target.tag.toLowerCase();
    let fragment = (t === 'symbol' || t === 'svg') ? target.inner : target.source;
    // Strip ids from the copy so the markup does not end up with duplicates.
    fragment = fragment.replace(/\sid\s*=\s*"[^"]*"/gi, '');
    fragment = cascadeUseAttrs(fragment, attrsChunk);
    const nextActive = new Set(active);
    nextActive.add(id);
    fragment = expandUseIn(fragment, index, nextActive, depth + 1, unresolved);
    // SVG defines <use> as a <g> carrying the use's own transform, with x/y as
    // a further translate applied inside it — so the translate goes last, where
    // parseSvgTransform composes it innermost.
    const own = attr(attrsChunk, 'transform');
    // A malformed x/y must not turn into translate(NaN,…) and take the whole
    // copy's matrix with it — treat it as absent, as SVG does.
    const num = (name) => {
      const v = numAttr(attrsChunk, name);
      return Number.isFinite(v) ? v : 0;
    };
    const x = num('x');
    const y = num('y');
    const parts = [];
    if (own) parts.push(own);
    if (x || y) parts.push(`translate(${x},${y})`);
    const tf = parts.length ? ` transform="${parts.join(' ')}"` : '';
    edits.push({ start: span.start, end: span.end, text: `<g${tf}>${fragment}</g>` });
  }

  if (!edits.length) return work;
  let out = '';
  let cursor = 0;
  for (const e of edits) {
    out += work.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  return out + work.slice(cursor);
}

// Elements whose contents are a *definition*: painted only where something
// references them, never where they stand. <symbol> is missing from the list
// on purpose — expandSvgUse has already blanked it by the time this runs.
//
// The shape scan is flat, so this too is answered positionally: a span covering
// the element's offset means the element is inside a definition.
const SVG_DEFINITION_TAGS = 'defs|pattern|mask|clipPath|marker';

// The two definitions this change teaches the converter to *use*. A shape
// inside one of them is not artwork under any reading: a <clipPath>'s rect is
// the clip region, and a <pattern>'s circle is one dot of a repeat. Painting
// either where it stands draws the machinery instead of the picture — a clip
// rectangle appears on the slide as an opaque box over the thing it bounds.
//
// `mask` joined the list once its own change came round. Its children are a
// stencil describing where another shape shows through, and because a mask is
// usually as large as the thing it covers, painting them put a full-bleed
// rectangle over the slide — carrying the mask's gradient, so it read as a
// deliberate overlay rather than as a bug. Worse, the conversion reported
// "SVG masks are not converted and were dropped" the whole time, which was the
// opposite of what it did. A warning that contradicts the output is worse than
// none, because it teaches people to stop reading the others.
//
// Still narrower than SVG_DEFINITION_TAGS: `defs` and `marker` have the same
// latent problem, and no fixture currently demonstrates them leaking, so they
// are tracked separately rather than changed on suspicion.
const SVG_CONSUMED_DEFINITION_TAGS = 'clipPath|pattern|mask';

// Derived, never restated. The guard below skips the span scan when the markup
// contains none of these tags, and it was written out by hand as
// `clipPath|pattern` — so adding `mask` to the list above changed nothing for
// any SVG that had a mask and no clip or pattern, which is the common case. The
// synthetic fixture happened to contain all three and reported success; the real
// export had only a mask and kept painting its stencil. Same defect as #13 and
// #8: one fact, stated twice, and the copies drifted.
const SVG_CONSUMED_DEFINITION_RE = new RegExp(`<(?:${SVG_CONSUMED_DEFINITION_TAGS})\\b`, 'i');

function scanSvgDefinitionSpans(markup, tags = SVG_DEFINITION_TAGS) {
  const spans = [];
  const re = new RegExp(`<(?:${tags})\\b`, 'gi');
  let m;
  while ((m = re.exec(markup)) !== null) {
    const span = elementSpanAt(markup, m.index);
    if (!span) continue;
    spans.push(span);
    // Nested definitions are inside this one already, so skipping past it
    // costs nothing and keeps the scan linear.
    re.lastIndex = span.end;
  }
  return spans;
}

// ---------------------------------------------------------------------------
// clipPath
// ---------------------------------------------------------------------------

// Figma's only clipping primitive is a frame, and a frame is a rectangle (with
// an optional corner radius). So a clip is either expressible or it is not,
// and there is no useful middle: a star-shaped clip approximated by its
// bounding box is a picture that is wrong on purpose and reads as deliberate.
// The rule for this whole section is therefore convert-or-report, never
// convert-approximately.

// The rectangle a <clipPath>'s contents describe, in the clip's own user
// space, or null when they describe anything else.
//
// Two spellings reach us. Hand-authored markup writes <rect>; every tool that
// emits SVG writes the same rectangle as a four-corner <path>, so recognising
// only the first would report most real rectangular clips as unsupported.
//
// `skipClips` on the inner parse stops the recursion: a clipPath's contents
// are shapes, and shapes are scanned for their own clip-path attributes.
export function clipPathRect(inner) {
  const { shapes } = parseSvgShapes(inner, { skipClips: true });
  // More than one shape is a union, which a frame cannot express.
  if (shapes.length !== 1) return null;
  const sh = flattenShapeCtm(shapes[0]);
  if (sh.type === 'rect') {
    const w = sh.width ?? 0;
    const h = sh.height ?? 0;
    if (!(w > 0) || !(h > 0)) return null;
    return { x: sh.x ?? 0, y: sh.y ?? 0, width: w, height: h, cornerRadius: Math.max(sh.rx ?? 0, sh.ry ?? 0) };
  }
  if (sh.type === 'path' && sh.d) return rectFromPathD(sh.d);
  return null;
}

// Is this path an axis-aligned rectangle? Only straight segments, and every
// point on one of two x values and one of two y values. A rounded rectangle
// drawn with arcs fails here and is reported, which is the right answer: the
// radius would be lost and the corners would be square.
function rectFromPathD(d) {
  const cmds = pathDToAbsoluteCmds(d);
  const xs = new Set();
  const ys = new Set();
  let points = 0;
  for (const c of cmds) {
    if (c.cmd === 'Z') continue;
    if (c.cmd !== 'M' && c.cmd !== 'L') return null;
    for (const [x, y] of c.pts) {
      // Rounded to absorb the float noise a transform leaves behind; a real
      // rectangle's corners agree to far better than a hundredth of a unit.
      xs.add(Math.round(x * 100) / 100);
      ys.add(Math.round(y * 100) / 100);
      points++;
    }
  }
  if (xs.size !== 2 || ys.size !== 2 || points < 4) return null;
  const [x0, x1] = [...xs].sort((a, b) => a - b);
  const [y0, y1] = [...ys].sort((a, b) => a - b);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, cornerRadius: 0 };
}

// id -> rectangle (or null for "present but not a rectangle"). Both answers
// matter: a missing id and a non-rectangular clip are reported differently
// nowhere, but a clip we simply failed to find would otherwise be silently
// indistinguishable from no clip at all.
function parseSvgClipDefs(markup) {
  const out = new Map();
  const re = /<clipPath\b/gi;
  let m;
  while ((m = re.exec(markup)) !== null) {
    const span = elementSpanAt(markup, m.index);
    if (!span) continue;
    re.lastIndex = span.end;
    const chunk = `<x ${span.attrs}>`;
    const id = attr(chunk, 'id');
    if (!id || out.has(id)) continue;
    // clipPathUnits="objectBoundingBox" makes the geometry fractions of the
    // clipped element's bounding box. Recorded as unsupported rather than
    // guessed at: the shape it produces is a rectangle, but scaling it needs
    // the bbox of every referencing element, and getting that wrong moves the
    // clip rather than dropping it.
    if (attr(chunk, 'clipPathUnits') === 'objectBoundingBox') { out.set(id, null); continue; }
    out.set(id, clipPathRect(span.inner));
  }
  return out;
}

// Every element carrying `clip-path="url(#id)"`, as a character span.
//
// Positional for the same reason the group scan is: the shape scan never
// descends a tree, so "is this shape inside a clipped group" is answered by
// asking whether its offset falls inside one.
function scanSvgClipSpans(markup) {
  const spans = [];
  const re = /<([A-Za-z_][\w.:-]*)\b((?:"[^"]*"|[^>"])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(markup)) !== null) {
    if (!/\bclip-path\s*=/i.test(m[2])) continue;
    const chunk = `<x ${m[2]}>`;
    const ref = /^url\(#([^)]+)\)$/.exec((attr(chunk, 'clip-path') ?? '').trim());
    // `clip-path: none`, or one of CSS's basic shapes. Neither references a
    // <clipPath>, and neither appears in an export we have seen.
    if (!ref) continue;
    const span = elementSpanAt(markup, m.index);
    if (!span) continue;
    const isGroup = m[1].toLowerCase() === 'g';
    spans.push({
      start: m.index,
      end: span.end,
      // A clip is expressed in the user space the clipping element itself
      // establishes — i.e. *after* its own transform. For a <g> that transform
      // is already in the group spans covering its content, so composing at
      // the content offset picks it up; for a shape carrying both attributes
      // there is no span, so its transform is passed explicitly.
      contentStart: m.index + m[0].length,
      own: isGroup ? null : attr(chunk, 'transform'),
      ref: ref[1],
    });
  }
  return spans;
}

// Map a rectangle through an affine, or return null if the result is not a
// rectangle. A rotated clip has no frame that expresses it.
function transformClipRect(rect, m) {
  if (!m) return rect;
  if (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9) return null;
  const [x0, y0] = applyAffine(m, rect.x, rect.y);
  const [x1, y1] = applyAffine(m, rect.x + rect.width, rect.y + rect.height);
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
    cornerRadius: (rect.cornerRadius ?? 0) * Math.abs(m[0]),
  };
}

// The clip in force at a character offset, in root user space.
//
// Returns `{ rect }` when every clip enclosing the offset is a rectangle we
// can express, or `{ unsupported: id }` when one of them is not. Nested clips
// intersect, which is what SVG does and what nested frames would do anyway.
function resolveClipAt(clipSpans, clipDefs, groupSpans, pos) {
  const enclosing = clipSpans.filter(s => s.start <= pos && pos < s.end);
  if (!enclosing.length) return null;
  let acc = null;
  for (const s of enclosing) {
    const def = clipDefs.get(s.ref);
    if (!def) return { unsupported: s.ref };
    const rect = transformClipRect(def, svgCtmAt(groupSpans, s.contentStart, s.own));
    if (!rect) return { unsupported: s.ref };
    acc = acc ? intersectRect(acc, rect) : rect;
  }
  return { rect: acc };
}

function intersectRect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
    // Two rounded rectangles do not intersect into a rounded rectangle in
    // general; the smaller radius is the closest single number and errs
    // towards squarer, which loses less than inventing a curve.
    cornerRadius: Math.min(a.cornerRadius ?? 0, b.cornerRadius ?? 0),
  };
}

// ---------------------------------------------------------------------------
// pattern fills
// ---------------------------------------------------------------------------

// Parse <pattern> defs, keyed by id. `source` is kept alongside the contents
// because the fallback path re-renders the whole definition rather than one
// tile, and needs it back verbatim.
function parseSvgPatterns(markup) {
  const out = new Map();
  const re = /<pattern\b/gi;
  let m;
  while ((m = re.exec(markup)) !== null) {
    const span = elementSpanAt(markup, m.index);
    if (!span) continue;
    re.lastIndex = span.end;
    const chunk = `<x ${span.attrs}>`;
    const id = attr(chunk, 'id');
    if (!id || out.has(id)) continue;
    // Only what decides *how* the pattern is converted is read out. The rest —
    // the tile's own x/y, `patternContentUnits`, a `viewBox` scaling the
    // contents into the tile — stays in `source` and is honoured by the raster
    // backend, which implements those rules already. Parsing them here would
    // be a second implementation of SVG's tiling, to be kept in agreement with
    // the first.
    out.set(id, {
      id,
      width: numAttr(chunk, 'width') ?? 0,
      height: numAttr(chunk, 'height') ?? 0,
      // Defaults to fractions of the referencing element's bounding box, not
      // to user units — the opposite of `patternContentUnits`.
      units: attr(chunk, 'patternUnits') === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'objectBoundingBox',
      transform: attr(chunk, 'patternTransform') ?? null,
      href: attr(chunk, 'href') ?? null,
      source: markup.slice(span.start, span.end),
    });
  }
  return out;
}

// Every definition in the markup, as source text, for re-rendering a fragment
// of it in isolation.
//
// A pattern is not self-contained: its contents may reference a gradient, and
// `xlink:href` may inherit from another pattern entirely. Handing the raster
// backend only the one `<pattern>` element leaves those references dangling and
// produces a tile that is silently blank in places. Handing it every definition
// costs a longer string and nothing else — an unreferenced def renders nothing.
function collectSvgDefsSource(markup) {
  const parts = [];
  const re = /<(defs|pattern|linearGradient|radialGradient|clipPath|mask|filter|symbol)\b/gi;
  let m;
  while ((m = re.exec(markup)) !== null) {
    const span = elementSpanAt(markup, m.index);
    if (!span) continue;
    parts.push(markup.slice(span.start, span.end));
    // Anything nested inside is already in the slice just taken.
    re.lastIndex = span.end;
  }
  return parts.join('');
}

/**
 * The pattern's repeat period, in the referencing shape's user space, or null
 * when the pattern has no rectangular period at all.
 *
 * This is the whole decision behind the tiled-image route. Figma repeats an
 * image paint on an axis-aligned lattice anchored at the node's top-left, and
 * can express nothing else. A `patternTransform` of `rotate(45)` — the ordinary
 * way to write a diagonal hatch — has no such lattice, and repeating an
 * unrotated tile in its place would produce a plausible pattern that is not the
 * authored one. Returning null sends the caller to the region raster: a bigger
 * bitmap, and the right picture.
 *
 * Only the *size* comes back, never the pattern's own `x`/`y`. Those set the
 * lattice's phase, which a Figma tile cannot carry — so the tile is instead
 * cropped from the tiled render at the node's own corner, where the phase is
 * already baked in. Handing the authored origin to the tiler would shift the
 * whole fill by up to one tile.
 *
 * Exported because it is the load-bearing judgement in this section and
 * deserves to be testable without a deck.
 */
export function svgPatternTile(pat, bbox) {
  if (!pat) return null;
  // `xlink:href` on a pattern inherits another pattern's attributes, so the
  // period may be written on an element this one only names. The region raster
  // renders the chain correctly without having to resolve it.
  if (pat.href) return null;
  let { width, height } = pat;
  if (pat.units === 'objectBoundingBox') {
    if (!bbox || !(bbox.w > 0) || !(bbox.h > 0)) return null;
    width *= bbox.w;
    height *= bbox.h;
  }
  if (pat.transform) {
    const m = parseSvgTransform(pat.transform);
    // Rotation or skew: no rectangular period exists, whatever we do to the
    // numbers. This is the diagonal-hatch case and the reason the fallback
    // exists at all.
    if (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9) return null;
    width *= Math.abs(m[0]);
    height *= Math.abs(m[3]);
  }
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

// How much finer than its on-canvas size a pattern tile is rasterised, and the
// ceiling on the result. A tile is repeated across a region and then zoomed in
// Figma, so it shows resampling far more readily than a one-off image does;
// the cap keeps a full-slide fallback region from becoming a 40-megapixel PNG.
const PATTERN_TILE_SUPERSAMPLE = 2;
const PATTERN_TILE_MAX_PX = 2048;

function rasterSize(width, height) {
  const w = Math.max(1, width * PATTERN_TILE_SUPERSAMPLE);
  const h = Math.max(1, height * PATTERN_TILE_SUPERSAMPLE);
  const shrink = Math.min(1, PATTERN_TILE_MAX_PX / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * shrink)), height: Math.max(1, Math.round(h * shrink)) };
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Portable base64. `btoa` is browser-only and `Buffer` is Node-only, and this
// module is loaded by both.
function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64_ALPHABET[c & 63];
  }
  return out;
}

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

function mimeForMediaSource(src) {
  if (src && typeof src === 'object' && src.mime) return src.mime;
  const name = typeof src === 'string' ? src : (src?.filename ?? '');
  return MIME_BY_EXT[String(name).toLowerCase().split('.').pop()] ?? 'image/png';
}

// Replace every <image href> in a fragment with a self-contained data URI.
//
// Neither raster backend resolves a reference out of the document — sharp gives
// librsvg no base URL, Chromium decodes SVG-in-<img> in secure static mode —
// and that is the behaviour we want rather than an obstacle: a pattern that
// could fetch would be a way for part of an export to leave the machine. An
// href we will not read is left alone, so it renders as nothing rather than
// failing the tile.
function inlinePatternImages(fragment, slide, ctx) {
  if (!/<image\b/i.test(fragment)) return fragment;
  // \x22 and \x27 rather than a literal `['"]`: see the note at the matching
  // scan in browser-extract.mjs. A quote character inside a regex literal is
  // invisible as such to the portability scan's string-stripper, and enough of
  // them turn that test from a failure into a hang.
  return fragment.replace(
    /(<image\b[^>]*?\b(?:xlink:)?href\s*=\s*([\x22\x27]))(.*?)\2/gi,
    (whole, pre, quote, href) => {
      const src = svgImageSource(href);
      if (!src) return whole;
      if (/^data:/i.test(src)) return whole;
      try {
        const media = ctx.resolveMedia(src);
        const bytes = slide.imageSourceBytes(media);
        if (!bytes?.length) return whole;
        // `pre` carries the opening quote, so the closing one has to be put
        // back explicitly. Note the catch below: anything thrown in here is
        // read as "that href could not be resolved" and leaves the reference
        // alone, so a mistake in this expression is invisible rather than
        // loud — the tile simply renders without its raster.
        return `${pre}data:${mimeForMediaSource(media)};base64,${bytesToBase64(bytes)}${quote}`;
      } catch {
        return whole;
      }
    },
  );
}

// ---------------------------------------------------------------------------

// Where an <image>'s href may point, and whether we are willing to read it.
//
// A data URI carries its own bytes; a bundle-relative reference names an asset
// the conversion already extracted to `media/`. Both resolve on this machine
// through `ctx.resolveMedia`, which both hosts implement.
//
// Everything else is refused rather than fetched: `http(s):`, `file:`, a
// protocol-relative `//host/…`, and a `blob:` URL that the asset scan could not
// pair back to a decoded asset. Fetching any of them would send part of the
// export — or the fact of it — off the machine, which nothing in this pipeline
// is allowed to do. A refused reference is reported by the extractor
// (`warnUnsupportedSvg`), so returning null here is a skip, not a silence.
//
// Exported for the regression test: the rule is a privacy boundary, and a
// boundary that is only tested through a full conversion is one nobody checks.
export function svgImageSource(href) {
  if (typeof href !== 'string') return null;
  const s = href.trim();
  // A bare fragment names an element in this document, not an image.
  if (!s || s.startsWith('#')) return null;
  if (/^data:/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return null;
  return s;
}

// Locate every <g>…</g> span and its parsed transform. The shape scan below is
// flat (it never descends a tree), so enclosing group transforms have to be
// recovered positionally: a shape at offset p is inside every span whose
// range covers p.
function scanSvgGroupSpans(markup) {
  const spans = [];
  const stack = [];
  const re = /<g\b([^>]*?)(\/?)>|<\/g\s*>/gi;
  let m;
  while ((m = re.exec(markup)) !== null) {
    if (m[0].startsWith('</')) {
      const open = stack.pop();
      if (open) spans.push({ start: open.start, end: m.index, transform: open.transform });
      continue;
    }
    if (m[2] === '/') continue; // self-closing <g/> encloses nothing
    const raw = attr(`<x ${m[1]}>`, 'transform');
    stack.push({ start: m.index + m[0].length, transform: raw ? parseSvgTransform(raw) : null });
  }
  for (const open of stack) {
    spans.push({ start: open.start, end: markup.length, transform: open.transform });
  }
  return spans;
}

// Compose the enclosing group transforms (outermost first) with the element's
// own transform. Returns a 2x3 affine, or null when the product is identity.
function svgCtmAt(spans, pos, ownRaw) {
  // Sorted by start, because scanSvgGroupSpans records a span when it sees the
  // *closing* tag and so lists the innermost group first. Composing in that
  // order applies the transforms inside-out: translate(100,0) around scale(2)
  // put a point at 202 instead of 102. Matters here because <use> expansion
  // manufactures nesting — the copy is a <g> inside whatever group held the
  // <use> — so the pair no longer has to be authored to hit it.
  const enclosing = spans
    .filter(s => s.transform && s.start <= pos && pos < s.end)
    .sort((a, b) => a.start - b.start);
  const mats = enclosing.map(s => s.transform);
  if (ownRaw) mats.push(parseSvgTransform(ownRaw));
  if (!mats.length) return null;
  let m = mats[0];
  for (let i = 1; i < mats.length; i++) m = mulAffine(m, mats[i]);
  return m;
}

/**
 * @param {string} innerMarkup
 * @param {object} [opts]
 * @param {boolean} [opts.skipClips]
 *   Do not resolve clip paths. Set only by `clipPathRect`, which parses a
 *   <clipPath>'s own contents through here: those contents are shapes, so
 *   without this the scan would look for *their* clips and recurse.
 */
export function parseSvgShapes(innerMarkup, opts = {}) {
  const shapes = [];
  const stripped = innerMarkup.replace(/<!--[\s\S]*?-->/g, '');
  // Gradients are read from the markup as authored: <use> expansion neither
  // creates nor moves a gradient def, and reading them here keeps a gradient
  // defined inside a <symbol> reachable after the symbol is blanked.
  const gradients = parseSvgGradients(stripped);
  // Patterns likewise: a <pattern> is a definition, and expansion neither
  // creates nor moves one. `defs` is the source text of every definition,
  // which is what a pattern has to be re-rendered against.
  const patterns = parseSvgPatterns(stripped);
  const defs = patterns.size ? collectSvgDefsSource(stripped) : '';
  // Everything positional below — the group-span scan and the shape scan —
  // must see the *same* string, and it must be the expanded one. See
  // expandSvgUse for why the two cannot be separated.
  const expanded = expandSvgUse(stripped).markup;
  const groupSpans = scanSvgGroupSpans(expanded);
  // Only <image> consults this, so only pay for it when there is one. `mask` is
  // no longer among the latent problems here — it is in
  // SVG_CONSUMED_DEFINITION_TAGS and excluded from every shape branch.
  const definitionSpans = /<image\b/i.test(expanded) ? scanSvgDefinitionSpans(expanded) : [];
  const inDefinition = (pos) => definitionSpans.some(s => pos >= s.start && pos < s.end);
  // Applies to every shape, not just <image>: see SVG_CONSUMED_DEFINITION_TAGS.
  const consumedSpans = SVG_CONSUMED_DEFINITION_RE.test(expanded)
    ? scanSvgDefinitionSpans(expanded, SVG_CONSUMED_DEFINITION_TAGS)
    : [];
  // Same reasoning as the definition scan: only pay for it when the markup has
  // a clip in it at all. Both scans call elementSpanAt once per hit, which is
  // linear in what follows the hit.
  const hasClip = !opts.skipClips && /\bclip-path\s*=/i.test(expanded);
  const clipSpans = hasClip ? scanSvgClipSpans(expanded) : [];
  const clipDefs = hasClip ? parseSvgClipDefs(expanded) : new Map();
  const tagRe = /<(circle|line|path|text|rect|ellipse|polyline|polygon|image)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1\s*>)/gi;
  let m;
  while ((m = tagRe.exec(expanded)) !== null) {
    const tag = m[1].toLowerCase();
    if (consumedSpans.some(s => m.index >= s.start && m.index < s.end)) continue;
    const attrsChunk = `<x ${m[2]}>`;
    const body = m[4];
    const shapeStart = shapes.length;
    const ctm = svgCtmAt(groupSpans, m.index, attr(attrsChunk, 'transform'));
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
    } else if (tag === 'image') {
      // A <pattern> or <mask> holding an <image> is a definition; the raster
      // is painted through the reference, at the referencing shape's place and
      // size, and never at the coordinates written here. Drawing it where it
      // stands puts a full-size bitmap over the artwork it was meant to fill —
      // worse than the loss this branch exists to fix.
      if (inDefinition(m.index)) continue;
      shapes.push({
        type: 'image',
        x: numAttr(attrsChunk, 'x') ?? 0,
        y: numAttr(attrsChunk, 'y') ?? 0,
        width: numAttr(attrsChunk, 'width') ?? 0,
        height: numAttr(attrsChunk, 'height') ?? 0,
        // `\bhref` matches xlink:href too, so one lookup covers both spellings.
        href: attr(attrsChunk, 'href'),
        preserveAspectRatio: attr(attrsChunk, 'preserveAspectRatio'),
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
    if (shapes.length > shapeStart) {
      const emitted = shapes[shapes.length - 1];
      if (ctm) emitted.ctm = ctm;
      // Resolved here rather than at emission time because it is a fact about
      // the *markup* — which spans enclose this offset, and what those spans
      // reference. By the time the dispatcher sees a shape the offsets are
      // gone. `clipUnsupported` and `clip` are deliberately separate: one says
      // "convert this unclipped and say so", the other says "clip it here".
      if (clipSpans.length) {
        const clip = resolveClipAt(clipSpans, clipDefs, groupSpans, m.index);
        if (clip?.unsupported) emitted.clipUnsupported = clip.unsupported;
        else if (clip?.rect) emitted.clip = clip.rect;
      }
    }
  }
  return { shapes, gradients, patterns, defs };
}

// Bake a shape's accumulated transform into its own coordinates, so the
// viewBox mapping downstream stays a plain per-axis remap. Without this,
// `<g transform="translate(...)">` and per-path `matrix(...)` are dropped and
// every sub-path collapses toward the SVG origin.
export function flattenShapeCtm(sh) {
  const m = sh?.ctm;
  if (!m) return sh;
  const P = (x, y) => applyAffine(m, x ?? 0, y ?? 0);
  const axisAligned = Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;

  if (sh.type === 'path' && sh.d) {
    const parts = [];
    for (const c of pathDToAbsoluteCmds(sh.d)) {
      if (c.cmd === 'Z') { parts.push('Z'); continue; }
      const pts = c.pts.map(([x, y]) => {
        const [px, py] = P(x, y);
        return `${px.toFixed(3)} ${py.toFixed(3)}`;
      });
      parts.push(`${c.cmd} ${pts.join(' ')}`);
    }
    return { ...sh, d: parts.join(' '), ctm: null };
  }
  if (sh.type === 'line') {
    const [x1, y1] = P(sh.x1, sh.y1);
    const [x2, y2] = P(sh.x2, sh.y2);
    return { ...sh, x1, y1, x2, y2, ctm: null };
  }
  // An <image> is placed by the same four numbers as a <rect> and flattens the
  // same way. Without this it falls through to the anchor-only tail below,
  // which moves the corner and leaves width/height at their authored values —
  // an image under `<g transform="scale(2)">` lands in the right place at half
  // the size, which reads as a layout bug rather than a transform bug.
  if ((sh.type === 'rect' || sh.type === 'image') && axisAligned) {
    const [x, y] = P(sh.x, sh.y);
    return { ...sh, x, y, width: (sh.width ?? 0) * m[0], height: (sh.height ?? 0) * m[3], ctm: null };
  }
  if (sh.type === 'circle' && axisAligned) {
    const [cx, cy] = P(sh.cx, sh.cy);
    return { ...sh, cx, cy, r: (sh.r ?? 0) * Math.abs(m[0]), ctm: null };
  }
  if (sh.type === 'ellipse' && axisAligned) {
    const [cx, cy] = P(sh.cx, sh.cy);
    return { ...sh, cx, cy, rx: (sh.rx ?? 0) * Math.abs(m[0]), ry: (sh.ry ?? 0) * Math.abs(m[3]), ctm: null };
  }
  if (sh.type === 'text') {
    const [x, y] = P(sh.x, sh.y);
    return { ...sh, x, y, ctm: null };
  }
  // Rotated/skewed primitives: translate the anchor so the shape lands in the
  // right region rather than at the origin. Rare in Claude Design exports.
  const [ax, ay] = P(sh.x ?? sh.cx ?? 0, sh.y ?? sh.cy ?? 0);
  if (sh.x != null) return { ...sh, x: ax, y: ay, ctm: null };
  if (sh.cx != null) return { ...sh, cx: ax, cy: ay, ctm: null };
  return { ...sh, ctm: null };
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

// Compose two 2x3 affines encoding [[a,c,e],[b,d,f],[0,0,1]].
function mulAffine(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

// Parse an SVG transform string (element, group, or gradientTransform) into a
// 2x3 affine [a,b,c,d,e,f]. Primitives compose left-to-right.
function parseSvgTransform(str) {
  const mul = mulAffine;
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
  let patterns = el.patterns instanceof Map ? el.patterns : new Map();
  let svgDefs = typeof el.svgDefs === 'string' ? el.svgDefs : '';
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
    patterns = parsed.patterns;
    svgDefs = parsed.defs;
  }
  shapes = (shapes ?? []).map(flattenShapeCtm);

  // Resolve `fill="url(#id)"` into either a Figma GRADIENT_LINEAR / _RADIAL
  // paint (returned as { gradient: paintObj }) or null if the ref is unknown
  // or the gradient has no stops. Solid fills come back as a hex string
  // via normalizeColor() as before.
  const resolveFill = (raw, shape) => {
    if (!raw) return { fill: null };
    const m = /^url\(#([^)]+)\)$/.exec(raw.trim());
    if (!m) return { fill: normalizeColor(raw) };
    const g = gradients.get(m[1]);
    if (g) {
      const bbox = g.units === 'userSpaceOnUse' ? shapeBBoxSvg(shape) : null;
      return { gradient: buildGradientPaint(g, bbox) };
    }
    // A pattern cannot be resolved synchronously — it has to be rasterised —
    // so the reference is carried through and turned into a paint after the
    // node exists, the same shape of two-step the gradients use.
    if (patterns.has(m[1])) return { pattern: m[1] };
    return { fill: null };
  };

  const applyGradient = (node, gradientPaint) => {
    if (node && gradientPaint) node.fillPaints = [gradientPaint];
  };

  // Which pattern ids have already been reported this SVG, so a hatch used by
  // forty shapes produces one warning rather than forty.
  const reportedPatterns = new Set();

  /**
   * Rasterise a pattern and hang it on `node` as an image paint.
   *
   * Two routes. Where the pattern has a rectangular tile, one tile is
   * rasterised and repeated by Figma (`imageScaleMode: 'TILE'`), which is a
   * small bitmap regardless of how large the filled region is. Where it does
   * not — a diagonal hatch has no rectangular tile at all — the whole filled
   * region is rasterised instead and the node's own geometry clips it.
   *
   * The vector geometry survives either way: the paint hangs on the path node,
   * so a pie wedge filled with a pattern is still a wedge.
   */
  const applyPattern = async (node, id, sh) => {
    if (!node || !id) return;
    const pat = patterns.get(id);
    const bbox = shapeBBoxSvg(sh);
    if (!pat || !bbox || !(bbox.w > 0) || !(bbox.h > 0)) return;
    if (!ctx.imageOps?.rasterizeSvg) {
      if (!reportedPatterns.has(id)) {
        reportedPatterns.add(id);
        ctx.warn?.(`SVG pattern fill #${id} was dropped: this host has no SVG rasteriser`);
      }
      return;
    }
    const period = svgPatternTile(pat, bbox);
    // Both routes ask the raster backend to render the pattern *as a fill*,
    // rather than rendering the pattern's contents by hand. That is the point:
    // the backend already implements SVG's tiling rules — the tile's own
    // origin, its clip, `patternContentUnits`, a `viewBox` that scales the
    // contents into the tile — and reimplementing any of them here would be a
    // second answer to a question already answered, differently.
    //
    // The two differ only in where the window is cut. The tile route crops one
    // period starting at the shape's top-left corner, because that is where
    // Figma anchors a repeat; cropping at the pattern's authored x/y instead
    // would put the right picture at the wrong phase, sliding the whole fill
    // by up to one tile. The region route takes the whole bounding box, which
    // needs no lattice at all and is why it can carry a diagonal hatch.
    const box = period
      ? { x: bbox.x, y: bbox.y, width: period.width, height: period.height }
      : { x: bbox.x, y: bbox.y, width: bbox.w, height: bbox.h };
    const onCanvas = { width: box.width * sx, height: box.height * sy };
    const raster = rasterSize(onCanvas.width, onCanvas.height);
    const doc = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
      + `width="${raster.width}" height="${raster.height}" `
      + `viewBox="${box.x} ${box.y} ${box.width} ${box.height}">`
      + `<defs>${inlinePatternImages(svgDefs || pat.source, slide, ctx)}</defs>`
      + `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="url(#${id})"/>`
      + '</svg>';
    if (!period && !reportedPatterns.has(id)) {
      reportedPatterns.add(id);
      ctx.warn?.(
        `SVG pattern #${id} has no axis-aligned tile — the filled region was rasterised `
        + 'instead of tiled, so that fill is a bitmap rather than a repeat',
      );
    }
    let png;
    try {
      png = await ctx.imageOps.rasterizeSvg(doc, raster);
    } catch {
      // A pattern we cannot rasterise is one missing fill, and the shape is
      // already on the slide. Failing the conversion over it would trade the
      // deck for a decoration.
      if (!reportedPatterns.has(id)) {
        reportedPatterns.add(id);
        ctx.warn?.(`SVG pattern fill #${id} could not be rasterised and was dropped`);
      }
      return;
    }
    const paint = await slide.createImagePaint({ bytes: png, mime: 'image/png' }, {
      imageOps: ctx.imageOps,
      scaleMode: period ? 'TILE' : 'FILL',
      // Figma sizes a tile as the image's natural pixels times `scale`, so
      // this is what undoes the supersampling. Get it wrong and the pattern
      // repeats at the wrong pitch, which still looks like a pattern.
      scale: period ? onCanvas.width / raster.width : 0.5,
    });
    node.fillPaints = [paint];
  };

  // Strokes can reference a gradient too — `stroke="url(#lg2)"` on a path is
  // ordinary SVG, and a charting export produces them for line series. Only
  // fills were resolved, so the raw `url(#…)` reached the colour parser and
  // threw, failing the whole conversion on a deck that was otherwise fine.
  //
  // Returns a colour string for `opts.stroke`, or a paint to hang on
  // `strokePaints` afterwards, mirroring how fills are handled.
  const resolveStroke = (raw, shape) => {
    if (!raw) return { stroke: null };
    const m = /^url\(#([^)]+)\)$/.exec(String(raw).trim());
    if (!m) return { stroke: normalizeColor(raw) };
    const g = gradients.get(m[1]);
    if (!g) return { stroke: null };
    const bbox = g.units === 'userSpaceOnUse' ? shapeBBoxSvg(shape) : null;
    const paint = buildGradientPaint(g, bbox);
    // A stroke needs a colour for the node to be created with an outline at
    // all; the paint replaces it immediately afterwards.
    return { stroke: paint ? '#000000' : null, strokePaint: paint };
  };

  const applyStrokeGradient = (node, paint) => {
    if (node && paint) node.strokePaints = [paint];
  };

  // Resolve SVG `currentColor` to the element's computed CSS `color` captured
  // by the extractor (white on dark slides, black on light). Without this,
  // vectorized paths whose fill/stroke is "currentColor" reach parseColor()
  // and throw "Unknown color".
  const inheritedColor = normalizeColor(el.color) || '#000000';
  for (const sh of shapes) {
    if (typeof sh.fill === 'string' && sh.fill.trim().toLowerCase() === 'currentcolor') sh.fill = inheritedColor;
    if (typeof sh.stroke === 'string' && sh.stroke.trim().toLowerCase() === 'currentcolor') sh.stroke = inheritedColor;
  }

  // One shape onto one target. Extracted from the loop below so a clipped
  // group can be emitted into a frame instead of straight onto the slide:
  // `target` is the slide or a clip frame, and `X`/`Y` are the outer mapping
  // shifted into that frame's local coordinates. Everything else — the
  // resolvers, the scale factors, the opacity rule — is shared, because a
  // clipped shape differs from an unclipped one only in where it is parented.
  const emitShape = async (target, sh, X, Y) => {
    if (sh.type === 'circle') {
      const { fill, gradient, pattern } = resolveFill(sh.fill, sh);
      const { stroke, strokePaint } = resolveStroke(sh.stroke, sh);
      const strokeWeight = (sh.strokeWidth ?? 1) * S;
      if (fill || gradient || pattern || stroke) {
        const d = circleBezierPath(X(sh.cx), Y(sh.cy), sh.r * S);
        const opts = { name: 'Circle' };
        if (fill) opts.fill = fill;
        else if (gradient || pattern) opts.fill = '#000000'; // placeholder so addPath emits fill geometry
        if (stroke) { opts.stroke = stroke; opts.strokeWeight = strokeWeight; }
        else opts.strokeWeight = 0;
        const node = target.addPath(d, opts);
        if (gradient) applyGradient(node, gradient);
        await applyPattern(node, pattern, sh);
        applyStrokeGradient(node, strokePaint);
        applyOpacity(node, sh);
      }
    } else if (sh.type === 'ellipse') {
      const { fill, gradient, pattern } = resolveFill(sh.fill, sh);
      const { stroke, strokePaint } = resolveStroke(sh.stroke, sh);
      const strokeWeight = (sh.strokeWidth ?? 1) * S;
      const rx = (sh.rx ?? 0) * sx;
      const ry = (sh.ry ?? 0) * sy;
      const opts = {};
      if (fill) opts.fill = fill;
      if (stroke) { opts.stroke = stroke; opts.strokeWeight = strokeWeight; }
      const node = target.addEllipse(X(sh.cx) - rx, Y(sh.cy) - ry, 2 * rx, 2 * ry, opts);
      if (gradient) applyGradient(node, gradient);
      await applyPattern(node, pattern, sh);
      applyStrokeGradient(node, strokePaint);
      applyOpacity(node, sh);
    } else if (sh.type === 'line') {
      const { stroke, strokePaint } = resolveStroke(sh.stroke, sh);
      if (!stroke) return;
      const lineOpts = {
        name: 'Line',
        stroke,
        strokeWeight: (sh.strokeWidth ?? 1) * S,
      };
      const cap = sh.strokeLinecap?.toUpperCase();
      if (cap === 'ROUND' || cap === 'SQUARE') lineOpts.strokeCap = cap;
      if (sh.strokeDasharray) lineOpts.dashPattern = sh.strokeDasharray.split(/[,\s]+/).map(Number).filter(n => Number.isFinite(n));
      const node = target.addPath(`M ${X(sh.x1)} ${Y(sh.y1)} L ${X(sh.x2)} ${Y(sh.y2)}`, lineOpts);
      applyStrokeGradient(node, strokePaint);
      applyOpacity(node, sh);
    } else if (sh.type === 'rect') {
      const { fill, gradient, pattern } = resolveFill(sh.fill, sh);
      const { stroke, strokePaint } = resolveStroke(sh.stroke, sh);
      const opts = {};
      if (fill) opts.fill = fill;
      if (stroke) { opts.stroke = stroke; opts.strokeWeight = (sh.strokeWidth ?? 1) * S; }
      const radius = Math.max(sh.rx ?? 0, sh.ry ?? 0);
      if (radius > 0) opts.cornerRadius = radius * S;
      const node = target.addRectangle(X(sh.x ?? 0), Y(sh.y ?? 0), (sh.width ?? 0) * sx, (sh.height ?? 0) * sy, opts);
      if (gradient) applyGradient(node, gradient);
      await applyPattern(node, pattern, sh);
      applyStrokeGradient(node, strokePaint);
      applyOpacity(node, sh);
    } else if (sh.type === 'path') {
      if (!sh.d) return;
      const { stroke, strokePaint } = resolveStroke(sh.stroke, sh);
      const { fill, gradient, pattern } = resolveFill(sh.fill, sh);
      const d = transformPathD(sh.d, X, Y);
      const opts = { name: 'Curve' };
      if (stroke) { opts.stroke = stroke; opts.strokeWeight = (sh.strokeWidth ?? 1) * S; }
      else opts.strokeWeight = 0;
      if (sh.strokeLinecap) opts.strokeCap = sh.strokeLinecap.toUpperCase();
      if (sh.strokeLinejoin) opts.strokeJoin = sh.strokeLinejoin.toUpperCase();
      if (sh.strokeDasharray) opts.dashPattern = sh.strokeDasharray.split(/[,\s]+/).map(Number).filter(n => Number.isFinite(n));
      if (fill) opts.fill = fill;
      else if (gradient || pattern) opts.fill = '#000000'; // placeholder to request fill geometry
      const node = target.addPath(d, opts);
      if (gradient) applyGradient(node, gradient);
      await applyPattern(node, pattern, sh);
      applyStrokeGradient(node, strokePaint);
      applyOpacity(node, sh);
    } else if (sh.type === 'image') {
      const src = svgImageSource(sh.href);
      // Refused or absent. The extractor already reported it by name, so
      // repeating it through `ctx.warn` would put the same fact in two places.
      if (!src) return;
      // The same `resolveMedia` an <img> goes through, so a data URI and a
      // `media/…` asset resolve identically in both hosts — the Node loader
      // spills a data URI to the bundle's media directory, the browser's
      // in-memory bundle decodes it to bytes, and `addImage` sees a record
      // either way.
      //
      // It throws when the name is not in the bundle, and for an <image> that
      // is a reachable state rather than a bug: only `blob:` hrefs are paired
      // back to a decoded asset, so an inline SVG pointing at a relative path
      // beside the HTML arrives here naming a file the bundle never held. An
      // <img> in that position throws and fails the conversion, but an <img>
      // src is remapped whatever its scheme, so it does not get here. Losing
      // one picture is the old behaviour for this construct and is a far
      // smaller harm than losing the deck; the extractor has already reported
      // the href, so the loss is not silent.
      let media;
      try {
        media = ctx.resolveMedia(src);
      } catch {
        return;
      }
      const node = await target.addImage(media, {
        name: 'Image',
        x: X(sh.x ?? 0),
        y: Y(sh.y ?? 0),
        width: (sh.width ?? 0) * sx,
        height: (sh.height ?? 0) * sy,
        // preserveAspectRatio defaults to "xMidYMid meet" — fit inside the
        // box. "slice" crops to fill it, and "none" stretches; Figma has no
        // stretch, and filling crops less of the picture than letterboxing
        // hides of the box.
        scaleMode: /\b(slice|none)\b/i.test(sh.preserveAspectRatio ?? '') ? 'FILL' : 'FIT',
        imageOps: ctx.imageOps,
      });
      applyOpacity(node, sh);
    } else if (sh.type === 'text') {
      if (!sh.text) return;
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
      target.addText(sh.text, opts);
    }
  };

  // Clipped runs of shapes go into a frame with "clip content" on; everything
  // else goes straight onto the slide.
  //
  // The walk stays in document order and opens a new frame whenever the clip
  // in force changes, rather than grouping all the clipped shapes together.
  // Grouping would be fewer frames and the wrong z-order: an unclipped shape
  // authored between two clipped ones would end up under both.
  let target = slide;
  let openClip = null;
  let clipOriginX = 0;
  let clipOriginY = 0;
  const reportedClips = new Set();
  for (const sh of shapes) {
    // A clip we cannot express becomes a reason to omit the content, not to
    // draw it loose. Converting it unclipped was the earlier behaviour and it
    // is worse than dropping: the geometry does not stay in its box, so a
    // single unclipped icon put long strokes across three neighbouring cards
    // and a large shape over an unrelated one. A missing logo is obvious and
    // honest; artwork sprayed across the slide is neither, and it is harder to
    // attribute to the converter.
    if (sh.clipUnsupported) {
      if (!reportedClips.has(sh.clipUnsupported)) {
        reportedClips.add(sh.clipUnsupported);
        ctx.warn?.(
          `SVG clip path #${sh.clipUnsupported} is not a rectangle, so its content was dropped `
          + 'rather than drawn outside the bounds it was clipped to',
        );
      }
      continue;
    }
    const clip = sh.clip ?? null;
    const key = clip ? `${clip.x} ${clip.y} ${clip.width} ${clip.height}` : null;
    if (key !== openClip) {
      openClip = key;
      if (!clip) {
        target = slide;
        clipOriginX = 0;
        clipOriginY = 0;
      } else {
        clipOriginX = X(clip.x);
        clipOriginY = Y(clip.y);
        const frame = slide.addFrame(
          clipOriginX, clipOriginY, clip.width * sx, clip.height * sy,
          { direction: 'NONE', spacing: 0, name: 'Clip' },
        );
        styleClipFrame(frame?._node, (clip.cornerRadius ?? 0) * S);
        target = frame ?? slide;
      }
    }
    // A frame's children are placed relative to it, so the outer mapping is
    // shifted by the frame's own origin. On the slide both offsets are zero
    // and the mapping is the one every shape had before clipping existed.
    await emitShape(
      target,
      sh,
      x => X(x) - clipOriginX,
      y => Y(y) - clipOriginY,
    );
  }
}

// A frame that exists only to clip: no auto-layout, and a fill that is present
// but fully transparent.
//
// The fill is not decoration. Figma stores "clip content" as
// `frameMaskDisabled: false`, and both Figma and this repo's rasterizer treat a
// frame with no visible fill as a grouping container rather than a viewport —
// so a clip frame with no fill at all quietly does not clip.
function styleClipFrame(node, cornerRadius) {
  if (!node) return;
  node.frameMaskDisabled = false;
  node.fillPaints = [{
    type: 'SOLID',
    color: { r: 0, g: 0, b: 0, a: 1 },
    opacity: 0,
    visible: true,
    blendMode: 'NORMAL',
  }];
  node.strokePaints = [];
  node.strokeWeight = 0;
  if (cornerRadius > 0) {
    node.cornerRadius = cornerRadius;
    node.rectangleTopLeftCornerRadius = cornerRadius;
    node.rectangleTopRightCornerRadius = cornerRadius;
    node.rectangleBottomLeftCornerRadius = cornerRadius;
    node.rectangleBottomRightCornerRadius = cornerRadius;
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
