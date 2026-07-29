#!/usr/bin/env node
/**
 * Compare the filtered photo regions in a compatibility-reference output against the Claude
 * Design ground truth.
 *
 * The end-to-end check on the paintFilter calibration. The calibration itself is
 * measured against a ramp (build-paint-filter-probe.mjs), which establishes what
 * Figma's controls do; this establishes whether the *mapping* from CSS lands in
 * the right place on a real slide, with a real photograph, under a real blend.
 *
 * Both regions carry `mix-blend-mode: multiply`, so a difference here is the sum
 * of the filter mapping and any difference in how the two renderers composite.
 * That is deliberate: it is the number a viewer actually sees. When it
 * disagrees with the ramp calibration, the blend is the next suspect.
 *
 * The two PDFs have different page sizes — Claude Design exports 720pt, Figma
 * 1920pt — so each is rendered at the dpi that brings it to the same pixel
 * width. Rendering both at one dpi compares different scales and says nothing.
 *
 * Usage:
 *   node scripts/measure-filtered-regions.mjs <compatibility-reference.pdf> [ground-truth.pdf]
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GT = join(HERE, '..', 'test', 'fixtures', 'standalone-html',
  'the-carbon-question', 'The-Carbon-Question.claude-design.pdf');

/** Filtered image regions, in 1920x1080 slide coordinates. */
const REGIONS = [
  { slide: 1, name: 'portrait crop', x: 1620, y: 0, w: 300, h: 309 },
  { slide: 7, name: 'photo band', x: 0, y: 780, w: 1920, h: 300 },
];

const SLIDE = { w: 1920, h: 1080 };
/** Common width both PDFs are rendered to. */
const TARGET_W = 1920;

function renderPages(pdf, dir, prefix) {
  const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
  const m = info.match(/Page size:\s+([\d.]+) x ([\d.]+)/);
  if (!m) throw new Error(`could not read page size from ${pdf}`);
  const ptW = parseFloat(m[1]);
  // pdftoppm's -r is dpi against a 72pt inch.
  const dpi = Math.round((TARGET_W / ptW) * 72);
  execFileSync('pdftoppm', ['-png', '-gray', '-r', String(dpi), pdf, join(dir, prefix)],
    { stdio: 'pipe' });
  return readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.png')).sort();
}

/**
 * Mean grey of a region, given in slide coordinates.
 *
 * The ground truth is letterboxed inside a letter page, so its slide box is
 * found by trimming: the content's bounding box is the slide. Without that the
 * region lands on the margin and reads as paper white.
 */
async function meanOfRegion(pngPath, region) {
  const img = sharp(pngPath);
  const { width, height } = await img.metadata();
  const trimmed = await sharp(pngPath).trim({ threshold: 5 }).toBuffer({ resolveWithObject: true });
  const box = trimmed.info.trimOffsetLeft !== undefined
    ? {
      left: -trimmed.info.trimOffsetLeft,
      top: -trimmed.info.trimOffsetTop,
      width: trimmed.info.width,
      height: trimmed.info.height,
    }
    : { left: 0, top: 0, width, height };
  const sx = box.width / SLIDE.w;
  const sy = box.height / SLIDE.h;
  const left = Math.round(box.left + region.x * sx);
  const top = Math.round(box.top + region.y * sy);
  const w = Math.max(1, Math.round(region.w * sx));
  const h = Math.max(1, Math.round(region.h * sy));
  const clipped = {
    left: Math.max(0, Math.min(left, width - 1)),
    top: Math.max(0, Math.min(top, height - 1)),
    width: Math.min(w, width - Math.max(0, left)),
    height: Math.min(h, height - Math.max(0, top)),
  };
  const stats = await sharp(pngPath).extract(clipped).stats();
  return { mean: stats.channels[0].mean, stdev: stats.channels[0].stdev, box: clipped };
}

async function main() {
  const figma = process.argv[2];
  const gt = process.argv[3] ?? DEFAULT_GT;
  if (!figma) {
    console.error('usage: measure-filtered-regions.mjs <compatibility-reference.pdf> [ground-truth.pdf]');
    process.exit(1);
  }
  if (!existsSync(gt)) {
    console.error(`ground truth not found: ${gt}`);
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), 'regions-'));
  try {
    const figPages = renderPages(figma, dir, 'fg');
    const gtPages = renderPages(gt, dir, 'gt');
    console.log(`compatibility reference: ${figPages.length} pages   ground truth: ${gtPages.length} pages\n`);

    const rows = [];
    for (const r of REGIONS) {
      const fp = figPages[r.slide - 1];
      const gp = gtPages[r.slide - 1];
      if (!fp || !gp) {
        rows.push({ slide: r.slide, region: r.name, note: 'page missing' });
        continue;
      }
      const f = await meanOfRegion(join(dir, fp), r);
      const g = await meanOfRegion(join(dir, gp), r);
      rows.push({
        slide: r.slide,
        region: r.name,
        figma: +f.mean.toFixed(1),
        groundTruth: +g.mean.toFixed(1),
        errorPct: +(((f.mean - g.mean) / g.mean) * 100).toFixed(1),
        figmaStdev: +f.stdev.toFixed(1),
        gtStdev: +g.stdev.toFixed(1),
      });
    }
    console.table(rows);
    console.log('errorPct positive = Figma is brighter than the design.');
    console.log('Before this calibration the photo band read 116.7 against 103.1, i.e. +13.2%.');
    console.log('stdev is the contrast check: a large gap there with a small mean gap');
    console.log('means the exposure landed and the contrast did not.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
