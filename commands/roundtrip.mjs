/**
 * roundtrip — Decode and re-encode a deck with zero changes (pipeline validation).
 *
 * Usage: node cli.mjs roundtrip <file.deck> -o <output.deck>
 */
import { FigDeck } from '../lib/core/fig-deck.mjs';

export async function run(args, flags) {
  const file = args[0];
  const outPath = flags.o || flags.output;

  if (!file || !outPath) {
    console.error('Usage: roundtrip <file.deck> -o <output.deck>');
    process.exit(1);
  }

  console.log(`Reading: ${file}`);
  const deck = await FigDeck.fromDeckFile(file);

  const slides = deck.getSlides();
  const active = deck.getActiveSlides();
  const instances = deck.getInstances();
  const symbols = deck.getSymbols();

  console.log(`  Nodes: ${deck.message.nodeChanges.length}`);
  console.log(`  Slides: ${active.length} active / ${slides.length} total`);
  console.log(`  Instances: ${instances.length}`);
  console.log(`  Symbols: ${symbols.length}`);
  console.log(`  Blobs: ${deck.message.blobs?.length || 0}`);
  console.log(`  Chunks: ${deck.rawFiles.length}`);
  if (deck.deckMeta) console.log(`  Deck name: ${deck.deckMeta.file_name || '(unknown)'}`);

  console.log(`\nEncoding...`);
  const bytes = await deck.saveDeck(outPath);
  console.log(`Saved: ${outPath} (${bytes} bytes)`);
  console.log(`\nRoundtrip complete. Open in Figma to verify.`);
}
