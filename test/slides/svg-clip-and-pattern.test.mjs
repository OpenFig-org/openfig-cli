/**
 * clipPath and pattern fills: the two judgements the converter has to get
 * right before it emits anything.
 *
 * Both constructs share a failure mode that the deck cannot detect and a
 * reviewer probably will not either — the wrong answer is not a missing
 * picture but a *plausible* one. An arbitrary clip approximated to its
 * bounding box is a rectangle nobody authored and everybody reads as
 * deliberate. A rotated hatch tiled without its rotation is still a hatch,
 * just not that one. A tile cropped at the pattern's authored origin repeats
 * exactly the right artwork, offset by up to a whole tile.
 *
 * So these tests are about which cases are converted and which are handed to
 * the fallback, rather than about the raster itself. The end-to-end
 * counterpart is test/fixtures/standalone-html/synthetic-svg-clip-pattern/,
 * which drives real markup through a browser into a real .deck and looks at
 * the pixels.
 */
import { describe, it, expect } from 'vitest';
import {
  applyElement,
  parseSvgShapes,
  clipPathRect,
  svgPatternTile,
} from '../../lib/slides/handoff/element-dispatch.mjs';
import { sharpImageOps } from '../../lib/core/image-utils.mjs';

/** The clip resolved for each shape, in document order. */
const clips = (markup) => parseSvgShapes(markup).shapes.map(
  (s) => (s.clipUnsupported ? { unsupported: s.clipUnsupported } : (s.clip ?? null)),
);

describe('recognising a rectangular clip', () => {
  it('reads a <rect>, including its corner radius', () => {
    // The radius is not decoration: a frame carries one, so a rounded panel
    // clip converts exactly rather than squaring off at the corners.
    expect(clipPathRect('<rect x="4" y="5" width="60" height="30" rx="8"/>'))
      .toEqual({ x: 4, y: 5, width: 60, height: 30, cornerRadius: 8 });
  });

  it('reads a rectangle written as a four-corner path', () => {
    // Hand-authored markup writes <rect>; every tool that emits SVG writes the
    // same rectangle as a path. Recognising only the first spelling would send
    // most real rectangular clips down the unsupported branch.
    expect(clipPathRect('<path d="M10 20 H110 V70 H10 Z"/>'))
      .toEqual({ x: 10, y: 20, width: 100, height: 50, cornerRadius: 0 });
  });

  it('refuses a path that is not a rectangle', () => {
    // A triangle, and a rounded rectangle drawn with arcs. Both have a
    // perfectly good bounding box, and using it would be the wrong picture
    // rendered confidently.
    expect(clipPathRect('<path d="M0 0 L10 30 L20 0 Z"/>')).toBeNull();
    expect(clipPathRect('<path d="M10 0 H90 A10 10 0 0 1 100 10 V50 H0 V10 Z"/>')).toBeNull();
  });

  it('refuses a union of two shapes', () => {
    // Two rectangles clip to their union, which is not a rectangle unless they
    // happen to line up. Taking the first would clip away artwork the author
    // asked to keep.
    expect(clipPathRect('<rect width="10" height="10"/><rect x="40" width="10" height="10"/>'))
      .toBeNull();
  });

  it('refuses a zero-sized rectangle', () => {
    // Nothing is visible through it, so there is no clip to express — and a
    // zero-size frame would swallow its children rather than clip them.
    expect(clipPathRect('<rect width="0" height="40"/>')).toBeNull();
  });
});

describe('resolving the clip in force at a shape', () => {
  const DEFS = '<clipPath id="win"><rect x="10" y="20" width="100" height="50"/></clipPath>';

  it('composes the clipping group\'s own transform into the clip', () => {
    // `transform` on the clipping element establishes the user space its
    // clip-path is measured in, so the clip moves with it. Composing only the
    // *enclosing* transforms would leave the clip behind while its content
    // moved, which crops the wrong part of the artwork.
    const [clip] = clips(
      `${DEFS}<g transform="translate(5,5)" clip-path="url(#win)"><rect width="9" height="9"/></g>`,
    );
    expect(clip).toMatchObject({ x: 15, y: 25, width: 100, height: 50 });
  });

  it('composes an outer group transform outside the clip', () => {
    const [clip] = clips(
      `${DEFS}<g transform="scale(2)"><g clip-path="url(#win)"><rect width="9" height="9"/></g></g>`,
    );
    expect(clip).toMatchObject({ x: 20, y: 40, width: 200, height: 100 });
  });

  it('applies a clip written on the shape itself, with that shape\'s transform', () => {
    // clip-path is not a group-only attribute, and a shape carrying both has
    // no <g> span for the transform scan to find.
    const [clip] = clips(
      `${DEFS}<rect clip-path="url(#win)" transform="translate(1,2)" width="4" height="4"/>`,
    );
    expect(clip).toMatchObject({ x: 11, y: 22, width: 100, height: 50 });
  });

  it('intersects nested clips', () => {
    // SVG intersects them, and so would nested frames. Taking the innermost
    // alone would let content through that the outer clip excluded.
    const outer = '<clipPath id="a"><rect x="0" y="0" width="100" height="100"/></clipPath>';
    const inner = '<clipPath id="b"><rect x="50" y="50" width="100" height="100"/></clipPath>';
    const [clip] = clips(
      `${outer}${inner}<g clip-path="url(#a)"><g clip-path="url(#b)"><rect width="9" height="9"/></g></g>`,
    );
    expect(clip).toMatchObject({ x: 50, y: 50, width: 50, height: 50 });
  });

  it('reports a rotated clip rather than squaring it off', () => {
    // A rectangle under rotate(30) is still a rectangle, just not an
    // axis-aligned one, and a frame cannot be rotated into place here. Its
    // bounding box is bigger than the clip in both directions, so approximating
    // would let through artwork the author clipped away.
    expect(clips(`${DEFS}<g transform="rotate(30)" clip-path="url(#win)"><rect width="9" height="9"/></g>`))
      .toEqual([{ unsupported: 'win' }]);
  });

  it('reports a reference to an id that is not there', () => {
    // SVG says an invalid reference means the element does not render at all.
    // Converting it unclipped and saying so keeps the artwork, which is the
    // less surprising of two wrong answers, and the warning is what makes it
    // not silent.
    expect(clips('<g clip-path="url(#gone)"><rect width="9" height="9"/></g>'))
      .toEqual([{ unsupported: 'gone' }]);
  });

  it('does not paint the clip rectangle itself', () => {
    // The <rect> inside a <clipPath> is the clip region, not artwork. Painting
    // it where it stands lays an opaque box over the thing it was meant to
    // bound — visible, deliberate-looking, and authored by nobody.
    const shapes = parseSvgShapes(`${DEFS}<rect width="9" height="9" fill="#123456"/>`).shapes;
    expect(shapes.map((s) => s.fill)).toEqual(['#123456']);
  });
});

describe('deciding whether a pattern has a tile', () => {
  const pat = (attrs) => parseSvgShapes(`<pattern id="p" ${attrs}><rect width="1" height="1"/></pattern>`)
    .patterns.get('p');

  it('takes the period from an axis-aligned pattern in user units', () => {
    expect(svgPatternTile(pat('patternUnits="userSpaceOnUse" x="3" y="7" width="20" height="30"'), null))
      .toEqual({ width: 20, height: 30 });
  });

  it('never carries the pattern\'s own x/y', () => {
    // Those set the lattice phase, and a Figma tiled paint is anchored at the
    // node's corner with nowhere to put one. The tile is cropped from the
    // tiled render at that corner instead, which bakes the phase into the
    // pixels — so a caller that used x/y here would shift the whole fill.
    const tile = svgPatternTile(pat('patternUnits="userSpaceOnUse" x="3" y="7" width="20" height="20"'), null);
    expect(Object.keys(tile).sort()).toEqual(['height', 'width']);
  });

  it('scales a bounding-box-relative period against the shape', () => {
    // patternUnits defaults to objectBoundingBox — fractions of the filled
    // shape — which is the opposite default from patternContentUnits.
    expect(svgPatternTile(pat('width="0.25" height="0.5"'), { x: 0, y: 0, w: 80, h: 40 }))
      .toEqual({ width: 20, height: 20 });
  });

  it('folds an axis-aligned patternTransform into the period', () => {
    // A scale changes the pitch of the repeat but leaves it rectangular, so
    // this is still tileable — at twice the size.
    expect(svgPatternTile(pat('patternUnits="userSpaceOnUse" width="10" height="10" patternTransform="scale(2)"'), null))
      .toEqual({ width: 20, height: 20 });
  });

  it('refuses a rotated or skewed pattern', () => {
    // The diagonal hatch. There is no rectangular period at any offset, so
    // there is nothing to hand a tiled paint — repeating an unrotated tile
    // would be a different pattern presented as this one.
    expect(svgPatternTile(pat('patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"'), null))
      .toBeNull();
    expect(svgPatternTile(pat('patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="skewX(20)"'), null))
      .toBeNull();
  });

  it('refuses a pattern that inherits from another', () => {
    // href inheritance means the period may be written on an element this one
    // only names. The region raster renders the chain correctly without having
    // to resolve it, so guessing here buys nothing.
    expect(svgPatternTile(pat('href="#base" patternUnits="userSpaceOnUse" width="8" height="8"'), null))
      .toBeNull();
  });

  it('does not paint the pattern\'s contents where they are defined', () => {
    // Same rule as the clip region: a <pattern>'s rect is one cell of a
    // repeat, and drawing it at the SVG origin puts a stray square on the
    // slide as well as leaving the fill unfilled.
    const markup = '<pattern id="p" patternUnits="userSpaceOnUse" width="8" height="8">'
      + '<rect width="4" height="4" fill="#ff0000"/></pattern>'
      + '<rect width="9" height="9" fill="#00ff00"/>';
    expect(parseSvgShapes(markup).shapes.map((s) => s.fill)).toEqual(['#00ff00']);
  });
});

/**
 * The emission side, driven with a stub. What the end-to-end fixture cannot
 * reach is a host with no rasteriser, which is a real state: `ImageOps` is a
 * capability group a caller supplies, and a pattern is the first thing in the
 * pipeline that needs more of it than sizing and thumbnailing.
 */
describe('emitting a pattern fill', () => {
  async function emit(inner, imageOps) {
    const nodes = [];
    const warnings = [];
    const node = () => { const n = {}; nodes.push(n); return n; };
    const slide = {
      addPath: node,
      addRectangle: node,
      addEllipse: node,
      addFrame: () => ({ _node: {}, addPath: node, addRectangle: node }),
      createImagePaint: async (src, opts) => ({ type: 'IMAGE', src, ...opts }),
      imageSourceBytes: () => new Uint8Array([1]),
    };
    await applyElement(slide, {
      type: 'svg',
      viewBox: '0 0 100 100',
      x: 0, y: 0, width: 100, height: 100,
      inline: `<svg viewBox="0 0 100 100">${inner}</svg>`,
    }, {
      slideIndex: 1,
      imageOps,
      resolveMedia: () => { throw new Error('no media in this test'); },
      warn: (msg) => warnings.push(msg),
    });
    return { nodes, warnings };
  }

  const DOTS = '<pattern id="d" patternUnits="userSpaceOnUse" width="10" height="10">'
    + '<circle cx="5" cy="5" r="4" fill="#ff0000"/></pattern>';

  it('hangs the paint on the shape instead of replacing it with a rectangle', async () => {
    // The reason this does not go through `addImage`: a pie wedge filled with
    // a pattern is a path, and emitting an image node in its place would swap
    // the wedge for a box. `addPath` is what gets called, and the paint lands
    // on the node it returned.
    const { nodes } = await emit(`${DOTS}<path d="M0 0 L50 0 L50 50 Z" fill="url(#d)"/>`, sharpImageOps);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].fillPaints[0]).toMatchObject({ type: 'IMAGE', scaleMode: 'TILE' });
  });

  it('reports a host that cannot rasterise, rather than emitting a blank fill', async () => {
    // A browser or an embedder may supply an `imageOps` without the SVG
    // rasteriser this needs. Emitting the placeholder fill the shape was
    // created with would put a black wedge on the slide, which is worse than
    // the unfilled shape and much worse than being told.
    const { nodes, warnings } = await emit(
      `${DOTS}<path d="M0 0 L50 0 L50 50 Z" fill="url(#d)"/>`,
      { imageSize: async () => ({ width: 1, height: 1 }), thumbnailPng: async () => new Uint8Array() },
    );
    expect(nodes[0].fillPaints).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/no SVG rasteriser/);
  });

  it('reports a tile that would not rasterise, and keeps the deck', async () => {
    // One decoration is a smaller loss than the whole conversion, so a raster
    // failure is caught. Silence is not on offer: without the warning this is
    // indistinguishable from a pattern that converted.
    const { warnings } = await emit(
      `${DOTS}<path d="M0 0 L50 0 L50 50 Z" fill="url(#d)"/>`,
      { ...sharpImageOps, rasterizeSvg: async () => { throw new Error('boom'); } },
    );
    expect(warnings.join('\n')).toMatch(/could not be rasterised/);
  });
});
