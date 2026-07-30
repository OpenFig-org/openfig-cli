#!/usr/bin/env node
/**
 * Build a minimal probe for the native `paintFilter.vibrance` field.
 *
 * The production mapping currently assumes CSS `grayscale(1)` is equivalent
 * to `paintFilter.vibrance = -1`. That assumption cannot be tested with the
 * existing grey-ramp probe: every patch in a grey ramp already has zero chroma.
 *
 * Each slide here carries the same saturated/neutral PNG and at most one
 * `vibrance` value. The filter is written directly onto the image paint,
 * bypassing the CSS mapping so it isolates native behavior from our converter.
 *
 * Usage:
 *   node scripts/build-paint-filter-color-probe.mjs [-o out.deck]
 *
 */
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { Deck } from '../lib/slides/api.mjs';
import {
  GRID,
  PATCHES,
  PROBE_STEPS,
  TARGET,
} from './paint-filter-color-probe-shared.mjs';

async function targetPng() {
  const width = TARGET.w;
  const height = TARGET.h;
  const patchWidth = width / GRID.columns;
  const patchHeight = height / GRID.rows;
  const pixels = Buffer.alloc(width * height * 3);

  for (const [index, patch] of PATCHES.entries()) {
    const column = index % GRID.columns;
    const row = Math.floor(index / GRID.columns);
    const x0 = Math.round(column * patchWidth);
    const x1 = Math.round((column + 1) * patchWidth);
    const y0 = Math.round(row * patchHeight);
    const y1 = Math.round((row + 1) * patchHeight);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const offset = (y * width + x) * 3;
        pixels[offset] = patch.rgb[0];
        pixels[offset + 1] = patch.rgb[1];
        pixels[offset + 2] = patch.rgb[2];
      }
    }
  }

  return sharp(pixels, {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();
}

async function main() {
  const outArg = process.argv.indexOf('-o');
  const outPath = outArg > -1
    ? process.argv[outArg + 1]
    : 'paint-filter-vibrance-probe.deck';
  if (!outPath) throw new Error('-o requires an output path');

  const tempDir = mkdtempSync(join(tmpdir(), 'vibrance-probe-'));
  const targetPath = join(tempDir, 'color-patches.png');
  writeFileSync(targetPath, await targetPng());

  const deck = await Deck.create({ name: 'paintFilter vibrance probe' });
  for (const [index, step] of PROBE_STEPS.entries()) {
    const slide = deck.addBlankSlide();
    slide.addText(`${String(index + 1).padStart(2, '0')}  ${step.label}`, {
      x: TARGET.x,
      y: 140,
      font: 'Inter',
      fontSize: 64,
      color: { r: 0, g: 0, b: 0 },
    });
    const image = await slide.addImage(targetPath, {
      x: TARGET.x,
      y: TARGET.y,
      width: TARGET.w,
      height: TARGET.h,
    });
    if (step.value !== null) {
      const paint = image.fillPaints?.[0];
      if (!paint) {
        throw new Error(`probe: slide ${index + 1} has no image paint to filter`);
      }
      paint.paintFilter = { vibrance: step.value };
    }
  }

  await deck.save(outPath);
  console.log(`wrote ${outPath}`);
  console.log(`  ${PROBE_STEPS.length} slides: reference plus four negative vibrance values`);
  console.log(`  ${PATCHES.length} patches: 9 saturated, 3 neutral controls`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
