#!/usr/bin/env node
/**
 * Generate an HTML visual comparison report: reference vs rendered, side-by-side.
 *
 * Usage:
 *   node lib/rasterizer/render-report.mjs [file.deck] [ref-dir] [output.html]
 *
 * Defaults:
 *   deck    = decks/reference/oil-machinations.deck
 *   ref-dir = decks/reference/oil-machinations/
 *   output  = /tmp/openfig-render-report.html
 */

import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { generateRenderReportFromDeck } from './render-report-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const [,, deckArg, refDirArg, outArg] = process.argv;
const DECK_PATH = resolve(deckArg  ?? join(__dirname, '../../decks/reference/oil-machinations.deck'));
const REF_DIR   = resolve(refDirArg ?? join(__dirname, '../../decks/reference/oil-machinations'));
const OUT_HTML  = outArg ?? '/tmp/openfig-render-report.html';
await generateRenderReportFromDeck({ deckPath: DECK_PATH, refDir: REF_DIR, outHtml: OUT_HTML });
console.log(`\nReport → ${OUT_HTML}`);
