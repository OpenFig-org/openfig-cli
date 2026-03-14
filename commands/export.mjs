/**
 * export — Export slides from a .deck file to images.
 *
 * Usage:
 *   openfig export <file.deck> [options]
 *
 * Options:
 *   -o <dir>        Output directory (default: <deckname>/)
 *   --slide <n>     Export only slide N (1-based). Omit to export all.
 *   --scale <n>     Zoom factor: 1 = 1920×1080, 0.5 = 960×540 (default: 1)
 *   --width <px>    Output width in pixels (height scales proportionally)
 *   --format <fmt>  Output format: png, jpg, webp (default: png)
 *   --fonts <dir>   Extra font directory to load (can repeat)
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, parse, resolve } from 'path';
import { createInterface } from 'readline';
import { FigDeck } from '../lib/core/fig-deck.mjs';
import { renderDeck, registerFontDir } from '../lib/rasterizer/deck-rasterizer.mjs';
import { resolveFonts } from '../lib/rasterizer/font-resolver.mjs';

async function confirmOverwrite(dir) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log(`Output directory "${dir}" already exists.`);
    rl.question(`Delete and replace all contents? (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

export async function run(args, flags) {
  const file = args[0];
  if (!file) {
    console.error('Usage: openfig export <file.deck> [options]\n');
    console.error('Options:');
    console.error('  -o <dir>        Output directory (default: <deckname>/)');
    console.error('  --slide <n>     Export only slide N (1-based)');
    console.error('  --scale <n>     Zoom factor: 1 = 1920×1080, 0.5 = 960×540 (default: 1)');
    console.error('  --width <px>    Output width in pixels (height scales proportionally)');
    console.error('  --format <fmt>  Output format: png, jpg, webp (default: png)');
    console.error('  --fonts <dir>   Extra font directory to load');
    process.exit(1);
  }

  const defaultOutDir = parse(file).name;
  const outDir = resolve(flags.o ?? flags.output ?? defaultOutDir);

  if (existsSync(outDir)) {
    const confirmed = await confirmOverwrite(outDir);
    if (!confirmed) {
      console.log('Aborted.');
      process.exit(0);
    }
    rmSync(outDir, { recursive: true });
  }

  const renderOpts = {};
  if (flags.width) renderOpts.width = parseInt(flags.width);
  else if (flags.scale) renderOpts.scale = parseFloat(flags.scale);

  const fontDirs = [].concat(flags.fonts ?? []);
  for (const d of fontDirs) registerFontDir(resolve(d));

  const deck = await FigDeck.fromDeckFile(file);
  await resolveFonts(deck, { quiet: false });
  mkdirSync(outDir, { recursive: true });

  const slideFilter = flags.slide ? parseInt(flags.slide) : null;
  const slides = await renderDeck(deck, renderOpts);

  for (const { index, slideId, png } of slides) {
    if (slideFilter && index + 1 !== slideFilter) continue;
    const outFile = join(outDir, `slide_${String(index + 1).padStart(3, '0')}.png`);
    writeFileSync(outFile, png);
    console.log(`  slide ${index + 1}  →  ${outFile}`);
  }

  const count = slideFilter ? 1 : slides.length;
  console.log(`\nExported ${count} slide(s) to ${outDir}`);
}
