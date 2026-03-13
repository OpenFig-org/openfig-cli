import { writeFileSync, existsSync } from 'fs';
import sharp from 'sharp';
import { ssim } from 'ssim.js';
import { FigDeck } from '../core/fig-deck.mjs';
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

/** Composite reference + inverted render at 50% to produce a diff overlay PNG buffer. */
async function buildOverlayPng(renderedPng, refPath) {
  const [refRaw, renRaw] = await Promise.all([
    sharp(refPath).resize(RENDER_W, RENDER_H, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(renderedPng).resize(RENDER_W, RENDER_H, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  const { width, height } = refRaw.info;
  const out = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const o = p * 4;
    out[o]   = Math.round(refRaw.data[o]   * 0.5 + (255 - renRaw.data[o])   * 0.5);
    out[o+1] = Math.round(refRaw.data[o+1] * 0.5 + (255 - renRaw.data[o+1]) * 0.5);
    out[o+2] = Math.round(refRaw.data[o+2] * 0.5 + (255 - renRaw.data[o+2]) * 0.5);
    out[o+3] = 255;
  }
  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

export async function buildReportRow({ slideNumber, renderedPng, refPath, score, scoreStr }) {
  const renderBuf = Buffer.from(renderedPng);
  const renderUri = await pngToDataUri(renderBuf);
  const renderMeta = await sharp(renderBuf).metadata();
  const renderDims = `${renderMeta.width} × ${renderMeta.height}`;
  let refUri = null;
  let refDims = null;
  let overlayUri = null;
  let resolvedScoreStr = scoreStr ?? '—';

  if (refPath && existsSync(refPath)) {
    refUri = await refToDataUri(refPath);
    const refMeta = await sharp(refPath).metadata();
    refDims = `${refMeta.width} × ${refMeta.height}`;
    if (typeof score === 'number') {
      resolvedScoreStr = score.toFixed(4);
    } else if (scoreStr == null) {
      const computedScore = await computeSsim(renderBuf, refPath);
      resolvedScoreStr = computedScore.toFixed(4);
    }
    // Build flattened overlay
    const overlayBuf = await buildOverlayPng(renderBuf, refPath);
    overlayUri = await pngToDataUri(overlayBuf);
  }

  return { n: slideNumber, scoreStr: resolvedScoreStr, renderUri, renderDims, refUri, refDims, overlayUri };
}

export function writeRenderReport({ outHtml, rows, title = 'FigmaTK Render Report' }) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${title}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:system-ui,sans-serif;background:#111;color:#eee;padding:20px}
  h1{font-size:1.2rem;margin:0 0 4px;color:#ccc}
  .meta{color:#888;margin-bottom:24px;font-size:14px}
  .slide-block{margin-bottom:40px;background:#1a1a1a;border-radius:8px;padding:16px}
  .slide-block h2{font-size:16px;margin-bottom:12px;border-bottom:1px solid #333;padding-bottom:6px}
  .slide-row{display:flex;gap:12px}
  .panel{flex:1;min-width:0}
  .panel label{display:block;font-size:12px;color:#888;margin-bottom:4px}
  .panel img{width:100%;display:block;border:1px solid #333;border-radius:4px;cursor:zoom-in}
  .dims{font-size:11px;color:#666;text-align:center;margin-top:4px;font-variant-numeric:tabular-nums}
  .ssim{float:right;font-size:14px;padding:2px 10px;border-radius:4px;font-weight:bold}
  .ssim.good{background:#2d5;color:#000}
  .ssim.ok{background:#fa0;color:#000}
  .ssim.bad{background:#f44;color:#fff}
  .lightbox{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.92);z-index:999;cursor:zoom-out;justify-content:center;align-items:center}
  .lightbox.active{display:flex}
  .lightbox img{max-width:95vw;max-height:95vh;object-fit:contain}
</style>
</head>
<body>
<div class="lightbox" id="lb" onclick="this.classList.remove('active')"><img id="lb-img"></div>
<script>
document.addEventListener("click",function(e){
  var t=e.target;
  if(t.tagName!=="IMG"||!t.closest(".panel"))return;
  e.stopPropagation();
  document.getElementById("lb-img").src=t.src;
  document.getElementById("lb").classList.add("active");
});
</script>
<h1>${title}</h1>
<p class="meta">${new Date().toISOString().slice(0,16).replace('T',' ')}</p>
${rows.map(({ n, scoreStr, renderUri, renderDims, refUri, refDims, overlayUri }) => {
  const v = parseFloat(scoreStr);
  const cls = isNaN(v) ? '' : v >= 0.98 ? 'good' : v >= 0.90 ? 'ok' : 'bad';
  const ssimHtml = scoreStr === '—' ? '' : `<span class="ssim ${cls}">SSIM: ${scoreStr}</span>`;
  return `
<div class="slide-block">
  <h2>Slide ${n} ${ssimHtml}</h2>
  <div class="slide-row">
    <div class="panel">
      <label>Reference (Figma)</label>
      ${refUri ? `<img src="${refUri}" alt="reference ${n}"/>` : '<em style="color:#555">no reference</em>'}
      ${refDims ? `<div class="dims">${refDims} px</div>` : ''}
    </div>
    <div class="panel">
      <label>FigmaTK Render</label>
      <img src="${renderUri}" alt="rendered ${n}"/>
      <div class="dims">${renderDims} px</div>
    </div>
    <div class="panel">
      <label>Overlay (differences glow)</label>
      ${overlayUri ? `<img src="${overlayUri}" alt="overlay ${n}"/>` : '<em style="color:#555">no overlay</em>'}
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
  for (let n = 1; n <= slides.length; n++) {
    const refPath = `${refDir}/page-${n}.png`;
    const slide = deck.getSlide(n);

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
