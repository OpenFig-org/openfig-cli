/**
 * A single-line label whose box is already the width of its own text must hug,
 * even when it carries a `text-align`.
 *
 * Aligned text is otherwise left at its measured box width on purpose: a
 * right-aligned numeral in a table cell sits in a box far wider than itself, and
 * that box is what positions it. Tightening those was what commit 1abf846 had to
 * work around, so the exclusion is deliberate and this fixture keeps it.
 *
 * What the exclusion did not anticipate is a box with *no slack*. Measured on a
 * real export: a centred 22px Bold label 313.2px wide inside a 313.2px box.
 * Alignment cannot do anything in zero pixels of spare room, and neither can the
 * box absorb the difference between Chromium's metrics and Figma's — so Figma
 * wrapped it onto two lines and the second line landed on top of the caption
 * below it. The same visible failure as a `<sup>` being counted as a line, from
 * the other direction.
 *
 * Both directions are asserted. Hugging the wide-box cases would be the
 * regression that reintroduces 1abf846's bug.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { convertStandaloneHtml } from '../../../../lib/slides/html-converter.mjs';
import { FigDeck } from '../../../../lib/core/fig-deck.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(FIXTURE_DIR, 'synthetic-aligned-hug.html');

let workDir;
let fd;

const byText = (needle) =>
  fd.message.nodeChanges.find(
    (n) => n.type === 'TEXT' && (n.textData?.characters ?? '').includes(needle) && (n.size?.x ?? 0) > 0,
  );

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'aligned-hug-'));
  const out = join(workDir, 'out.deck');
  await convertStandaloneHtml(HTML_PATH, out, { scratchDir: join(workDir, 'build') });
  fd = await FigDeck.fromDeckFile(out);
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('a centred label with no slack', () => {
  it('hugs, so Figma cannot re-wrap it', () => {
    const label = byText('SATISFIED OR VERY SATISFIED');
    expect(label, 'the label did not convert').toBeTruthy();
    expect(label.textAutoResize, 'a zero-slack centred label kept a fixed width').toBe(
      'WIDTH_AND_HEIGHT',
    );
  });

  it('does not overlap the line below it', () => {
    // The actual symptom: the wrapped second line landed on this caption.
    const label = byText('SATISFIED OR VERY SATISFIED');
    const below = byText('Average rating');
    expect(below, 'the caption did not convert').toBeTruthy();
    const labelBottom = label.transform.m12 + label.size.y;
    expect(labelBottom, 'the label box already reaches the caption').toBeLessThanOrEqual(
      below.transform.m12 + 1,
    );
  });
});

describe('aligned text whose box is load-bearing', () => {
  it('leaves a right-aligned numeral at its cell width', () => {
    // 312 in a 400px right-aligned box. Hugging this moves the number, which is
    // the bug 1abf846 was written for.
    const cell = byText('312');
    expect(cell, 'the numeral did not convert').toBeTruthy();
    expect(cell.textAutoResize, 'a right-aligned cell was tightened').not.toBe('WIDTH_AND_HEIGHT');
    expect(cell.size.x, 'the cell lost its width').toBeGreaterThan(200);
  });

  it('leaves a centred label at its container width', () => {
    const wide = byText('276');
    expect(wide, 'the label did not convert').toBeTruthy();
    expect(wide.textAutoResize, 'a wide centred box was tightened').not.toBe('WIDTH_AND_HEIGHT');
    expect(wide.size.x).toBeGreaterThan(200);
  });
});
