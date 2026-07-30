#!/usr/bin/env node
/**
 * Compare the brightness-only native probe against Chromium's CSS rendering.
 *
 * Direct errors answer what the viewer sees. Effect errors divide each host by
 * its own unfiltered reference first, removing static differences in JPEG
 * colour management, crop, and PDF resampling so the remaining number isolates
 * the filter operation.
 *
 * Usage:
 *   node scripts/measure-paint-filter-brightness-probe.mjs \
 *     <reference.pdf> [ground-truth-dir]
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import sharp from 'sharp';
import { ssim } from 'ssim.js';
import {
  PHOTO,
  PROBE_STEPS,
  SLIDE,
  groundTruthFilename,
} from './paint-filter-brightness-probe-shared.mjs';

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function summarizeLuminance(values) {
  const average = mean(values);
  const variance = values.reduce(
    (total, value) => total + (value - average) ** 2,
    0,
  ) / values.length;
  return {
    mean: average,
    stdev: Math.sqrt(variance),
    clippedHighPct: (values.filter((value) => value >= 254).length / values.length) * 100,
  };
}

/**
 * Read the exact 1920x300 photo band after normalising the page to slide size.
 */
export async function readPhotoRegion(imagePath) {
  const { data, info } = await sharp(imagePath)
    .resize(SLIDE.w, SLIDE.h, { fit: 'fill' })
    .extract({
      left: PHOTO.x,
      top: PHOTO.y,
      width: PHOTO.w,
      height: PHOTO.h,
    })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const values = Array.from(data);
  return {
    data,
    width: info.width,
    height: info.height,
    ...summarizeLuminance(values),
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

export function effectErrorPct(filtered, reference, cssFiltered, cssReference) {
  const nativeEffect = filtered / reference;
  const cssEffect = cssFiltered / cssReference;
  return ((nativeEffect / cssEffect) - 1) * 100;
}

async function main() {
  const pdf = process.argv[2];
  const groundTruthDir = resolve(
    process.argv[3] ?? 'paint-filter-brightness-css-ground-truth',
  );
  if (!pdf) {
    console.error(
      'usage: measure-paint-filter-brightness-probe.mjs <reference.pdf> [ground-truth-dir]',
    );
    process.exit(1);
  }
  for (const [index] of PROBE_STEPS.entries()) {
    const path = join(groundTruthDir, groundTruthFilename(index));
    if (!existsSync(path)) {
      throw new Error(`ground truth is missing: ${path}`);
    }
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'brightness-measure-'));
  try {
    execFileSync('pdftoppm', ['-png', '-r', '72', pdf, join(tempDir, 'native')], {
      stdio: 'pipe',
    });
    const pages = readdirSync(tempDir)
      .filter((file) => file.startsWith('native') && file.endsWith('.png'))
      .sort();
    if (pages.length !== PROBE_STEPS.length) {
      throw new Error(
        `expected ${PROBE_STEPS.length} reference pages, got ${pages.length}`,
      );
    }

    const native = [];
    const css = [];
    for (const [index, page] of pages.entries()) {
      native.push(await readPhotoRegion(join(tempDir, page)));
      css.push(await readPhotoRegion(join(groundTruthDir, groundTruthFilename(index))));
    }

    const rows = PROBE_STEPS.map((step, index) => {
      const f = native[index];
      const c = css[index];
      return {
        brightness: step.brightness,
        exposure: step.exposure ?? 0,
        nativeMean: +f.mean.toFixed(2),
        cssMean: +c.mean.toFixed(2),
        meanVsCssPct: +(((f.mean / c.mean) - 1) * 100).toFixed(2),
        nativeStdev: +f.stdev.toFixed(2),
        cssStdev: +c.stdev.toFixed(2),
        stdevVsCssPct: +(((f.stdev / c.stdev) - 1) * 100).toFixed(2),
        meanEffectErrorPct: +effectErrorPct(
          f.mean,
          native[0].mean,
          c.mean,
          css[0].mean,
        ).toFixed(2),
        spreadEffectErrorPct: +effectErrorPct(
          f.stdev,
          native[0].stdev,
          c.stdev,
          css[0].stdev,
        ).toFixed(2),
        nativeClippedHighPct: +f.clippedHighPct.toFixed(2),
        cssClippedHighPct: +c.clippedHighPct.toFixed(2),
        ssim: +ssim(ssimImage(f), ssimImage(c)).mssim.toFixed(4),
      };
    });

    console.log('Brightness-only comparison (no grayscale, contrast, or blend mode):');
    console.table(rows);
    console.log("\nEffect errors are normalized against each host's unfiltered page.");
    console.log('A negative spreadEffectErrorPct means exposure preserves less');
    console.log('histogram spread than CSS brightness, independent of baseline rendering.');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('measure-paint-filter-brightness-probe.mjs')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
