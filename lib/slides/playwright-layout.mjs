import { chromium } from 'playwright-core';
import { pathToFileURL } from 'url';

async function tryLaunch(opts, label, errors) {
  try {
    return await chromium.launch({ headless: true, ...opts });
  } catch (e) {
    errors.push(`${label}: ${e.message.split('\n')[0]}`);
    return null;
  }
}

async function resolveBrowser() {
  const errors = [];
  const viaChannel = await tryLaunch({ channel: 'chrome' }, "channel:'chrome'", errors);
  if (viaChannel) return viaChannel;

  const envPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (envPath) {
    const viaEnv = await tryLaunch({ executablePath: envPath }, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${envPath}`, errors);
    if (viaEnv) return viaEnv;
  }

  const viaCache = await tryLaunch({}, 'playwright default cache', errors);
  if (viaCache) return viaCache;

  throw new Error(
    [
      'openfig convert-html: no Chromium/Chrome executable is available.',
      '',
      'Tried:',
      ...errors.map((e) => `  - ${e}`),
      '',
      'To fix, do one of:',
      '  1. Install Google Chrome: https://www.google.com/chrome/',
      '  2. Run: npx playwright install --only-shell chromium',
      '  3. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a Chromium/Chrome binary',
    ].join('\n'),
  );
}

// Preload the fonts declared by the page from Google Fonts so Playwright's
// text-box metrics match what Figma will render. Without this, a page whose
// stack is `Inter, -apple-system, ...` may fall back to -apple-system in
// headless Chromium (the source's bare @font-face urls often fail to load),
// producing narrower boxes that overflow when Figma renders the same text in
// real Inter. Scanning declared families lets us preload whatever the page
// actually uses — Roboto, Poppins, EB Garamond, etc. — not just Inter.
//
// Set OPENFIG_NO_FONT_PRELOAD=1 to skip (offline or airgapped CI).
async function collectDeclaredFontFamilies(page) {
  return page.evaluate(() => {
    const NON_PORTABLE = new Set([
      'blinkmacsystemfont', 'system-ui',
      'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
      'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
      'emoji', 'math', 'fangsong',
    ]);
    function pickPortable(stack) {
      if (!stack) return null;
      const tokens = stack.split(',').map((t) => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      for (const t of tokens) {
        if (t.startsWith('-')) continue;
        if (NON_PORTABLE.has(t.toLowerCase())) continue;
        return t;
      }
      return null;
    }
    const found = new Set();
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const picked = pickPortable(getComputedStyle(el).fontFamily);
      if (picked) found.add(picked);
    }
    return [...found];
  });
}

function googleFontsCssUrl(family) {
  const enc = encodeURIComponent(family).replace(/%20/g, '+');
  return `https://fonts.googleapis.com/css2?family=${enc}:wght@300;400;500;600;700;800;900&display=swap`;
}

// When the source CSS stack is `-apple-system, system-ui, ...` with no
// explicit Inter, Chromium resolves to SF Pro (narrow metrics) while our
// handoff emits `font: Inter` via the portable-stack walk. Figma then
// renders the wider Inter glyphs into a box Chromium measured against SF
// Pro, and the text overflows — visible as a big section-number "11" that
// wraps to two stacked "1"s instead of fitting on one line.
//
// The fix: for every element whose computed fontFamily starts with a
// non-portable token (a system keyword Figma can't resolve), prepend
// "Inter" to the inline style so Chromium re-lays out with Inter. The
// page's CSS is untouched; only elements that would have resolved to a
// system font get nudged onto Inter. Explicit non-Inter families (EB
// Garamond, Roboto, etc.) land on their first portable token via the
// stack walk and are left alone.
async function reresolveSystemFontsToInter(page) {
  await page.evaluate(() => {
    const NON_PORTABLE = new Set([
      'blinkmacsystemfont', 'system-ui',
      'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
      'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
      'emoji', 'math', 'fangsong',
    ]);
    function firstTokenIsNonPortable(stack) {
      if (!stack) return false;
      const first = stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      if (!first) return false;
      if (first.startsWith('-')) return true;
      return NON_PORTABLE.has(first.toLowerCase());
    }
    for (const el of document.querySelectorAll('*')) {
      const stack = getComputedStyle(el).fontFamily;
      if (firstTokenIsNonPortable(stack)) {
        // setProperty with 'important' applies inline !important, which
        // beats any stylesheet rule no matter how specific. Plain
        // el.style.fontFamily = ... would lose to a page rule like
        // `.cls { font-family: -apple-system !important }`.
        el.style.setProperty('font-family', 'Inter, ' + stack, 'important');
      }
    }
  });
}

async function preloadMeasurementFonts(page) {
  if (process.env.OPENFIG_NO_FONT_PRELOAD === '1') return;
  let families;
  try {
    families = await collectDeclaredFontFamilies(page);
  } catch {
    return;
  }
  // One addStyleTag per family so that a single family failing (e.g. a
  // name Google Fonts doesn't host, or a weight variant the family lacks)
  // doesn't block the others from loading.
  await Promise.all(
    families.map((family) =>
      page.addStyleTag({ url: googleFontsCssUrl(family) }).catch(() => {}),
    ),
  );
}

// A Claude Design standalone renders its slide inside a viewer stage that
// scales the canvas down to leave room for presenter chrome, so measuring at a
// 1920-wide viewport yields geometry at ~90% of true size. The scaling lives
// inside the stage's shadow DOM; rather than reach into internals that differ
// per export, grow the viewport until the slide reports its own CSS size 1:1
// and measure there. Converges in 2-3 passes for any linear fit rule, and
// no-ops for pages that already render unscaled.
async function fitViewportToCanvas(page, selector, viewport) {
  let { width, height } = viewport;
  for (let i = 0; i < 5; i++) {
    const m = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cssW = parseFloat(getComputedStyle(el).width);
      return { rendered: el.getBoundingClientRect().width, css: cssW };
    }, selector);
    if (!m || !m.css || !m.rendered) return;
    const scale = m.rendered / m.css;
    if (!Number.isFinite(scale) || scale <= 0) return;
    if (Math.abs(scale - 1) < 0.0005) return;
    width = Math.round(width / scale);
    height = Math.round(height / scale);
    await page.setViewportSize({ width, height });
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
  }
}

export async function withChromiumPage(htmlPath, viewport, fn, opts = {}) {
  const browser = await resolveBrowser();
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    // A Claude Design standalone builds its DOM from a runtime that runs after
    // 'load', so the document can still be empty here. Everything downstream —
    // font collection included — walks the DOM, so wait for real content to
    // exist before measuring anything.
    if (opts.readySelector) {
      await page.waitForSelector(opts.readySelector, { state: 'attached', timeout: 15_000 });
    }
    // Must precede any measurement — resizing the viewport re-runs layout, so
    // font metrics and wrapping have to settle at the final scale, not before.
    if (opts.fitSelector) {
      await fitViewportToCanvas(page, opts.fitSelector, viewport);
    }
    await preloadMeasurementFonts(page);
    await page.evaluate(async () => {
      if (document.fonts?.ready) {
        try {
          await document.fonts.ready;
        } catch {}
      }
    });
    await reresolveSystemFontsToInter(page);
    await page.evaluate(async () => {
      // Give layout one extra turn after fonts resolve and after we nudge
      // system-font stacks onto Inter, so text metrics and wrapping settle
      // before we snapshot geometry.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    return await fn(page);
  } finally {
    await browser.close();
  }
}
