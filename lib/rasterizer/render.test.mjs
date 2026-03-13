/**
 * Render quality tests: compare rendered slides against Figma reference PNGs
 * using SSIM (Structural Similarity Index). Scores range 0–1; 1 = identical.
 *
 * Reference: decks/reference/oil-machinations/ (page-N.png, 4000×2250, 2× Figma export)
 * Render size: 1920×1080 — reference is downscaled to match before comparison.
 *
 * Run: npm test
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { ssim } from 'ssim.js';
import { FigDeck } from '../fig-deck.mjs';
import { slideToSvg } from './svg-builder.mjs';
import { svgToPng } from './deck-rasterizer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK_PATH   = join(__dirname, '../../decks/reference/oil-machinations.deck');
const REF_DIR     = join(__dirname, '../../decks/reference/oil-machinations');
const RENDER_W    = 1920;
const RENDER_H    = 1080;

// Per-slide minimum SSIM thresholds — set just below current scores as regression guard.
// Raise each threshold as rendering improves (these are deliberate quality targets).
//   Slide 1: 0.60 — unresolved color-variable fills (SHAPE_WITH_TEXT) on yellow bg
//   Slide 6: 0.50 — card text overflows bounds; label pill colors wrong
//   Slide 7: 0.45 — large font overflow at right edge; gray pill rect
const SSIM_THRESHOLDS = {
  1: 0.60,
  2: 0.72,
  3: 0.75,
  4: 0.80,
  5: 0.85,
  6: 0.50,
  7: 0.45,
};

const JUST_FONTS_DECK = join(__dirname, '../../decks/reference/just-fonts.deck');
const JUST_FONTS_REF  = join(__dirname, '../../decks/reference/just-fonts');

/** Render a slide to PNG bytes at native 1920×1080. */
async function renderSlide(deck, slide) {
  const svg = slideToSvg(deck, slide);
  return svgToPng(svg, {});
}

/** Load a PNG from disk, resize to target dimensions, return raw RGBA buffer. */
async function toRgbaBuffer(source, width, height) {
  const buf = await sharp(source)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return { data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength), width, height };
}

/** Compute SSIM between two PNG byte sources (Buffer or path). */
async function computeSsim(rendered, refPath) {
  const [a, b] = await Promise.all([
    toRgbaBuffer(rendered, RENDER_W, RENDER_H),
    toRgbaBuffer(refPath,  RENDER_W, RENDER_H),
  ]);
  const { mssim } = ssim(a, b);
  return mssim;
}

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

      const threshold = SSIM_THRESHOLDS[i] ?? 0.70;
      console.log(`  slide ${i}  SSIM=${score.toFixed(4)}  threshold=${threshold}  →  ${outPath}`);
      expect(score).toBeGreaterThanOrEqual(threshold);
    });
  }
});

describe('just-fonts deck rendering', () => {
  it('slide 1 SSIM ≥ 0.70', async () => {
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
    console.log(`  slide 1  SSIM=${score.toFixed(4)}  →  ${outPath}`);
    expect(score).toBeGreaterThanOrEqual(0.70);
  });
});
