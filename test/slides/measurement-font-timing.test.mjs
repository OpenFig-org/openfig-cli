/**
 * Inter has to be loaded *after* the export rehydrates, and before the pass
 * that points system-font stacks at it.
 *
 * The browser host used to do it when the surface opened. That is too early:
 * at that moment the Claude Design export has not rehydrated (zero sections),
 * and when it does its runtime replaces the document head — taking the
 * stylesheet link with it. The load never completed, so every browser
 * conversion spent the full `loadWebFont` timeout, printed "Inter could not be
 * fetched", and then measured system-font text in a substitute face while the
 * deck still named Inter. Measured against a real export: the link was gone
 * from the realm by the time the sections appeared.
 *
 * Nothing about that was visible in the output — the deck converts, the node
 * count is right, only the text metrics are quietly wrong — so the ordering is
 * pinned here rather than left to be rediscovered.
 */
import { describe, it, expect } from 'vitest';
import { prepareForMeasurement } from '../../lib/slides/core/measurement-surface.mjs';

/** Records the order of the calls prepareForMeasurement makes. */
function makeSurface(trace) {
  return {
    waitForSelector: async () => { trace.push('waitForSelector'); },
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes('firstTokenIsNonPortable')) trace.push('reresolveSystemFontsToInter');
      else if (src.includes('fonts.ready')) trace.push('awaitFontsReady');
      else trace.push('evaluate');
      return [];
    },
    loadWebFont: async () => { trace.push('loadWebFont'); },
    settle: async () => { trace.push('settle'); },
  };
}

describe('prepareForMeasurement font ordering', () => {
  it('ensures the re-resolve font only after the page is ready', async () => {
    const trace = [];
    const host = {
      webFontPreload: false,
      log: () => {},
      ensureReresolveFont: async () => { trace.push('ensureReresolveFont'); },
    };
    await prepareForMeasurement(makeSurface(trace), host, { readySelector: 'section' });

    const at = (name) => trace.indexOf(name);
    expect(at('ensureReresolveFont'), 'hook never ran').toBeGreaterThan(-1);
    expect(
      at('ensureReresolveFont'),
      'the font was requested before the export had rehydrated — the head it lands in gets replaced',
    ).toBeGreaterThan(at('waitForSelector'));
    expect(
      at('ensureReresolveFont'),
      'the font must exist before system-font stacks are pointed at it',
    ).toBeLessThan(at('reresolveSystemFontsToInter'));
  });

  it('waits on document.fonts after requesting it, since a stylesheet load is not the faces', async () => {
    // `loadWebFont` resolves on the <link> load event, which only means the CSS
    // arrived — the font files are fetched lazily when the family is first
    // used. Measured in Chrome: immediately after the load event Inter still
    // measured identically to a family that does not exist, and only differed
    // once `document.fonts.ready` had settled.
    const trace = [];
    const host = {
      webFontPreload: false,
      log: () => {},
      ensureReresolveFont: async () => { trace.push('ensureReresolveFont'); },
    };
    await prepareForMeasurement(makeSurface(trace), host, { readySelector: 'section' });
    expect(trace.indexOf('awaitFontsReady')).toBeGreaterThan(trace.indexOf('ensureReresolveFont'));
  });

  it('is optional — a host that guarantees its own fonts need not implement it', async () => {
    const trace = [];
    await expect(
      prepareForMeasurement(makeSurface(trace), { webFontPreload: false, log: () => {} }, { readySelector: 'section' }),
    ).resolves.toBeUndefined();
    expect(trace).toContain('reresolveSystemFontsToInter');
  });
});
