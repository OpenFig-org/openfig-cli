#!/usr/bin/env node
/**
 * Rank the combined native tone-control candidates from a compatibility-reference output.
 *
 * Page 1 is the Chromium CSS target. Page 2 is the current native mapping.
 * Remaining pages vary shadows, highlights, and exposure.
 *
 * Ramp and photograph scores stay separate deliberately. The fixture's CSS
 * uses object-position: 50% 58% and a mask, while the current converted image
 * is centered and unmasked. A photo-pixel metric therefore includes crop and
 * mask errors that tone controls cannot solve; the ramp isolates the transfer
 * function, while photo mean/spread records the end-to-end visual result.
 *
 * Usage:
 *   node scripts/measure-paint-filter-tone-refinement-probe.mjs <reference.pdf>
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { ssim } from 'ssim.js';
import {
  REFINEMENT_PLAN,
} from './build-paint-filter-tone-refinement-probe.mjs';
import {
  PHOTO,
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

function errorPct(actual, target) {
  return ((actual / target) - 1) * 100;
}

function rmse(actual, target) {
  const mse = actual.reduce(
    (sum, value, index) => sum + (value - target[index]) ** 2,
    0,
  ) / actual.length;
  return Math.sqrt(mse);
}

async function normalizedGray(pngPath) {
  return sharp(pngPath)
    .resize(SLIDE.width, SLIDE.height, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function readRamp(pngPath) {
  const { data, info } = await normalizedGray(pngPath);
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
  const { data, info } = await sharp(pngPath)
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
  const values = Array.from(data);
  return {
    data,
    width: info.width,
    height: info.height,
    ...summarize(values),
  };
}

function ssimImage(region) {
  const rgba = new Uint8ClampedArray(region.data.length * 4);
  for (let index = 0; index < region.data.length; index++) {
    const value = region.data[index];
    const offset = index * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  return { data: rgba, width: region.width, height: region.height };
}

function rowFor(index, sample, target) {
  const step = REFINEMENT_PLAN[index];
  const filter = step.paintFilter ?? {};
  const photoMeanErrorPct = errorPct(sample.photo.mean, target.photo.mean);
  const photoSpreadErrorPct = errorPct(sample.photo.stdev, target.photo.stdev);
  return {
    page: index + 1,
    exposure: filter.exposure ?? null,
    highlights: filter.highlights ?? null,
    shadows: filter.shadows ?? null,
    rampRmse: +rmse(sample.ramp.values, target.ramp.values).toFixed(2),
    rampMeanErrorPct: +errorPct(sample.ramp.mean, target.ramp.mean).toFixed(2),
    rampSpreadErrorPct: +errorPct(sample.ramp.stdev, target.ramp.stdev).toFixed(2),
    photoMean: +sample.photo.mean.toFixed(2),
    photoMeanErrorPct: +photoMeanErrorPct.toFixed(2),
    photoSpread: +sample.photo.stdev.toFixed(2),
    photoSpreadErrorPct: +photoSpreadErrorPct.toFixed(2),
    photoStatsScore: +Math.hypot(photoMeanErrorPct, photoSpreadErrorPct).toFixed(2),
    photoSsim: +ssim(
      ssimImage(sample.photo),
      ssimImage(target.photo),
    ).mssim.toFixed(4),
  };
}

async function main() {
  const pdf = process.argv[2];
  if (!pdf) {
    console.error('usage: measure-paint-filter-tone-refinement-probe.mjs <reference.pdf>');
    process.exit(1);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'tone-refinement-measure-'));
  try {
    execFileSync('pdftoppm', ['-png', '-r', '72', pdf, join(scratch, 'page')], {
      stdio: 'pipe',
    });
    const pages = readdirSync(scratch)
      .filter((name) => name.startsWith('page-') && name.endsWith('.png'))
      .sort();
    if (pages.length !== REFINEMENT_PLAN.length) {
      throw new Error(`expected ${REFINEMENT_PLAN.length} pages, got ${pages.length}`);
    }

    const samples = [];
    for (const page of pages) {
      const path = join(scratch, page);
      samples.push({
        ramp: await readRamp(path),
        photo: await readPhoto(path),
      });
    }

    const target = samples[0];
    const rows = samples.slice(1).map((sample, offset) =>
      rowFor(offset + 1, sample, target));
    const baseline = rows[0];
    const candidates = rows.slice(1);

    console.log('Target and current baseline:');
    console.table([
      {
        page: 1,
        setting: 'Chromium CSS target',
        rampMean: +target.ramp.mean.toFixed(2),
        rampSpread: +target.ramp.stdev.toFixed(2),
        photoMean: +target.photo.mean.toFixed(2),
        photoSpread: +target.photo.stdev.toFixed(2),
      },
      {
        ...baseline,
        setting: 'current native mapping',
      },
    ]);

    console.log('\nBest photo mean/spread matches (crop and mask still differ):');
    console.table(
      [...candidates]
        .sort((a, b) => a.photoStatsScore - b.photoStatsScore)
        .slice(0, 12),
    );

    console.log('\nBest transfer-curve matches (crop and mask independent):');
    console.table(
      [...candidates]
        .sort((a, b) => a.rampRmse - b.rampRmse)
        .slice(0, 12),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('measure-paint-filter-tone-refinement-probe.mjs')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
