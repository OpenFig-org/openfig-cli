/**
 * Tests for slide-primitive features added alongside the London Underground
 * Map fidelity work: addPath, per-run color, letterSpacing / lineHeight,
 * rectangle stroke / dash, text opacity, speaker notes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Deck } from '../../lib/slides/api.mjs';
import { FigDeck } from '../../lib/core/fig-deck.mjs';

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'openfig-prims-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function buildAndReload(fn) {
  const deck = await Deck.create({ name: 'Primitives Test' });
  const slide = deck.addBlankSlide();
  fn(slide);
  const out = join(workDir, 'out.deck');
  await deck.save(out);
  expect(existsSync(out)).toBe(true);
  return FigDeck.fromDeckFile(out);
}

describe('slide primitive extensions', () => {
  it('addText supports letterSpacing (number → PIXELS) and lineHeight', async () => {
    const fd = await buildAndReload(s => {
      s.addText('SPACED', { letterSpacing: 12, lineHeight: 1.55 });
    });
    const node = fd.message.nodeChanges.find(n => n.type === 'TEXT' && n.textData?.characters === 'SPACED');
    expect(node.letterSpacing).toEqual({ value: 12, units: 'PIXELS' });
    expect(node.lineHeight.value).toBeCloseTo(1.55, 3);
  });

  it('addText supports opacity override', async () => {
    const fd = await buildAndReload(s => {
      s.addText('faded', { opacity: 0.15 });
    });
    const node = fd.message.nodeChanges.find(n => n.type === 'TEXT' && n.textData?.characters === 'faded');
    expect(node.opacity).toBeCloseTo(0.15, 3);
  });

  it('addText runs honor per-run color via styleOverrideTable', async () => {
    const fd = await buildAndReload(s => {
      s.addText([
        { text: 'WHITE', color: '#FFFFFF' },
        { text: ' · ', color: '#DC241F' },
        { text: '1933', color: '#C9D4E8' },
      ]);
    });
    const node = fd.message.nodeChanges.find(n => n.type === 'TEXT' && n.textData?.characters.startsWith('WHITE'));
    const table = node.textData.styleOverrideTable;
    expect(table.length).toBeGreaterThanOrEqual(3);
    const withFills = table.filter(e => Array.isArray(e.fillPaints) && e.fillPaints.length);
    expect(withFills.length).toBeGreaterThanOrEqual(3);
  });

  it('addRectangle honors stroke, strokeWeight, dashPattern', async () => {
    const fd = await buildAndReload(s => {
      s.addRectangle(100, 100, 200, 50, {
        fill: 'white',
        stroke: '#E8EAEE',
        strokeWeight: 1,
        dashPattern: [6, 4],
      });
    });
    const rects = fd.message.nodeChanges.filter(n => n.type === 'ROUNDED_RECTANGLE');
    const rect = rects.find(n => n.strokePaints?.length);
    expect(rect).toBeTruthy();
    expect(rect.strokeWeight).toBe(1);
    expect(rect.dashPattern).toEqual([6, 4]);
  });

  it('addLine honors dashPattern and stroke alias', async () => {
    const fd = await buildAndReload(s => {
      s.addLine(0, 0, 500, 0, { stroke: '#DC241F', strokeWeight: 2, dashPattern: [8, 5] });
    });
    const line = fd.message.nodeChanges.find(n => n.type === 'LINE');
    expect(line.strokeWeight).toBe(2);
    expect(line.dashPattern).toEqual([8, 5]);
  });

  it('addPath emits a VECTOR node with stroke paints', async () => {
    const fd = await buildAndReload(s => {
      s.addPath('M 0 0 Q 100 100 200 0', { stroke: '#B36305', strokeWeight: 7 });
    });
    const vec = fd.message.nodeChanges.find(n => n.type === 'VECTOR' && n.name === 'Path');
    expect(vec).toBeTruthy();
    expect(vec.strokeWeight).toBe(7);
    expect(vec.strokePaints?.[0]?.type).toBe('SOLID');
    expect(vec.vectorData?.vectorNetworkBlob).toBeTypeOf('number');
  });

  it('setSpeakerNotes attaches Lexical-wrapped text to the SLIDE node', async () => {
    const fd = await buildAndReload(s => {
      s.setSpeakerNotes('Hello notes');
    });
    const slide = fd.message.nodeChanges.find(n => n.type === 'SLIDE');
    // Figma stores slideSpeakerNotes as serialized Lexical editor state JSON,
    // not raw plain text. The plain string must appear inside the Lexical tree.
    expect(slide.slideSpeakerNotes).toBeTypeOf('string');
    const doc = JSON.parse(slide.slideSpeakerNotes);
    expect(doc?.root?.type).toBe('root');
    const text = (doc.root.children ?? [])
      .flatMap(p => p?.children ?? [])
      .map(c => c?.text ?? '')
      .join('');
    expect(text).toBe('Hello notes');
  });
});
