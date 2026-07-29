/**
 * End-to-end guard for clipPath and pattern fills, from a standalone export
 * through the extractor to the nodes in a real .deck.
 *
 * The unit tests in test/slides/svg-clip-and-pattern.test.mjs drive the
 * geometry decisions on markup written by hand. This file exists because those
 * decisions are only half the job, and the other half cannot be reached
 * without a real conversion:
 *
 *   - A clip becomes a *frame*, and a frame reparents its children. Getting
 *     the rectangle right and the reparenting wrong puts the clipped artwork
 *     one frame-origin away from where it belongs, which is a plausible
 *     picture in the wrong place rather than an obvious failure.
 *   - A pattern becomes an image paint, which means bytes: a rasteriser, a
 *     hash, an archive entry. A tile that came out empty still produces a
 *     paint, a node and a passing parse.
 *   - The warnings are a two-sided contract. Something must report the clip
 *     that could not be expressed, and nothing must go on reporting the two
 *     constructs that now convert.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { convertStandaloneHtml } from '../../../../lib/slides/html-converter.mjs';
import { FigDeck } from '../../../../lib/core/fig-deck.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(FIXTURE_DIR, 'synthetic-svg-clip-pattern.html');

let workDir;
let deck;
let warnings;

/** Frames that actually clip: Figma stores "clip content" as this being false. */
const clipFrames = () => deck.message.nodeChanges.filter(
  (n) => n.type === 'FRAME' && n.frameMaskDisabled === false,
);

const childrenOf = (parent) => deck.message.nodeChanges.filter(
  (n) => n.parentIndex?.guid?.sessionID === parent.guid.sessionID
    && n.parentIndex?.guid?.localID === parent.guid.localID,
);

/** Every IMAGE paint in the deck, with the node it hangs on. */
const imagePaints = () => deck.message.nodeChanges.flatMap((n) =>
  (n.fillPaints ?? [])
    .filter((p) => p.type === 'IMAGE')
    .map((p) => ({ node: n, paint: p })));

const box = (n) => ({ x: n.transform.m02, y: n.transform.m12, width: n.size.x, height: n.size.y });

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'svgclip-html-'));
  const deckPath = join(workDir, 'out.deck');
  const res = await convertStandaloneHtml(HTML_PATH, deckPath, {
    scratchDir: join(workDir, 'build'),
    silent: true,
  });
  warnings = res.warnings;
  deck = await FigDeck.fromFile(deckPath);
}, 180_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('a group clipped to a rectangle', () => {
  it('becomes one frame with clipping on, at the clip rectangle', () => {
    // Only the rectangular clip produces a frame. A second frame would mean
    // the triangle clip was approximated to its bounding box, which is the
    // failure this whole branch exists to avoid.
    const frames = clipFrames();
    expect(frames).toHaveLength(1);
    // clipPath rect 10,10 80x60, in an SVG translated by (100,100).
    expect(box(frames[0])).toEqual({ x: 110, y: 110, width: 80, height: 60 });
  });

  it('holds the clipped shape at its own size, positioned relative to the frame', () => {
    // A frame's children are placed relative to it. The rect is authored at
    // the SVG origin, so inside a frame whose origin is 10,10 further along it
    // sits at -10,-10 — and it keeps its full 400x200, because the frame is
    // what bounds it, not a resize. A converter that forgot to rebase would
    // put it at 100,100 instead: on the slide, in the right shape, and one
    // clip-origin away from where it belongs.
    const [frame] = clipFrames();
    const kids = childrenOf(frame);
    expect(kids).toHaveLength(1);
    expect(box(kids[0])).toEqual({ x: -10, y: -10, width: 400, height: 200 });
  });
});

describe('a group clipped to a shape Figma cannot express', () => {
  it('drops the content rather than drawing it outside its bounds', () => {
    // This was the opposite assertion until a real export disproved it. The
    // old contract was to convert unclipped, on the reasoning that an
    // approximated clip is a wrong picture that looks deliberate. In practice
    // unclipped geometry does not stay near its box: one icon put long strokes
    // across three neighbouring cards, and a large shape landed over an
    // unrelated one. A missing element is obvious and attributable; artwork
    // sprayed across a slide is neither. The loss is reported — see below.
    const purple = deck.message.nodeChanges.find(
      (n) => n.type === 'ROUNDED_RECTANGLE' && n.size?.x === 80 && n.size?.y === 60,
    );
    expect(purple, 'content under an inexpressible clip reached the deck').toBeFalsy();
  });

  it('reports it, naming the clip', () => {
    const reported = warnings.filter((w) => /clip path #wedge is not a rectangle/.test(w.msg));
    expect(reported).toHaveLength(1);
  });
});

describe('pattern fills', () => {
  it('gives the axis-aligned pattern a tiled paint at one period', () => {
    const tiles = imagePaints().filter(({ paint }) => paint.imageScaleMode === 'TILE');
    expect(tiles).toHaveLength(1);
    const { node, paint } = tiles[0];
    // The paint hangs on the shape rather than replacing it: the rect is still
    // a rect, at the size the SVG gave it.
    expect(box(node)).toEqual({ x: 200, y: 200, width: 60, height: 40 });
    // One period is 20x20 user units, which is 20x20 on the slide here, and
    // the tile is rasterised at 2x for zoom. `scale` is what converts the
    // image's natural pixels back to the tile's on-canvas size — get it wrong
    // and the pattern repeats at the wrong pitch, which still looks like a
    // pattern.
    expect(paint.originalImageWidth).toBe(40);
    expect(paint.originalImageHeight).toBe(40);
    expect(paint.scale).toBeCloseTo(0.5, 6);
  });

  it('falls back to rasterising the region for the diagonal pattern', () => {
    // rotate(45) has no rectangular period, so there is no tile to repeat.
    // FILL over the shape's own 60x40 box, rasterised at 2x.
    const region = imagePaints().filter(({ paint }) => paint.imageScaleMode === 'FILL');
    expect(region).toHaveLength(1);
    expect(box(region[0].node)).toEqual({ x: 300, y: 200, width: 60, height: 40 });
    expect(region[0].paint.originalImageWidth).toBe(120);
    expect(region[0].paint.originalImageHeight).toBe(80);
  });

  it('says so when it fell back, because a bitmap is not a repeat', () => {
    // The picture is right, but the fill is no longer a pattern anyone can
    // edit, and it is a full-region bitmap rather than a 40x40 tile. That is a
    // cost worth naming rather than absorbing silently.
    expect(warnings.filter((w) => /pattern #hatch has no axis-aligned tile/.test(w.msg)))
      .toHaveLength(1);
  });

  it('paints the authored colour into each raster', async () => {
    // A tile that rendered as nothing still produces a paint, a node, and a
    // passing geometry assertion — which is the exact shape of failure this
    // change exists to stop. Geometry cannot tell an empty tile from a full
    // one, so read the pixels: the grid tile has to carry the red square it
    // was authored with, and the hatch region the blue one.
    const expected = { TILE: [255, 0, 0], FILL: [0, 0, 255] };
    for (const { paint } of imagePaints()) {
      const hex = [...paint.image.hash].map((b) => b.toString(16).padStart(2, '0')).join('');
      const { data } = await sharp(readFileSync(join(deck.imagesDir, hex)))
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const [r, g, b] = expected[paint.imageScaleMode];
      let hits = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === r && data[i + 1] === g && data[i + 2] === b && data[i + 3] === 255) hits++;
      }
      expect(hits, `${paint.imageScaleMode} raster carries no ${r},${g},${b} pixels`)
        .toBeGreaterThan(0);
    }
  });
});

describe('the unsupported-construct list', () => {
  it('no longer reports clip paths or pattern fills as dropped', () => {
    // Both were on that list while they really were being dropped. A list that
    // keeps naming things which now convert is a list people learn to skip,
    // and it exists to be believed.
    const stale = warnings.filter((w) => /not converted and were dropped/.test(w.msg));
    expect(stale.map((w) => w.msg)).toEqual([]);
  });
});
