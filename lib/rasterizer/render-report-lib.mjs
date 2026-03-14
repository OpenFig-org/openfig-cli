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

export async function computeSsim(rendered, refPath, width, height) {
  // Auto-detect from rendered image when no explicit size given —
  // downscale reference to match render, never upscale render
  if (width == null || height == null) {
    const meta = await sharp(rendered).metadata();
    width = meta.width;
    height = meta.height;
  }
  const [a, b] = await Promise.all([
    toRgbaBuffer(rendered, width, height),
    toRgbaBuffer(refPath, width, height),
  ]);
  const { mssim } = ssim(a, b);
  return mssim;
}

async function pngToDataUri(buf) {
  const thumb = await sharp(buf).resize(THUMB_W, null, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return `data:image/png;base64,${thumb.toString('base64')}`;
}

async function refToDataUri(refPath) {
  const thumb = await sharp(refPath).resize(THUMB_W, null, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return `data:image/png;base64,${thumb.toString('base64')}`;
}

const DIFF_THRESHOLD = 10; // max channel delta to count as "off"

/** Composite reference + inverted render at 50% to produce a diff overlay PNG buffer.
 *  Also counts pixels where any channel differs by more than DIFF_THRESHOLD.
 *  Comparison is done at the rendered image's native resolution — the reference is
 *  downscaled to match (consistent with SSIM).  This avoids upscale-blur artefacts
 *  when the reference was exported at a higher DPI than the render. */
async function buildOverlayPng(renderedPng, refPath) {
  const renMeta = await sharp(renderedPng).metadata();
  const ow = renMeta.width, oh = renMeta.height;
  const [refRaw, renRaw] = await Promise.all([
    sharp(refPath).resize(ow, oh, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(renderedPng).resize(ow, oh, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  const { width, height } = refRaw.info;
  const totalPixels = width * height;
  const out = Buffer.alloc(totalPixels * 4);
  let offCount = 0;
  let deltaSum = 0;
  let offDeltaSum = 0;
  for (let p = 0; p < totalPixels; p++) {
    const o = p * 4;
    const dr = Math.abs(refRaw.data[o]   - renRaw.data[o]);
    const dg = Math.abs(refRaw.data[o+1] - renRaw.data[o+1]);
    const db = Math.abs(refRaw.data[o+2] - renRaw.data[o+2]);
    const maxD = Math.max(dr, dg, db);
    if (maxD > DIFF_THRESHOLD) { offCount++; offDeltaSum += maxD; }
    deltaSum += maxD;
    out[o]   = Math.round(refRaw.data[o]   * 0.5 + (255 - renRaw.data[o])   * 0.5);
    out[o+1] = Math.round(refRaw.data[o+1] * 0.5 + (255 - renRaw.data[o+1]) * 0.5);
    out[o+2] = Math.round(refRaw.data[o+2] * 0.5 + (255 - renRaw.data[o+2]) * 0.5);
    out[o+3] = 255;
  }
  const pngBuf = await sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const offPct = (offCount / totalPixels * 100).toFixed(2);
  // meanDelta: average max-channel deviation per pixel (0–255 scale).
  const meanDelta = +(deltaSum / totalPixels).toFixed(2);
  // offDelta: average severity among off pixels only (0–255 scale).
  // Subpixel shift ≈ 12, missing content ≈ 150+.
  const offDelta = offCount > 0 ? +(offDeltaSum / offCount).toFixed(1) : 0;
  return { pngBuf, offCount, offPct, totalPixels, meanDelta, offDelta };
}

export async function buildReportRow({ slideNumber, renderedPng, refPath, score, scoreStr, notes }) {
  const renderBuf = Buffer.from(renderedPng);
  const renderUri = await pngToDataUri(renderBuf);
  const renderMeta = await sharp(renderBuf).metadata();
  const renderDims = `${renderMeta.width} × ${renderMeta.height}`;
  let refUri = null;
  let refDims = null;
  let overlayUri = null;
  let offCount = 0;
  let offPct = '0.00';
  let meanDelta = 0;
  let offDelta = 0;
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
    // Build flattened overlay + pixel diff count
    const overlay = await buildOverlayPng(renderBuf, refPath);
    overlayUri = await pngToDataUri(overlay.pngBuf);
    offCount = overlay.offCount;
    offPct = overlay.offPct;
    meanDelta = overlay.meanDelta;
    offDelta = overlay.offDelta;
  }

  return { n: slideNumber, scoreStr: resolvedScoreStr, renderUri, renderDims, refUri, refDims, overlayUri, offCount, offPct, meanDelta, offDelta, notes: notes ?? null };
}

export function writeRenderReport({ outHtml, rows, title = 'OpenFig Render Report' }) {
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
  .slide-row{display:flex;gap:12px;align-items:flex-start}
  .panel{min-width:0}
  .panel label{display:block;font-size:12px;color:#888;margin-bottom:4px}
  .panel img{max-width:100%;display:block;border:1px solid #333;border-radius:4px;cursor:zoom-in}
  .dims{font-size:11px;color:#666;text-align:center;margin-top:4px;font-variant-numeric:tabular-nums}
  .badge{float:right;font-size:14px;padding:2px 10px;border-radius:4px;font-weight:bold}
  .badge.pass{background:#2d5;color:#000}
  .badge.warn{background:#fa0;color:#000}
  .badge.fail{background:#f44;color:#fff}
  .metrics{margin-top:8px;font-size:12px;font-variant-numeric:tabular-nums}
  .metrics td{padding:1px 8px 1px 0}
  .metrics .label{color:#888}
  .metrics .g{color:#6f6}
  .metrics .y{color:#fa0}
  .metrics .r{color:#f66}
  .notes{margin-top:8px;font-size:12px;color:#999;line-height:1.4;border-left:2px solid #444;padding-left:8px}
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
${rows.map(({ n, scoreStr, renderUri, renderDims, refUri, refDims, overlayUri, offCount, offPct, meanDelta, offDelta, notes }) => {
  const ssim = parseFloat(scoreStr);
  const hasRef = !isNaN(ssim);
  // Visual diff: mean delta as % of max — correlates with human perception
  const visualDiff = (meanDelta / 255 * 100);
  // Three-tier badge: PASS (≥0.99), WARN (≥0.90), FAIL (<0.90)
  const tier = !hasRef ? '' : ssim >= 0.99 ? 'pass' : ssim >= 0.90 ? 'warn' : 'fail';
  const tierLabel = tier === 'pass' ? 'PASS' : tier === 'warn' ? 'WARN' : 'FAIL';
  const badgeHtml = !hasRef ? '' : `<span class="badge ${tier}">${tierLabel}</span>`;
  const ssimCls = !hasRef ? '' : ssim >= 0.99 ? 'g' : ssim >= 0.90 ? 'y' : 'r';
  const diffCls = visualDiff <= 0.5 ? 'g' : visualDiff <= 2.0 ? 'y' : 'r';
  const metricsHtml = !hasRef ? '' : `<table class="metrics">
    <tr><td class="label">SSIM</td><td class="${ssimCls}">${scoreStr}</td></tr>
    <tr><td class="label">Pixels off</td><td>${offCount.toLocaleString()} (${offPct}%)</td></tr>
    <tr><td class="label">Visual diff</td><td class="${diffCls}">${visualDiff.toFixed(2)}%</td></tr>
  </table>`;
  return `
<div class="slide-block">
  <h2>Slide ${n} ${badgeHtml}</h2>
  <div class="slide-row">
    <div class="panel">
      <label>Reference (Figma)</label>
      ${refUri ? `<img src="${refUri}" alt="reference ${n}"/>` : '<em style="color:#555">no reference</em>'}
      ${refDims ? `<div class="dims">${refDims} px</div>` : ''}
    </div>
    <div class="panel">
      <label>OpenFig Render</label>
      <img src="${renderUri}" alt="rendered ${n}"/>
      <div class="dims">${renderDims} px</div>
    </div>
    <div class="panel">
      <label>Overlay</label>
      ${overlayUri ? `<img src="${overlayUri}" alt="overlay ${n}"/>` : '<em style="color:#555">no overlay</em>'}
      ${metricsHtml}
      ${notes ? `<div class="notes">${notes}</div>` : ''}
    </div>
  </div>
</div>`;
}).join('')}
</body>
</html>`;

  writeFileSync(outHtml, html);
}

export async function generateRenderReportFromDeck({ deckPath, refDir, outHtml, title = 'OpenFig Render Report', log = console.log }) {
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
