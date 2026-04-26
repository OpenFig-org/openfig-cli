#!/usr/bin/env node
// Generates nowrap-edge-cases.html — synthetic fixture covering the
// failure modes that surfaced during 2026-04-24 visual QA:
//
//   Slide A — Bullet `<span>` with margin-right + bare-text body.
//             Pre-fix this lost the margin entirely and rendered
//             "•Body" with no gap. (Fix: 5c99f21)
//
//   Slide B — Bullet `<span>` + body wrapped in its own `<span>`.
//             Already worked; included as regression check.
//
//   Slide C — Large right-anchored numeral ("11") at fontSize 420
//             with negative letter-spacing. Triggers the Slides
//             implicit wrap boundary. (Fix: ce4f679)
//
//   Slide D — Long single-line noWrap body bullets near right edge.
//             Pre-fix this was the false-positive zone for the
//             1.3× heuristic; verifies body text is no longer
//             shifted. (Fix: ce4f679)
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
body { font-family: 'Inter', system-ui, sans-serif; color: #0a0a0a; background: #fafafa; }
section {
  position: relative;
  width: 1920px;
  height: 1080px;
  padding: 80px 60px;
  box-sizing: border-box;
  background: #ffffff;
  overflow: hidden;
}
section + section { margin-top: 40px; }
.title { font-weight: 700; font-size: 28px; margin: 0 0 40px; }
.bullet-row {
  font-size: 24px;
  line-height: 1.4;
  margin-bottom: 14px;
}
.divider-num {
  position: absolute;
  right: 56px;
  top: 80px;
  font-size: 420px;
  letter-spacing: -0.03em;
  color: #4B7FAE;
  font-weight: 400;
  line-height: 1;
}
`;

const TEMPLATE_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>noWrap edge cases</title>
<style>${FONT_CSS}${SECTION_CSS}</style>
</head>
<body>

<section data-label="A — bullet span + bare text">
  <h1 class="title">A. Bullet span (margin-right) + bare text body</h1>
  <div class="bullet-row"><span style="color:#275C8F;font-weight:700;margin-right:8px;">&bull;</span>Each request must include an authentication token in the Authorization header.</div>
  <div class="bullet-row"><span style="color:#275C8F;font-weight:700;margin-right:8px;">&bull;</span>Responses are JSON-encoded and subject to a per-key request rate limit.</div>
  <div class="bullet-row"><span style="color:#275C8F;font-weight:700;margin-right:8px;">&bull;</span>Idempotency keys are honored for twenty-four hours after first use.</div>
</section>

<section data-label="B — bullet span + body span">
  <h1 class="title">B. Bullet span + body span (regression check)</h1>
  <div class="bullet-row"><span style="color:#275C8F;font-weight:700;min-width:16px;margin-right:8px;">&bull;</span><span>Webhooks are delivered with at-least-once semantics and exponential retry.</span></div>
  <div class="bullet-row"><span style="color:#275C8F;font-weight:700;min-width:16px;margin-right:8px;">&bull;</span><span>Subscribers should treat duplicate deliveries as benign and dedupe by event id.</span></div>
</section>

<section data-label="C — large right-anchored numeral">
  <h1 class="title">C. Large right-anchored numeral (Slides wrap boundary)</h1>
  <div class="divider-num">11</div>
</section>

<section data-label="D — long noWrap body near right edge">
  <h1 class="title">D. Long noWrap body bullets near right edge (false-positive zone)</h1>
  <div class="bullet-row" style="white-space:nowrap;"><span style="color:#275C8F;font-weight:700;margin-right:8px;">&bull;</span>The schema migration runs inside a single transaction and is reversible by replaying the inverse in the opposite direction.</div>
  <div class="bullet-row" style="white-space:nowrap;"><span style="color:#275C8F;font-weight:700;margin-right:8px;">&bull;</span>Database connections are pooled per worker and returned to the pool when the request handler returns or throws an exception.</div>
</section>

</body></html>`;

const PAGE_HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>noWrap edge cases</title>
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

writeFileSync(join(HERE, 'nowrap-edge-cases.html'), PAGE_HTML);
console.log('wrote', join(HERE, 'nowrap-edge-cases.html'));
