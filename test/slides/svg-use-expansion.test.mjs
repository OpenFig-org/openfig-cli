/**
 * <use>/<symbol> resolution, exercised directly on markup.
 *
 * The shape scan in element-dispatch is flat: one regex over the markup, no
 * tree, no way to follow a reference. So references are resolved by rewriting
 * the markup before anything reads it, and these tests pin the three properties
 * of that rewrite that are not obvious from the code:
 *
 *  - markup with no <use> and no <symbol> comes back byte-identical. Every SVG
 *    in every deck goes through this function; a rewrite that "helpfully"
 *    normalises quoting or whitespace would move the recorded byte baselines
 *    for reasons nobody could attribute.
 *  - a definition is drawn at its use sites and nowhere else. Painting the
 *    <symbol> where it is defined is the failure mode that looks almost right:
 *    the icon appears the correct number of times plus one, at the origin.
 *  - a reference that cannot be resolved is reported and skipped. A missing id,
 *    a chain that eats itself, an external file — none may fail the conversion,
 *    and none may silently take the rest of the SVG with them.
 *
 * The self-reference cases are here rather than in a fixture because the bug
 * they guard is a hang, not a wrong picture: an expander with no cycle guard
 * never returns, and a test that never returns is a test suite that hangs.
 */
import { describe, it, expect } from 'vitest';
import { expandSvgUse, parseSvgShapes, flattenShapeCtm } from '../../lib/slides/handoff/element-dispatch.mjs';

/** Path data for every shape the parser recovers, with transforms baked in. */
const paths = (markup) => parseSvgShapes(markup).shapes.map(s => flattenShapeCtm(s).d);

const SQUARE = '<path d="M 0 0 L 10 0 L 10 10 Z"/>';

describe('markup with no references', () => {
  it('is returned byte-identical', () => {
    const markup = `<g transform="translate(3,4)">${SQUARE}</g>`;
    const out = expandSvgUse(markup);
    expect(out.markup).toBe(markup);
    expect(out.unresolved).toEqual([]);
  });
});

describe('a <symbol> referenced by <use>', () => {
  const markup = `<defs><symbol id="sq">${SQUARE}</symbol></defs>`
    + '<use href="#sq" x="100" y="200"/>'
    + '<use xlink:href="#sq" x="300" y="400"/>';

  it('is drawn once per use site', () => {
    expect(paths(markup)).toHaveLength(2);
  });

  it('is not also drawn where it is defined', () => {
    // A copy still sitting at 0,0 means the <symbol> body was scanned in place.
    expect(paths(markup).some(d => /^M 0 0\b/.test(d))).toBe(false);
  });

  it('honours xlink:href as well as href', () => {
    const nums = (paths(markup)[1].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(nums.slice(0, 2)).toEqual([300, 400]);
  });
});

describe('a <use> referencing an ordinary element', () => {
  // Legal SVG, and unlike <symbol> the original is painted too — <use> copies,
  // it does not move.
  const markup = `<g id="mark">${SQUARE}</g><use href="#mark" x="50" y="0"/>`;

  it('leaves the original in place and adds the copy', () => {
    expect(paths(markup)).toEqual([
      // The original carries no transform, so its `d` is passed through as
      // authored; only the copy is rewritten.
      'M 0 0 L 10 0 L 10 10 Z',
      'M 50.000 0.000 L 60.000 0.000 L 60.000 10.000 Z',
    ]);
  });
});

describe('the <use> element own placement', () => {
  it('applies its transform outside its x/y translation', () => {
    // SVG defines <use> as a <g> carrying the use's transform, with x/y as a
    // further translate *inside* it. So scale(2) multiplies the offset: the
    // copy's origin lands at 20,0, not 10,0.
    const markup = `<defs><symbol id="sq">${SQUARE}</symbol></defs>`
      + '<use href="#sq" transform="scale(2)" x="10" y="0"/>';
    const nums = (paths(markup)[0].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(nums.slice(0, 4)).toEqual([20, 0, 40, 0]);
  });
});

describe('presentation attributes on the <use>', () => {
  const markup = '<defs><symbol id="pair">'
    + '<path d="M 0 0 L 1 0"/><path d="M 2 0 L 3 0" fill="#111111"/>'
    + '</symbol></defs>'
    + '<use href="#pair" fill="#ff0000"/>';

  it('reach a copied shape that sets no paint of its own', () => {
    // Without this the copy has no fill at all and the shape branches drop it,
    // so a recoloured sprite — the reason <use> exists — converts to nothing.
    expect(parseSvgShapes(markup).shapes[0].fill).toBe('#ff0000');
  });

  it('do not override a copied shape that sets its own', () => {
    expect(parseSvgShapes(markup).shapes[1].fill).toBe('#111111');
  });
});

describe('a reference that cannot be resolved', () => {
  it('is reported and skipped, leaving the rest of the SVG intact', () => {
    const markup = `${SQUARE}<use href="#nowhere" x="5" y="5"/>`;
    const out = expandSvgUse(markup);
    expect(out.unresolved).toEqual(['#nowhere']);
    expect(paths(markup)).toHaveLength(1);
  });

  it('treats an external file reference as unresolved rather than fetching it', () => {
    // Nothing from the export may leave the machine, so a cross-document
    // reference is reported like a missing id rather than followed.
    const out = expandSvgUse('<use href="icons.svg#star"/>');
    expect(out.unresolved).toEqual(['icons.svg#star']);
    expect(out.markup).not.toContain('<use');
  });
});

describe('a <use> chain that references itself', () => {
  it('drops a <use> sitting inside the element it names', () => {
    // Self-reference is an error in SVG and paints nothing extra. With no
    // guard the expander inlines the group into itself forever.
    const markup = `<g id="loop">${SQUARE}<use href="#loop"/></g>`;
    expect(paths(markup)).toHaveLength(1);
  });

  it('terminates on a two-step cycle', () => {
    const markup = '<defs>'
      + `<g id="a">${SQUARE}<use href="#b"/></g>`
      + '<g id="b"><use href="#a"/></g>'
      + '</defs>'
      + '<use href="#a" x="0" y="0"/>';
    // a -> b -> a, which no single-step check catches. The assertion that
    // matters is that this returns at all; the exact copy count is not
    // meaningful, since the cycle is cut wherever the set of ids under
    // expansion first repeats. What must hold is that nothing is left
    // unresolved and the output stays bounded rather than doubling per level.
    const out = expandSvgUse(markup);
    expect(out.markup).not.toContain('<use');
    expect(paths(markup).length).toBeLessThan(8);
  });
});
