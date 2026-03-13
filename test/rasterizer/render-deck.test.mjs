/**
 * .deck (Figma Slides) render quality tests — compare rendered slides against
 * Figma reference PNGs using SSIM (Structural Similarity Index).
 *
 * Fixtures:  decks/reference/
 * Report:    /tmp/figmatk-render-report-deck.html
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { slideToSvg } from '../../lib/rasterizer/svg-builder.mjs';
import { svgToPng } from '../../lib/rasterizer/deck-rasterizer.mjs';
import { buildReportRow, writeRenderReport, computeSsim } from '../../lib/rasterizer/render-report-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_OUT = '/private/tmp/figmatk-render-report-deck.html';

const DECK_PATH   = join(__dirname, '../../decks/reference/oil-machinations.deck');
const REF_DIR     = join(__dirname, '../../decks/reference/oil-machinations');

const JUST_FONTS_DECK = join(__dirname, '../../decks/reference/just-fonts.deck');
const JUST_FONTS_REF  = join(__dirname, '../../decks/reference/just-fonts');

const SVG_DECK = join(__dirname, '../../decks/reference/svg-deck.deck');
const SVG_REF  = join(__dirname, '../../decks/reference/svg-deck');

const FOUR_TEXT_COL_DECK = join(__dirname, '../../decks/reference/4-text-column.deck');
const FOUR_TEXT_COL_REF  = join(__dirname, '../../decks/reference/4-text-column');

// Per-slide minimum SSIM thresholds — set just below current scores as regression guard.
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

// Per-slide max pixel-off percentage — catches localized defects SSIM misses.
// Default 10%; override per-slide where known rendering gaps exist.
const DEFAULT_MAX_OFF_PCT = 10.0;
const OFF_PCT_THRESHOLDS = {
  4: 15.0,   // 13.88% — gradient/image dithering differences
  5: 12.0,   // 10.27% — subtle text rendering differences
};

// Per-slide max mean delta (0–255) — severity-weighted metric.
// A subpixel shift scores ~1, a missing object scores ~200.
const DEFAULT_MAX_MEAN_DELTA = 5.0;
const MEAN_DELTA_THRESHOLDS = {
  4: 7.0,    // 5.99 — gradient/image dithering
};

async function renderSlide(deck, slide) {
  const svg = slideToSvg(deck, slide);
  return svgToPng(svg, {});
}

const reportRows = [];

describe('oil-machinations deck rendering', () => {
  let deck;

  it('loads deck successfully', async () => {
    deck = await FigDeck.fromDeckFile(DECK_PATH);
    expect(deck.getActiveSlides().length).toBe(7);
  });

  for (let i = 1; i <= 7; i++) {
    it(`slide ${i} SSIM ≥ ${SSIM_THRESHOLDS[i] ?? 0.70}`, async () => {
      if (!deck) deck = await FigDeck.fromDeckFile(DECK_PATH);

      const slide   = deck.getSlide(i);
      const refPath = join(REF_DIR, `page-${i}.png`);

      if (!existsSync(refPath)) {
        console.warn(`  ⚠ Reference missing: ${refPath} — skipping`);
        return;
      }

      const png   = await renderSlide(deck, slide);
      const score = await computeSsim(Buffer.from(png), refPath);

      const outPath = join('/tmp', `figmatk-test-slide-${i}.png`);
      writeFileSync(outPath, Buffer.from(png));
      const row = await buildReportRow({ slideNumber: i, renderedPng: Buffer.from(png), refPath, score });
      reportRows.push(row);

      const ssimThreshold = SSIM_THRESHOLDS[i] ?? 0.70;
      const maxOffPct = OFF_PCT_THRESHOLDS[i] ?? DEFAULT_MAX_OFF_PCT;
      const maxMeanDelta = MEAN_DELTA_THRESHOLDS[i] ?? DEFAULT_MAX_MEAN_DELTA;
      console.log(`  slide ${i}  SSIM=${score.toFixed(4)}  offPct=${row.offPct}%  Δ${row.meanDelta}  severity=${row.offDelta}  →  ${outPath}`);
      expect(score).toBeGreaterThanOrEqual(ssimThreshold);
      expect(parseFloat(row.offPct)).toBeLessThanOrEqual(maxOffPct);
      expect(row.meanDelta).toBeLessThanOrEqual(maxMeanDelta);
    });
  }
});

describe('just-fonts deck rendering', () => {
  it('slide 1 SSIM ≥ 0.99', async () => {
    const deck    = await FigDeck.fromDeckFile(JUST_FONTS_DECK);
    expect(deck.getActiveSlides().length).toBe(1);

    const refPath = join(JUST_FONTS_REF, 'page-1.png');
    const png     = await renderSlide(deck, deck.getSlide(1));
    const outPath = join('/tmp', 'figmatk-test-just-fonts-1.png');
    writeFileSync(outPath, Buffer.from(png));

    if (!existsSync(refPath)) {
      console.warn(`  ⚠ Reference missing: ${refPath} — skipping SSIM`);
      return;
    }
    const score = await computeSsim(Buffer.from(png), refPath);
    const row = await buildReportRow({ slideNumber: 'fonts-1', renderedPng: Buffer.from(png), refPath, score });
    reportRows.push(row);
    console.log(`  slide 1  SSIM=${score.toFixed(4)}  offPct=${row.offPct}%  Δ${row.meanDelta}  severity=${row.offDelta}  →  ${outPath}`);
    expect(score).toBeGreaterThanOrEqual(0.99);
    expect(parseFloat(row.offPct)).toBeLessThanOrEqual(DEFAULT_MAX_OFF_PCT);
    expect(row.meanDelta).toBeLessThanOrEqual(DEFAULT_MAX_MEAN_DELTA);
  });
});

describe('svg-deck rendering (VECTOR nodes)', () => {
  it('slide 1 SSIM ≥ 0.90', async () => {
    const deck    = await FigDeck.fromDeckFile(SVG_DECK);
    expect(deck.getActiveSlides().length).toBe(1);

    const refPath = join(SVG_REF, 'page-1.png');
    const png     = await renderSlide(deck, deck.getSlide(1));
    const outPath = join('/tmp', 'figmatk-test-svg-deck-1.png');
    writeFileSync(outPath, Buffer.from(png));

    if (!existsSync(refPath)) {
      console.warn(`  ⚠ Reference missing: ${refPath} — skipping SSIM`);
      return;
    }
    const score = await computeSsim(Buffer.from(png), refPath);
    const row = await buildReportRow({ slideNumber: 'svg-1', renderedPng: Buffer.from(png), refPath, score });
    reportRows.push(row);
    console.log(`  slide 1  SSIM=${score.toFixed(4)}  offPct=${row.offPct}%  Δ${row.meanDelta}  severity=${row.offDelta}  →  ${outPath}`);
    expect(score).toBeGreaterThanOrEqual(0.90);
    expect(parseFloat(row.offPct)).toBeLessThanOrEqual(DEFAULT_MAX_OFF_PCT);
    expect(row.meanDelta).toBeLessThanOrEqual(DEFAULT_MAX_MEAN_DELTA);
  });
});

describe('4-text-column deck rendering', () => {
  it('slide 1 SSIM ≥ 0.90', async () => {
    const deck    = await FigDeck.fromDeckFile(FOUR_TEXT_COL_DECK);
    expect(deck.getActiveSlides().length).toBe(1);

    const refPath = join(FOUR_TEXT_COL_REF, 'page-1.png');
    const png     = await renderSlide(deck, deck.getSlide(1));
    const outPath = join('/tmp', 'figmatk-test-4-text-column-1.png');
    writeFileSync(outPath, Buffer.from(png));

    if (!existsSync(refPath)) {
      console.warn(`  ⚠ Reference missing: ${refPath} — skipping SSIM`);
      return;
    }
    const score = await computeSsim(Buffer.from(png), refPath);
    const row = await buildReportRow({ slideNumber: '4textcol-1', renderedPng: Buffer.from(png), refPath, score });
    reportRows.push(row);
    console.log(`  slide 1  SSIM=${score.toFixed(4)}  offPct=${row.offPct}%  Δ${row.meanDelta}  severity=${row.offDelta}  →  ${outPath}`);
    expect(score).toBeGreaterThanOrEqual(0.90);
    expect(parseFloat(row.offPct)).toBeLessThanOrEqual(DEFAULT_MAX_OFF_PCT);
    expect(row.meanDelta).toBeLessThanOrEqual(DEFAULT_MAX_MEAN_DELTA);
  });
});

afterAll(() => {
  if (!reportRows.length) return;
  writeRenderReport({ outHtml: REPORT_OUT, rows: reportRows, title: 'FigmaTK Deck Render Report' });
  console.log(`\nReport → ${REPORT_OUT}`);
});
