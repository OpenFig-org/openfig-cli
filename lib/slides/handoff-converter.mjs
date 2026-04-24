import { mkdirSync } from 'fs';
import { Deck } from './api.mjs';
import { loadBundle } from './handoff/bundle-loader.mjs';
import { applyElement } from './handoff/element-dispatch.mjs';

function scopeScratchDir(outPath) {
  const scratch = outPath.replace(/\.deck$/, '') + '-build';
  mkdirSync(scratch, { recursive: true });
  process.env.TMPDIR = scratch;
  return scratch;
}

function isParagraphText(el) {
  return !!el
    && (el.type === 'text' || el.type === 'richText')
    && !el.noWrap
    && typeof el.height === 'number'
    && el.height >= 80
    && typeof el.width === 'number'
    && el.width >= 240;
}

function isPillRect(el) {
  return !!el
    && el.type === 'rect'
    && typeof el.width === 'number'
    && typeof el.height === 'number'
    && el.height >= 20
    && el.height <= 48
    && typeof el.cornerRadius === 'number'
    && el.cornerRadius >= el.height / 2 - 2
    && !!el.stroke
    && !!el.fill;
}

function isPillText(el, rect) {
  return !!el
    && el.type === 'text'
    && el.noWrap
    && typeof el.x === 'number'
    && typeof el.y === 'number'
    && typeof el.width === 'number'
    && typeof el.height === 'number'
    && el.x >= rect.x - 2
    && el.y >= rect.y - 2
    && el.x + el.width <= rect.x + rect.width + 2
    && el.y + el.height <= rect.y + rect.height + 4;
}

function isStatDivider(el) {
  return !!el
    && el.type === 'rect'
    && typeof el.width === 'number'
    && el.width <= 2
    && typeof el.height === 'number'
    && el.height >= 240
    && typeof el.fill === 'string';
}

function isStatNumber(el) {
  return !!el
    && el.type === 'richText'
    && el.noWrap
    && typeof el.size === 'number'
    && el.size >= 72
    && typeof el.height === 'number'
    && el.height >= 80;
}

function isStatLabel(el, number) {
  return !!el
    && el.type === 'text'
    && !el.noWrap
    && typeof el.width === 'number'
    && el.width >= 240
    && el.width <= 360
    && typeof el.lineHeight === 'number'
    && el.lineHeight >= 28
    && Math.abs(el.x - number.x) <= 4
    && el.y > number.y;
}

function isRingCaption(el, svg) {
  return !!el
    && el.type === 'text'
    && typeof el.size === 'number'
    && el.size >= 20
    && el.size <= 28
    && typeof el.x === 'number'
    && typeof el.y === 'number'
    && el.x >= svg.x + svg.width - 4
    && el.y >= svg.y - 4
    && el.y + el.height <= svg.y + svg.height + 4;
}

function horizontalOverlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function maybeStatWithRing(elements, startIdx) {
  let i = startIdx;
  let divider = null;
  if (isStatDivider(elements[i])) {
    divider = elements[i];
    i += 1;
  }

  const number = elements[i];
  const label = elements[i + 1];
  const ring = elements[i + 2];
  const caption = elements[i + 3];
  if (!isStatNumber(number) || !isStatLabel(label, number) || ring?.type !== 'svg' || !isRingCaption(caption, ring)) {
    return null;
  }

  const gap = ring.y - (label.y + label.height);
  if (gap < 8 || gap > 32) return null;

  return {
    consumedUntil: i + 4,
    element: {
      type: 'statWithRing',
      number,
      label,
      ring,
      caption,
      divider,
    },
  };
}

function maybeTextWithPillRow(elements, startIdx) {
  const textBlock = elements[startIdx];
  if (!isParagraphText(textBlock)) return null;

  const items = [];
  let i = startIdx + 1;
  while (i + 1 < elements.length) {
    const rect = elements[i];
    const text = elements[i + 1];
    if (!isPillRect(rect) || !isPillText(text, rect)) break;
    if (items.length > 0) {
      const prev = items[items.length - 1].rect;
      const gap = rect.x - (prev.x + prev.width);
      if (Math.abs(rect.y - prev.y) > 4 || gap < 0 || gap > 32) break;
    }
    items.push({ rect, text });
    i += 2;
  }
  if (items.length < 2) return null;

  const rowX = items[0].rect.x;
  const rowY = Math.min(...items.map((item) => item.rect.y));
  const rowH = Math.max(...items.map((item) => item.rect.height));
  const last = items[items.length - 1].rect;
  const rowW = last.x + last.width - rowX;
  const gap = rowY - (textBlock.y + textBlock.height);
  if (gap < 8 || gap > 48) return null;

  const overlap = horizontalOverlap(
    textBlock.x,
    textBlock.x + textBlock.width,
    rowX,
    rowX + rowW,
  );
  if (overlap < Math.min(textBlock.width, rowW) * 0.3) return null;

  const itemGaps = [];
  for (let idx = 1; idx < items.length; idx++) {
    const prev = items[idx - 1].rect;
    const cur = items[idx].rect;
    itemGaps.push(cur.x - (prev.x + prev.width));
  }
  const rowGap = itemGaps.length
    ? Math.round(itemGaps.reduce((sum, n) => sum + n, 0) / itemGaps.length)
    : 0;

  return {
    consumedUntil: i,
    element: {
      type: 'textWithPillRow',
      x: textBlock.x,
      y: textBlock.y,
      width: Math.max(textBlock.width, rowW),
      height: textBlock.height + gap + rowH,
      gap,
      textBlock,
      row: {
        width: rowW,
        height: rowH,
        gap: rowGap,
        items: items.map(({ rect, text }) => ({ rect, text })),
      },
    },
  };
}

// Match a standalone pill row (no paragraph anchor) inside a flex container.
// This handles cases like Carbon slide 1's bottom-right "ENERGY / DATA CENTERS
// / CLIMATE" chips, which sit in their own flex column and aren't preceded by
// a paragraph — so `maybeTextWithPillRow` can't anchor. Without this, the
// pill rect and its text label become two separate Auto Layout siblings and
// the pill loses its shape.
function maybePillRow(elements, startIdx) {
  const items = [];
  let i = startIdx;
  while (i + 1 < elements.length) {
    const rect = elements[i];
    const text = elements[i + 1];
    if (!isPillRect(rect) || !isPillText(text, rect)) break;
    if (items.length > 0) {
      const prev = items[items.length - 1].rect;
      const gap = rect.x - (prev.x + prev.width);
      if (Math.abs(rect.y - prev.y) > 4 || gap < 0 || gap > 32) break;
    }
    items.push({ rect, text });
    i += 2;
  }
  if (items.length < 2) return null;

  const rowX = items[0].rect.x;
  const rowY = Math.min(...items.map((item) => item.rect.y));
  const rowH = Math.max(...items.map((item) => item.rect.height));
  const last = items[items.length - 1].rect;
  const rowW = last.x + last.width - rowX;

  const itemGaps = [];
  for (let idx = 1; idx < items.length; idx++) {
    const prev = items[idx - 1].rect;
    const cur = items[idx].rect;
    itemGaps.push(cur.x - (prev.x + prev.width));
  }
  const rowGap = itemGaps.length
    ? Math.round(itemGaps.reduce((sum, n) => sum + n, 0) / itemGaps.length)
    : 0;

  return {
    consumedUntil: i,
    element: {
      type: 'pillRow',
      x: rowX,
      y: rowY,
      width: rowW,
      height: rowH,
      gap: rowGap,
      items: items.map(({ rect, text }) => ({ rect, text })),
    },
  };
}

function coalesceAutoLayoutStructures(elements = []) {
  const out = [];
  for (let i = 0; i < elements.length; i++) {
    const stat = maybeStatWithRing(elements, i);
    if (stat) {
      out.push(stat.element);
      i = stat.consumedUntil - 1;
      continue;
    }
    const grouped = maybeTextWithPillRow(elements, i);
    if (grouped) {
      out.push(grouped.element);
      i = grouped.consumedUntil - 1;
      continue;
    }
    const pills = maybePillRow(elements, i);
    if (pills) {
      out.push(pills.element);
      i = pills.consumedUntil - 1;
      continue;
    }
    const el = elements[i];
    if (el && el.type === 'layoutContainer' && Array.isArray(el.children)) {
      // Recurse so specialized pill/stat coalescers fire inside nested flex
      // containers too.
      out.push({ ...el, children: coalesceAutoLayoutStructures(el.children) });
      continue;
    }
    out.push(el);
  }
  return out;
}

export async function convertHandoffBundle(bundlePath, outDeckPath, opts = {}) {
  const bundle = loadBundle(bundlePath);
  const manifest = bundle.manifest;
  const scratch = opts.scratchDir ?? scopeScratchDir(outDeckPath);

  const deck = await Deck.create({ name: opts.title ?? manifest.title ?? 'Untitled' });

  for (let i = 0; i < manifest.slides.length; i++) {
    const def = manifest.slides[i];
    const slide = deck.addBlankSlide();
    if (def.background) slide.setBackground(def.background);
    const ctx = { ...bundle, slideIndex: i + 1, slideDef: def, slideWidth: manifest.dimensions?.width ?? 1920 };
    for (const el of coalesceAutoLayoutStructures(def.elements ?? [])) {
      await applyElement(slide, el, ctx);
    }
    if (def.speakerNotes) slide.setSpeakerNotes(def.speakerNotes);
  }

  await deck.save(outDeckPath);
  return { deck, scratchDir: scratch, bundle };
}
