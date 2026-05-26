/**
 * Regression test for the svg-color-tweak-wrap synthetic fixture.
 * Covers three convert-html fixes:
 *   1. Inline SVG fill="currentColor" resolves to the element's computed color
 *      (white on a dark section, near-black on a light one) — previously threw
 *      "Unknown color: currentColor".
 *   2. Saved deck TWEAK_DEFAULTS (quoteStyle:"top") is replayed before
 *      extraction, so a `.sidebox` collapses to a single top rule instead of
 *      emitting a phantom 4-side box.
 *   3. A <br> label whose second segment is wider than its 200px column wraps
 *      (textAutoResize HEIGHT) instead of being forced noWrap and overflowing;
 *      a control label whose segments fit keeps its authored break (noWrap).
 *
 * The fixture content is entirely synthetic ("Northwind Telemetry").
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { convertStandaloneHtml } from '../../../../lib/slides/html-converter.mjs';
import { FigDeck } from '../../../../lib/core/fig-deck.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(FIXTURE_DIR, 'svg-color-tweak-wrap.html');

let workDir;
let scratchDir;
let outPath;
let fd;
let manifest;
let templateHtml;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'svg-color-tweak-wrap-'));
  scratchDir = join(workDir, 'build');
  outPath = join(workDir, 'fixture.deck');
  // A throw here (e.g. "Unknown color: currentColor") fails the whole suite —
  // that itself is the primary guard for the currentColor fix.
  await convertStandaloneHtml(HTML_PATH, outPath, { scratchDir });
  fd = await FigDeck.fromDeckFile(outPath);
  manifest = JSON.parse(readFileSync(join(scratchDir, 'manifest.json'), 'utf8'));
  templateHtml = readFileSync(join(scratchDir, 'template.html'), 'utf8');
}, 60_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function slideRects(index) {
  const slide = manifest.slides.find((s) => s.index === index);
  const out = [];
  const walk = (els) => {
    for (const e of els) {
      if (e.type === 'rect') out.push(e);
      if (e.children) walk(e.children);
    }
  };
  walk(slide.elements);
  return out;
}

function textNode(characters) {
  return fd.message.nodeChanges.find(
    (n) => n.type === 'TEXT' && n.textData?.characters === characters,
  );
}

describe('svg-color-tweak-wrap standalone HTML → .deck build', () => {
  it('writes a non-empty .deck file with 4 slides', () => {
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(10_000);
    expect(fd.getActiveSlides()).toHaveLength(4);
  });

  // Fix 1 — SVG currentColor resolves to the inherited computed color.
  it('resolves currentColor per element: white icon on dark, dark icon on light', () => {
    const vectors = fd.message.nodeChanges.filter((n) => n.type === 'VECTOR');
    expect(vectors).toHaveLength(2);
    const fills = vectors
      .map((v) => v.fillPaints?.[0]?.color)
      .filter(Boolean)
      .map((c) => ({ r: c.r, g: c.g, b: c.b }));
    const white = fills.find((c) => c.r > 0.9 && c.g > 0.9 && c.b > 0.9);
    const dark = fills.find((c) => c.r < 0.2 && c.g < 0.2 && c.b < 0.2);
    expect(white, 'white icon on the dark section').toBeTruthy();
    expect(dark, 'dark icon on the light section').toBeTruthy();
  });

  // Fix 2 — TWEAK_DEFAULTS replayed: body.quote-top, sidebox is a top rule.
  it('replays quoteStyle:"top" so the sidebox is a top rule, not a 4-side box', () => {
    expect(templateHtml).toMatch(/<body[^>]*class="[^"]*\bquote-top\b/);
    const rects = slideRects(3);
    // No phantom box: no stroked rect taller than a hairline.
    const boxes = rects.filter((r) => r.stroke && r.height > 8);
    expect(boxes).toHaveLength(0);
    // The collapsed border is a single thin top line.
    const topLine = rects.find((r) => !r.stroke && r.fill && r.height <= 6 && r.width > 200);
    expect(topLine, 'a thin top-border line').toBeTruthy();
  });

  // Fix 3 — a <br> segment wider than its column wraps; a fitting one does not.
  it('wraps an overflowing label segment but keeps a fitting one as noWrap', () => {
    const wrapping = textNode('SECTION 01\nTHROUGHPUT METRICS');
    const control = textNode('PART TWO\nOK');
    expect(wrapping, 'overflowing label node').toBeTruthy();
    expect(control, 'control label node').toBeTruthy();
    // Wrapping text reflows vertically within its fixed-width column.
    expect(wrapping.textAutoResize).toBe('HEIGHT');
    // A label whose authored lines all fit keeps its break on one line each.
    expect(control.textAutoResize).toBe('WIDTH_AND_HEIGHT');
  });
});
