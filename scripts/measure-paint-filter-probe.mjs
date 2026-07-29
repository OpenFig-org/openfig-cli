#!/usr/bin/env node
/**
 * Measure native `paintFilter` transfer functions from a reference PDF.
 *
 * Companion to build-paint-filter-probe.mjs. That script writes 21 slides, each
 * a 32-band grey ramp carrying one filter value; this one reads each band back
 * out of the PDF and prints the transfer function, plus the table to paste into
 * `element-dispatch.mjs`.
 *
 * Why this instrument. Mean luminance calibrated exposure adequately and told us
 * nothing about contrast, which changes spread rather than average — the old
 * sweep read 69.8, 68.0, 61.3, 62.0, 62.2. Reading a ramp band by band measures
 * the thing directly: input level is known by position, output is the pixel
 * value there.
 *
 * Usage:
 *   node scripts/measure-paint-filter-probe.mjs <exported.pdf>
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

export const BANDS = 32;
// Must match the probe. Slide coordinates are 1920x1080.
const RAMP = { x: 160, y: 380, w: 1600, h: 500 };
const SLIDE = { w: 1920, h: 1080 };

const CONTRAST_VALUES = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
const EXPOSURE_VALUES = [-1, -0.75, -0.5, -0.25, 0, 0.125, 0.25, 0.375, 0.5, 0.75, 1];

/** The level the probe painted into band i. */
export const inputLevel = (i) => Math.round(8 + (i / (BANDS - 1)) * 239);

/**
 * Mean grey of each band, read from the middle of the band and the middle
 * of the ramp's height.
 *
 * Sampled well inside each band rather than across it: a PDF rasterised at any
 * dpi resamples, and band edges are where that shows. The middle 60% is flat
 * under any sane resampler.
 */
export async function readBands(pngPath) {
  const img = sharp(pngPath);
  const meta = await img.metadata();
  const sx = meta.width / SLIDE.w;
  const sy = meta.height / SLIDE.h;
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const bandW = RAMP.w / BANDS;
  const out = [];
  for (let b = 0; b < BANDS; b++) {
    const x0 = Math.round((RAMP.x + b * bandW + bandW * 0.2) * sx);
    const x1 = Math.round((RAMP.x + b * bandW + bandW * 0.8) * sx);
    const y0 = Math.round((RAMP.y + RAMP.h * 0.2) * sy);
    const y1 = Math.round((RAMP.y + RAMP.h * 0.8) * sy);
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * info.width + x) * ch;
        sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
        n += 1;
      }
    }
    out.push(n ? sum / n : NaN);
  }
  return out;
}

/**
 * Fit output = slope * (input - pivot) + pivot over the unclipped bands.
 *
 * A contrast control is a linear stretch about some pivot. Fitting slope and
 * pivot describes it in two numbers that can be inverted for any CSS value,
 * instead of a lookup table that has to be interpolated. Clipped bands are
 * excluded: they carry no information about the slope, and including them drags
 * the fit toward 1.
 */
export function fitLinear(inputs, outputs) {
  const pts = inputs
    .map((x, i) => [x, outputs[i]])
    .filter(([, y]) => Number.isFinite(y) && y > 3 && y < 252);
  if (pts.length < 4) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  const slope = den ? num / den : 1;
  // y = slope*x + c, and the pivot is where y == x.
  const c = my - slope * mx;
  const pivot = slope === 1 ? NaN : c / (1 - slope);
  return { slope: +slope.toFixed(4), pivot: +pivot.toFixed(1), used: n };
}

async function main() {
  const pdf = process.argv[2];
  if (!pdf) {
    console.error('usage: measure-paint-filter-probe.mjs <exported.pdf>');
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), 'probe-measure-'));
  try {
    execFileSync('pdftoppm', ['-png', '-r', '72', pdf, join(dir, 'p')], { stdio: 'pipe' });
    const pages = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    const expected = 1 + CONTRAST_VALUES.length + EXPOSURE_VALUES.length;
    if (pages.length !== expected) {
      console.error(`expected ${expected} pages, got ${pages.length} — is this the probe export?`);
      process.exit(1);
    }

    const inputs = Array.from({ length: BANDS }, (_, i) => inputLevel(i));
    const reference = await readBands(join(dir, pages[0]));

    console.log('Reference ramp, as exported (input -> output):');
    console.log('  ' + inputs.map((x, i) => `${x}:${reference[i].toFixed(0)}`).join(' '));
    const refFit = fitLinear(inputs, reference);
    console.log(`  reference fit: slope ${refFit?.slope} pivot ${refFit?.pivot}`);
    console.log('  (a slope far from 1.0 here means the PDF pipeline itself is not linear,');
    console.log('   and every number below is relative to this rather than to sRGB)\n');

    const report = (label, values, startPage) => {
      console.log(`=== ${label}`);
      const rows = [];
      for (const [i, v] of values.entries()) {
        rows.push({ value: v, page: startPage + i });
      }
      return (async () => {
        const table = [];
        for (const r of rows) {
          const bands = await readBands(join(dir, pages[r.page - 1]));
          const fit = fitLinear(inputs, bands);
          const meanRatio = bands.reduce((s, b) => s + b, 0)
            / reference.reduce((s, b) => s + b, 0);
          table.push({
            [label.split(' ')[0]]: r.value,
            slope: fit?.slope ?? null,
            pivot: fit?.pivot ?? null,
            meanRatio: +meanRatio.toFixed(4),
            clippedBands: bands.filter((b) => b <= 3 || b >= 252).length,
          });
        }
        console.table(table);
        return table;
      })();
    };

    const contrast = await report('contrast sweep', CONTRAST_VALUES, 2);
    const exposure = await report('exposure sweep', EXPOSURE_VALUES, 2 + CONTRAST_VALUES.length);

    console.log('\n--- CONTRAST_CURVE for element-dispatch.mjs');
    console.log('// (figma contrast, measured slope) — CSS contrast(c) has slope c about 127.5');
    console.log('const CONTRAST_CURVE = [');
    for (const r of contrast) console.log(`  [${r.contrast}, ${r.slope}],`);
    console.log('];');

    console.log('\n--- EXPOSURE_CURVE for element-dispatch.mjs');
    console.log('// (figma exposure, luminance as a multiple of unadjusted)');
    console.log('const EXPOSURE_CURVE = [');
    for (const r of exposure) console.log(`  [${r.exposure}, ${r.meanRatio}],`);
    console.log('];');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Only when run as a script: the test imports readBands/fitLinear.
if (process.argv[1] && process.argv[1].endsWith('measure-paint-filter-probe.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
