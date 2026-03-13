/**
 * JUST FONTS TESTING — render quality test for just-fonts.deck
 *
 * Deck: decks/reference/just-fonts.deck
 * Reference: decks/reference/just-fonts/page-1.png
 *
 * Fonts used: Inter Bold, Inter Regular, Irish Grover Regular
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
const DECK_PATH = join(__dirname, '../../decks/reference/just-fonts.deck');
const REF_DIR   = join(__dirname, '../../decks/reference/just-fonts');
const RENDER_W  = 1920;
const RENDER_H  = 1080;

async function toRgbaBuffer(source, width, height) {
  const buf = await sharp(source)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return { data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength), width, height };
}

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

    const [a, b] = await Promise.all([
      toRgbaBuffer(Buffer.from(png), RENDER_W, RENDER_H),
      toRgbaBuffer(refPath, RENDER_W, RENDER_H),
    ]);
    const { mssim } = ssim(a, b);
    console.log(`  slide 1  SSIM=${mssim.toFixed(4)}  →  ${outPath}`);
    expect(mssim).toBeGreaterThanOrEqual(0.70);
  });
});
