/**
 * .fig (Figma Design) render quality tests — render frames from Design files
 * and compare against Figma reference PNGs using SSIM.
 *
 * Fixtures:  figs/reference/
 * Report:    /tmp/figmatk-render-report-fig.html
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { frameToSvg } from '../../lib/rasterizer/svg-builder.mjs';
import { nid } from '../../lib/core/node-helpers.mjs';
import { svgToPng } from '../../lib/rasterizer/deck-rasterizer.mjs';
import { buildReportRow, writeRenderReport, computeSsim } from '../../lib/rasterizer/render-report-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_OUT = '/private/tmp/figmatk-render-report-fig.html';

// Universal quality gates — three complementary metrics:
//   SSIM ≥ 0.90       global perceptual similarity (catches missing/shifted content)
//   meanDelta ≤ 10.0   average per-pixel deviation (catches severity SSIM downweights)
//   offDelta ≤ 130     mean severity among divergent pixels (anti-aliasing ≈ 20–90, shadow filters ≈ 100–130, missing content ≈ 150+)
const DEFAULT_MIN_SSIM = 0.90;
const DEFAULT_MAX_MEAN_DELTA = 10.0;
const DEFAULT_MAX_OFF_DELTA = 130;

const FIG_PATH = join(__dirname, '../../figs/reference/medium-complex.fig');
const FIG_REF  = join(__dirname, '../../figs/reference/medium-complex');

const CLIP_TEST_PATH = join(__dirname, '../../figs/reference/clip-test.fig');
const CLIP_TEST_REF  = join(__dirname, '../../figs/reference/clip-test');

const BASIC_SHAPES_PATH = join(__dirname, '../../figs/reference/basic-shapes.fig');
const BASIC_SHAPES_REF  = join(__dirname, '../../figs/reference/basic-shapes');

const reportRows = [];

describe('medium-complex.fig frame rendering', () => {
  let fig;

  it('loads .fig file', async () => {
    fig = await FigDeck.fromDeckFile(FIG_PATH);
    expect(fig.getPages().length).toBe(3);
  });

  const expectedFrames = [
    { page: 'Great Seal Page', frame: 'GreatSeal' },
    { page: 'Page 2', frame: 'how-to' },
    { page: 'Page 2', frame: 'Lady' },
    { page: 'Page 3', frame: 'User Bio' },
    { page: 'Page 3', frame: 'bike lady' },
  ];

  for (const { page, frame } of expectedFrames) {
    it(`${page} / ${frame} renders`, async () => {
      if (!fig) fig = await FigDeck.fromDeckFile(FIG_PATH);

      const pageNode = fig.getPages().find(p => p.name === page);
      const frameNode = fig.getChildren(nid(pageNode))
        .filter(c => c.phase !== 'REMOVED' && c.type === 'FRAME')
        .find(c => c.name === frame);
      expect(frameNode).toBeTruthy();

      const svg = frameToSvg(fig, frameNode);
      const png = await svgToPng(svg, { background: 'rgba(0,0,0,0)' });
      const pngBuf = Buffer.from(png);
      const slug = `${page}-${frame}`.replace(/\s+/g, '_').toLowerCase();
      const outPath = join('/tmp', `figmatk-test-fig-${slug}.png`);
      writeFileSync(outPath, pngBuf);

      const refPath = join(FIG_REF, `${slug}.png`);
      if (existsSync(refPath)) {
        const score = await computeSsim(pngBuf, refPath);
        const row = await buildReportRow({ slideNumber: `fig:${frame}`, renderedPng: pngBuf, refPath, score });
        reportRows.push(row);
        console.log(`  ${page}/${frame}  SSIM=${score.toFixed(4)}  Δ${row.meanDelta}  offΔ=${row.offDelta}  →  ${outPath}`);
        expect(score).toBeGreaterThanOrEqual(DEFAULT_MIN_SSIM);
        expect(row.meanDelta).toBeLessThanOrEqual(DEFAULT_MAX_MEAN_DELTA);
        expect(row.offDelta).toBeLessThanOrEqual(DEFAULT_MAX_OFF_DELTA);
      } else {
        // No reference yet — just include in report for visual review
        reportRows.push(await buildReportRow({ slideNumber: `fig:${frame}`, renderedPng: pngBuf, refPath: null }));
        console.log(`  ${page}/${frame}  (no ref)  →  ${outPath}`);
      }
    });
  }
});

describe('clip-test.fig frame clipping', () => {
  const clipFrames = [
    { frame: 'clip_on', ref: 'clip_on.png' },
    { frame: 'clip_off', ref: 'clip_off.png' },
  ];

  for (const { frame, ref } of clipFrames) {
    it(`${frame} renders`, async () => {
      const fig = await FigDeck.fromDeckFile(CLIP_TEST_PATH);
      const page = fig.getPages()[0];
      const frameNode = fig.getChildren(nid(page))
        .filter(c => c.phase !== 'REMOVED' && c.type === 'FRAME')
        .find(c => c.name === frame);
      expect(frameNode).toBeTruthy();

      const svg = frameToSvg(fig, frameNode);
      const png = await svgToPng(svg, { background: 'rgba(0,0,0,0)' });
      const pngBuf = Buffer.from(png);
      const refPath = join(CLIP_TEST_REF, ref);
      const score = await computeSsim(pngBuf, refPath);
      const row = await buildReportRow({ slideNumber: `clip:${frame}`, renderedPng: pngBuf, refPath, score });
      reportRows.push(row);
      console.log(`  ${frame}  SSIM=${score.toFixed(4)}  Δ${row.meanDelta}  offΔ=${row.offDelta}`);
      expect(score).toBeGreaterThanOrEqual(DEFAULT_MIN_SSIM);
      expect(row.meanDelta).toBeLessThanOrEqual(DEFAULT_MAX_MEAN_DELTA);
      expect(row.offDelta).toBeLessThanOrEqual(DEFAULT_MAX_OFF_DELTA);
    });
  }
});

describe('basic-shapes.fig rendering (STAR, POLYGON)', () => {
  it('basic_shapes renders', async () => {
    const fig = await FigDeck.fromDeckFile(BASIC_SHAPES_PATH);
    const page = fig.getPages()[0];
    const frameNode = fig.getChildren(nid(page))
      .filter(c => c.phase !== 'REMOVED' && c.type === 'FRAME')
      .find(c => c.name === 'basic_shapes');
    expect(frameNode).toBeTruthy();

    const svg = frameToSvg(fig, frameNode);
    const png = await svgToPng(svg, { background: 'rgba(0,0,0,0)' });
    const pngBuf = Buffer.from(png);
    const refPath = join(BASIC_SHAPES_REF, 'basic_shapes.png');
    const score = await computeSsim(pngBuf, refPath);
    const row = await buildReportRow({ slideNumber: 'shapes', renderedPng: pngBuf, refPath, score });
    reportRows.push(row);
    console.log(`  basic_shapes  SSIM=${score.toFixed(4)}  Δ${row.meanDelta}  offΔ=${row.offDelta}`);
    expect(score).toBeGreaterThanOrEqual(DEFAULT_MIN_SSIM);
    expect(row.meanDelta).toBeLessThanOrEqual(DEFAULT_MAX_MEAN_DELTA);
    expect(row.offDelta).toBeLessThanOrEqual(DEFAULT_MAX_OFF_DELTA);
  });
});

afterAll(() => {
  if (!reportRows.length) return;
  writeRenderReport({ outHtml: REPORT_OUT, rows: reportRows, title: 'FigmaTK Design Render Report' });
  console.log(`\nReport → ${REPORT_OUT}`);
});
