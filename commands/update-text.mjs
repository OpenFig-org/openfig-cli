/**
 * update-text — Apply text overrides to an instance on a slide.
 *
 * Usage: node cli.mjs update-text <file.deck> -o <output.deck> --slide <id|name> --set key=value [--set key=value ...]
 */
import { FigDeck } from '../lib/core/fig-deck.mjs';
import { nid, parseId } from '../lib/core/node-helpers.mjs';

export async function run(args, flags) {
  const file = args[0];
  const outPath = flags.o || flags.output;
  const slideRef = flags.slide;
  const sets = Array.isArray(flags.set) ? flags.set : (flags.set ? [flags.set] : []);

  if (!file || !outPath || !slideRef || sets.length === 0) {
    console.error('Usage: update-text <file.deck> -o <out.deck> --slide <id|name> --set key=value [--set ...]');
    process.exit(1);
  }

  const deck = await FigDeck.fromDeckFile(file);

  // Find slide by ID or name
  const slide = findSlide(deck, slideRef);
  if (!slide) { console.error(`Slide not found: ${slideRef}`); process.exit(1); }

  const inst = deck.getSlideInstance(nid(slide));
  if (!inst) { console.error(`No instance found on slide ${nid(slide)}`); process.exit(1); }

  // Ensure symbolOverrides exists
  if (!inst.symbolData) inst.symbolData = {};
  if (!inst.symbolData.symbolOverrides) inst.symbolData.symbolOverrides = [];

  let updated = 0;
  for (const pair of sets) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) { console.error(`Invalid --set format: ${pair}`); continue; }
    const keyStr = pair.substring(0, eqIdx);
    let value = pair.substring(eqIdx + 1);

    // Empty string → space (prevents Figma crash)
    if (value === '') value = ' ';

    const key = parseId(keyStr);
    const overrides = inst.symbolData.symbolOverrides;

    // Find existing override for this key
    const existing = overrides.find(o =>
      o.guidPath?.guids?.length === 1 &&
      o.guidPath.guids[0].sessionID === key.sessionID &&
      o.guidPath.guids[0].localID === key.localID &&
      o.textData
    );

    if (existing) {
      existing.textData.characters = value;
    } else {
      overrides.push({
        guidPath: { guids: [key] },
        textData: { characters: value },
      });
    }
    updated++;
    console.log(`  ${keyStr} → ${JSON.stringify(value.substring(0, 60))}`);
  }

  console.log(`Updated ${updated} text override(s) on slide "${slide.name || nid(slide)}"`);

  const bytes = await deck.saveDeck(outPath);
  console.log(`Saved: ${outPath} (${bytes} bytes)`);
}

function findSlide(deck, ref) {
  // Try as ID first
  const byId = deck.getNode(ref);
  if (byId?.type === 'SLIDE') return byId;

  // Try as name
  return deck.getActiveSlides().find(s => s.name === ref);
}
