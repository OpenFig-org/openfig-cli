/**
 * Contrast validation must compare text against the nearest painted ancestor,
 * not the slide background. Text on a dark card with light ink is legible;
 * the old check compared the light ink against the white slide and warned.
 *
 * See: https://github.com/OpenFig-org/openfig-cli/issues/7
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { nid } from '../../lib/core/node-helpers.mjs';

function solidPaint(r, g, b, extra = {}) {
  return { type: 'SOLID', color: { r, g, b, a: 1 }, opacity: 1, visible: true, blendMode: 'NORMAL', ...extra };
}

let nextLocal = 100;
function guid(sessionID = 0) {
  return { sessionID, localID: nextLocal++ };
}

function injectNode(fd, node) {
  fd.message.nodeChanges.push(node);
}

/** Build a minimal node with common fields. */
function makeNode(type, name, parentGuid, extra = {}) {
  const g = guid();
  return {
    guid: g,
    phase: 'CREATED',
    type,
    name,
    visible: true,
    opacity: 1,
    size: { x: 200, y: 60 },
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    parentIndex: { guid: { ...parentGuid }, position: '!' },
    ...extra,
  };
}

describe('contrast validation', () => {
  let fd;
  let slideGuid;

  beforeEach(() => {
    nextLocal = 100;
    fd = FigDeck.createEmpty();
    const slide = fd.getActiveSlides()[0];
    slideGuid = slide.guid;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function validate() {
    return fd.validate();
  }

  it('warns for low-contrast text directly on the slide background', () => {
    // Yellow text on white slide — ratio ~1.07
    const text = makeNode('TEXT', 'barely visible', slideGuid, {
      fillPaints: [solidPaint(1, 1, 0.8)],
    });
    injectNode(fd, text);
    fd.rebuildMaps();

    const warnings = validate();
    const contrastWarnings = warnings.filter(w => w.includes('contrast ratio'));
    expect(contrastWarnings.length).toBe(1);
    expect(contrastWarnings[0]).toContain(nid(text));
  });

  it('does not warn for good-contrast text on the slide background', () => {
    // Black text on white slide — ratio 21:1
    const text = makeNode('TEXT', 'legible', slideGuid, {
      fillPaints: [solidPaint(0, 0, 0)],
    });
    injectNode(fd, text);
    fd.rebuildMaps();

    const warnings = validate();
    expect(warnings.filter(w => w.includes('contrast ratio'))).toEqual([]);
  });

  it('compares text against a card fill, not the slide background', () => {
    // White text on a dark card sitting on a white slide.
    // Old behaviour: white text vs white slide → ratio 1:1 → false warning.
    // Correct: white text vs dark card → ratio ~17:1 → no warning.
    const card = makeNode('FRAME', 'dark card', slideGuid, {
      fillPaints: [solidPaint(0.1, 0.1, 0.1)],
    });
    const text = makeNode('TEXT', 'light on dark', card.guid, {
      fillPaints: [solidPaint(1, 1, 1)],
    });
    injectNode(fd, card);
    injectNode(fd, text);
    fd.rebuildMaps();

    const warnings = validate();
    expect(warnings.filter(w => w.includes('contrast ratio'))).toEqual([]);
  });

  it('warns when text contrasts poorly with its card, even if fine against the slide', () => {
    // Dark text on a dark card on a white slide.
    // Against slide: dark vs white → fine. Against card: dark vs dark → bad.
    const card = makeNode('FRAME', 'dark card', slideGuid, {
      fillPaints: [solidPaint(0.1, 0.1, 0.1)],
    });
    const text = makeNode('TEXT', 'dark on dark', card.guid, {
      fillPaints: [solidPaint(0.15, 0.15, 0.15)],
    });
    injectNode(fd, card);
    injectNode(fd, text);
    fd.rebuildMaps();

    const warnings = validate();
    const contrastWarnings = warnings.filter(w => w.includes('contrast ratio'));
    expect(contrastWarnings.length).toBe(1);
    expect(contrastWarnings[0]).toContain(nid(text));
  });

  it('uses the nearest painted ancestor when frames nest', () => {
    // Slide (white) → outer frame (no fill) → inner frame (dark) → text (white)
    // Should compare against inner frame's dark fill.
    const outer = makeNode('FRAME', 'no fill', slideGuid);
    const inner = makeNode('FRAME', 'dark band', outer.guid, {
      fillPaints: [solidPaint(0.05, 0.05, 0.05)],
    });
    const text = makeNode('TEXT', 'nested light', inner.guid, {
      fillPaints: [solidPaint(1, 1, 1)],
    });
    injectNode(fd, outer);
    injectNode(fd, inner);
    injectNode(fd, text);
    fd.rebuildMaps();

    const warnings = validate();
    expect(warnings.filter(w => w.includes('contrast ratio'))).toEqual([]);
  });

  it('skips the check when the backdrop is a gradient', () => {
    const band = makeNode('FRAME', 'gradient band', slideGuid, {
      fillPaints: [{
        type: 'GRADIENT_LINEAR',
        gradientStops: [
          { color: { r: 0, g: 0, b: 0, a: 1 }, position: 0 },
          { color: { r: 1, g: 1, b: 1, a: 1 }, position: 1 },
        ],
        visible: true,
        opacity: 1,
        blendMode: 'NORMAL',
      }],
    });
    // Text that would fail against either gradient endpoint — but we skip.
    const text = makeNode('TEXT', 'on gradient', band.guid, {
      fillPaints: [solidPaint(0.5, 0.5, 0.5)],
    });
    injectNode(fd, band);
    injectNode(fd, text);
    fd.rebuildMaps();

    const warnings = validate();
    expect(warnings.filter(w => w.includes('contrast ratio'))).toEqual([]);
  });

  it('skips the check when the backdrop is an image', () => {
    const band = makeNode('FRAME', 'photo band', slideGuid, {
      fillPaints: [{
        type: 'IMAGE',
        imageRef: 'abc123',
        visible: true,
        opacity: 1,
        blendMode: 'NORMAL',
      }],
    });
    const text = makeNode('TEXT', 'on photo', band.guid, {
      fillPaints: [solidPaint(0.5, 0.5, 0.5)],
    });
    injectNode(fd, band);
    injectNode(fd, text);
    fd.rebuildMaps();

    const warnings = validate();
    expect(warnings.filter(w => w.includes('contrast ratio'))).toEqual([]);
  });

  it('skips the check when the slide itself has a gradient background', () => {
    const slide = fd.getActiveSlides()[0];
    slide.fillPaints = [{
      type: 'GRADIENT_LINEAR',
      gradientStops: [
        { color: { r: 0, g: 0, b: 0, a: 1 }, position: 0 },
        { color: { r: 1, g: 1, b: 1, a: 1 }, position: 1 },
      ],
      visible: true,
      opacity: 1,
      blendMode: 'NORMAL',
    }];
    const text = makeNode('TEXT', 'on gradient slide', slideGuid, {
      fillPaints: [solidPaint(0.5, 0.5, 0.5)],
    });
    injectNode(fd, text);
    fd.rebuildMaps();

    const warnings = validate();
    expect(warnings.filter(w => w.includes('contrast ratio'))).toEqual([]);
  });

  it('resumes checking inside a solid frame after a gradient parent', () => {
    // Slide (white) → gradient frame → solid dark card → white text
    // The gradient frame makes its own subtree unknown, but the solid card
    // inside it re-establishes a known background.
    const gradientFrame = makeNode('FRAME', 'gradient', slideGuid, {
      fillPaints: [{
        type: 'GRADIENT_LINEAR',
        gradientStops: [
          { color: { r: 0, g: 0, b: 0, a: 1 }, position: 0 },
          { color: { r: 1, g: 1, b: 1, a: 1 }, position: 1 },
        ],
        visible: true,
        opacity: 1,
        blendMode: 'NORMAL',
      }],
    });
    const card = makeNode('FRAME', 'solid card', gradientFrame.guid, {
      fillPaints: [solidPaint(0.1, 0.1, 0.1)],
    });
    const text = makeNode('TEXT', 'recovered', card.guid, {
      fillPaints: [solidPaint(1, 1, 1)],
    });
    injectNode(fd, gradientFrame);
    injectNode(fd, card);
    injectNode(fd, text);
    fd.rebuildMaps();

    const warnings = validate();
    expect(warnings.filter(w => w.includes('contrast ratio'))).toEqual([]);
  });

  it('ignores invisible paints and inherits from parent', () => {
    // Frame has a dark fill but it's invisible → should inherit white slide bg.
    const card = makeNode('FRAME', 'invisible fill', slideGuid, {
      fillPaints: [solidPaint(0.1, 0.1, 0.1, { visible: false })],
    });
    // Yellow text: bad against white (inherited), good against dark (ignored).
    const text = makeNode('TEXT', 'yellow', card.guid, {
      fillPaints: [solidPaint(1, 1, 0.8)],
    });
    injectNode(fd, card);
    injectNode(fd, text);
    fd.rebuildMaps();

    const warnings = validate();
    const contrastWarnings = warnings.filter(w => w.includes('contrast ratio'));
    expect(contrastWarnings.length).toBe(1);
  });

  it('follows INSTANCE → SYMBOL and carries the background through', () => {
    // Place a dark frame on the slide, then an INSTANCE inside it whose
    // SYMBOL contains white text. The text should compare against the dark
    // frame, not the white slide.
    const darkFrame = makeNode('FRAME', 'dark', slideGuid, {
      fillPaints: [solidPaint(0.1, 0.1, 0.1)],
    });

    const internalCanvas = fd.message.nodeChanges.find(
      n => n.type === 'CANVAS' && n.name === 'Internal Only Canvas'
    );

    const symGuid = guid(99);
    const symbol = {
      guid: symGuid,
      phase: 'CREATED',
      type: 'SYMBOL',
      name: 'TestComp',
      componentKey: 'test-contrast-key',
      visible: true,
      opacity: 1,
      size: { x: 200, y: 60 },
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      parentIndex: { guid: { ...internalCanvas.guid }, position: '!' },
    };

    const symText = makeNode('TEXT', 'symbol text', symGuid, {
      fillPaints: [solidPaint(1, 1, 1)],
    });

    const instance = makeNode('INSTANCE', 'comp instance', darkFrame.guid, {
      symbolData: { symbolID: { sessionID: symGuid.sessionID, localID: symGuid.localID } },
    });

    injectNode(fd, darkFrame);
    injectNode(fd, symbol);
    injectNode(fd, symText);
    injectNode(fd, instance);
    fd.rebuildMaps();

    const warnings = validate();
    expect(warnings.filter(w => w.includes('contrast ratio'))).toEqual([]);
  });
});
