#!/usr/bin/env node
/**
 * Build the brightness-only isolation probe and its Chromium ground truth.
 *
 * No grayscale, contrast, or blend mode is present. The native deck isolates
 * the Exposure leg of the production mapping; the PNG reference pages use the
 * browser's actual CSS `brightness()` implementation on the same source photo
 * with the same object-fit crop. Production additionally uses the separately
 * calibrated Highlights/Shadows refinement.
 *
 * Usage:
 *   node scripts/build-paint-filter-brightness-probe.mjs \
 *     [-o out.deck] [--ground-truth out-dir]
 *
 */
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { Deck } from '../lib/slides/api.mjs';
import { resolveBrowser } from '../lib/slides/playwright-layout.mjs';
import {
  PHOTO,
  PROBE_STEPS,
  SLIDE,
  groundTruthFilename,
  readSourcePhoto,
} from './paint-filter-brightness-probe-shared.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

async function writeCssGroundTruth(directory, photo) {
  mkdirSync(directory, { recursive: true });
  const browser = await resolveBrowser();
  try {
    const context = await browser.newContext({
      viewport: { width: SLIDE.w, height: SLIDE.h },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const src = `data:${photo.mime};base64,${Buffer.from(photo.bytes).toString('base64')}`;

    for (const [index, step] of PROBE_STEPS.entries()) {
      await page.setContent(`<!doctype html>
        <style>
          html, body {
            width: ${SLIDE.w}px;
            height: ${SLIDE.h}px;
            margin: 0;
            overflow: hidden;
            background: white;
            font-family: Arial, sans-serif;
          }
          h1 {
            position: absolute;
            left: 160px;
            top: 110px;
            margin: 0;
            font-size: 64px;
            font-weight: 400;
          }
          img {
            position: absolute;
            left: ${PHOTO.x}px;
            top: ${PHOTO.y}px;
            width: ${PHOTO.w}px;
            height: ${PHOTO.h}px;
            object-fit: cover;
            filter: brightness(${step.brightness});
          }
        </style>
        <h1>${String(index + 1).padStart(2, '0')} CSS brightness ${step.brightness}</h1>
        <img src="${src}" alt="">`, { waitUntil: 'load' });
      await page.waitForFunction(() => {
        const image = document.querySelector('img');
        return image?.complete && image.naturalWidth > 0;
      });
      await page.screenshot({
        path: resolve(directory, groundTruthFilename(index)),
        animations: 'disabled',
      });
    }
    await context.close();
  } finally {
    await browser.close();
  }
}

async function main() {
  const outPath = resolve(option('-o', 'paint-filter-brightness-probe.deck'));
  const groundTruthDir = resolve(option(
    '--ground-truth',
    'paint-filter-brightness-css-ground-truth',
  ));
  const photo = readSourcePhoto();

  const deck = await Deck.create({ name: 'paintFilter brightness isolation probe' });
  for (const [index, step] of PROBE_STEPS.entries()) {
    const slide = deck.addBlankSlide();
    const exposureLabel = step.exposure === null
      ? 'no paintFilter'
      : `exposure ${step.exposure}`;
    slide.addText(
      `${String(index + 1).padStart(2, '0')}  CSS ${step.brightness} → ${exposureLabel}`,
      {
        x: 160,
        y: 140,
        width: 1600,
        font: 'Inter',
        fontSize: 64,
        color: { r: 0, g: 0, b: 0 },
      },
    );
    const image = await slide.addImage(photo, {
      x: PHOTO.x,
      y: PHOTO.y,
      width: PHOTO.w,
      height: PHOTO.h,
      scaleMode: 'FILL',
    });
    if (step.exposure !== null) {
      const paint = image.fillPaints?.[0];
      if (!paint) {
        throw new Error(`probe: slide ${index + 1} has no image paint to filter`);
      }
      paint.paintFilter = { exposure: step.exposure };
    }
  }

  await Promise.all([
    deck.save(outPath),
    writeCssGroundTruth(groundTruthDir, photo),
  ]);

  console.log(`wrote ${outPath}`);
  console.log(`wrote Chromium ground truth to ${groundTruthDir}`);
  for (const [index, step] of PROBE_STEPS.entries()) {
    console.log(
      `  slide ${index + 1}: brightness ${step.brightness}`
      + (step.exposure === null ? ' / reference' : ` / exposure ${step.exposure}`),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
