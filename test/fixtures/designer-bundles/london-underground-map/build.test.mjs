/**
 * End-to-end acceptance test for the London Underground Map fixture.
 * Drives the generic handoff converter against the fixture bundle so every
 * roadmap primitive (addPath, per-run color, letterSpacing / lineHeight,
 * stroked rectangles, dashed lines, text opacity, speaker notes) is
 * exercised on every run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { convertHandoffBundle } from '../../../../lib/slides/handoff-converter.mjs';
import { FigDeck } from '../../../../lib/core/fig-deck.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

let workDir;
let outPath;
let fd;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'london-underground-'));
  outPath = join(workDir, 'london-underground.deck');
  await convertHandoffBundle(FIXTURE_DIR, outPath);
  fd = await FigDeck.fromDeckFile(outPath);
}, 60_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const allNodes = () => fd.message.nodeChanges.filter(n => n.phase !== 'REMOVED');
const slidesOnly = () => allNodes().filter(n => n.type === 'SLIDE');

describe('London Underground deck build', () => {
  it('writes a non-empty .deck file', () => {
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(10_000);
  });

  it('contains exactly 12 active slides', () => {
    expect(slidesOnly()).toHaveLength(12);
  });

  it('attaches speaker notes to every slide from the manifest', () => {
    const slides = slidesOnly();
    for (const s of slides) {
      expect(s.slideSpeakerNotes).toBeTypeOf('string');
      expect(s.slideSpeakerNotes.length).toBeGreaterThan(40);
    }
  });

  it('slide 1 title has PIXELS-based letterSpacing on LONDON / UNDERGROUND MAP', () => {
    const texts = allNodes().filter(n => n.type === 'TEXT');
    const london = texts.find(n => n.textData?.characters === 'LONDON');
    const underground = texts.find(n => n.textData?.characters === 'UNDERGROUND MAP');
    expect(london?.letterSpacing).toEqual({ value: 12, units: 'PIXELS' });
    expect(underground?.letterSpacing).toEqual({ value: 10, units: 'PIXELS' });
  });

  it('slide 1 byline emits per-run color via styleOverrideTable', () => {
    const texts = allNodes().filter(n => n.type === 'TEXT');
    const byline = texts.find(n => n.textData?.characters?.includes('HARRY BECK') && n.textData?.characters?.includes('1933'));
    expect(byline).toBeTruthy();
    const table = byline.textData.styleOverrideTable;
    const colored = table.filter(e => Array.isArray(e.fillPaints) && e.fillPaints.length > 0);
    expect(colored.length).toBeGreaterThanOrEqual(3);
  });

  it('slide 9 decorative quote uses native text opacity', () => {
    const texts = allNodes().filter(n => n.type === 'TEXT');
    const quote = texts.find(n => n.fontSize === 280);
    expect(quote).toBeTruthy();
    expect(quote.opacity).toBeCloseTo(0.15, 3);
  });

  it('slide 11 emits curved VECTOR spokes (Bakerloo + District) with rounded caps', () => {
    const curves = allNodes().filter(n => n.type === 'VECTOR' && n.name === 'Curve' && n.strokeCap === 'ROUND');
    expect(curves.length).toBe(2);
    for (const v of curves) {
      expect(v.strokeWeight).toBeGreaterThan(0);
      expect(v.strokePaints?.[0]?.type).toBe('SOLID');
      expect(v.vectorData?.vectorNetworkBlob).toBeTypeOf('number');
    }
  });

  it('slide 11 renders stroke-only concentric rings as fill-less VECTOR paths', () => {
    const strokeOnly = allNodes().filter(n =>
      n.type === 'VECTOR' && n.name === 'Circle' &&
      (!Array.isArray(n.fillPaints) || n.fillPaints.length === 0)
    );
    expect(strokeOnly.length).toBeGreaterThanOrEqual(5);
  });

  it('all straight lines render as VECTOR paths (not LINE nodes) so strokes stay centered on geometry', () => {
    expect(allNodes().filter(n => n.type === 'LINE').length).toBe(0);
    const spokes = allNodes().filter(n => n.type === 'VECTOR' && n.name === 'Line');
    expect(spokes.length).toBeGreaterThan(0);
    for (const v of spokes) expect(v.strokeAlign).toBe('CENTER');
  });

  it('slide 11 emits the inline SVG caption text from the HTML', () => {
    const texts = allNodes().filter(n => n.type === 'TEXT');
    const caption = texts.find(n => n.textData?.characters?.includes('Illustrative'));
    expect(caption).toBeTruthy();
    expect(caption.textData.characters).toContain('circles and spokes');
  });

  it('slide 4 cards render with stroked borders', () => {
    const rects = allNodes().filter(n => n.type === 'ROUNDED_RECTANGLE' && n.strokePaints?.length > 0);
    expect(rects.length).toBeGreaterThanOrEqual(9);
    for (const r of rects) {
      expect(r.strokeWeight).toBe(1);
    }
  });

  it('slide 6 chart emits dashed grid lines', () => {
    const dashed = allNodes().filter(n => n.type === 'VECTOR' && n.name === 'Line' && Array.isArray(n.dashPattern) && n.dashPattern.length > 0);
    expect(dashed.length).toBeGreaterThanOrEqual(6);
    const six4 = dashed.filter(n => n.dashPattern[0] === 6 && n.dashPattern[1] === 4);
    expect(six4.length).toBeGreaterThanOrEqual(4);
    const eight5 = dashed.filter(n => n.dashPattern[0] === 8 && n.dashPattern[1] === 5);
    expect(eight5.length).toBe(1);
  });
});
