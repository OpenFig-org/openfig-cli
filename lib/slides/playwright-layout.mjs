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

// Preload Inter into the measurement browser so that Playwright's text-box
// metrics match what Figma will render. Without this, a page whose CSS stack
// is `Inter, -apple-system, ...` will fall back to -apple-system in headless
// Chromium (no system Inter, no network fetch of the page's bare @font-face
// urls) — and Playwright records narrower box widths than Figma then needs
// for the real-Inter glyphs, overflowing the frame. Inter is Figma's default
// and the font most web content declares first, so loading it unconditionally
// is the high-leverage fix.
//
// Set OPENFIG_NO_FONT_PRELOAD=1 to skip (useful offline or in CI without
// network egress).
const INTER_STYLESHEET_URL =
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap';

async function preloadMeasurementFonts(page) {
  if (process.env.OPENFIG_NO_FONT_PRELOAD === '1') return;
  try {
    await page.addStyleTag({ url: INTER_STYLESHEET_URL });
  } catch {
    // Network offline, CSP-blocked, etc. Fall through — document.fonts.ready
    // will still resolve against whatever the page loaded on its own.
  }
}

export async function withChromiumPage(htmlPath, viewport, fn) {
  const browser = await resolveBrowser();
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await preloadMeasurementFonts(page);
    await page.evaluate(async () => {
      if (document.fonts?.ready) {
        try {
          await document.fonts.ready;
        } catch {}
      }
      // Give layout one extra turn after fonts resolve so text metrics and
      // wrapping settle before we snapshot geometry.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    return await fn(page);
  } finally {
    await browser.close();
  }
}
