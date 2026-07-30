#!/usr/bin/env node
/**
 * Measure the native tone-fitting probe from a compatibility-reference output.
 *
 * Reports every candidate relative to the matching reference:
 * - SOLO pages use the unfiltered first page.
 * - SLIDE 7 pages use the native slide 7 baseline page.
 *
 * The ramp describes the transfer curve. The photograph describes the result
 * that matters for issue #20, including the authored multiply blend.
 *
 * Usage:
 *   node scripts/measure-paint-filter-tone-fit-probe.mjs <compatibility-reference.pdf>
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import {
  PHOTO,
  PROBE_PLAN,
  RAMP,
} from './build-paint-filter-tone-fit-probe.mjs';

const SLIDE = { width: 1920, height: 1080 };
const BANDS = 32;

function summarize(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  ) / values.length;
  return { mean, stdev: Math.sqrt(variance) };
}

async function normalizedRaw(pngPath) {
  return sharp(pngPath)
    .resize(SLIDE.width, SLIDE.height, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function readRamp(pngPath) {
  const { data, info } = await normalizedRaw(pngPath);
  const bandWidth = RAMP.width / BANDS;
  const values = [];
  for (let band = 0; band < BANDS; band++) {
    const x0 = Math.round(RAMP.x + band * bandWidth + bandWidth * 0.2);
    const x1 = Math.round(RAMP.x + band * bandWidth + bandWidth * 0.8);
    const y0 = Math.round(RAMP.y + RAMP.height * 0.2);
    const y1 = Math.round(RAMP.y + RAMP.height * 0.8);
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        sum += data[y * info.width + x];
        count += 1;
      }
    }
    values.push(sum / count);
  }
  return { values, ...summarize(values) };
}

async function readPhoto(pngPath) {
  const { data } = await sharp(pngPath)
    .resize(SLIDE.width, SLIDE.height, { fit: 'fill' })
    .extract({
      left: PHOTO.x,
      top: PHOTO.y,
      width: PHOTO.width,
      height: PHOTO.height,
    })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return summarize(Array.from(data));
}

function relativeRow(step, page, sample, reference) {
  return {
    page,
    setting: step.label,
    rampMean: +sample.ramp.mean.toFixed(2),
    rampSpread: +sample.ramp.stdev.toFixed(2),
    rampSpreadVsRefPct: +(
      ((sample.ramp.stdev / reference.ramp.stdev) - 1) * 100
    ).toFixed(2),
    photoMean: +sample.photo.mean.toFixed(2),
    photoMeanVsRefPct: +(
      ((sample.photo.mean / reference.photo.mean) - 1) * 100
    ).toFixed(2),
    photoSpread: +sample.photo.stdev.toFixed(2),
    photoSpreadVsRefPct: +(
      ((sample.photo.stdev / reference.photo.stdev) - 1) * 100
    ).toFixed(2),
  };
}

async function main() {
  const pdf = process.argv[2];
  if (!pdf) {
    console.error('usage: measure-paint-filter-tone-fit-probe.mjs <compatibility-reference.pdf>');
    process.exit(1);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'tone-fit-measure-'));
  try {
    execFileSync('pdftoppm', ['-png', '-r', '72', pdf, join(scratch, 'page')], {
      stdio: 'pipe',
    });
    const pages = readdirSync(scratch)
      .filter((name) => name.startsWith('page-') && name.endsWith('.png'))
      .sort();
    if (pages.length !== PROBE_PLAN.length) {
      throw new Error(`expected ${PROBE_PLAN.length} pages, got ${pages.length}`);
    }

    const samples = [];
    for (const page of pages) {
      const path = join(scratch, page);
      samples.push({
        ramp: await readRamp(path),
        photo: await readPhoto(path),
      });
    }

    const slide7Baseline = PROBE_PLAN.findIndex(
      (step) => step.label === 'SLIDE 7 BASELINE',
    );
    if (slide7Baseline < 0) throw new Error('slide 7 baseline is absent from probe plan');

    const solo = [];
    const slide7 = [];
    for (const [index, step] of PROBE_PLAN.entries()) {
      if (index === 0 || index === slide7Baseline) continue;
      const isSlide7 = index > slide7Baseline;
      const reference = samples[isSlide7 ? slide7Baseline : 0];
      const row = relativeRow(step, index + 1, samples[index], reference);
      (isSlide7 ? slide7 : solo).push(row);
    }

    console.log('Reference samples:');
    console.table([
      relativeRow(PROBE_PLAN[0], 1, samples[0], samples[0]),
      relativeRow(
        PROBE_PLAN[slide7Baseline],
        slide7Baseline + 1,
        samples[slide7Baseline],
        samples[slide7Baseline],
      ),
    ]);
    console.log('\nUnused fields alone:');
    console.table(solo);
    console.log('\nUnused fields on top of the slide 7 baseline:');
    console.table(slide7);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('measure-paint-filter-tone-fit-probe.mjs')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
