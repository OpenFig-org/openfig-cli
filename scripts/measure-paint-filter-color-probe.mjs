#!/usr/bin/env node
/**
 * Measure the compatibility-reference output of the paint-filter vibrance probe.
 *
 * Chroma is `max(R,G,B) - min(R,G,B)`. A truly gray pixel has chroma zero,
 * regardless of which grayscale luminance formula produced it. Neutral patches
 * provide a per-page noise floor for channel imbalance in the PDF pipeline.
 *
 * Usage:
 *   node scripts/measure-paint-filter-color-probe.mjs <exported.pdf>
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import {
  PATCHES,
  PROBE_STEPS,
  SLIDE,
  patchRect,
} from './paint-filter-color-probe-shared.mjs';

const chroma = (rgb) => Math.max(...rgb) - Math.min(...rgb);
const sum = (values) => values.reduce((total, value) => total + value, 0);

/**
 * Read mean RGB from the interior 60% of each color patch.
 *
 * Staying away from the edges prevents PDF rasterisation from mixing adjacent
 * patches. Coordinates are scaled from the deck's 1920x1080 slide space, so
 * the reader remains valid if the PDF is rasterised at a different resolution.
 */
export async function readPatches(pngPath) {
  const image = sharp(pngPath);
  const metadata = await image.metadata();
  const scaleX = metadata.width / SLIDE.w;
  const scaleY = metadata.height / SLIDE.h;
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;

  const results = [];
  for (const [index, patch] of PATCHES.entries()) {
    const rect = patchRect(index);
    const x0 = Math.round((rect.x + rect.w * 0.2) * scaleX);
    const x1 = Math.round((rect.x + rect.w * 0.8) * scaleX);
    const y0 = Math.round((rect.y + rect.h * 0.2) * scaleY);
    const y1 = Math.round((rect.y + rect.h * 0.8) * scaleY);
    const totals = [0, 0, 0];
    let count = 0;

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const offset = (y * info.width + x) * channels;
        totals[0] += data[offset];
        totals[1] += data[offset + 1];
        totals[2] += data[offset + 2];
        count += 1;
      }
    }

    const rgb = totals.map((total) => total / count);
    results.push({
      name: patch.name,
      neutral: patch.neutral,
      rgb,
      chroma: chroma(rgb),
    });
  }
  return results;
}

export function summarizePage(reference, measured) {
  const coloredIndices = PATCHES
    .map((patch, index) => (patch.neutral ? null : index))
    .filter((index) => index !== null);
  const neutralIndices = PATCHES
    .map((patch, index) => (patch.neutral ? index : null))
    .filter((index) => index !== null);
  const referenceChroma = sum(coloredIndices.map((index) => reference[index].chroma));
  const measuredChroma = coloredIndices.map((index) => measured[index].chroma);
  const neutralFloor = Math.max(...neutralIndices.map((index) => measured[index].chroma));

  return {
    meanColoredChroma: sum(measuredChroma) / measuredChroma.length,
    maxColoredChroma: Math.max(...measuredChroma),
    chromaRatio: referenceChroma ? sum(measuredChroma) / referenceChroma : NaN,
    neutralFloor,
  };
}

/**
 * Classify only decisive results. The neutral controls determine the PDF's
 * channel-noise floor; a small fixed allowance covers 8-bit quantisation.
 */
export function classifyDesaturation(summary) {
  const noiseLimit = summary.neutralFloor + 2;
  if (summary.chromaRatio <= 0.01 && summary.maxColoredChroma <= noiseLimit) {
    return {
      status: 'PASS',
      detail: 'vibrance -1 is full desaturation within PDF measurement noise',
    };
  }
  if (summary.chromaRatio >= 0.03 || summary.maxColoredChroma >= noiseLimit + 3) {
    return {
      status: 'FAIL',
      detail: 'vibrance -1 leaves measurable chroma',
    };
  }
  return {
    status: 'INCONCLUSIVE',
    detail: 'residual chroma is too close to the PDF noise floor to classify',
  };
}

async function main() {
  const pdf = process.argv[2];
  if (!pdf) {
    console.error('usage: measure-paint-filter-color-probe.mjs <exported.pdf>');
    process.exit(1);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'vibrance-measure-'));
  try {
    execFileSync('pdftoppm', ['-png', '-r', '72', pdf, join(tempDir, 'page')], {
      stdio: 'pipe',
    });
    const pages = readdirSync(tempDir)
      .filter((file) => file.endsWith('.png'))
      .sort();
    if (pages.length !== PROBE_STEPS.length) {
      console.error(
        `expected ${PROBE_STEPS.length} pages, got ${pages.length} — is this the vibrance probe export?`,
      );
      process.exit(1);
    }

    const readings = [];
    for (const page of pages) {
      readings.push(await readPatches(join(tempDir, page)));
    }
    const reference = readings[0];
    const summaries = readings.map((reading) => summarizePage(reference, reading));

    console.log('Vibrance sweep (RGB chroma = max channel - min channel):');
    console.table(summaries.map((summary, index) => ({
      vibrance: PROBE_STEPS[index].value ?? 0,
      meanColoredChroma: +summary.meanColoredChroma.toFixed(2),
      maxColoredChroma: +summary.maxColoredChroma.toFixed(2),
      chromaVsReference: +summary.chromaRatio.toFixed(4),
      neutralNoiseFloor: +summary.neutralFloor.toFixed(2),
    })));

    const lastReading = readings.at(-1);
    console.log('\nPer-patch result at vibrance -1:');
    console.table(lastReading.map((patch) => ({
      patch: patch.name,
      kind: patch.neutral ? 'neutral control' : 'colored',
      R: +patch.rgb[0].toFixed(2),
      G: +patch.rgb[1].toFixed(2),
      B: +patch.rgb[2].toFixed(2),
      chroma: +patch.chroma.toFixed(2),
    })));

    const result = classifyDesaturation(summaries.at(-1));
    console.log(`\n${result.status}: ${result.detail}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('measure-paint-filter-color-probe.mjs')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
