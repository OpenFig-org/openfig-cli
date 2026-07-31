#!/usr/bin/env node
/**
 * Measure the public-domain photo generalization probe from a reference PDF.
 *
 * Each page contains the embedded CSS pixel target on the left and the editable
 * native paint-filter result on the right. The control pages quantify export
 * and layout noise; mild and strong pages quantify the actual translation.
 *
 * Usage:
 *   node scripts/measure-paint-filter-stock-probe.mjs reference.pdf \
 *     [--json results.json] [--without-control]
 */
import { execFileSync } from 'child_process';
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import sharp from 'sharp';
import { ssim } from 'ssim.js';
import {
  NATIVE_REGION,
  SLIDE,
  TARGET_REGION,
  probePlanForMode,
  profilesForMode,
} from './build-paint-filter-stock-probe.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function summarize(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce(
    (sum, value) => sum + ((value - mean) ** 2),
    0,
  ) / values.length;
  return { mean, stdev: Math.sqrt(variance) };
}

function errorPct(actual, target) {
  return target === 0 ? 0 : ((actual / target) - 1) * 100;
}

async function region(page, box) {
  const { data, info } = await sharp(page)
    .resize(SLIDE.width, SLIDE.height, { fit: 'fill' })
    .extract({
      left: box.x,
      top: box.y,
      width: box.width,
      height: box.height,
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function luma(rgb) {
  const values = new Float64Array(rgb.data.length / 3);
  for (let source = 0, target = 0; source < rgb.data.length; source += 3, target++) {
    values[target] =
      (0.2126 * rgb.data[source])
      + (0.7152 * rgb.data[source + 1])
      + (0.0722 * rgb.data[source + 2]);
  }
  return summarize(values);
}

function pixelError(actual, target) {
  let absolute = 0;
  let square = 0;
  for (let index = 0; index < actual.data.length; index++) {
    const delta = actual.data[index] - target.data[index];
    absolute += Math.abs(delta);
    square += delta * delta;
  }
  return {
    mae: absolute / actual.data.length,
    rmse: Math.sqrt(square / actual.data.length),
  };
}

function rgba(rgb) {
  const data = new Uint8ClampedArray((rgb.data.length / 3) * 4);
  for (let source = 0, target = 0; source < rgb.data.length; source += 3, target += 4) {
    data[target] = rgb.data[source];
    data[target + 1] = rgb.data[source + 1];
    data[target + 2] = rgb.data[source + 2];
    data[target + 3] = 255;
  }
  return { data, width: rgb.width, height: rgb.height };
}

async function rowFor(page, index, plan) {
  const { profile, source } = plan[index];
  const [target, native] = await Promise.all([
    region(page, TARGET_REGION),
    region(page, NATIVE_REGION),
  ]);
  const targetLuma = luma(target);
  const nativeLuma = luma(native);
  const error = pixelError(native, target);
  return {
    page: index + 1,
    profile: profile.id,
    source: source.id,
    meanErrorPct: +errorPct(nativeLuma.mean, targetLuma.mean).toFixed(2),
    spreadErrorPct: +errorPct(nativeLuma.stdev, targetLuma.stdev).toFixed(2),
    mae: +error.mae.toFixed(2),
    rmse: +error.rmse.toFixed(2),
    ssim: +ssim(rgba(native), rgba(target)).mssim.toFixed(4),
  };
}

function aggregate(rows, profile) {
  const selected = rows.filter((row) => row.profile === profile.id);
  const average = (key) =>
    selected.reduce((sum, row) => sum + row[key], 0) / selected.length;
  return {
    profile: profile.id,
    photos: selected.length,
    meanAbsMeanErrorPct: +average(
      'absoluteMeanErrorPct',
    ).toFixed(2),
    meanAbsSpreadErrorPct: +average(
      'absoluteSpreadErrorPct',
    ).toFixed(2),
    meanRmse: +average('rmse').toFixed(2),
    meanSsim: +average('ssim').toFixed(4),
    worstRmse: +Math.max(...selected.map((row) => row.rmse)).toFixed(2),
  };
}

async function main() {
  const pdf = process.argv[2];
  if (!pdf || pdf.startsWith('-')) {
    throw new Error('usage: measure-paint-filter-stock-probe.mjs <reference.pdf> [--json results.json]');
  }
  const jsonPath = option('--json', '');
  const mode = option('--mode', 'generalization');
  const withoutControl = process.argv.includes('--without-control');
  const profiles = profilesForMode(mode)
    .filter((profile) => !withoutControl || profile.id !== 'control');
  const plan = probePlanForMode(mode)
    .filter(({ profile }) => !withoutControl || profile.id !== 'control');
  const scratch = mkdtempSync(join(tmpdir(), 'paint-filter-stock-measure-'));
  try {
    execFileSync(
      'pdftoppm',
      ['-png', '-r', '72', resolve(pdf), join(scratch, 'page')],
      { stdio: 'pipe' },
    );
    const pages = readdirSync(scratch)
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (pages.length !== plan.length) {
      throw new Error(`expected ${plan.length} pages, got ${pages.length}`);
    }

    const rows = [];
    for (const [index, page] of pages.entries()) {
      const row = await rowFor(join(scratch, page), index, plan);
      rows.push({
        ...row,
        absoluteMeanErrorPct: Math.abs(row.meanErrorPct),
        absoluteSpreadErrorPct: Math.abs(row.spreadErrorPct),
      });
    }
    const summary = profiles.map((profile) => aggregate(rows, profile));

    console.log('Aggregate by profile:');
    console.table(summary);
    for (const profile of profiles) {
      console.log(`\n${profile.label}:`);
      console.table(rows
        .filter((row) => row.profile === profile.id)
        .map(({
          absoluteMeanErrorPct,
          absoluteSpreadErrorPct,
          ...row
        }) => row));
    }

    if (jsonPath) {
      writeFileSync(
        resolve(jsonPath),
        `${JSON.stringify({ summary, rows }, null, 2)}\n`,
      );
      console.log(`\nwrote ${resolve(jsonPath)}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
