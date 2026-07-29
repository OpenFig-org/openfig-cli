/**
 * An inline baseline shift must not be mistaken for a line break.
 *
 * A `<sub>`, `<sup>`, or anything with `vertical-align` sits at a different
 * `top` than the text beside it while sharing the same line. Counting distinct
 * `top` values therefore reports two lines where a reader sees one. The run
 * then misses the single-line branch that sets `noWrap`, Figma is left free to
 * re-wrap a fixed-width box using its own font metrics, and the fragment lands
 * on whatever sits below it — which is how a unit ended up on top of a caption.
 *
 * Counting by vertical overlap is the fix: rects on one line overlap, rects on
 * different lines do not. That was implemented once and then reimplemented, by
 * `top`, at two more call sites — so this fixture exercises the paths those
 * sites feed rather than the helper directly.
 *
 * The narrow wrapping column is here to stop the fix overreaching. Its width
 * is load-bearing: marking it `noWrap` would push it out of its column and
 * across whatever is beside it, which is the same class of damage in the
 * opposite direction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { convertStandaloneHtml } from '../../../../lib/slides/html-converter.mjs';
import { FigDeck } from '../../../../lib/core/fig-deck.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(FIXTURE_DIR, 'synthetic-inline-baseline.html');

let workDir;
let fd;

// The raised variant renders the same string as the control — "847 TWh" either
// way, since the shift is a style on an inline span — so text cannot tell them
// apart. Position can: the fixture stacks the three figures in the left column
// and puts the wrapping case on the right.
// The blank template carries three zero-width "Rag 123" nodes at the origin as
// its text-style definitions; they are not slide content and must not be
// mistaken for the first figure.
const textNodes = () =>
  fd.message.nodeChanges
    .filter((n) => n.type === 'TEXT' && (n.textData?.characters ?? '').trim() && (n.size?.x ?? 0) > 0)
    .map((n) => ({ node: n, x: n.transform.m02, y: n.transform.m12 }));

/** The nth figure down the left column: 0 plain, 1 raised, 2 lowered. */
const figure = (n) =>
  textNodes()
    .filter((t) => t.x < 600)
    .sort((a, b) => a.y - b.y)[n]?.node;

const wrapping = () => textNodes().find((t) => t.x > 1000)?.node;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'inline-baseline-'));
  const out = join(workDir, 'out.deck');
  await convertStandaloneHtml(HTML_PATH, out, { scratchDir: join(workDir, 'build') });
  fd = await FigDeck.fromDeckFile(out);
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('an inline baseline shift is not a second line', () => {
  it('converts all four cases', () => {
    for (const i of [0, 1, 2]) {
      expect(figure(i), `no figure at index ${i}`).toBeTruthy();
    }
    expect(wrapping(), 'no wrapping column').toBeTruthy();
    expect(figure(0).textData.characters.replace(/\s+/g, ' ')).toContain('847');
    expect(figure(2).textData.characters.replace(/\s+/g, ' ')).toContain('1.5');
  });

  it('hugs a raised unit exactly as it hugs plain text', () => {
    expect(figure(0).textAutoResize, 'the control regressed').toBe('WIDTH_AND_HEIGHT');
    expect(figure(1).textAutoResize, 'a raised unit was counted as a second line').toBe(
      'WIDTH_AND_HEIGHT',
    );
  });

  it('hugs a lowered unit too', () => {
    expect(figure(2).textAutoResize, 'a lowered unit was counted as a second line').toBe(
      'WIDTH_AND_HEIGHT',
    );
  });

  it('gives the raised variant a width close to the plain one', () => {
    // Same glyphs at the same size, so the boxes should agree. Before the fix
    // the raised variant measured wide — it took the wrapping branch, which
    // sizes to the box rather than to the run: 600 against 347.
    const plain = figure(0);
    const raised = figure(1);
    const ratio = raised.size.x / plain.size.x;
    expect(ratio, `plain ${plain.size.x}, raised ${raised.size.x}`).toBeGreaterThan(0.85);
    expect(ratio, `plain ${plain.size.x}, raised ${raised.size.x}`).toBeLessThan(1.15);
  });

  it('leaves genuinely wrapped text free to wrap', () => {
    // Two real lines in a 300px column. Hugging this would overflow the column.
    expect(wrapping().textAutoResize).not.toBe('WIDTH_AND_HEIGHT');
  });
});
