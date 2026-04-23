/**
 * convert-html — Convert a Claude Design standalone HTML export into a .deck file.
 *
 * Usage: openfig convert-html <input.html> -o <out.deck> [--title "Name"] [--dry-run]
 */
import { statSync } from 'fs';
import { resolve } from 'path';
import { convertStandaloneHtml } from '../../lib/slides/html-converter.mjs';

export async function run(args, flags) {
  const inPath = args[0];
  const outPath = flags.o || flags.out || flags.output;
  const dryRun = !!(flags['dry-run'] || flags.dryRun);
  if (!inPath || (!dryRun && (!outPath || outPath === true))) {
    console.error('Usage: convert-html <input.html> -o <out.deck> [--title "Name"] [--dry-run]');
    console.error('  <input.html>  (required)  Claude Design standalone HTML export');
    console.error('  -o / --out    (required unless --dry-run)  output .deck path');
    console.error('  --title       (optional)  presentation name (default: inferred from <title>)');
    console.error('  --dry-run     (optional)  extract geometry only, skip .deck emission');
    process.exit(1);
  }

  const title = typeof flags.title === 'string' ? flags.title : undefined;
  const opts = {};
  if (title) opts.title = title;
  if (dryRun) opts.dryRun = true;

  // In dry-run mode there's no .deck output path; pick a scratch-only target
  // next to the input so the extractor's scratch directory lives somewhere
  // predictable for inspection.
  const effectiveOut = outPath && outPath !== true
    ? outPath
    : inPath.replace(/\.html?$/i, '') + '.dryrun.deck';
  const result = await convertStandaloneHtml(inPath, effectiveOut, opts);

  if (dryRun) {
    console.log(`Dry run: extracted ${result.manifest.slides.length} slide(s); manifest at ${result.scratchDir}/manifest.json`);
    return;
  }

  const absolute = resolve(outPath);
  const bytes = statSync(absolute).size;
  console.log(`Saved: ${outPath} (${bytes} bytes)`);
}
