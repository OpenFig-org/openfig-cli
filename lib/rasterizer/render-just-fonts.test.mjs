/**
 * JUST FONTS TESTING — render quality test for just-fonts.deck
 *
 * Deck: decks/reference/just-fonts.deck
 * Reference: decks/reference/just-fonts/page-1.png
 *
 * Fonts used: Inter Bold, Inter Regular, Irish Grover Regular
 * Run: npm test
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FigDeck } from '../fig-deck.mjs';
import { slideToSvg } from './svg-builder.mjs';
import { svgToPng } from './deck-rasterizer.mjs';
import { buildReportRow, writeRenderReport, computeSsim } from './render-report-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK_PATH = join(__dirname, '../../decks/reference/just-fonts.deck');
const REF_DIR   = join(__dirname, '../../decks/reference/just-fonts');
const REPORT_OUT = '/private/tmp/figmatk-render-report-just-fonts.html';
const reportRows = [];

describe('just-fonts deck rendering', () => {
  it('slide 1 SSIM ≥ 0.70', async () => {
    const deck   = await FigDeck.fromDeckFile(DECK_PATH);
    const slides = deck.getActiveSlides();
    expect(slides.length).toBe(1);

    const slide   = slides[0];
    const refPath = join(REF_DIR, 'page-1.png');

    const svg = slideToSvg(deck, slide);
    const png = await svgToPng(svg, {});

    const outPath = join('/tmp', 'figmatk-test-just-fonts-1.png');
    writeFileSync(outPath, Buffer.from(png));

    if (!existsSync(refPath)) {
      console.warn(`  ⚠ Reference missing: ${refPath} — skipping SSIM`);
      return;
    }

    const mssim = await computeSsim(Buffer.from(png), refPath);
    reportRows.push(await buildReportRow({ slideNumber: 1, renderedPng: Buffer.from(png), refPath, score: mssim }));
    console.log(`  slide 1  SSIM=${mssim.toFixed(4)}  →  ${outPath}`);
    expect(mssim).toBeGreaterThanOrEqual(0.99);
  });
});

afterAll(() => {
  if (!reportRows.length) return;
  writeRenderReport({ outHtml: REPORT_OUT, rows: reportRows, title: 'FigmaTK Render Report' });
  console.log(`\nReport → ${REPORT_OUT}`);
});
