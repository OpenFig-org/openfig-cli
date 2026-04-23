#!/usr/bin/env node
// Generates text-wrap-probe.html, the synthetic fixture for measuring
// Chromium vs Figma wrap-point divergence on multi-line paragraphs.
//
// Usage:
//   node build-fixture.mjs
//
// Optional: swap the Inter source by editing FONT_CSS below before
// regenerating. The three candidates referenced in the openspec are:
//
//   (a) Claude Design's bundled local Inter (requires a local WOFF2 path)
//   (b) Google Fonts CSS2 Inter WOFF2 (the default below)
//   (c) Rasmus Andersson's official Inter GitHub release (requires a local
//       or CDN WOFF2 path)

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Inter source under test. Replace the url(...) to probe a different build.
const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
`;

// Short styled label + 400-500 character body, per paragraph.
// Varied prose so wrap points are sensitive to font metrics rather than
// dominated by a single long token.
const PARAGRAPHS = [
  {
    label: 'Participant A',
    body: 'joined the initial cohort in late March and has been testing the onboarding flow across several devices. Their feedback focused on the clarity of permission prompts and how quickly the first screen loads when the network is slow. Notes mention a preference for fewer tooltips on the home view and a concern that the default sort order may hide recent activity from returning users. Overall tone is constructive.',
  },
  {
    label: 'Participant B',
    body: 'has a background in product design and spent the first week documenting small friction points in the editor. Their main concern is keyboard navigation: several commands require the mouse even when the cursor is already in a known region of the canvas. Suggestions include adding a command palette shortcut and surfacing the current selection count somewhere persistent. Willing to pair on a follow-up.',
  },
  {
    label: 'Participant C',
    body: 'reported that the weekly summary email reached them on Tuesday morning rather than Monday afternoon as documented. On investigation this was traced to a timezone fallback when the user profile lacks a saved region. They also asked whether the summary could include a compact view that fits a single screen without horizontal scroll on a tablet in portrait orientation.',
  },
  {
    label: 'Participant D',
    body: 'uses the mobile app almost exclusively and surfaced a visual glitch where the top navigation bar occasionally disappears after scrolling quickly through a long document. This appears to be related to the bounce animation on iOS and has been reproduced on two recent devices. They have offered to record screen captures for the bug tracker if that would speed up the investigation.',
  },
  {
    label: 'Participant E',
    body: 'works primarily from a desktop with a very wide monitor and flagged that some dialog boxes open at the far edge of the screen rather than centered on the active window. This is a minor annoyance but repeats every session. They also noted that the zoom controls in the settings panel do not persist across restarts, which makes it harder to restore their preferred working magnification each day.',
  },
  {
    label: 'Participant F',
    body: 'spent most of the evaluation time with the collaboration features and had generally positive things to say about presence indicators. One gap: when a teammate joins mid-session the list of active participants does not update until the next refresh. They would like to see a short animation or sound cue when a new collaborator joins, particularly in review sessions with four or more attendees.',
  },
  {
    label: 'Participant G',
    body: 'is new to the product and spent several hours learning the interface before giving structured feedback. They found the documentation thorough but suggested that the getting-started page could link directly to a short video walkthrough rather than asking the reader to scroll through dense text. They also asked about import support for legacy formats that their team still maintains for archival reasons.',
  },
  {
    label: 'Participant H',
    body: 'reported a crash that occurred only when pasting a long block of text from a source document into a newly created page. The crash is not deterministic but reproduces roughly once in every three or four attempts with the same input. They sent a sanitized copy of the source so engineers can look into whether a particular character sequence triggers the failing code path reliably.',
  },
];

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function slide(index, label, fontSize) {
  const cols = [PARAGRAPHS.slice(0, 4), PARAGRAPHS.slice(4, 8)];
  const paraHtml = (p) =>
    `<p class="para"><strong class="label">${escapeHtml(p.label)}</strong> – ${escapeHtml(p.body)}</p>`;
  const columnHtml = (col) =>
    `<div class="col">${col.map(paraHtml).join('\n')}</div>`;
  const lineHeight = 1.55;
  return `<section data-label="${label}" style="font-size:${fontSize}px;line-height:${lineHeight};">
  <h1 class="title">Text-wrap probe — Inter ${fontSize}px</h1>
  <div class="stack">
    ${columnHtml(cols[0])}
    ${columnHtml(cols[1])}
  </div>
  <div class="footer"><span>text-wrap probe fixture</span><span class="page">${index}</span></div>
</section>`;
}

const templateHtml = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>Text-wrap probe</title>
<style>
${FONT_CSS}
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
.title {
  font-weight: 700;
  font-size: 2em;
  margin: 0 0 40px;
  line-height: 1.1;
}
.stack {
  display: flex;
  flex-direction: row;
  gap: 40px;
}
.col {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.para {
  margin: 0;
}
.label {
  color: #2a5db0;
  font-weight: 700;
}
.footer {
  position: absolute;
  left: 60px;
  right: 60px;
  bottom: 40px;
  display: flex;
  justify-content: space-between;
  font-size: 0.6em;
  color: #666;
  border-top: 1px solid #ddd;
  padding-top: 12px;
}
</style>
</head>
<body>
${slide(1, '01 Inter 24', 24)}
${slide(2, '02 Inter 16', 16)}
${slide(3, '03 Inter 32', 32)}
</body></html>`;

const manifestJson = '{}';
const templateJson = JSON.stringify(templateHtml);

// Wrapper HTML that loads the bundled template the same way Claude Design
// standalone exports do. Minimal bootstrap — no Claude-Design loading UI,
// just enough for convert-html's extractor to find the two script tags.
const output = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Text-wrap probe</title>
<style>html, body { margin: 0; padding: 0; }</style>
</head>
<body>
<div id="mount"></div>
<script type="__bundler/manifest">
${manifestJson}
</script>
<script type="__bundler/template">
${templateJson}
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
    // Inject the template's <style> blocks into the live document head so
    // computed styles resolve when the converter reads the page.
    var styles = doc.head.querySelectorAll('style, link[rel="stylesheet"]');
    for (var j = 0; j < styles.length; j++) {
      document.head.appendChild(document.importNode(styles[j], true));
    }
  })();
</script>
</body></html>`;

writeFileSync(join(HERE, 'text-wrap-probe.html'), output, 'utf8');
process.stderr.write('wrote text-wrap-probe.html\n');
