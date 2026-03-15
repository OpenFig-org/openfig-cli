/**
 * pdf — Export slides from a .deck file to a multi-page PDF.
 *
 * Usage:
 *   openfig pdf <file.deck> [options]
 *
 * Options:
 *   -o <file.pdf>   Output PDF path (default: <deckname>.pdf)
 *   --slide <n>     Export only slide N (1-based). Omit to export all.
 *   --scale <n>     Zoom factor: 1 = 1920×1080, 0.5 = 960×540 (default: 1)
 *   --width <px>    Output width in pixels (height scales proportionally)
 *   --fonts <dir>   Extra font directory to load (can repeat)
 */

import { writeFileSync } from 'fs';
import { parse, resolve } from 'path';
import { PDFDocument } from 'pdf-lib';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { renderDeck, registerFontDir } from '../../lib/rasterizer/deck-rasterizer.mjs';
import { resolveFonts } from '../../lib/rasterizer/font-resolver.mjs';

export async function run(args, flags) {
  const file = args[0];
  if (!file) {
    console.error('Usage: openfig pdf <file.deck> [options]\n');
    console.error('Options:');
    console.error('  -o <file.pdf>   Output PDF path (default: <deckname>.pdf)');
    console.error('  --slide <n>     Export only slide N (1-based)');
    console.error('  --scale <n>     Zoom factor: 1 = 1920×1080 (default: 1)');
    console.error('  --width <px>    Output width in pixels');
    console.error('  --fonts <dir>   Extra font directory to load');
    process.exit(1);
  }

  const defaultOut = parse(file).name + '.pdf';
  const outPath = resolve(flags.o ?? flags.output ?? defaultOut);

  const renderOpts = {};
  if (flags.width) renderOpts.width = parseInt(flags.width);
  else if (flags.scale) renderOpts.scale = parseFloat(flags.scale);

  const fontDirs = [].concat(flags.fonts ?? []);
  for (const d of fontDirs) registerFontDir(resolve(d));

  const deck = await FigDeck.fromDeckFile(file);
  await resolveFonts(deck, { quiet: false });

  const slideFilter = flags.slide ? parseInt(flags.slide) : null;
  const slides = await renderDeck(deck, renderOpts);

  const doc = await PDFDocument.create();

  let count = 0;
  for (const { index, png } of slides) {
    if (slideFilter && index + 1 !== slideFilter) continue;
    const image = await doc.embedPng(png);
    const page = doc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    count++;
    console.log(`  slide ${index + 1}  →  page ${count}`);
  }

  const pdfBytes = await doc.save();
  writeFileSync(outPath, pdfBytes);
  console.log(`\nExported ${count} slide(s) to ${outPath} (${pdfBytes.length} bytes)`);
}
