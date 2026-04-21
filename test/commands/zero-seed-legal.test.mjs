/**
 * Legal assertion tests — ensure decks produced by the zero-seed pipeline
 * contain no Figma-authored theme content (strings, node names, VARIABLE_SET
 * nodes) extracted from a real Figma Slides document.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { Deck } from '../../lib/slides/api.mjs';
import { FigDeck } from '../../lib/core/fig-deck.mjs';

const FIGMA_THEME_STRINGS = [
  'Light slides',
  'Pale Persimmon',
  'Pale Pink',
  'Persimmon',
  'Pale Teal',
  'Pale Violet',
  'Pale Yellow',
  'Pale Red',
  'Pale Green',
  'Pale Blue',
  'Pale Purple',
];

const FIGMA_STYLE_NAMES = [
  'Title',
  'Header 1',
  'Header 2',
  'Header 3',
  'Body 1',
  'Body 2',
  'Body 3',
  'Note',
];

let workDir;
let deckPath;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'openfig-zero-seed-'));
  deckPath = join(workDir, 'out.deck');
  const deck = await Deck.create({ name: 'Zero-seed test' });
  await deck.save(deckPath);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function extractCanvasFig(path) {
  const tmp = mkdtempSync(join(tmpdir(), 'openfig-unzip-'));
  execSync(`unzip -o "${path}" -d "${tmp}"`, { stdio: 'pipe' });
  const bytes = readFileSync(join(tmp, 'canvas.fig'));
  rmSync(tmp, { recursive: true, force: true });
  return bytes;
}

describe('zero-seed deck — legal assertions', () => {
  it('does not contain any Figma Light Slides theme strings in the canvas.fig bytes', () => {
    const bytes = extractCanvasFig(deckPath);
    const text = bytes.toString('latin1');
    for (const forbidden of FIGMA_THEME_STRINGS) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('only contains OpenFig-authored VARIABLE_SET and VARIABLE nodes', async () => {
    // Phase 2 adds an OpenFig-authored neutral theme. Legal guarantee: any
    // theme nodes present must carry OpenFig-authored names, never Figma ones.
    const fd = await FigDeck.fromDeckFile(deckPath);
    const varSets = fd.message.nodeChanges.filter(n => n.type === 'VARIABLE_SET');
    const vars = fd.message.nodeChanges.filter(n => n.type === 'VARIABLE');
    const allowedVsetNames = ['OpenFig default'];
    const allowedVarNames = ['Ink', 'Paper', 'Accent'];
    for (const vs of varSets) {
      expect(allowedVsetNames).toContain(vs.name);
    }
    for (const v of vars) {
      expect(allowedVarNames).toContain(v.name);
    }
  });

  it('contains the OpenFig-authored neutral theme (Phase 2)', async () => {
    const fd = await FigDeck.fromDeckFile(deckPath);
    const vset = fd.message.nodeChanges.find(n => n.type === 'VARIABLE_SET' && n.name === 'OpenFig default');
    expect(vset).toBeDefined();
    const doc = fd.message.nodeChanges.find(n => n.type === 'DOCUMENT');
    expect(doc.themeID?.guid).toBeDefined();
    expect(doc.slideThemeMap?.entries?.length).toBeGreaterThan(0);
    const styleNames = fd.message.nodeChanges
      .filter(n => n.type === 'TEXT' && n.styleType === 'TEXT')
      .map(n => n.name);
    expect(styleNames).toEqual(expect.arrayContaining(['Heading', 'Body', 'Caption']));
  });

  it('does not contain Figma-authored named TEXT styles under Internal Only Canvas', async () => {
    const fd = await FigDeck.fromDeckFile(deckPath);
    const internal = fd.message.nodeChanges.find(
      n => n.type === 'CANVAS' && n.name === 'Internal Only Canvas',
    );
    expect(internal).toBeDefined();
    const internalId = `${internal.guid.sessionID}:${internal.guid.localID}`;
    const forbidden = fd.message.nodeChanges.filter(n =>
      n.type === 'TEXT' &&
      FIGMA_STYLE_NAMES.includes(n.name) &&
      n.parentIndex?.guid &&
      `${n.parentIndex.guid.sessionID}:${n.parentIndex.guid.localID}` === internalId,
    );
    expect(forbidden).toEqual([]);
  });

  it('preserves the minimum valid Slides hierarchy', async () => {
    const fd = await FigDeck.fromDeckFile(deckPath);
    const docs = fd.message.nodeChanges.filter(n => n.type === 'DOCUMENT');
    const grids = fd.message.nodeChanges.filter(n => n.type === 'SLIDE_GRID' && n.name === 'Presentation');
    const rows = fd.message.nodeChanges.filter(n => n.type === 'SLIDE_ROW');
    const slides = fd.getActiveSlides();
    const page1 = fd.message.nodeChanges.find(n => n.type === 'CANVAS' && n.name === 'Page 1');

    expect(docs.length).toBe(1);
    expect(page1).toBeDefined();
    expect(grids.length).toBe(1);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(slides.length).toBeGreaterThanOrEqual(1);
  });
});
