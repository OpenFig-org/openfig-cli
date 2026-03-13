#!/usr/bin/env node
/**
 * Generate an HTML visual comparison report: reference vs rendered, side-by-side.
 *
 * Usage:
 *   node lib/rasterizer/render-report.mjs [file.deck] [ref-dir] [output.html]
 *
 * Defaults:
 *   deck    = decks/reference/oil-machinations.deck
 *   ref-dir = decks/reference/oil-machinations/
 *   output  = /tmp/figmatk-render-report.html
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { ssim } from 'ssim.js';
import { FigDeck } from '../fig-deck.mjs';
import { slideToSvg } from './svg-builder.mjs';
import { svgToPng } from './deck-rasterizer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const [,, deckArg, refDirArg, outArg] = process.argv;
const DECK_PATH = resolve(deckArg  ?? join(__dirname, '../../decks/reference/oil-machinations.deck'));
const REF_DIR   = resolve(refDirArg ?? join(__dirname, '../../decks/reference/oil-machinations'));
const OUT_HTML  = outArg ?? '/tmp/figmatk-render-report.html';
const RENDER_W  = 1920;
const RENDER_H  = 1080;
const THUMB_W   = 800; // display width in HTML

async function toRgbaBuffer(buf, w, h) {
  const raw = await sharp(buf).resize(w, h, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  return { data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength), width: w, height: h };
}

async function pngToDataUri(buf) {
  const thumb = await sharp(buf).resize(THUMB_W, null, { fit: 'inside' }).png().toBuffer();
  return `data:image/png;base64,${thumb.toString('base64')}`;
}

async function refToDataUri(refPath) {
  const thumb = await sharp(refPath).resize(THUMB_W, null, { fit: 'inside' }).png().toBuffer();
  return `data:image/png;base64,${thumb.toString('base64')}`;
}

console.log('Loading deck…');
const deck   = await FigDeck.fromDeckFile(DECK_PATH);
const slides = deck.getActiveSlides();
console.log(`${slides.length} slides`);

const rows = [];
for (let i = 0; i < slides.length; i++) {
  const n        = i + 1;
  const refPath  = join(REF_DIR, `page-${n}.png`);
  const slide    = slides[i];

  process.stdout.write(`  Rendering slide ${n}… `);
  const svg  = slideToSvg(deck, slide);
  const png  = await svgToPng(svg, {});

  let scoreStr = '—';
  if (existsSync(refPath)) {
    const [a, b] = await Promise.all([
      toRgbaBuffer(Buffer.from(png), RENDER_W, RENDER_H),
      toRgbaBuffer(refPath,          RENDER_W, RENDER_H),
    ]);
    const { mssim } = ssim(a, b);
    scoreStr = mssim.toFixed(4);
    process.stdout.write(`SSIM=${scoreStr}`);
  }
  console.log();

  const renderUri = await pngToDataUri(Buffer.from(png));
  const refUri    = existsSync(refPath) ? await refToDataUri(refPath) : null;

  rows.push({ n, scoreStr, renderUri, refUri });
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>FigmaTK Render Report</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111; color: #eee; margin: 0; padding: 16px; }
  h1   { font-size: 1.2rem; margin: 0 0 16px; color: #aaa; }
  .slide-row { display: flex; gap: 12px; margin-bottom: 24px; align-items: flex-start; }
  .panel { flex: 1; }
  .panel label { display: block; font-size: 0.75rem; color: #888; margin-bottom: 4px; }
  .panel img { width: 100%; border-radius: 4px; border: 1px solid #333; display: block; }
  .score { font-size: 0.9rem; font-weight: bold; padding: 2px 8px; border-radius: 4px; }
  .score.good { background: #1a4a1a; color: #6f6; }
  .score.bad  { background: #4a1a1a; color: #f66; }
  h2 { font-size: 0.95rem; margin: 0 0 8px; display: flex; gap: 10px; align-items: center; }
  .slide-block { margin-bottom: 32px; }
</style>
</head>
<body>
<h1>FigmaTK Render Report — ${new Date().toISOString().slice(0,16).replace('T',' ')}</h1>
${rows.map(({ n, scoreStr, renderUri, refUri }) => {
  const ok    = parseFloat(scoreStr) >= 0.70;
  const badge = scoreStr === '—' ? '' : `<span class="score ${ok ? 'good' : 'bad'}">SSIM ${scoreStr}</span>`;
  return `
<div class="slide-block">
  <h2>Slide ${n} ${badge}</h2>
  <div class="slide-row">
    <div class="panel">
      <label>Reference (Figma export)</label>
      ${refUri ? `<img src="${refUri}" alt="reference ${n}"/>` : '<em style="color:#555">no reference</em>'}
    </div>
    <div class="panel">
      <label>Rendered (figmatk)</label>
      <img src="${renderUri}" alt="rendered ${n}"/>
    </div>
  </div>
</div>`;
}).join('')}
</body>
</html>`;

writeFileSync(OUT_HTML, html);
console.log(`\nReport → ${OUT_HTML}`);
