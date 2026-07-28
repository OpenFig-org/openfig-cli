/**
 * `convertHandoffBundle`'s Node entry point.
 *
 * The conversion itself lives in `core/convert-bundle.mjs`, which is
 * environment-agnostic; this file supplies the three things only Node can — a
 * bundle read off disk, a scratch directory for the diagnostics sidecar, and
 * the write of the finished `.deck`.
 *
 * `handoff/bundle-loader.mjs` is imported here and nowhere else on the write
 * path. It is only reachable from the string form of `bundlePath`, which only
 * exists in Node, so it keeps all four of its Node imports and its whole
 * `realpath` containment apparatus without any of that reaching a browser
 * bundle.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { Deck } from './api.mjs';
import { sharpImageOps } from '../core/image-utils.mjs';
import { loadBundle } from './handoff/bundle-loader.mjs';
import { convertHandoffBundleToBytes } from './core/convert-bundle.mjs';

export { convertHandoffBundleToBytes };

function scopeScratchDir(outPath) {
  const scratch = outPath.replace(/\.deck$/, '') + '-build';
  mkdirSync(scratch, { recursive: true });
  // Deliberately no `process.env.TMPDIR = scratch` any more. That existed to
  // make `tmpdir()` inside `api.mjs`'s image staging land here rather than in
  // the real temp dir — and task 4b.4 removed the staging, so there is nothing
  // left for it to redirect. It was also a process-global mutation in a
  // long-lived MCP server. Consequence to record rather than discover:
  // temp files are no longer captured by the scratch directory.
  return scratch;
}

/**
 * @param {string|{manifest: object, html?: string|null, resolveMedia: Function}} bundlePath
 *   A bundle directory or `.zip`, or an already-loaded bundle. The object form
 *   is what `browser/memory-bundle.mjs` produces: a browser has no directory
 *   to hand over, and the loader's whole containment apparatus exists to
 *   confine filesystem paths that an in-memory bundle does not have.
 * @param {string} outDeckPath
 * @param {object} [opts]
 * @param {import('../core/image-ops.mjs').ImageOps} [opts.imageOps]
 *   Overrides the sharp raster implementation; see `core/image-ops.mjs`.
 */
export async function convertHandoffBundle(bundlePath, outDeckPath, opts = {}) {
  const bundle = typeof bundlePath === 'string' ? loadBundle(bundlePath) : bundlePath;
  const scratch = opts.scratchDir ?? scopeScratchDir(outDeckPath);

  const { deck, bytes, noWrapDiagnostics } = await convertHandoffBundleToBytes(bundle, {
    ...opts,
    deckClass: Deck,
    imageOps: opts.imageOps ?? sharpImageOps,
  });

  if (noWrapDiagnostics.length) {
    writeFileSync(join(scratch, 'nowrap-diagnostics.json'), JSON.stringify(noWrapDiagnostics, null, 2));
  }

  writeFileSync(resolve(outDeckPath), bytes);
  return { deck, scratchDir: scratch, bundle };
}
