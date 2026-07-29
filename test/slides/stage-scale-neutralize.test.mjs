/**
 * A Claude Design export may render its slide at a fixed fraction of the size
 * it lays out at, and the conversion has to undo that before reading geometry.
 *
 * Measured on a real export: `<section>` reported an `offsetWidth` of 1920 and
 * a `getBoundingClientRect().width` of 1732 — every coordinate multiplied by
 * 0.902 — because a `div.canvas` inside `deck-stage`'s shadow root carried
 * `transform: scale(0.902083)`. Font sizes were untouched, since computed
 * style does not see a transform. The result was a deck where layout had
 * shrunk and type had not: wrong everywhere, obviously wrong nowhere. The user
 * described it as "printed on a frame that was too small".
 *
 * Two things about the fix are easy to get wrong and are pinned here.
 *
 * Ordering: the stage applies the transform after first paint, so anything
 * that looks earlier in `prepareForMeasurement` — the fit included — measures
 * a scale of exactly 1 and finds nothing to do. The first attempt at this fix
 * sat inside the fit and never once ran.
 *
 * Durability: the stage owns that element's style attribute and rewrites
 * `style.transform` on its own schedule, which drops an inline `!important`
 * along with the rest of the declaration. The override has to be an author
 * rule in a stylesheet, in the node's own root, to outrank it.
 */
import { describe, it, expect } from 'vitest';
import { prepareForMeasurement } from '../../lib/slides/core/measurement-surface.mjs';

/**
 * The smallest DOM that reproduces the shape: a light-DOM `<section>` slotted
 * into a custom element whose shadow root holds the scaled node.
 *
 * `rewritesInlineStyle` models the stage's own runtime reasserting its
 * transform, which is what makes an inline override insufficient.
 */
function makeStageRealm({ scale = 0.902083, rewritesInlineStyle = true } = {}) {
  const sheets = [];
  const el = (tag, cls = '') => ({
    tagName: tag.toUpperCase(),
    className: cls,
    attrs: {},
    inline: {},
    shadowRoot: null,
    parentElement: null,
    root: null,
    setAttribute(k, v) { this.attrs[k] = v; },
    getRootNode() { return this.root; },
    style: {
      setProperty(k, v) { this.owner.inline[k] = v; },
    },
  });
  const link = (node, owner) => { node.style.owner = owner ?? node; return node; };

  const section = link(el('section'));
  const canvas = link(el('div', 'canvas'));
  const stage = link(el('div', 'stage'));
  const deckStage = link(el('deck-stage'));
  const body = link(el('body'));
  const documentElement = link(el('html'));

  section.parentElement = deckStage;
  deckStage.parentElement = body;
  body.parentElement = documentElement;

  const shadowRoot = {
    isShadowRoot: true,
    children: [canvas, stage],
    querySelectorAll: () => [canvas, stage],
    appendChild: (s) => { sheets.push({ root: 'shadow', css: s.textContent }); },
  };
  deckStage.shadowRoot = shadowRoot;
  canvas.root = shadowRoot;
  stage.root = shadowRoot;

  const document = {
    documentElement,
    head: { appendChild: (s) => sheets.push({ root: 'document', css: s.textContent }) },
    querySelector: (sel) => (sel === 'section' ? section : null),
    createElement: () => ({ textContent: '' }),
  };
  section.root = document;
  deckStage.root = document;
  body.root = document;

  // The scale survives an inline override — the stage rewrites the style
  // attribute — but not an author rule marked `!important` in its own root.
  const neutralized = () =>
    sheets.some((s) => s.root === 'shadow' && /transform:none!important/.test(s.css)
      && canvas.attrs['data-openfig-unscaled'] !== undefined)
    || (!rewritesInlineStyle && canvas.inline.transform === 'none');

  const realm = {
    document,
    getComputedStyle: (node) => ({
      transform: node === canvas && !neutralized() ? `matrix(${scale}, 0, 0, ${scale}, 0, 0)` : 'none',
      scale: 'none',
      zoom: '1',
    }),
  };

  section.offsetWidth = 1920;
  section.getBoundingClientRect = () => ({ width: neutralized() ? 1920 : 1920 * scale });

  return { realm, section, canvas, sheets };
}

/** A surface that actually runs what `prepareForMeasurement` hands it. */
function makeSurface(realm, trace) {
  return {
    waitForSelector: async () => {},
    // The fit reads a computed `width` this realm does not model, so it bails
    // on its first pass — which is the point: on a stage like this it has
    // nothing to contribute, and the neutralization is what does the work.
    viewport: () => ({ width: 1920, height: 1080 }),
    resize: async () => {},
    // Only the neutralization pass runs for real. The realm here models the
    // one thing under test — a scaled node behind a shadow boundary — and the
    // font passes that share this sequence would need a whole document to
    // walk, which would make the fixture about them instead.
    evaluate: async (fn, arg) => {
      if (!String(fn).includes('data-openfig-unscaled')) return null;
      trace.push('neutralize');
      return fn({ realm, arg });
    },
    loadWebFont: async () => {},
    settle: async () => { trace.push('settle'); },
  };
}

const host = { webFontPreload: false, log: () => {} };

describe('stage scale neutralization', () => {
  it('undoes a scale a shadow-DOM stage reasserts on its own style attribute', async () => {
    const { realm, section, canvas } = makeStageRealm();
    expect(section.getBoundingClientRect().width / section.offsetWidth).toBeCloseTo(0.902, 3);

    await prepareForMeasurement(makeSurface(realm, []), host, {
      readySelector: 'section',
      fitSelector: 'section',
    });

    expect(section.getBoundingClientRect().width / section.offsetWidth).toBe(1);
    expect(realm.getComputedStyle(canvas).transform).toBe('none');
  });

  it('overrides via a stylesheet in the node\'s own root, not inline style', async () => {
    // A rule in the document does not cross a shadow boundary, and an inline
    // declaration loses to the stage's next write.
    const { realm, sheets } = makeStageRealm();
    await prepareForMeasurement(makeSurface(realm, []), host, {
      readySelector: 'section',
      fitSelector: 'section',
    });
    expect(sheets.some((s) => s.root === 'shadow')).toBe(true);
  });

  it('runs after the final settle, when the stage has applied its transform', async () => {
    // Earlier than this and there is no transform yet to find.
    const trace = [];
    const { realm } = makeStageRealm();
    await prepareForMeasurement(makeSurface(realm, trace), host, {
      readySelector: 'section',
      fitSelector: 'section',
    });
    const neutralizeAt = trace.indexOf('neutralize');
    expect(neutralizeAt, 'neutralization never ran').toBeGreaterThan(-1);
    expect(trace.lastIndexOf('settle')).toBeGreaterThan(neutralizeAt);
    expect(trace.slice(0, neutralizeAt)).toContain('settle');
  });

  it('leaves an unscaled stage alone', async () => {
    const { realm, sheets, section } = makeStageRealm({ scale: 1 });
    await prepareForMeasurement(makeSurface(realm, []), host, {
      readySelector: 'section',
      fitSelector: 'section',
    });
    expect(section.getBoundingClientRect().width).toBe(1920);
    expect(sheets).toHaveLength(0);
  });
});
