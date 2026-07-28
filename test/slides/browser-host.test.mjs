/**
 * The browser adapter, driven in a real browser.
 *
 * Nothing here mocks a DOM. The adapter is bundled for the browser, loaded
 * into a page served from a real origin, and asked to convert a standalone
 * export the same way the conversion page will. What is asserted is geometry,
 * because both failure modes this adapter can have produce plausible geometry
 * rather than an error:
 *
 *   - the realm bug: the extractor payload binds `document` to the *host*
 *     page instead of the iframe, and measures the wrong document. The host
 *     page here carries a decoy `<section>` precisely so that mistake is
 *     visible in the output rather than silent, and one test deliberately
 *     feeds the payload the host realm to prove the decoy actually catches it;
 *   - the scale bug: the iframe is not sized up to undo the export's own
 *     viewer-stage fit, so every coordinate arrives at ~90%. The
 *     synthetic-viewer-chrome fixture's two anchors are authored at known
 *     coordinates, and the far one (1400, 800) is where a uniform 0.902 shows
 *     up as a 137px error rather than a rounding difference.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { resolveBrowser } from '../../lib/slides/playwright-layout.mjs';
import { extractSlides } from '../../lib/slides/browser-extract.mjs';
import { bundleForBrowser, repoWarnings } from './browser-bundle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const FIXTURE = join(
  REPO, 'test', 'fixtures', 'standalone-html',
  'synthetic-viewer-chrome', 'synthetic-viewer-chrome.html',
);

// A real origin, so `URL.createObjectURL` produces a `blob:` URL the iframe is
// same-origin with. An `about:blank` host has an opaque origin and its blobs
// are not same-origin with anything, which would fail for a reason that has
// nothing to do with the adapter. Nothing is served over the network — the
// request is fulfilled by the route handler.
const HOST_ORIGIN = 'https://openfig.test';

// The decoy is what makes a realm mistake visible. It is a `<section>`, which
// is exactly what the extractor looks for, and it carries its own `data-label`
// and its own text so a payload bound to the host page produces *this* slide
// instead of the export's.
const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>host</title>
<style>section { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }</style>
</head><body>
<section data-label="HOST DECOY"><p style="position:absolute;left:11px;top:13px">HOST DECOY TEXT</p></section>
</body></html>`;

let browser;
let page;
let sourceHtml;

async function bundleBrowserAdapter() {
  const { code, warnings } = await bundleForBrowser();
  const ours = repoWarnings(warnings);
  if (ours.length) {
    throw new Error(`bundling the browser adapter warned: ${ours.map((w) => w.message).join('; ')}`);
  }
  return code;
}

beforeAll(async () => {
  sourceHtml = readFileSync(FIXTURE, 'utf8');
  const code = await bundleBrowserAdapter();
  browser = await resolveBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  await page.route(`${HOST_ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HOST_PAGE }));
  await page.goto(`${HOST_ORIGIN}/`, { waitUntil: 'load' });
  await page.addScriptTag({ content: code });
  // The bundle must have survived the crossing before anything else is
  // asserted, or every later failure reads as an adapter bug.
  expect(await page.evaluate(() => typeof globalThis.OpenFigBrowser?.BrowserConversionHost))
    .toBe('function');
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

/** Convert the fixture in the page and bring the result back. */
async function convertInBrowser(src) {
  return page.evaluate(async (html) => {
    const { BrowserConversionHost, convertStandaloneCore } = globalThis.OpenFigBrowser;
    const host = new BrowserConversionHost({
      sourceHtml: html,
      // Deterministic and offline: the fixture's anchors are absolutely
      // positioned, so their coordinates do not depend on the font, and
      // fetching Inter from Google Fonts would put a network round trip in a
      // unit test. `ensureInter` has its own test below.
      ensureInter: false,
      onLog: () => {},
    });
    const { manifest, warnings } = await convertStandaloneCore(html, host, { silent: true });
    return {
      manifest,
      warnings,
      artifacts: [...host.texts.keys()].sort(),
      mediaCount: host.media.size,
      // Proof the iframe was taken back down rather than left in the page.
      framesLeftBehind: document.querySelectorAll('iframe').length,
    };
  }, src);
}

function findText(slide, needle) {
  let hit = null;
  const walk = (els) => {
    for (const el of els ?? []) {
      if (typeof el.text === 'string' && el.text.includes(needle)) hit = el;
      walk(el.children);
    }
  };
  walk(slide.elements);
  return hit;
}

describe('browser conversion host, in a real browser', () => {
  let result;

  beforeAll(async () => {
    result = await convertInBrowser(sourceHtml);
  }, 180_000);

  it('measures the export, not the host page that is driving it', () => {
    // The host page holds a `<section data-label="HOST DECOY">`. Under
    // the realm bug the extractor finds that one first and the manifest
    // describes the wrong document — with no error anywhere.
    expect(result.manifest.slides).toHaveLength(1);
    // The fixture's `<section>` carries no `data-label`, so the core names it
    // positionally; the decoy carries one, so a measured decoy is unmistakable.
    expect(result.manifest.slides[0].label).toBe('Slide 1');
    expect(findText(result.manifest.slides[0], 'HOST DECOY')).toBeNull();
    expect(result.manifest.title).toBe('Synthetic Viewer Chrome');
  });

  it('reports the canvas at full 1920x1080', () => {
    expect(result.manifest.dimensions).toEqual({ width: 1920, height: 1080 });
  });

  it('measures geometry at true scale, not the stage-fitted scale', () => {
    const a = findText(result.manifest.slides[0], 'ANCHOR ALPHA');
    expect(a).toBeTruthy();
    expect(a.x).toBeCloseTo(200, 0);
    expect(a.y).toBeCloseTo(300, 0);
  });

  it('holds true scale for anchors far from the origin', () => {
    // At the unfitted 0.902 this lands near (1263, 722). A tolerance-only
    // check near the origin would not have noticed.
    const b = findText(result.manifest.slides[0], 'ANCHOR BETA');
    expect(b).toBeTruthy();
    expect(b.x).toBeCloseTo(1400, 0);
    expect(b.y).toBeCloseTo(800, 0);
  });

  it('emits the same three named artifacts the Node host writes to disk', () => {
    expect(result.artifacts).toEqual(['manifest.json', 'template.html', 'warnings.json']);
    expect(result.mediaCount).toBe(0); // this fixture declares no assets
  });

  it('takes the measurement surface back down', () => {
    expect(result.framesLeftBehind).toBe(0);
  });
});

describe('the decoy actually catches a realm mistake', () => {
  it('measures the host page when the payload is handed the host realm', async () => {
    // The mirror image of the first test. Without this, "no decoy in the
    // output" only proves the decoy was never reachable. Here the payload gets
    // the host page's own globals — which is exactly what a direct call from a
    // host page does when the payload closes over `document` — and the
    // extractor duly describes the decoy.
    const label = await page.evaluate(async (payloadSource) => {
      const runPayload = new Function(`return (${payloadSource})`)();
      const hostRealm = {
        document,
        window,
        getComputedStyle: window.getComputedStyle.bind(window),
      };
      const surface = { evaluate: (fn, arg) => fn({ realm: hostRealm, arg }) };
      const out = await runPayload(surface, { flexAutoLayout: false });
      return out.slides.map((s) => s.dataLabel);
      // `new Function` here is test scaffolding to get the *shared* extractor
      // into the page for the negative control. The adapter itself never
      // evaluates source — that is what keeps `wasm-unsafe-eval` sufficient.
    }, extractSlides.toString());
    expect(label).toEqual(['HOST DECOY']);
  }, 120_000);
});

describe('the iframe surface', () => {
  it('grows past the canvas until the slide renders 1:1, and reports that size', async () => {
    const measured = await page.evaluate(async (html) => {
      const { openIframeSurface, BrowserConversionHost, prepareForMeasurement } =
        globalThis.OpenFigBrowser;
      const surface = await openIframeSurface({
        sourceHtml: html,
        viewport: { width: 1920, height: 1080 },
      });
      try {
        const host = new BrowserConversionHost({ sourceHtml: html, ensureInter: false, onLog: () => {} });
        await prepareForMeasurement(surface, host, { readySelector: 'section', fitSelector: 'section' });
        const rendered = await surface.evaluate(({ realm }) => {
          const { document, getComputedStyle } = realm;
          const el = document.querySelector('section');
          return {
            rendered: el.getBoundingClientRect().width,
            css: parseFloat(getComputedStyle(el).width),
            innerWidth: realm.window.innerWidth,
            innerHeight: realm.window.innerHeight,
          };
        });
        return { viewport: surface.viewport(), ...rendered };
      } finally {
        await surface.close();
      }
    }, sourceHtml);

    // The fixture reserves a 188px sidebar and scales to fit, so a 1920-wide
    // realm renders the slide at 1732px — 0.9021. The fit grows the realm
    // until the slide renders at its authored 1920.
    expect(measured.css).toBe(1920);
    expect(measured.rendered).toBeCloseTo(1920, 0);

    // ~2108x1186, the same size the Node path converges to. Asserted as a
    // range because the fit rounds to whole pixels each pass.
    expect(measured.viewport.width).toBeGreaterThan(2090);
    expect(measured.viewport.width).toBeLessThan(2130);
    expect(measured.viewport.height).toBeGreaterThan(1175);
    expect(measured.viewport.height).toBeLessThan(1200);

    // `viewport()` is the size we asked for; the realm has to have actually
    // taken it. If an outer container had clamped the iframe these would
    // diverge and every coordinate above would be uniformly wrong.
    expect(measured.innerWidth).toBe(measured.viewport.width);
    expect(measured.innerHeight).toBe(measured.viewport.height);
  }, 180_000);

  it('keeps its size against a host page that is actively trying to clamp it', async () => {
    // The prevention half of F2. Author `!important` in a stylesheet is the
    // strongest thing a host page can bring, and inline `!important` still
    // beats it — which is why every geometry-critical property is pinned that
    // way rather than merely set.
    const measured = await page.evaluate(async (html) => {
      const { openIframeSurface } = globalThis.OpenFigBrowser;
      const style = document.createElement('style');
      style.textContent = `
        .cage { display: flex; max-width: 700px; overflow: hidden; }
        .cage iframe {
          max-width: 640px !important; max-height: 480px !important;
          width: 300px !important; height: 200px !important;
          border: 8px solid red !important; padding: 12px !important;
          box-sizing: border-box !important; zoom: 0.5 !important;
        }`;
      document.head.appendChild(style);
      const cage = document.createElement('div');
      cage.className = 'cage';
      document.body.appendChild(cage);
      const surface = await openIframeSurface({
        sourceHtml: html,
        viewport: { width: 1920, height: 1080 },
        container: cage,
      });
      try {
        await surface.resize({ width: 2108, height: 1186 });
        const win = surface.viewport();
        const inner = await surface.evaluate(({ realm }) => ({
          w: realm.window.innerWidth, h: realm.window.innerHeight,
        }));
        return { asked: win, inner };
      } finally {
        await surface.close();
        cage.remove();
        style.remove();
      }
    }, sourceHtml);

    expect(measured.inner.w).toBe(measured.asked.width);
    expect(measured.inner.h).toBe(measured.asked.height);
  }, 120_000);

  it('refuses to measure a surface that is not being laid out at all', async () => {
    // The detection half of F2, exercised through the one clamp the pinning
    // cannot prevent: a container that is not rendered. Mounting the surface
    // into a hidden element is a plausible mistake for a page that wants it out
    // of the way, and it yields a realm with no size rather than an error.
    const message = await page.evaluate(async (html) => {
      const { openIframeSurface } = globalThis.OpenFigBrowser;
      const cage = document.createElement('div');
      cage.style.display = 'none';
      document.body.appendChild(cage);
      try {
        const surface = await openIframeSurface({
          sourceHtml: html,
          viewport: { width: 1920, height: 1080 },
          container: cage,
        });
        try {
          await surface.resize({ width: 2108, height: 1186 });
          return null;
        } finally {
          await surface.close();
        }
      } catch (err) {
        return err.message;
      } finally {
        cage.remove();
      }
    }, sourceHtml);

    expect(message).toBeTruthy();
    expect(message).toContain('did not lay out at the size it was given');
  }, 120_000);
});

describe('canvas image ops, the browser replacement for sharp', () => {
  // Assertions are on *decoded pixel values*, never on hashes and never on a
  // Canvas-produced reference: two encoders can never agree byte for byte, and
  // a Canvas result checked against another Canvas result checks nothing. The
  // input is built by sharp and the output is decoded by sharp, so both ends
  // of every assertion sit outside the implementation under test.
  let redPng;

  beforeAll(async () => {
    // 2x2, pure red, the bottom row fully transparent. Drawn 1:1, so no
    // resampling is involved and the expected values are exact.
    redPng = await sharp(Buffer.from([
      255, 0, 0, 255, 255, 0, 0, 255,
      255, 0, 0, 0, 255, 0, 0, 0,
    ]), { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
  });

  /** Run one op in the page and bring the bytes back. */
  async function run(op, bytes, ...args) {
    const out = await page.evaluate(async ({ op, data, args, mime }) => {
      const { canvasImageOps } = globalThis.OpenFigBrowser;
      const src = { filename: mime === 'image/svg+xml' ? 'x.svg' : 'x.png', bytes: new Uint8Array(data), mime };
      const result = await canvasImageOps[op](src, ...args);
      return result?.byteLength === undefined ? result : [...result];
    }, { op, data: [...bytes], args, mime: 'image/png' });
    return Array.isArray(out) ? Buffer.from(out) : out;
  }

  const pixels = async (bytes) => {
    const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return [...data];
  };

  it('reports intrinsic dimensions', async () => {
    expect(await run('imageSize', redPng)).toEqual({ width: 2, height: 2 });
  });

  it('inverts RGB and preserves alpha', async () => {
    const px = await pixels(await run('bakeFilter', redPng, { invert: 1 }));
    expect(px.slice(0, 4)).toEqual([0, 255, 255, 255]); // red → cyan
    expect(px[11]).toBe(0);                             // alpha untouched
  });

  it('forces every visible pixel white and keeps the alpha mask', async () => {
    const px = await pixels(await run('bakeFilter', redPng, { forceWhite: true }));
    expect(px.slice(0, 4)).toEqual([255, 255, 255, 255]);
    expect(px[11]).toBe(0);
  });

  it('thumbnails to 320px wide, with the height sharp would have chosen', async () => {
    const big = await sharp({
      create: { width: 800, height: 1200, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer();
    const out = await run('thumbnailPng', big);
    const meta = await sharp(out).metadata();
    // `round(1200 * 320 / 800)` is arithmetic, not resampling, so this is one
    // of the few image properties both implementations must agree on exactly.
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 320, height: 480 });
  });

  it('does not enlarge a source narrower than the thumbnail width', async () => {
    const meta = await sharp(await run('thumbnailPng', redPng)).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 2, height: 2 });
  });
});

describe('the input precondition', () => {
  it('reports that a Claude Design standalone export is required', async () => {
    const out = await page.evaluate(() => {
      const { precheckStandaloneExport, BrowserConversionHost, convertStandaloneCore } =
        globalThis.OpenFigBrowser;
      const notAnExport = '<!doctype html><html><body><h1>just a web page</h1></body></html>';
      const pre = precheckStandaloneExport(notAnExport);
      // Constructing the host must not create an iframe or run anything: an
      // input that fails the precondition must never reach a live realm.
      const host = new BrowserConversionHost({ sourceHtml: notAnExport, onLog: () => {} });
      const framesAfterConstruct = document.querySelectorAll('iframe').length;
      return convertStandaloneCore(notAnExport, host, { silent: true })
        .then(() => ({ pre, framesAfterConstruct, threw: null }))
        .catch((e) => ({ pre, framesAfterConstruct, threw: e.message }));
    });

    expect(out.pre.ok).toBe(false);
    expect(out.pre.message).toContain('not a Claude Design standalone export');
    expect(out.framesAfterConstruct).toBe(0);
    expect(out.threw).toContain('missing __bundler/manifest or /template');
  }, 120_000);

  it('accepts the fixture', async () => {
    const ok = await page.evaluate(
      (html) => globalThis.OpenFigBrowser.precheckStandaloneExport(html).ok,
      sourceHtml,
    );
    expect(ok).toBe(true);
  });
});
