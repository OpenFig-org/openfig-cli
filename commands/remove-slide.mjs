/**
 * remove-slide — Mark slides as REMOVED.
 *
 * Usage: node cli.mjs remove-slide <file.deck> -o <output.deck> --slide <id|name> [--slide ...]
 */
import { FigDeck } from '../lib/core/fig-deck.mjs';
import { nid, removeNode } from '../lib/core/node-helpers.mjs';

export async function run(args, flags) {
  const file = args[0];
  const outPath = flags.o || flags.output;
  const slideRefs = Array.isArray(flags.slide) ? flags.slide : (flags.slide ? [flags.slide] : []);

  if (!file || !outPath || slideRefs.length === 0) {
    console.error('Usage: remove-slide <file.deck> -o <out.deck> --slide <id|name> [--slide ...]');
    process.exit(1);
  }

  const deck = await FigDeck.fromDeckFile(file);

  let removed = 0;
  for (const ref of slideRefs) {
    const slide = findSlide(deck, ref);
    if (!slide) { console.error(`Slide not found: ${ref}`); continue; }

    removeNode(slide);
    console.log(`  REMOVED slide "${slide.name || ''}" (${nid(slide)})`);

    // Also remove child instances
    for (const child of deck.getChildren(nid(slide))) {
      removeNode(child);
      console.log(`    REMOVED child ${child.type} (${nid(child)})`);
    }
    removed++;
  }

  console.log(`\nRemoved ${removed} slide(s)`);

  const bytes = await deck.saveDeck(outPath);
  console.log(`Saved: ${outPath} (${bytes} bytes)`);
}

function findSlide(deck, ref) {
  const byId = deck.getNode(ref);
  if (byId?.type === 'SLIDE') return byId;
  return deck.getActiveSlides().find(s => s.name === ref);
}
