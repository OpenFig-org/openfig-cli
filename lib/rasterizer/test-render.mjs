#!/usr/bin/env node
/**
 * Test harness: render slide N from a .deck file to PNG.
 *
 * Usage:
 *   node lib/rasterizer/test-render.mjs <file.deck> [slide-number] [--width 960] [--height 540] [--scale 0.5]
 *
 * slide-number is 1-based (default: 1). Size options are mutually exclusive.
 * Output: /tmp/openfig-test-slide-N.png
 */

import { writeFileSync } from 'fs';
import { FigDeck } from '../core/fig-deck.mjs';
import { slideToSvg } from './svg-builder.mjs';
import { svgToPng } from './deck-rasterizer.mjs';

// Minimal arg parser
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    flags[argv[i].slice(2)] = argv[++i];
  } else {
    positional.push(argv[i]);
  }
}
const [file, slideArg] = positional;
if (!file) {
  console.error('Usage: node lib/rasterizer/test-render.mjs <file.deck> [slide-number]');
  process.exit(1);
}

const slideNum = parseInt(slideArg ?? '1', 10);

const deck = await FigDeck.fromDeckFile(file);

console.log(`Deck: ${file}`);
console.log(`Active slides: ${deck.getActiveSlides().length}`);

const slide = deck.getSlide(slideNum);
console.log(`Rendering slide ${slideNum}: "${slide.name ?? ''}"`);

const svg = slideToSvg(deck, slide);
const outSvg = `/tmp/openfig-test-slide-${slideNum}.svg`;
writeFileSync(outSvg, svg);
console.log(`  SVG → ${outSvg}`);

const renderOpts = {};
if (flags.width)  renderOpts.width  = parseInt(flags.width);
if (flags.height) renderOpts.height = parseInt(flags.height);
if (flags.scale)  renderOpts.scale  = parseFloat(flags.scale);

const png = await svgToPng(svg, renderOpts);
const outPng = `/tmp/openfig-test-slide-${slideNum}.png`;
writeFileSync(outPng, png);
console.log(`  PNG → ${outPng}`);
