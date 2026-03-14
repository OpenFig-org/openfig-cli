/**
 * list-text — List all text content in the deck.
 *
 * Usage: node cli.mjs list-text <file.deck>
 */
import { FigDeck } from '../lib/core/fig-deck.mjs';
import { nid } from '../lib/core/node-helpers.mjs';
import { hashToHex } from '../lib/core/image-helpers.mjs';

export async function run(args) {
  const file = args[0];
  if (!file) { console.error('Usage: list-text <file.deck>'); process.exit(1); }

  const deck = file.endsWith('.fig')
    ? FigDeck.fromFigFile(file)
    : await FigDeck.fromDeckFile(file);

  // Direct text nodes
  console.log('=== Direct text nodes ===\n');
  for (const node of deck.message.nodeChanges) {
    if (node.type === 'TEXT' && node.textData?.characters) {
      const text = node.textData.characters;
      const preview = text.length > 80 ? text.substring(0, 77) + '...' : text;
      console.log(`[${nid(node)}] "${node.name || ''}" → ${JSON.stringify(preview)}`);
    }
  }

  // Override text per slide
  console.log('\n=== Override text (per slide instance) ===\n');
  const slides = deck.getActiveSlides();

  for (const slide of slides) {
    const inst = deck.getSlideInstance(nid(slide));
    if (!inst) continue;

    const symId = inst.symbolData?.symbolID;
    const symStr = symId ? `${symId.sessionID}:${symId.localID}` : '?';
    console.log(`SLIDE "${slide.name || nid(slide)}" → INSTANCE (${nid(inst)}) sym=${symStr}`);

    const overrides = inst.symbolData?.symbolOverrides || [];
    for (const ov of overrides) {
      const path = (ov.guidPath?.guids || [])
        .map(g => `${g.sessionID}:${g.localID}`).join(' → ');

      if (ov.textData?.characters) {
        const text = ov.textData.characters;
        const preview = text.length > 80 ? text.substring(0, 77) + '...' : text;
        console.log(`  ${path}  TEXT: ${JSON.stringify(preview)}`);
      }
      if (ov.fillPaints?.length) {
        const paint = ov.fillPaints[0];
        if (paint.type === 'IMAGE' && paint.image?.hash) {
          const hex = hashToHex(paint.image.hash);
          console.log(`  ${path}  IMAGE: ${hex} (${paint.originalImageWidth}×${paint.originalImageHeight})`);
        }
      }
    }
    console.log('');
  }
}
