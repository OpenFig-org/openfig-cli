/**
 * Render quality tests: compare rendered slides against Figma reference PNGs
 * using SSIM (Structural Similarity Index). Scores range 0–1; 1 = identical.
 *
 * Reference: decks/reference/oil-machinations/ (page-N.png, 4000×2250, 2× Figma export)
 * Render size: 1920×1080 — reference is downscaled to match before comparison.
 *
 * Run: npm test
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FigDeck } from '../../lib/fig-deck.mjs';
import { slideToSvg } from '../../lib/rasterizer/svg-builder.mjs';
import { svgToPng } from '../../lib/rasterizer/deck-rasterizer.mjs';
import { buildReportRow, writeRenderReport, computeSsim } from '../../lib/rasterizer/render-report-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK_PATH   = join(__dirname, '../../decks/reference/oil-machinations.deck');
const REF_DIR     = join(__dirname, '../../decks/reference/oil-machinations');
const REPORT_OUT   = '/private/tmp/figmatk-render-report.html';

// Per-slide minimum SSIM thresholds — set just below current scores as regression guard.
// Raise each threshold as rendering improves (these are deliberate quality targets).
//   Slide 2: 0.83 — lowest; unresolved elements
//   Slide 6: 0.88 — card text overflows bounds; label pill colors wrong
const SSIM_THRESHOLDS = {
  1: 0.98,
  2: 0.83,
  3: 0.96,
  4: 0.95,
  5: 0.96,
  6: 0.88,
  7: 0.98,
};

const JUST_FONTS_DECK = join(__dirname, '../../decks/reference/just-fonts.deck');
const JUST_FONTS_REF  = join(__dirname, '../../decks/reference/just-fonts');

const SVG_DECK = join(__dirname, '../../decks/reference/svg-deck.deck');
const SVG_REF  = join(__dirname, '../../decks/reference/svg-deck');

/** Render a slide to PNG bytes at native 1920×1080. */
async function renderSlide(deck, slide) {
  const svg = slideToSvg(deck, slide);
  return svgToPng(svg, {});
}

const reportRows = [];

describe('oil-machinations deck rendering', () => {
  let deck;
  let slides;

  // Load deck once before all tests
  it('loads deck successfully', async () => {
    deck   = await FigDeck.fromDeckFile(DECK_PATH);
    slides = deck.getActiveSlides();
    expect(slides.length).toBe(7);
  });

  for (let i = 1; i <= 7; i++) {
    it(`slide ${i} SSIM ≥ ${SSIM_THRESHOLDS[i] ?? 0.70}`, async () => {
      if (!deck) deck = await FigDeck.fromDeckFile(DECK_PATH);
      if (!slides) slides = deck.getActiveSlides();

      const slide    = slides[i - 1];
      const refPath  = join(REF_DIR, `page-${i}.png`);

      if (!existsSync(refPath)) {
        console.warn(`  ⚠ Reference missing: ${refPath} — skipping`);
        return;
      }

      const png   = await renderSlide(deck, slide);
      const score = await computeSsim(Buffer.from(png), refPath);

      // Save render for manual inspection
      const outPath = join('/tmp', `figmatk-test-slide-${i}.png`);
      writeFileSync(outPath, Buffer.from(png));
      reportRows.push(await buildReportRow({ slideNumber: i, renderedPng: Buffer.from(png), refPath, score }));

      const threshold = SSIM_THRESHOLDS[i] ?? 0.70;
      console.log(`  slide ${i}  SSIM=${score.toFixed(4)}  threshold=${threshold}  →  ${outPath}`);
      expect(score).toBeGreaterThanOrEqual(threshold);
    });
  }
});

describe('just-fonts deck rendering', () => {
  it('slide 1 SSIM ≥ 0.99', async () => {
    const deck    = await FigDeck.fromDeckFile(JUST_FONTS_DECK);
    const slides  = deck.getActiveSlides();
    expect(slides.length).toBe(1);

    const refPath = join(JUST_FONTS_REF, 'page-1.png');
    const png     = await renderSlide(deck, slides[0]);
    const outPath = join('/tmp', 'figmatk-test-just-fonts-1.png');
    writeFileSync(outPath, Buffer.from(png));

    if (!existsSync(refPath)) {
      console.warn(`  ⚠ Reference missing: ${refPath} — skipping SSIM`);
      return;
    }
    const score = await computeSsim(Buffer.from(png), refPath);
    reportRows.push(await buildReportRow({ slideNumber: 'fonts-1', renderedPng: Buffer.from(png), refPath, score }));
    console.log(`  slide 1  SSIM=${score.toFixed(4)}  →  ${outPath}`);
    expect(score).toBeGreaterThanOrEqual(0.99);
  });
});

describe('svg-deck rendering (VECTOR nodes)', () => {
  it('slide 1 SSIM ≥ 0.90', async () => {
    const deck    = await FigDeck.fromDeckFile(SVG_DECK);
    const slides  = deck.getActiveSlides();
    expect(slides.length).toBe(1);

    const refPath = join(SVG_REF, 'page-1.png');
    const png     = await renderSlide(deck, slides[0]);
    const outPath = join('/tmp', 'figmatk-test-svg-deck-1.png');
    writeFileSync(outPath, Buffer.from(png));

    if (!existsSync(refPath)) {
      console.warn(`  ⚠ Reference missing: ${refPath} — skipping SSIM`);
      return;
    }
    const score = await computeSsim(Buffer.from(png), refPath);
    reportRows.push(await buildReportRow({ slideNumber: 'svg-1', renderedPng: Buffer.from(png), refPath, score }));
    console.log(`  slide 1  SSIM=${score.toFixed(4)}  →  ${outPath}`);
    expect(score).toBeGreaterThanOrEqual(0.90);
  });
});

afterAll(() => {
  if (!reportRows.length) return;
  writeRenderReport({ outHtml: REPORT_OUT, rows: reportRows, title: 'FigmaTK Render Report' });
  console.log(`\nReport → ${REPORT_OUT}`);
});
