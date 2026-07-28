/**
 * `convert-html`'s Node entry point.
 *
 * The conversion itself lives in `core/convert-standalone.mjs`, which is
 * environment-agnostic; this file supplies the two things only Node can — the
 * export's bytes off disk and a scratch directory — and then hands the result
 * to the Node-only deck-emission tail.
 *
 * Path arithmetic stays here on purpose: the core takes no paths at all.
 */
import { readFileSync } from 'fs';
import { convertHandoffBundle } from './handoff-converter.mjs';
import { convertStandaloneCore } from './core/convert-standalone.mjs';
import { NodeConversionHost } from './node/node-conversion-host.mjs';

export async function convertStandaloneHtml(htmlPath, outDeckPath, opts = {}) {
  const src = readFileSync(htmlPath, 'utf8');
  const scratch = opts.scratchDir ?? (outDeckPath.replace(/\.deck$/, '') + '-html-build');

  const host = new NodeConversionHost({ sourcePath: htmlPath, scratchDir: scratch });
  const { manifest, warnings } = await convertStandaloneCore(src, host, opts);

  // Dry-run: skip the .deck emission. Returns the intermediate geometry so
  // callers can inspect Chromium's wrap points without paying the full
  // handoff-bundle conversion cost. Used by Phase 2 font-metric experiments.
  if (opts.dryRun) {
    return { manifest, warnings, scratchDir: scratch };
  }

  const result = await convertHandoffBundle(scratch, outDeckPath, { scratchDir: scratch, ...opts });
  return { ...result, warnings };
}
