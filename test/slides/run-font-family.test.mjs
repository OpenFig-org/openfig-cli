/**
 * A run in a different family from its paragraph must keep its own family.
 *
 * Runs only ever carried bold/italic flags, so the family came from the
 * paragraph. A Space Grotesk unit suffix inside an Instrument Serif number —
 * `847`+`TWh`, `1.5`+`°C` — was therefore written as "Instrument Serif Bold".
 * Two errors at once: the wrong family, and a style that family does not have,
 * which is what put Instrument Serif in Figma's missing-font dialog with three
 * Bold rows against it.
 *
 * The family had to be threaded through three layers that each dropped it —
 * the extractor's run style, the manifest's run whitelist, and the override
 * builder — so the seam is worth a test at the top of the stack.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Deck } from '../../lib/slides/api.mjs';
import { FigDeck } from '../../lib/core/fig-deck.mjs';

let workDir;
beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'openfig-runfont-')); });
afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

async function buildAndReload(fn) {
  const deck = await Deck.create({ name: 'Run font test' });
  const slide = deck.addBlankSlide();
  fn(slide);
  const out = join(workDir, 'out.deck');
  await deck.save(out);
  return FigDeck.fromDeckFile(out);
}

const overrideFonts = (node) =>
  (node.textData.styleOverrideTable ?? [])
    .filter((e) => e.fontName)
    .map((e) => `${e.fontName.family} ${e.fontName.style}`);

describe('per-run font family', () => {
  it('keeps a run in its own family rather than the paragraph\'s', async () => {
    const fd = await buildAndReload((s) => {
      s.addText([
        { text: '847' },
        { text: ' TWh', font: 'Space Grotesk', bold: true },
      ], { font: 'Instrument Serif' });
    });
    const node = fd.message.nodeChanges.find(
      (n) => n.type === 'TEXT' && n.textData?.characters?.startsWith('847'),
    );
    expect(node.fontName.family).toBe('Instrument Serif');
    expect(overrideFonts(node)).toContain('Space Grotesk Bold');
    // The bug wrote the paragraph's family onto the run. Instrument Serif has
    // no Bold at all, so this exact string is what Figma reported missing.
    expect(overrideFonts(node)).not.toContain('Instrument Serif Bold');
  });

  it('carries the family even when the run is neither bold nor italic', async () => {
    // The override used to be built only for bold/italic runs, so a plain run
    // in another family had nowhere to record it.
    const fd = await buildAndReload((s) => {
      s.addText([
        { text: 'serif ' },
        { text: 'sans', font: 'Space Grotesk' },
      ], { font: 'Instrument Serif' });
    });
    const node = fd.message.nodeChanges.find(
      (n) => n.type === 'TEXT' && n.textData?.characters?.startsWith('serif'),
    );
    expect(overrideFonts(node)).toContain('Space Grotesk Regular');
  });

  it('leaves runs that share the paragraph family alone', async () => {
    const fd = await buildAndReload((s) => {
      s.addText([
        { text: 'plain ' },
        { text: 'bold', bold: true },
      ], { font: 'Space Grotesk' });
    });
    const node = fd.message.nodeChanges.find(
      (n) => n.type === 'TEXT' && n.textData?.characters?.startsWith('plain'),
    );
    for (const f of overrideFonts(node)) expect(f).toMatch(/^Space Grotesk /);
  });
});
