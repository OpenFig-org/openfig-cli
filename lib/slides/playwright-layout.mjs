/**
 * The Node measurement realm: resolve a Chromium, open the export in it, and
 * expose it as a `Surface` (see `core/host-contract.mjs`).
 *
 * Everything that used to live here and was not Node-specific — the fit
 * correction, the font preload, the Inter re-resolution, the settle sequence —
 * moved to `core/measurement-surface.mjs`, so a browser host runs the same
 * preparation against an iframe. What stays is the part with no browser
 * analogue: launching a browser and pointing it at a file on disk.
 */
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

/**
 * The first Chromium we can launch, with the message that names every place we
 * looked when there is none. Exported so tests that need a real browser for
 * something other than a measurement surface — driving the *browser* host, for
 * one — resolve it the same way the CLI does.
 */
export async function resolveBrowser() {
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

/**
 * Launch Chromium, load `htmlPath`, and wrap the page as a `Surface`.
 *
 * `deviceScaleFactor: 1` pins DPR so raster work downstream is deterministic;
 * geometry is in CSS px either way. `close()` shuts the browser down and must
 * be called from a `finally` — the core does.
 *
 * @param {string} htmlPath
 * @param {{width: number, height: number}} viewport
 * @returns {Promise<import('./core/host-contract.mjs').Surface>}
 */
export async function openPlaywrightSurface(htmlPath, viewport) {
  const browser = await resolveBrowser();
  let size = { ...viewport };
  try {
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });

    // The realm the payloads measure, as a live in-page object. Playwright
    // would bind their globals correctly anyway — it serialises each payload
    // and re-parses it inside the page — but the iframe host cannot, so both
    // hosts pass the realm in explicitly and one payload serves both. Built
    // once: the page never navigates, so the handle stays valid for the
    // conversion, and `setViewportSize` does not invalidate it.
    const realm = await page.evaluateHandle(() => ({
      document,
      window,
      // Bound, because the payloads call it as a free function. Unbound it
      // would throw "Illegal invocation" the moment it left `window`.
      getComputedStyle: window.getComputedStyle.bind(window),
    }));

    return {
      // Playwright resolves JSHandles nested in the argument structure back to
      // the live in-page object, so the payload still arrives serialised and
      // re-parsed *and* receives its globals explicitly.
      evaluate: (fn, arg) => page.evaluate(fn, { realm, arg }),
      resize: async (next) => {
        await page.setViewportSize(next);
        size = { ...next };
      },
      viewport: () => ({ ...size }),
      settle: () => page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      ),
      waitForSelector: (sel, o = {}) => page.waitForSelector(sel, { state: 'attached', timeout: o.timeout }),
      loadWebFont: (_family, cssUrl) => page.addStyleTag({ url: cssUrl }),
      content: () => page.content(),
      close: async () => {
        await realm.dispose().catch(() => {});
        await browser.close();
      },
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}
