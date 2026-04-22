/**
 * convert-html — Convert a Claude Design standalone HTML export into a .deck file.
 *
 * Usage: openfig convert-html <input.html> -o <out.deck> [--title "Name"]
 */
import { statSync } from 'fs';
import { resolve } from 'path';
import { convertStandaloneHtml } from '../../lib/slides/html-converter.mjs';

export async function run(args, flags) {
  const inPath = args[0];
  const outPath = flags.o || flags.out || flags.output;
  if (!inPath || !outPath || outPath === true) {
    console.error('Usage: convert-html <input.html> -o <out.deck> [--title "Name"]');
    console.error('  <input.html>  (required)  Claude Design standalone HTML export');
    console.error('  -o / --out    (required)  output .deck path');
    console.error('  --title       (optional)  presentation name (default: inferred from <title>)');
    process.exit(1);
  }

  const title = typeof flags.title === 'string' ? flags.title : undefined;
  await convertStandaloneHtml(inPath, outPath, title ? { title } : {});

  const absolute = resolve(outPath);
  const bytes = statSync(absolute).size;
  console.log(`Saved: ${outPath} (${bytes} bytes)`);
}
