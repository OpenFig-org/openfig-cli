/**
 * deck-to-fig — Convert a Figma Slides (.deck) file to a standard Figma Design (.fig) file.
 *
 * Usage: openfig deck-to-fig <input.deck> -o <output.fig> [options]
 */
import { statSync, existsSync, readdirSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { convertDeckToFig } from 'openfig-core';

export async function run(args, flags) {
  const inPath = args[0];
  const outPath = flags.o || flags.out || flags.output;
  const dryRun = !!(flags['dry-run'] || flags.dryRun);

  if (!inPath || (!dryRun && (!outPath || outPath === true))) {
    console.error('Usage: openfig deck-to-fig <input.deck> -o <output.fig> [options]');
    console.error('  <input.deck>  (required)  Figma Slides .deck file');
    console.error('  -o / --out    (required unless --dry-run)  output .fig path');
    console.error('  --title       (optional)  canvas/page name (default: deck title)');
    console.error('  --layout      (optional)  frame arrangement: "row" or "grid" (default: "row")');
    console.error('  --gap         (optional)  gap between frames in pixels (default: 200)');
    console.error('  --wrap        (optional)  number of frames per row in grid layout (default: 5)');
    console.error('  --dry-run     (optional)  run transform and print summary without emitting file');
    process.exit(1);
  }

  const title = typeof flags.title === 'string' ? flags.title : undefined;
  const layout = typeof flags.layout === 'string' ? flags.layout.toLowerCase() : 'row';
  const gap = flags.gap ? parseInt(flags.gap, 10) : 200;
  const wrap = flags.wrap ? parseInt(flags.wrap, 10) : 5;

  if (layout !== 'row' && layout !== 'grid') {
    console.error(`Error: Invalid layout "${layout}". Must be either "row" or "grid".`);
    process.exit(1);
  }

  if (isNaN(gap) || gap < 0) {
    console.error(`Error: Invalid gap value "${flags.gap}". Must be a non-negative number.`);
    process.exit(1);
  }

  if (isNaN(wrap) || wrap <= 0) {
    console.error(`Error: Invalid wrap value "${flags.wrap}". Must be a positive integer.`);
    process.exit(1);
  }

  console.log(`Reading slides deck: ${inPath}`);
  const deck = await FigDeck.fromDeckFile(inPath);

  const imagesMap = new Map();
  if (deck.imagesDir && existsSync(deck.imagesDir)) {
    const files = readdirSync(deck.imagesDir);
    for (const f of files) {
      const fullPath = join(deck.imagesDir, f);
      const stats = statSync(fullPath);
      if (stats.isFile()) {
        imagesMap.set(f, new Uint8Array(readFileSync(fullPath)));
      }
    }
  }

  // Build FigDocument for openfig-core convert transform
  const inputDoc = {
    header: deck.header,
    nodes: deck.message.nodeChanges,
    nodeMap: deck.nodeMap,
    childrenMap: deck.childrenMap,
    schema: deck.schema,
    compiledSchema: deck.compiledSchema,
    rawChunks: deck.rawFiles,
    message: deck.message,
    meta: deck.deckMeta,
    thumbnail: deck.deckThumbnail,
    images: imagesMap,
  };

  console.log(`Baking slides content with overrides...`);
  const designDoc = convertDeckToFig(inputDoc, {
    title,
    layout,
    gap,
    wrap,
  });

  const canvas = designDoc.nodes.find((n) => n.type === 'CANVAS');
  const canvasGuidStr = canvas ? `${canvas.guid.sessionID}:${canvas.guid.localID}` : '';
  const frames = designDoc.nodes.filter(
    (n) => n.type === 'FRAME' && n.parentIndex?.guid &&
           `${n.parentIndex.guid.sessionID}:${n.parentIndex.guid.localID}` === canvasGuidStr
  );

  if (dryRun) {
    console.log('\n--- DRY RUN SUMMARY ---');
    console.log(`Canvas Page Title: "${canvas?.name || '(Untitled)'}"`);
    console.log(`Layout strategy  : ${layout.toUpperCase()} (gap: ${gap}px${layout === 'grid' ? `, wrap: ${wrap}` : ''})`);
    console.log(`Frame count      : ${frames.length}`);
    console.log('\nFrames positioned on canvas:');
    frames.forEach((f, idx) => {
      const x = f.transform?.m02 ?? 0;
      const y = f.transform?.m12 ?? 0;
      const w = f.size?.x ?? 1920;
      const h = f.size?.y ?? 1080;
      console.log(`  [${String(idx + 1).padStart(2, '0')}] "${f.name}"  size: ${w}x${h}  pos: (${x}, ${y})`);
    });
    console.log('\nDry run complete. No file was written.');
    return;
  }

  console.log(`Encoding output Design file...`);
  const outputDeck = new FigDeck();
  outputDeck.header = { prelude: 'fig-kiwi', version: designDoc.header.version };
  outputDeck.schema = designDoc.schema;
  outputDeck.compiledSchema = designDoc.compiledSchema;
  outputDeck.message = designDoc.message;
  outputDeck.rawFiles = designDoc.rawChunks;
  outputDeck.rebuildMaps();
  outputDeck.deckMeta = designDoc.meta;
  outputDeck.deckThumbnail = designDoc.thumbnail;
  outputDeck.imagesDir = deck.imagesDir;

  const absoluteOut = resolve(outPath);
  await outputDeck.saveDeck(absoluteOut);

  const bytes = statSync(absoluteOut).size;
  console.log(`Saved: ${outPath} (${bytes} bytes)`);
  console.log(`Success! Conversion complete. Output file is valid Figma Design format.`);
}
