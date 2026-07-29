#!/usr/bin/env node
/**
 * Build a probe deck that measures Figma's `paintFilter` transfer functions.
 *
 * Why a grey ramp rather than a photograph. The previous calibration measured
 * *mean luminance* from a compatibility-reference output. That works for exposure, which moves
 * the mean directly, and fails for contrast, which changes the spread of the
 * histogram while leaving the mean nearly fixed — the sweep read 69.8, 68.0,
 * 61.3, 62.0, 62.2, which says almost nothing about what contrast did.
 *
 * A horizontal ramp from black to white makes the instrument match the quantity.
 * Input level is position, output level is the pixel value there, so one patch
 * yields the *entire* transfer function instead of one summary statistic. That
 * also answers the other open question — whether EXPOSURE_CURVE's seven points
 * are too sparse — because the measured curve arrives dense enough to see the
 * chord error between them.
 *
 * Each slide carries one ramp with one filter value, plus a label. Slide 1 is
 * unfiltered and is the reference every other slide is divided by.
 *
 * Usage:
 *   node scripts/build-paint-filter-probe.mjs [-o out.deck]
 *
 * Then: use an approved compatibility-reference PDF, and run
 * scripts/measure-paint-filter-probe.mjs against it.
 */
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { Deck } from '../lib/slides/api.mjs';

const RAMP_W = 1600;
const RAMP_H = 500;
const RAMP_X = 160;
const RAMP_Y = 380;

/** Values swept for each field. Denser than the tables they will replace. */
const CONTRAST_VALUES = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
const EXPOSURE_VALUES = [-1, -0.75, -0.5, -0.25, 0, 0.125, 0.25, 0.375, 0.5, 0.75, 1];

/**
 * A horizontal black-to-white ramp, banded rather than smooth.
 *
 * Bands, not a gradient: a PDF rasterised at any dpi resamples, and a smooth
 * ramp turns every measurement into a question about interpolation. 32 flat
 * bands each 50 px wide survive resampling, and the middle of a band is a
 * reliable sample of one known input level. Encoded as PNG deliberately — this
 * is measurement data, and JPEG would put ringing on every band edge.
 */
async function rampPng() {
  const bands = 32;
  const bandW = Math.round(RAMP_W / bands);
  const px = Buffer.alloc(RAMP_W * RAMP_H * 3);
  for (let x = 0; x < RAMP_W; x++) {
    const band = Math.min(bands - 1, Math.floor(x / bandW));
    // Levels spread over 8..247 rather than 0..255: a value already clipped at
    // the ends cannot show a filter pushing it further, and both fields clip.
    const level = Math.round(8 + (band / (bands - 1)) * 239);
    for (let y = 0; y < RAMP_H; y++) {
      const i = (y * RAMP_W + x) * 3;
      px[i] = level; px[i + 1] = level; px[i + 2] = level;
    }
  }
  return sharp(px, { raw: { width: RAMP_W, height: RAMP_H, channels: 3 } }).png().toBuffer();
}

async function main() {
  const outArg = process.argv.indexOf('-o');
  const outPath = outArg > -1 ? process.argv[outArg + 1] : 'paint-filter-probe.deck';

  const tmp = mkdtempSync(join(tmpdir(), 'probe-'));
  const rampPath = join(tmp, 'ramp.png');
  writeFileSync(rampPath, await rampPng());

  const deck = await Deck.create({ name: 'paintFilter calibration probe' });
  const plan = [
    { field: null, value: 0, label: 'REFERENCE — no filter' },
    ...CONTRAST_VALUES.map((v) => ({ field: 'contrast', value: v, label: `contrast ${v}` })),
    ...EXPOSURE_VALUES.map((v) => ({ field: 'exposure', value: v, label: `exposure ${v}` })),
  ];

  for (const [i, step] of plan.entries()) {
    const slide = deck.addBlankSlide();
    // The label is read by a human checking the PDF lines up with the plan; the
    // measurement script keys off slide order, not this text.
    slide.addText(`${String(i + 1).padStart(2, '0')}  ${step.label}`, {
      x: RAMP_X, y: 140, font: 'Inter', fontSize: 64, color: { r: 0, g: 0, b: 0 },
    });
    const img = await slide.addImage(rampPath, {
      x: RAMP_X, y: RAMP_Y, width: RAMP_W, height: RAMP_H,
    });
    if (step.field) {
      // Written straight onto the paint, bypassing the CSS mapping entirely.
      // Calibrating through our own mapping would measure the mapping.
      const paint = img.fillPaints?.[0];
      if (!paint) throw new Error(`probe: slide ${i + 1} has no image paint to filter`);
      paint.paintFilter = { ...(paint.paintFilter ?? {}), [step.field]: step.value };
    }
  }

  await deck.save(outPath);
  console.log(`wrote ${outPath}`);
  console.log(`  ${plan.length} slides: 1 reference, ${CONTRAST_VALUES.length} contrast, ${EXPOSURE_VALUES.length} exposure`);
  console.log('  ramp: 32 bands, levels 8..247');
  console.log('\nNext: use an approved compatibility-reference PDF, then');
  console.log(`  node scripts/measure-paint-filter-probe.mjs <exported.pdf>`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
