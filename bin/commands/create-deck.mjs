/**
 * create-deck — Create a new .deck file from scratch.
 *
 * Usage: node cli.mjs create-deck -o <out.deck> [--title "Name"] [--layout cover --layout content ...]
 */
import { statSync } from 'fs';
import { resolve } from 'path';
import { createDraftTemplate } from '../../lib/slides/template-deck.mjs';

export async function run(args, flags) {
  const outPath = flags.o || flags.out || flags.output;
  if (!outPath || outPath === true) {
    console.error('Usage: create-deck -o <out.deck> [--title "Name"] [--layout <name> ...]');
    console.error('  -o / --out   (required)  output .deck path');
    console.error('  --title      (optional)  presentation name (default: "Untitled")');
    console.error('  --layout     (optional, repeatable) layout name(s) for blank slides (default: cover)');
    process.exit(1);
  }

  const title = typeof flags.title === 'string' ? flags.title : undefined;
  const layouts = Array.isArray(flags.layout)
    ? flags.layout
    : (flags.layout ? [flags.layout] : undefined);

  await createDraftTemplate(outPath, {
    ...(title !== undefined ? { title } : {}),
    ...(layouts ? { layouts } : {}),
  });

  const absolute = resolve(outPath);
  const bytes = statSync(absolute).size;
  const slideCount = layouts ? layouts.length : 1;
  console.log(`Saved: ${outPath} (${bytes} bytes, ${slideCount} slide${slideCount === 1 ? '' : 's'})`);
}
