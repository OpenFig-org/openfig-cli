#!/usr/bin/env node
// Generates svg-color-tweak-wrap.html — a synthetic standalone-HTML fixture
// (invented "Northwind Telemetry" content) covering three convert-html fixes:
//
//   Slide 1 — Inline SVG icon with fill="currentColor" on a DARK section whose
//             inherited color is white. Pre-fix, vectorized paths with
//             currentColor reached parseColor() and threw "Unknown color".
//             Now currentColor resolves to the computed CSS color.
//             (Fix: SVG currentColor → computed color.)
//
//   Slide 2 — Same icon on a LIGHT section whose inherited color is black.
//             Verifies the resolution is per-element, not a fixed default.
//
//   Slide 3 — A .sidebox with a base `border: 1px solid #000` (full box) and a
//             `body.quote-top .sidebox` override collapsing it to a single top
//             rule. TWEAK_DEFAULTS sets quoteStyle:"top". Pre-fix, convert-html
//             never replayed the tweak, so body lacked `quote-top`, the base
//             rule won, and a phantom 4-side box was emitted.
//             (Fix: replay deck TWEAK_DEFAULTS before extraction.)
//
//   Slide 4 — A 200px label column with a <br>: one label's second segment is
//             wider than the column and soft-wraps; a control label's segments
//             both fit. Pre-fix, any <br> leaf was forced noWrap, so the wide
//             segment overflowed into the body column instead of wrapping.
//             (Fix: only force noWrap when visual lines == authored lines.)
//
// Usage: node build-fixture.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
`;

const SECTION_CSS = `
html, body { margin: 0; padding: 0; }
body { font-family: 'Inter', system-ui, sans-serif; }
section {
  position: relative;
  width: 1920px;
  height: 1080px;
  padding: 80px 60px;
  box-sizing: border-box;
  overflow: hidden;
}
section + section { margin-top: 40px; }
.dark  { background: #10243a; color: #ffffff; }
.light { background: #ffffff; color: #101010; }
.title { font-weight: 700; font-size: 40px; margin: 24px 0 0; }
.glyph { color: inherit; }

/* Quote side box: base is a full box; quote-top mode collapses to a top rule. */
.sidebox { border: 1px solid #000000; padding: 20px 24px; max-width: 760px; }
body.quote-top .sidebox { border: none; border-top: 4px solid #275C8F; padding: 20px 0; }
.sidebox p { font-size: 24px; line-height: 32px; color: #275C8F; margin: 0; font-style: italic; }

/* Two-column rows with a fixed 200px label column. */
.row { display: flex; gap: 50px; align-items: flex-start; }
.row + .row { margin-top: 40px; }
.lbl {
  width: 200px; flex-shrink: 0;
  font-weight: 700; font-size: 24px; line-height: 26px;
  color: #275C8F; text-transform: uppercase;
}
.bdy { font-size: 24px; line-height: 32px; max-width: 1200px; color: #101010; }
`;

const TEMPLATE_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>Northwind Telemetry — Reliability Digest</title>
<style>${FONT_CSS}${SECTION_CSS}</style>
<!-- Deck tweak state saved by the design tool; convert-html replays this.
     TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{"quoteStyle":"top"}/*EDITMODE-END*/ -->
</head>
<body>

<section class="dark" data-label="dark-icon">
  <span class="glyph"><svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path d="M8 8 H40 V40 H8 Z" fill="currentColor"></path></svg></span>
  <h1 class="title">Signal Coverage</h1>
</section>

<section class="light" data-label="light-icon">
  <span class="glyph"><svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><path d="M8 8 H40 V40 H8 Z" fill="currentColor"></path></svg></span>
  <h1 class="title">Regional Latency</h1>
</section>

<section class="light" data-label="quote-box">
  <h1 class="title">Window Summary</h1>
  <div class="sidebox"><p>Latency stayed within the committed target across every region for the full measurement window.</p></div>
</section>

<section class="light" data-label="wrap-label">
  <h1 class="title">Findings</h1>
  <div class="row" style="margin-top:40px;">
    <div class="lbl">SECTION 01<br>THROUGHPUT METRICS</div>
    <div class="bdy">Aggregate throughput held above the committed floor for the entire measurement window with no sustained dips.</div>
  </div>
  <div class="row">
    <div class="lbl">PART TWO<br>OK</div>
    <div class="bdy">A control label whose second segment fits inside the column, so its authored line break is preserved as-is.</div>
  </div>
</section>

</body></html>`;

const PAGE_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Northwind Telemetry — Reliability Digest</title>
<style>html, body { margin: 0; padding: 0; }</style>
</head>
<body>
<div id="mount"></div>
<script type="__bundler/manifest">
{}
</script>
<script type="__bundler/template">
${JSON.stringify(TEMPLATE_HTML)}
</script>
<script>
  (function () {
    var tpl = document.querySelector('script[type="__bundler/template"]').textContent;
    var html = JSON.parse(tpl);
    var doc = new DOMParser().parseFromString(html, 'text/html');
    // Replay the saved tweak state so the live preview matches the design tool.
    var m = html.match(/EDITMODE-BEGIN\\*\\/([\\s\\S]*?)\\/\\*EDITMODE-END/);
    var tweaks = {};
    try { tweaks = JSON.parse(m[1]); } catch (e) {}
    if (tweaks.quoteStyle === 'top') document.body.classList.add('quote-top');
    var mount = document.getElementById('mount');
    for (var i = 0; i < doc.body.children.length; i++) {
      mount.appendChild(document.importNode(doc.body.children[i], true));
    }
    var styles = doc.head.querySelectorAll('style, link[rel="stylesheet"]');
    for (var j = 0; j < styles.length; j++) {
      document.head.appendChild(document.importNode(styles[j], true));
    }
  })();
</script>
</body></html>`;

writeFileSync(join(HERE, 'svg-color-tweak-wrap.html'), PAGE_HTML);
console.log('wrote', join(HERE, 'svg-color-tweak-wrap.html'));
