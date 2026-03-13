import { writeFileSync, existsSync } from 'fs';
import sharp from 'sharp';
import { ssim } from 'ssim.js';
import { FigDeck } from '../fig-deck.mjs';
import { slideToSvg } from './svg-builder.mjs';
import { svgToPng } from './deck-rasterizer.mjs';

export const RENDER_W = 1920;
export const RENDER_H = 1080;
const THUMB_W = 800;

export async function toRgbaBuffer(source, width = RENDER_W, height = RENDER_H) {
  const buf = await sharp(source)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return { data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength), width, height };
}

export async function computeSsim(rendered, refPath, width = RENDER_W, height = RENDER_H) {
  const [a, b] = await Promise.all([
    toRgbaBuffer(rendered, width, height),
    toRgbaBuffer(refPath, width, height),
  ]);
  const { mssim } = ssim(a, b);
  return mssim;
}

async function pngToDataUri(buf) {
  const thumb = await sharp(buf).resize(THUMB_W, null, { fit: 'inside' }).png().toBuffer();
  return `data:image/png;base64,${thumb.toString('base64')}`;
}

async function refToDataUri(refPath) {
  const thumb = await sharp(refPath).resize(THUMB_W, null, { fit: 'inside' }).png().toBuffer();
  return `data:image/png;base64,${thumb.toString('base64')}`;
}

export async function buildReportRow({ slideNumber, renderedPng, refPath, score, scoreStr }) {
  const renderUri = await pngToDataUri(Buffer.from(renderedPng));
  let refUri = null;
  let resolvedScoreStr = scoreStr ?? '—';

  if (refPath && existsSync(refPath)) {
    refUri = await refToDataUri(refPath);
    if (typeof score === 'number') {
      resolvedScoreStr = score.toFixed(4);
    } else if (scoreStr == null) {
      const computedScore = await computeSsim(Buffer.from(renderedPng), refPath);
      resolvedScoreStr = computedScore.toFixed(4);
    }
  }

  return { n: slideNumber, scoreStr: resolvedScoreStr, renderUri, refUri };
}

export function writeRenderReport({ outHtml, rows, title = 'FigmaTK Render Report' }) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111; color: #eee; margin: 0; padding: 16px; }
  h1   { font-size: 1.2rem; margin: 0 0 16px; color: #aaa; }
  .slide-row { display: flex; gap: 12px; margin-bottom: 24px; align-items: flex-start; }
  .panel { flex: 1; }
  .panel label { display: block; font-size: 0.75rem; color: #888; margin-bottom: 4px; }
  .panel img { width: 100%; border-radius: 4px; border: 1px solid #333; display: block; }
  .score { margin-top: 6px; font-size: 1.1rem; font-weight: bold; font-variant-numeric: tabular-nums; text-align: center; }
  .score.good { color: #6f6; }
  .score.bad  { color: #f66; }
  h2 { font-size: 0.95rem; margin: 0 0 8px; }
  .slide-block { margin-bottom: 32px; }
</style>
</head>
<body>
<h1>${title} — ${new Date().toISOString().slice(0,16).replace('T',' ')}</h1>
${rows.map(({ n, scoreStr, renderUri, refUri }) => {
  const ok = parseFloat(scoreStr) >= 0.70;
  const ssimHtml = scoreStr === '—' ? '' : `<div class="score ${ok ? 'good' : 'bad'}">SSIM ${scoreStr}</div>`;
  return `
<div class="slide-block">
  <h2>Slide ${n}</h2>
  <div class="slide-row">
    <div class="panel">
      <label>Reference (Figma export)</label>
      ${refUri ? `<img src="${refUri}" alt="reference ${n}"/>` : '<em style="color:#555">no reference</em>'}
    </div>
    <div class="panel">
      <label>Rendered (figmatk)</label>
      <img src="${renderUri}" alt="rendered ${n}"/>
      ${ssimHtml}
    </div>
  </div>
</div>`;
}).join('')}
</body>
</html>`;

  writeFileSync(outHtml, html);
}

export async function generateRenderReportFromDeck({ deckPath, refDir, outHtml, title = 'FigmaTK Render Report', log = console.log }) {
  log('Loading deck…');
  const deck = await FigDeck.fromDeckFile(deckPath);
  const slides = deck.getActiveSlides();
  log(`${slides.length} slides`);

  const rows = [];
  for (let i = 0; i < slides.length; i++) {
    const n = i + 1;
    const refPath = `${refDir}/page-${n}.png`;
    const slide = slides[i];

    process.stdout.write(`  Rendering slide ${n}… `);
    const svg = slideToSvg(deck, slide);
    const png = await svgToPng(svg, {});
    const row = await buildReportRow({ slideNumber: n, renderedPng: Buffer.from(png), refPath });
    rows.push(row);
    process.stdout.write(row.scoreStr === '—' ? 'SSIM=—' : `SSIM=${row.scoreStr}`);
    process.stdout.write('\n');
  }

  writeRenderReport({ outHtml, rows, title });
}
