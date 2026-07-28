/**
 * The browser host's byte codecs, checked against the Node host's.
 *
 * These four functions are the quietest place the two hosts can diverge: every
 * one of them is a drop-in for a `Buffer`/`node:zlib`/`node:crypto` call whose
 * browser equivalent is *stricter*, and a divergence shows up as a missing
 * image or an empty asset map rather than as an error.
 *
 * They need no DOM, so they run in plain Node against the real Node host —
 * which is the only comparison worth making. (`readTemplateMeta` and
 * `openSurface` do need a DOM and are covered in `browser-host.test.mjs`.)
 */
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserConversionHost } from '../../lib/slides/browser/browser-conversion-host.mjs';
import { NodeConversionHost } from '../../lib/slides/node/node-conversion-host.mjs';

const browserHost = new BrowserConversionHost({ sourceHtml: '<html></html>', onLog: () => {} });

let scratch;
function nodeHost() {
  scratch ??= mkdtempSync(join(tmpdir(), 'host-codec-'));
  return new NodeConversionHost({ sourcePath: 'unused.html', scratchDir: scratch });
}

describe('bytesFromBase64', () => {
  it('agrees with Buffer.from on ordinary input', () => {
    const bytes = randomBytes(3000);
    const b64 = bytes.toString('base64');
    expect([...browserHost.bytesFromBase64(b64)]).toEqual([...nodeHost().bytesFromBase64(b64)]);
  });

  it('returns bytes, not a binary string', () => {
    expect(browserHost.bytesFromBase64('AAEC')).toBeInstanceOf(Uint8Array);
  });

  // The three ways `Buffer.from(b64, 'base64')` is lenient and `atob` is not.
  // The input is `a.data` out of the export's own manifest JSON, so any of the
  // three would have failed in the browser only.
  it('ignores whitespace and newlines the way Buffer.from does', () => {
    const bytes = randomBytes(300);
    const wrapped = bytes.toString('base64').replace(/(.{60})/g, '$1\n');
    expect([...browserHost.bytesFromBase64(wrapped)]).toEqual([...bytes]);
  });

  it('accepts unpadded input', () => {
    for (const src of [Buffer.from('a'), Buffer.from('ab'), Buffer.from('abc')]) {
      const unpadded = src.toString('base64').replace(/=+$/, '');
      expect([...browserHost.bytesFromBase64(unpadded)]).toEqual([...src]);
    }
  });

  it('accepts the base64url alphabet', () => {
    const bytes = Buffer.from([0xfb, 0xff, 0xbe, 0x3f]);
    expect([...browserHost.bytesFromBase64(bytes.toString('base64url'))]).toEqual([...bytes]);
  });
});

describe('base64FromBytes', () => {
  it('agrees with Buffer#toString for a whole image-sized payload', () => {
    // `String.fromCharCode(...bytes)` exceeds the argument limit somewhere
    // around 100 KB, and the only caller inlines whole SVG assets.
    const bytes = randomBytes(400_000);
    const out = browserHost.base64FromBytes(bytes);
    expect(out).toBe(bytes.toString('base64'));
    expect(out).toBe(nodeHost().base64FromBytes(bytes));
  });

  it('emits padded standard-alphabet output with no newlines', () => {
    const out = browserHost.base64FromBytes(randomBytes(1001));
    expect(out).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});

describe('gunzip', () => {
  it('agrees with zlib.gunzipSync', async () => {
    const payload = randomBytes(50_000);
    const out = await browserHost.gunzip(new Uint8Array(gzipSync(payload)));
    expect(Buffer.from(out).equals(payload)).toBe(true);
  });
});

describe('sha1Hex', () => {
  it('agrees with node:crypto, which is the other side of the image join', async () => {
    // `indexAssetsBySha1` hashes here and `mapImageSrcsToAssets` hashes in the
    // page with `crypto.subtle`. If the two disagree the join comes back empty
    // and the conversion succeeds with every image missing.
    const bytes = randomBytes(9999);
    expect(await browserHost.sha1Hex(bytes)).toBe(createHash('sha1').update(bytes).digest('hex'));
    expect(await browserHost.sha1Hex(bytes)).toBe(await nodeHost().sha1Hex(bytes));
  });

  it('pads single-digit bytes', async () => {
    expect(await browserHost.sha1Hex(new Uint8Array(0)))
      .toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });
});

describe('the artifact sink', () => {
  it('rejects exactly the names the Node host rejects', async () => {
    // The filename comes from a uuid key in the export's own JSON. There is no
    // filesystem here to escape into, so this buys the browser nothing — it is
    // here so both hosts refuse the same input.
    const hostile = ['../x.png', 'a/b.png', 'a\\b.png', '..', ''];
    for (const name of hostile) {
      await expect(browserHost.putMedia(name, new Uint8Array(1))).rejects.toThrow(/Unsafe media filename/);
      await expect(nodeHost().putMedia(name, new Uint8Array(1))).rejects.toThrow(/Unsafe media filename/);
    }
  });

  it('hands back a filename and bytes, and leaves the mime to the core', async () => {
    const ref = await browserHost.putMedia('a.png', new Uint8Array([1, 2]));
    // Node's `putMedia` returns no mime either; the core stamps it onto its own
    // copy of the record, so a host that guessed would be a second source of
    // truth for a field nobody reads from the host's copy.
    expect(Object.keys(ref).sort()).toEqual(['bytes', 'filename']);
    expect(browserHost.media.get('a.png')).toBe(ref);
  });

  it('keeps the three named artifacts the handoff stage expects', async () => {
    await browserHost.putText('manifest.json', '{}');
    expect(browserHost.texts.get('manifest.json')).toBe('{}');
  });
});

describe('capabilities', () => {
  it('preloads web fonts by default, as the Node path does', () => {
    // A real browser has the user's real fonts, which makes skipping the
    // preload look free — but the font set parity is measured against is
    // Figma's (Google Fonts + system families), not this machine's. With it
    // off, 45 of 188 elements on london-underground-map diverge from the Node
    // manifest, worst 81px; with it on, 3.
    expect(browserHost.webFontPreload).toBe(true);
  });

  it('still allows opting out, for a host that knows its fonts are complete', () => {
    const h = new BrowserConversionHost({ sourceHtml: '<html></html>', webFontPreload: false });
    expect(h.webFontPreload).toBe(false);
  });

  it('defaults flex auto-layout off, as Node does', () => {
    expect(browserHost.flexAutoLayout).toBe(false);
  });

  it('collects log lines as well as emitting them', () => {
    const seen = [];
    const h = new BrowserConversionHost({ sourceHtml: '<html></html>', onLog: (l) => seen.push(l) });
    h.log('one');
    expect(seen).toEqual(['one']);
    expect(h.logLines).toEqual(['one']);
  });
});

describe('ensureInter', () => {
  /**
   * A surface stub whose realm answers by *measurement*, which is how the host
   * actually detects Inter. `document.fonts.check()` cannot be used for this —
   * it reports on registered FontFace objects, so it returns true for a family
   * with no face at all, including names that cannot exist. Stubbing that call
   * is what let an inert implementation pass: the mock encoded a wrong model of
   * the API, so the assertion held both before and after a fix.
   *
   * Here a canvas reports one width for the absent-sentinel family and, when
   * `interPresent`, a different width for Inter — the signal the host reads.
   */
  function stubSurface(interPresent) {
    const loaded = [];
    const ABSENT_WIDTH = 100;
    return {
      loaded,
      evaluate: async (fn) => fn({
        realm: {
          document: {
            createElement: () => ({
              getContext: () => {
                let font = '';
                return {
                  set font(v) { font = v; },
                  get font() { return font; },
                  measureText: () => ({
                    width: interPresent && /(^|\s)Inter\s*,/.test(font) ? 120 : ABSENT_WIDTH,
                  }),
                };
              },
            }),
          },
        },
        arg: undefined,
      }),
      loadWebFont: async (family, url) => { loaded.push({ family, url }); },
    };
  }

  it('loads Inter when the machine does not have it', async () => {
    // `reresolveSystemFontsToInter` prepends `Inter,` to every system-font
    // stack unconditionally, but the preload that guarantees Inter exists is
    // skipped whenever `webFontPreload` is false — which is always, here. With
    // no Inter the stack falls through to the next family and geometry is
    // measured in a font the manifest does not name.
    const surface = stubSurface(false);
    const logs = [];
    const h = new BrowserConversionHost({ sourceHtml: '<html></html>', onLog: (l) => logs.push(l) });
    await h.ensureInter(surface);
    expect(surface.loaded).toHaveLength(1);
    expect(surface.loaded[0].family).toBe('Inter');
    expect(surface.loaded[0].url).toContain('family=Inter');
    expect(logs.join('\n')).toContain('Inter is not installed locally');
  });

  it('makes no request when Inter is already installed', async () => {
    const surface = stubSurface(true);
    const h = new BrowserConversionHost({ sourceHtml: '<html></html>', onLog: () => {} });
    await h.ensureInter(surface);
    expect(surface.loaded).toEqual([]);
  });

  it('is skippable, since it is the only network request the path makes', async () => {
    const surface = stubSurface(false);
    const h = new BrowserConversionHost({ sourceHtml: '<html></html>', ensureInter: false, onLog: () => {} });
    // The flag gates the call from `openSurface`; the method itself stays
    // callable so this test can distinguish "not called" from "did nothing".
    expect(h._ensureInter).toBe(false);
    await h.ensureInter(surface);
    expect(surface.loaded).toHaveLength(1);
  });
});

process.on('exit', () => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});
