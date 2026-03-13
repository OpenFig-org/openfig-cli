/**
 * Core codec tests — verify that FigDeck can parse both .deck (Slides)
 * and .fig (Design) files. The codec is format-agnostic: same kiwi schema
 * + zstd pipeline, same ZIP structure (canvas.fig + meta.json + thumbnail).
 *
 * Fixtures:
 *   decks/reference/   — .deck files (Figma Slides)
 *   figs/reference/    — .fig files (Figma Design)
 */

import { describe, it, expect } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { nid } from '../../lib/core/node-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK_PATH = join(__dirname, '../../decks/reference/oil-machinations.deck');
const FIG_PATH  = join(__dirname, '../../figs/reference/open-peeps.fig');
const FIG_SMALL = join(__dirname, '../../figs/reference/medium-complex.fig');

// ── .deck (Figma Slides) ─────────────────────────────────────────────────────

describe('.deck codec (Figma Slides)', () => {
  let fd;

  it('parses a .deck file', async () => {
    fd = await FigDeck.fromDeckFile(DECK_PATH);
    expect(fd.header).toBeTruthy();
    expect(fd.message).toBeTruthy();
  });

  it('has fig-deck prelude', () => {
    expect(fd.header.prelude).toBe('fig-deck');
  });

  it('builds nodeMap and childrenMap', () => {
    expect(fd.nodeMap.size).toBeGreaterThan(0);
    expect(fd.childrenMap.size).toBeGreaterThan(0);
  });

  it('contains SLIDE nodes', () => {
    const slides = fd.getActiveSlides();
    expect(slides.length).toBeGreaterThan(0);
    expect(slides[0].type).toBe('SLIDE');
  });

  it('has meta.json with file_name', () => {
    expect(fd.deckMeta).toBeTruthy();
    expect(fd.deckMeta.file_name).toBeTruthy();
  });

  it('has a thumbnail', () => {
    expect(fd.deckThumbnail).toBeTruthy();
    expect(fd.deckThumbnail.length).toBeGreaterThan(0);
  });
});

// ── .fig (Figma Design) ──────────────────────────────────────────────────────

describe('.fig codec (Figma Design)', () => {
  let fd;

  it('parses a .fig file (same ZIP structure as .deck)', async () => {
    fd = await FigDeck.fromDeckFile(FIG_PATH);
    expect(fd.header).toBeTruthy();
    expect(fd.message).toBeTruthy();
  });

  it('has fig-kiwi prelude (not fig-deck)', () => {
    expect(fd.header.prelude).toBe('fig-kiwi');
  });

  it('builds nodeMap and childrenMap', () => {
    expect(fd.nodeMap.size).toBeGreaterThan(0);
    expect(fd.childrenMap.size).toBeGreaterThan(0);
  });

  it('has pages (CANVAS nodes) instead of SLIDEs', () => {
    expect(fd.getActiveSlides().length).toBe(0);
    expect(fd.getPages().length).toBeGreaterThan(0);
  });

  it('contains SYMBOL and INSTANCE nodes', () => {
    const symbols = fd.getSymbols();
    const instances = fd.getInstances();
    expect(symbols.length).toBeGreaterThan(0);
    expect(instances.length).toBeGreaterThan(0);
  });

  it('contains VECTOR nodes with blobs', () => {
    const vectors = fd.message.nodeChanges.filter(n => n.type === 'VECTOR');
    expect(vectors.length).toBeGreaterThan(0);
    expect(fd.message.blobs.length).toBeGreaterThan(0);
  });

  it('has meta.json with file_name', () => {
    expect(fd.deckMeta).toBeTruthy();
    expect(fd.deckMeta.file_name).toBe('open-peeps');
  });

  it('node tree is walkable', () => {
    const doc = fd.message.nodeChanges.find(n => n.type === 'DOCUMENT');
    expect(doc).toBeTruthy();
    let visited = 0;
    fd.walkTree(nid(doc), () => { visited++; });
    expect(visited).toBeGreaterThan(100);
  });
});

// ── .fig multi-page (medium-complex) ─────────────────────────────────────────

describe('.fig codec (medium-complex, multi-page)', () => {
  let fd;

  it('parses a smaller .fig file', async () => {
    fd = await FigDeck.fromDeckFile(FIG_SMALL);
    expect(fd.header.prelude).toBe('fig-kiwi');
    expect(fd.message.nodeChanges.length).toBeGreaterThan(0);
  });

  it('getPages() returns user-facing pages sorted by position', () => {
    const pages = fd.getPages();
    expect(pages.length).toBe(3);
    // Great Seal Page was dragged to the top in Figma — position ordering must reflect this
    expect(pages.map(c => c.name)).toEqual(['Great Seal Page', 'Page 2', 'Page 3']);
  });

  it('getPage(n) is 1-indexed and respects sort order', () => {
    expect(fd.getPage(1).name).toBe('Great Seal Page');
    expect(fd.getPage(2).name).toBe('Page 2');
    expect(fd.getPage(3).name).toBe('Page 3');
    expect(() => fd.getPage(0)).toThrow(RangeError);
    expect(() => fd.getPage(4)).toThrow(RangeError);
  });

  it('Internal Only Canvas exists in raw data but is filtered by getPages()', () => {
    const allCanvases = fd.message.nodeChanges.filter(n => n.type === 'CANVAS');
    expect(allCanvases.length).toBe(4);
    expect(allCanvases.find(c => c.name === 'Internal Only Canvas')).toBeTruthy();
  });

  it('each page has children', () => {
    const canvases = fd.message.nodeChanges
      .filter(n => n.type === 'CANVAS' && n.name !== 'Internal Only Canvas');
    for (const page of canvases) {
      const children = fd.getChildren(nid(page));
      expect(children.length).toBeGreaterThan(0);
    }
  });
});
