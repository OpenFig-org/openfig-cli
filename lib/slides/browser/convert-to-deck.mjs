/**
 * Export in, `.deck` bytes out — the whole browser path as one call.
 *
 * The two halves already existed and were not joined up: group 3 made a
 * browser able to *measure* an export (`core/convert-standalone.mjs` returns a
 * geometry manifest byte-identical to Node's), and group 4b made the deck
 * writer portable. This is the seam between them, and it is the same seam
 * `html-converter.mjs` is in Node — read the two side by side.
 *
 * Nothing here is orchestration for a page: no progress reporting, no file
 * picker, no download. That belongs to the conversion page (group 5), and
 * keeping it out means this is drivable from a test without one.
 */
import { convertStandaloneCore } from '../core/convert-standalone.mjs';
import { convertHandoffBundleToBytes } from '../core/convert-bundle.mjs';
import { createMemoryBundle } from './memory-bundle.mjs';
import { canvasImageOps } from './canvas-image-ops.mjs';

/**
 * @param {string} sourceHtml - The Claude Design standalone export, as text.
 * @param {import('../core/host-contract.mjs').ConversionHost} host
 *   A `BrowserConversionHost`, already constructed over the same text.
 * @param {object} [opts]
 * @param {string} [opts.title] - Overrides the export's own `<title>`.
 * @param {import('../../core/image-ops.mjs').ImageOps} [opts.imageOps]
 *   Defaults to `canvasImageOps`. There is no `sharp` here, so unlike Node
 *   this cannot fall through to a class default.
 * @returns {Promise<{bytes: Uint8Array, manifest: object, warnings: object[],
 *   deck: import('../api-core.mjs').Deck, bundle: object}>}
 */
export async function convertStandaloneToDeckBytes(sourceHtml, host, opts = {}) {
  const { manifest, warnings } = await convertStandaloneCore(sourceHtml, host, opts);
  host.debug?.('convertStandaloneCore returned');

  // The bundle the deck writer consumes. Node writes `manifest.json`,
  // `template.html` and `media/*` into a scratch directory and reads them
  // straight back; here they never leave memory. `template.html` is what
  // `addSVG` markup lookups read, so it is passed through rather than dropped.
  const bundle = createMemoryBundle({
    manifest,
    html: host.texts?.get('template.html') ?? null,
    media: host.media,
  });

  host.debug?.('convertHandoffBundleToBytes start');
  const { bytes, deck, warnings: deckWarnings } = await convertHandoffBundleToBytes(bundle, {
    title: opts.title,
    imageOps: opts.imageOps ?? canvasImageOps,
  });

  // Both stages' losses, in one list, exactly as `html-converter.mjs` joins
  // them in Node. A browser that reported only the extraction warnings would
  // tell a different story about the same export.
  return { bytes, manifest, warnings: [...warnings, ...deckWarnings], deck, bundle };
}
