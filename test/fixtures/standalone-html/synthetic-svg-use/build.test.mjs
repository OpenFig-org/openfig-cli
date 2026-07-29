/**
 * End-to-end guard for <use>/<symbol> resolution, from a standalone export
 * through the extractor to the parsed geometry.
 *
 * The unit tests in test/slides/svg-use-expansion.test.mjs drive the rewriter
 * directly. This file exists because the rewriter has to be correct *in place*:
 * it runs against markup the browser serialised (attribute order and quoting
 * are the browser's, not the author's), and the character offsets it shifts are
 * the ones scanSvgGroupSpans records a moment later. A rewriter that passes its
 * own unit tests can still be wired in at the wrong point in the pipeline, and
 * the only symptom is geometry that lands somewhere plausible and wrong.
 *
 * It also guards the warning contract from the other side: a <use> nobody can
 * resolve has to be reported, and a <use> that resolved fine must not be.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { convertStandaloneHtml } from '../../../../lib/slides/html-converter.mjs';
import { parseSvgShapes, flattenShapeCtm } from '../../../../lib/slides/handoff/element-dispatch.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(FIXTURE_DIR, 'synthetic-svg-use.html');

let workDir;
let manifest;
let warnings;

const spriteInner = () => {
  const svg = manifest.slides[0].elements.find(el => el.type === 'svg');
  expect(svg, 'the <use> SVG produced no element at all').toBeTruthy();
  return svg.inline.replace(/^[\s\S]*?<svg\b[^>]*>|<\/svg>\s*$/g, '');
};

/** Flattened path data for every shape the parser recovers, in document order. */
const flattenedPaths = () =>
  parseSvgShapes(spriteInner()).shapes.map(s => flattenShapeCtm(s).d);

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'svguse-html-'));
  const buildDir = join(workDir, 'build');
  const res = await convertStandaloneHtml(HTML_PATH, join(workDir, 'out.deck'), {
    scratchDir: buildDir,
    silent: true,
  });
  warnings = res.warnings;
  manifest = JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8'));
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('<use> and <symbol> in an inline SVG', () => {
  it('draws the symbol once per use site and not at its definition', () => {
    // One triangle means the <use> elements were dropped and only the
    // definition was scanned; three means the definition was painted too.
    expect(flattenedPaths()).toHaveLength(2);
  });

  it('applies the x/y on the <use> to the inlined copy', () => {
    // Authored 0,0 -> 20,0 -> 20,20 under x="10" y="20".
    const nums = (flattenedPaths()[0].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(nums.slice(0, 6)).toEqual([10, 20, 30, 20, 30, 40]);
  });

  it('composes the enclosing <g> transform outside the <use> own transform', () => {
    // translate(100,0) around scale(2): the copy's 20,20 corner is at 140,40.
    // Composed inside-out it would be at 240,40 — on the canvas, in the right
    // shape, and 100 user units from where it belongs.
    const nums = (flattenedPaths()[1].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(nums.slice(0, 6)).toEqual([100, 0, 140, 0, 140, 40]);
  });

  it('reports the <use> whose target id is absent, and still converts', () => {
    const missing = warnings.filter(w => /use.*absent/i.test(w.msg));
    expect(missing).toHaveLength(1);
    // The other two copies survived, which is the "does not fail the
    // conversion" half of the requirement.
    expect(flattenedPaths()).toHaveLength(2);
  });

  it('no longer reports <use> or <symbol> as unconverted constructs', () => {
    // These were on the unsupported list while the geometry really was being
    // dropped. Leaving them there once it is not trains people to ignore the
    // list, which is what the list exists to prevent.
    const stale = warnings.filter(w => /not converted and were dropped/.test(w.msg));
    expect(stale.map(w => w.msg)).toEqual([]);
  });
});
