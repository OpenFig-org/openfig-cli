/**
 * <image> inside an inline SVG: parsing, placement, and the rule about which
 * sources we are willing to read.
 *
 * The parser handled eight shape elements and dropped everything else without
 * a word. `<image>` was the largest of those losses — a slide's whole raster
 * content could vanish and the conversion still report success — so these
 * tests are mostly about the ways a *converted* image can be wrong in a way
 * that still looks like a picture on a slide:
 *
 *   - placed by its anchor but never resized, so a transform halves it;
 *   - painted out of a <pattern>, where it was a definition and not artwork;
 *   - read from a URL, which would mean part of the export leaving the machine.
 *
 * The end-to-end counterpart is
 * test/fixtures/standalone-html/synthetic-svg-image/build.test.mjs, which
 * drives the same constructs through a real browser and a real .deck.
 */
import { describe, it, expect } from 'vitest';
import {
  applyElement,
  parseSvgShapes,
  flattenShapeCtm,
  svgImageSource,
} from '../../lib/slides/handoff/element-dispatch.mjs';

const images = (markup) =>
  parseSvgShapes(markup).shapes.filter(s => s.type === 'image').map(flattenShapeCtm);

describe('parsing <image>', () => {
  it('reads x, y, width, height and href', () => {
    const [img] = images('<image href="p.png" x="10" y="20" width="30" height="40"></image>');
    expect(img).toMatchObject({ x: 10, y: 20, width: 30, height: 40, href: 'p.png' });
  });

  it('accepts the xlink:href spelling', () => {
    // Every SVG written before SVG 2 uses it, and a chart library that still
    // emits the namespaced form would otherwise produce an image element with
    // no source at all — parsed, placed, and blank.
    const [img] = images('<image xlink:href="p.png" width="1" height="1"/>');
    expect(img.href).toBe('p.png');
  });

  it('defaults a missing x/y to the origin rather than NaN', () => {
    // SVG says x/y default to 0. Left undefined they reach the affine maths as
    // NaN and the node lands nowhere, which Figma renders as an image at the
    // top-left corner of the slide.
    const [img] = images('<image href="p.png" width="8" height="6"/>');
    expect(img).toMatchObject({ x: 0, y: 0 });
  });

  it('is found in both the self-closing and the closed-tag spellings', () => {
    // A browser's outerHTML always writes the closed form; hand-authored
    // markup and the template artifact use the self-closing one.
    expect(images('<image href="a.png" width="1" height="1"/>')).toHaveLength(1);
    expect(images('<image href="a.png" width="1" height="1"></image>')).toHaveLength(1);
  });
});

describe('placing <image> under a transform', () => {
  it('scales the box, not only its corner', () => {
    // The generic tail of flattenShapeCtm moves the anchor and leaves
    // width/height alone. An image under scale(2) then lands in the right
    // place at half the size — which reads as a layout bug and sends anyone
    // debugging it to the wrong module.
    const [img] = images('<g transform="translate(300,0) scale(2)"><image href="p.png" x="10" y="20" width="50" height="40"/></g>');
    expect(img).toMatchObject({ x: 320, y: 40, width: 100, height: 80 });
  });

  it('composes enclosing groups outermost-first', () => {
    // translate(100,0) around scale(2) is not scale(2) around translate(100,0):
    // composed inside-out the image sits at 120 instead of 140. Both are on
    // the canvas and only one is right.
    const [img] = images('<g transform="translate(100,0)"><g transform="scale(2)"><image href="p.png" x="20" y="0" width="10" height="10"/></g></g>');
    expect(img.x).toBe(140);
  });
});

describe('<image> inside a definition', () => {
  it('is not painted where a <pattern> defines it', () => {
    // A pattern tile is drawn wherever a fill references it, at that shape's
    // place and size — never at the coordinates written inside the <pattern>.
    // Painting it in place puts a full-size bitmap on top of the artwork it
    // was meant to fill, which is a worse outcome than the loss this branch
    // exists to fix.
    expect(images('<defs><pattern id="p" width="100" height="100"><image href="a.png" width="100" height="100"/></pattern></defs><rect width="10" height="10" fill="url(#p)"/>')).toHaveLength(0);
  });

  it('is not painted from inside <defs>, <mask> or <clipPath> either', () => {
    expect(images('<defs><image href="a.png" width="1" height="1"/></defs>')).toHaveLength(0);
    expect(images('<mask id="m"><image href="a.png" width="1" height="1"/></mask>')).toHaveLength(0);
    expect(images('<clipPath id="c"><image href="a.png" width="1" height="1"/></clipPath>')).toHaveLength(0);
  });

  it('still paints an <image> that merely follows a definition block', () => {
    // The check is by character offset, so a definition whose span were
    // mis-measured would swallow everything after it and silently drop the
    // slide's real artwork — the exact failure mode this change is fixing.
    expect(images('<defs><pattern id="p"><image href="a.png" width="1" height="1"/></pattern></defs><image href="b.png" x="5" y="5" width="1" height="1"/>')).toHaveLength(1);
  });
});

describe('which <image> sources may be read', () => {
  it('accepts a data URI and a bundle-relative asset', () => {
    expect(svgImageSource('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(svgImageSource('media/asset.png')).toBe('media/asset.png');
  });

  it('refuses anything that would have to be fetched', () => {
    // This is a privacy boundary, not a capability gap: nothing from an export
    // may leave the machine, so a converter must never resolve one of these —
    // not even to discover that it 404s. A `blob:` reaching this far means the
    // asset scan could not pair it with a decoded asset, so it is dead too.
    for (const href of [
      'https://images.example.invalid/remote.png',
      'http://example.invalid/remote.png',
      '//example.invalid/remote.png',
      'file:///etc/hosts',
      'blob:null/2f1c1e2a-0000-4000-8000-000000000000',
    ]) {
      expect(svgImageSource(href), href).toBeNull();
    }
  });

  it('refuses a bare fragment and an absent href', () => {
    // `#foo` names an element in this document, not an image; treating it as a
    // relative path would send the media resolver looking for a file called
    // "#foo" and fail the whole conversion.
    expect(svgImageSource('#foo')).toBeNull();
    expect(svgImageSource(undefined)).toBeNull();
    expect(svgImageSource('   ')).toBeNull();
  });
});

/**
 * The branch that actually emits a node, driven with a stub slide. The
 * end-to-end fixture covers the happy path; what it cannot reach is a bundle
 * that does not hold the asset, because everything in it resolves.
 */
describe('emitting the image node', () => {
  /** @returns the options every addImage call received, in order. */
  async function emit(inner, resolveMedia) {
    const seen = [];
    const slide = { addImage: async (src, opts) => { seen.push({ src, ...opts }); return {}; } };
    const el = {
      type: 'svg',
      viewBox: '0 0 100 100',
      x: 0, y: 0, width: 100, height: 100,
      inline: `<svg viewBox="0 0 100 100">${inner}</svg>`,
    };
    await applyElement(slide, el, { slideIndex: 1, resolveMedia, imageOps: {} });
    return seen;
  }

  it('skips an href the bundle cannot resolve instead of failing the deck', async () => {
    // Only `blob:` hrefs are paired back to a decoded asset, so an inline SVG
    // pointing at a path beside the HTML — `art/logo.png` — reaches
    // resolveMedia naming a file the bundle never held, and resolveMedia
    // throws. Letting that escape trades one missing picture for the whole
    // conversion, on markup that converted (badly, by dropping the image)
    // before <image> was supported at all.
    const resolveMedia = (src) => {
      if (src !== 'media/there.png') throw new Error(`Media asset not found: ${src}`);
      return { filename: 'there.png', bytes: new Uint8Array([1]), mime: 'image/png' };
    };
    const seen = await emit(
      '<image href="art/logo.png" width="10" height="10"/>'
      + '<image href="media/there.png" x="20" y="20" width="10" height="10"/>',
      resolveMedia,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].src.filename).toBe('there.png');
  });

  it('reads preserveAspectRatio as the choice between FIT and FILL', async () => {
    // SVG's default is `xMidYMid meet` — letterbox inside the box — and
    // `slice` crops to fill it. Figma has no stretch, so `none` is treated as
    // fill: cropping the picture loses less than leaving a band of empty box
    // where the author asked for none.
    const media = () => ({ filename: 'a.png', bytes: new Uint8Array([1]), mime: 'image/png' });
    const modes = async (par) => (await emit(
      `<image href="media/a.png" width="10" height="10"${par}/>`, media,
    ))[0].scaleMode;
    expect(await modes('')).toBe('FIT');
    expect(await modes(' preserveAspectRatio="xMidYMid meet"')).toBe('FIT');
    expect(await modes(' preserveAspectRatio="xMidYMid slice"')).toBe('FILL');
    expect(await modes(' preserveAspectRatio="none"')).toBe('FILL');
  });
});
