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

export async function withChromiumPage(htmlPath, viewport, fn) {
  const browser = await resolveBrowser();
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    return await fn(page);
  } finally {
    await browser.close();
  }
}
