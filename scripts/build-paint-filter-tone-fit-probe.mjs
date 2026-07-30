#!/usr/bin/env node
/**
 * Build the first native tone-fitting probe.
 *
 * This probe asks two questions before OpenFig invests in an image-aware
 * optimizer:
 *
 * 1. Do the unused portable paintFilter fields (`shadows`, `highlights`, and
 *    `detail`) produce useful, measurable output?
 * 2. Do they still provide useful headroom on top of slide 7's current native
 *    mapping, where contrast is already clamped at its measured maximum?
 *
 * Each slide contains the same 32-band grey ramp and the real slide 7
 * photograph. The photo is multiplied over the authored coral background, as
 * it is in the fixture. Filter values are written directly on both IMAGE
 * paints, bypassing the CSS mapping under investigation.
 *
 * Usage:
 *   node scripts/build-paint-filter-tone-fit-probe.mjs [-o out.deck]
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { Deck } from '../lib/slides/api.mjs';
import { readSourcePhoto } from './paint-filter-brightness-probe-shared.mjs';

export const RAMP = { x: 160, y: 260, width: 1600, height: 300 };
export const PHOTO = { x: 160, y: 690, width: 1600, height: 250 };
const CORAL = '#FF5B45';

const FIELDS = ['shadows', 'highlights', 'detail'];
const VALUES = [-1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1];

// Current native mapping for grayscale(1) contrast(1.15) brightness(1.55).
const SLIDE_7_BASELINE = {
  vibrance: -1,
  contrast: 0.5,
  exposure: 0.3292,
};

export const PROBE_PLAN = [
  {
    label: 'REFERENCE — no paintFilter',
    paintFilter: null,
  },
  ...FIELDS.flatMap((field) => VALUES.map((value) => ({
    label: `SOLO — ${field} ${value}`,
    paintFilter: { [field]: value },
  }))),
  {
    label: 'SLIDE 7 BASELINE',
    paintFilter: { ...SLIDE_7_BASELINE },
  },
  ...FIELDS.flatMap((field) => VALUES.map((value) => ({
    label: `SLIDE 7 + ${field} ${value}`,
    paintFilter: { ...SLIDE_7_BASELINE, [field]: value },
  }))),
];

/**
 * A banded ramp survives PDF resampling better than a smooth gradient.
 * Levels avoid 0 and 255 because already-clipped samples cannot reveal how a
 * tone control moves them.
 */
async function rampPng() {
  const bands = 32;
  const bandW = Math.round(RAMP.width / bands);
  const pixels = Buffer.alloc(RAMP.width * RAMP.height * 3);
  for (let x = 0; x < RAMP.width; x++) {
    const band = Math.min(bands - 1, Math.floor(x / bandW));
    const level = Math.round(8 + (band / (bands - 1)) * 239);
    for (let y = 0; y < RAMP.height; y++) {
      const i = (y * RAMP.width + x) * 3;
      pixels[i] = level;
      pixels[i + 1] = level;
      pixels[i + 2] = level;
    }
  }
  return sharp(pixels, {
    raw: { width: RAMP.width, height: RAMP.height, channels: 3 },
  }).png().toBuffer();
}

function applyPaintFilter(node, paintFilter, { multiply = false } = {}) {
  const paint = node.fillPaints?.find((candidate) => candidate.type === 'IMAGE');
  if (!paint) throw new Error(`probe: ${node.name ?? 'image'} has no IMAGE paint`);
  if (paintFilter) paint.paintFilter = { ...paintFilter };
  if (multiply) paint.blendMode = 'MULTIPLY';
}

async function main() {
  const outIndex = process.argv.indexOf('-o');
  const outPath = outIndex > -1
    ? process.argv[outIndex + 1]
    : 'paint-filter-tone-fit-probe.deck';
  if (!outPath) throw new Error('-o requires an output path');

  const scratch = mkdtempSync(join(tmpdir(), 'tone-fit-probe-'));
  try {
    const rampPath = join(scratch, 'ramp.png');
    writeFileSync(rampPath, await rampPng());
    const photo = readSourcePhoto();

    const deck = await Deck.create({ name: 'OpenFig native tone-fit probe' });
    for (const [index, step] of PROBE_PLAN.entries()) {
      const slide = deck.addBlankSlide();
      slide.addText(
        `${String(index + 1).padStart(2, '0')}  ${step.label}`,
        {
          x: 160,
          y: 72,
          width: 1600,
          font: 'Inter',
          fontSize: 52,
          color: { r: 0, g: 0, b: 0 },
        },
      );
      slide.addText(
        `${step.paintFilter ? JSON.stringify(step.paintFilter) : '{}'}`
        + '  ·  ramp above  ·  slide 7 photo below, multiply on coral',
        {
          x: 160,
          y: 155,
          width: 1600,
          font: 'Inter',
          fontSize: 23,
          color: { r: 0.25, g: 0.25, b: 0.25 },
        },
      );

      const ramp = await slide.addImage(rampPath, {
        ...RAMP,
        name: 'Measured grey ramp',
        scaleMode: 'FILL',
      });
      applyPaintFilter(ramp, step.paintFilter);

      slide.addRectangle(PHOTO.x, PHOTO.y, PHOTO.width, PHOTO.height, {
        name: 'Slide 7 coral background',
        fill: CORAL,
      });
      const image = await slide.addImage(photo, {
        ...PHOTO,
        name: 'Measured slide 7 photograph',
        scaleMode: 'FILL',
      });
      applyPaintFilter(image, step.paintFilter, { multiply: true });
    }

    await deck.save(outPath);
    console.log(`wrote ${outPath}`);
    console.log(`  ${PROBE_PLAN.length} slides`);
    console.log(`  fields: ${FIELDS.join(', ')}`);
    console.log(`  values: ${VALUES.join(', ')}`);
    console.log('  each field is measured alone and on top of the slide 7 baseline');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('build-paint-filter-tone-fit-probe.mjs')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
