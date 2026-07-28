/**
 * Measurement preparation, shared by every host.
 *
 * Moved verbatim out of `../playwright-layout.mjs`; the only change is that it
 * talks to a `Surface` (see `./host-contract.mjs`) instead of a Playwright
 * page, so the same sequence runs against an iframe. No imports, and nothing
 * here may reach for `process` or a Node builtin.
 *
 * The order of the steps is load-bearing and is the reason this lives in one
 * function rather than in each host — see `prepareForMeasurement`.
 */

// Preload the fonts declared by the page from Google Fonts so the measured
// text-box metrics match what Figma will render. Without this, a page whose
// stack is `Inter, -apple-system, ...` may fall back to -apple-system in
// headless Chromium (the source's bare @font-face urls often fail to load),
// producing narrower boxes that overflow when Figma renders the same text in
// real Inter. Scanning declared families lets us preload whatever the page
// actually uses — Roboto, Poppins, EB Garamond, etc. — not just Inter.
//
// Hosts that already have the user's real fonts report `webFontPreload: false`
// and skip the whole pass, the collection walk included.
async function collectDeclaredFontFamilies(surface) {
  return surface.evaluate(({ realm }) => {
    const { document, getComputedStyle } = realm;
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
// "Inter" to the inline style so the engine re-lays out with Inter. The
// page's CSS is untouched; only elements that would have resolved to a
// system font get nudged onto Inter. Explicit non-Inter families (EB
// Garamond, Roboto, etc.) land on their first portable token via the
// stack walk and are left alone.
async function reresolveSystemFontsToInter(surface) {
  await surface.evaluate(({ realm }) => {
    const { document, getComputedStyle } = realm;
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

async function preloadMeasurementFonts(surface, host) {
  // Checked here rather than inside loadWebFont so that a host which opts out
  // also skips the whole-document walk below, exactly as the env-var early
  // return used to.
  if (!host.webFontPreload) return;
  let families;
  try {
    families = await collectDeclaredFontFamilies(surface);
  } catch {
    return;
  }
  // One request per family so that a single family failing (e.g. a name
  // Google Fonts doesn't host, or a weight variant the family lacks) doesn't
  // block the others from loading.
  //
  // Failures are reported rather than swallowed. A blocked preload does not
  // fail the conversion — it silently measures in whatever face is installed
  // instead, while the deck still names the family that was asked for, which
  // is the measure-in-A-name-B class of error. The caller cannot see that in
  // the output, so it has to be said out loud.
  const failed = [];
  await Promise.all(
    families.map((family) =>
      surface.loadWebFont(family, googleFontsCssUrl(family)).catch(() => { failed.push(family); }),
    ),
  );
  if (!failed.length) return;

  // A failed fetch is not the same as a missing font. Google does not host the
  // system families (SF Mono, Helvetica Neue…), which are installed locally
  // anyway — warning about those would cry wolf on most conversions. Ask the
  // realm which of the failures actually resolve to nothing, by measuring the
  // family against a name that cannot exist: identical widths mean it never
  // applied. `document.fonts.check()` cannot answer this — it reports on
  // registered FontFace objects and returns true for a family with no face.
  let absent = failed;
  try {
    absent = await surface.evaluate(({ realm, arg }) => {
      const { document } = realm;
      const ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) return arg;
      const sample = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789';
      const widthOf = (family) => {
        ctx.font = `40px ${family}, monospace`;
        return ctx.measureText(sample).width;
      };
      const sentinel = widthOf('"OpenFigDefinitelyAbsentFamily"');
      return arg.filter((family) => widthOf(`"${family}"`) === sentinel);
    }, failed);
  } catch { /* fall back to reporting every failure */ }

  if (absent.length && typeof host.log === 'function') {
    host.log(
      `convert-html: could not load ${absent.length} font famil${absent.length === 1 ? 'y' : 'ies'} ` +
      `(${[...absent].sort().join(', ')}), and ${absent.length === 1 ? 'it is' : 'they are'} not ` +
      'installed locally either. Text in them is measured in a substitute face while the deck names ' +
      'the original, so those elements may be sized wrongly. A blocked network or a ' +
      'Content-Security-Policy that disallows fonts.googleapis.com is the usual cause.',
    );
  }
}

/**
 * A Claude Design standalone renders its slide inside a viewer stage that
 * scales the canvas down to leave room for presenter chrome, so measuring at a
 * 1920-wide viewport yields geometry at ~90% of true size. The scaling lives
 * inside the stage's shadow DOM; rather than reach into internals that differ
 * per export, grow the surface until the slide reports its own CSS size 1:1
 * and measure there. Converges in 2-3 passes for any linear fit rule, and
 * no-ops for surfaces that already render unscaled.
 *
 * The ratio matters because of how the extractor measures: it pins the target
 * `<section>` to 1920×1080 and subtracts its rect from every child. Subtracting
 * the origin removes the *translation* an ancestor transform contributes but
 * not the scale, so every child stays multiplied by ~0.902 while the section
 * believes it is 1920 CSS px wide.
 *
 * Every constant here feeds measured geometry: the 5-iteration bound, the
 * 0.0005 epsilon, `Math.round`, `return` (not `break`) on the two guards, and
 * `settle()` *after* `resize()`. Guarded by the synthetic-viewer-chrome
 * fixture, which is the only fixture in the suite that exercises this at all.
 *
 * @param {import('./host-contract.mjs').Surface} surface
 * @param {string} selector
 */
export async function fitSurfaceToCanvas(surface, selector) {
  let { width, height } = surface.viewport();
  for (let i = 0; i < 5; i++) {
    // The realm binding matters most here: bound to the host page instead of
    // the export, `querySelector` returns null, the loop returns on the first
    // pass, and every coordinate comes back uniformly scaled — the same
    // symptom as the fit never running at all.
    const m = await surface.evaluate(({ realm, arg: sel }) => {
      const { document, getComputedStyle } = realm;
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
    await surface.resize({ width, height });
    await surface.settle();
  }
}

/**
 * Bring a freshly loaded surface to the state geometry may be read from.
 *
 * The sequence is the contract:
 *   1. wait for the export's own runtime to build the DOM — a Claude Design
 *      standalone can still be empty after `load`, and every later step is a
 *      whole-document walk that would silently no-op against an empty body;
 *   2. fit, because resizing re-runs layout and wrapping has to settle once,
 *      at the final size;
 *   3. preload the declared web fonts, then await them;
 *   4. nudge system-font stacks onto Inter;
 *   5. settle, so the metrics from step 4 have flushed.
 *
 * @param {import('./host-contract.mjs').Surface} surface
 * @param {import('./host-contract.mjs').ConversionHost} host
 * @param {{readySelector?: string, fitSelector?: string}} opts
 */
export async function prepareForMeasurement(surface, host, opts = {}) {
  if (opts.readySelector) {
    await surface.waitForSelector(opts.readySelector, { timeout: 15_000 });
  }
  if (opts.fitSelector) {
    await fitSurfaceToCanvas(surface, opts.fitSelector);
  }
  await preloadMeasurementFonts(surface, host);
  await surface.evaluate(async ({ realm }) => {
    const { document } = realm;
    if (document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch {}
    }
  });
  await reresolveSystemFontsToInter(surface);
  // Give layout one extra turn after fonts resolve and after we nudge
  // system-font stacks onto Inter, so text metrics and wrapping settle
  // before we snapshot geometry.
  await surface.settle();
}
