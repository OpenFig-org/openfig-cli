/**
 * The browser implementation of the conversion host (`../core/host-contract.mjs`).
 *
 * The Node counterpart is `../node/node-conversion-host.mjs`; reading the two
 * side by side is the fastest way to see what is environment and what is not.
 * Where Node reaches for `Buffer`, `node:zlib`, `node:crypto`,
 * `node-html-parser`, Playwright and the filesystem, this reaches for `atob`,
 * `fflate`, `crypto.subtle`, `DOMParser`, an iframe and two `Map`s.
 *
 * Nothing here is on the core's import graph, so importing `fflate` is free —
 * `test/core/core-portability.test.mjs` bans third-party imports from the
 * core, not from a host.
 *
 * Artifacts stay in memory. Node writes a bundle directory because the
 * deck-emission tail re-reads it off disk; a browser has nothing to re-read
 * from, so `putMedia` hands back bytes and `./memory-bundle.mjs` assembles the
 * same shape the loader would have produced.
 */
import { gunzipSync } from 'fflate';
import { checkStandaloneExport, NOT_A_STANDALONE_EXPORT } from '../core/convert-standalone.mjs';
import { openIframeSurface } from './iframe-surface.mjs';

/** What a user should be told when the input is not a Claude Design export. */
export const REQUIRES_STANDALONE_EXPORT =
  'This file is not a Claude Design standalone export. Open your design in Claude, ' +
  'export it as a standalone HTML file (usually named "<Project> (Standalone).html"), ' +
  'and convert that. A screenshot, a saved web page, or hand-written HTML cannot be converted.';

/**
 * Answer the precondition question *before* anything is loaded into a live
 * realm — the ordering the core documents as a security property, not only a
 * UX one: arbitrary HTML must never reach an iframe and run its scripts.
 *
 * The core re-checks, so a caller that skips this still cannot get past it.
 *
 * @param {string} sourceHtml
 * @returns {{ok: boolean, reason: string|null, message: string|null}}
 */
export function precheckStandaloneExport(sourceHtml) {
  const { ok, reason } = checkStandaloneExport(sourceHtml);
  return { ok, reason, message: ok ? null : REQUIRES_STANDALONE_EXPORT };
}

// `filename` is built from a key in the export's own JSON, so it is
// attacker-controlled. There is no filesystem here to escape into, so this
// buys no browser-side safety at all — it is here so both hosts reject the
// same names. Parity on rejection is the point; see the Node host's copy.
function assertSafeName(filename) {
  if (typeof filename !== 'string' || filename === '') {
    throw new Error(`Unsafe media filename: ${JSON.stringify(filename)}`);
  }
  if (filename.includes('/') || filename.includes('\\') || filename.split(/[\\/]/).includes('..') || filename === '..') {
    throw new Error(`Unsafe media filename escapes the media directory: ${filename}`);
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

// `String.fromCharCode(...bytes)` exceeds the argument limit somewhere around
// 100 KB and these are whole images, so the string is built in chunks.
const B64_CHUNK = 0x8000;

/** Ensure a family is actually resolvable, or say so. See `ensureInter`. */
const INTER_CSS_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap';

export class BrowserConversionHost {
  /**
   * @param {object} opts
   * @param {string} opts.sourceHtml - The export, as text. Node takes a path
   *   and loads the file so the export's own runtime rehydrates it exactly as
   *   authored; there is no path here, so the text is handed to a `blob:` URL
   *   and the effect is the same.
   * @param {boolean} [opts.flexAutoLayout=false] - Matches the Node default.
   * @param {boolean} [opts.webFontPreload=true] - Preload declared families
   *   from Google Fonts, as the Node path does. It is tempting to skip this
   *   because a real browser already has the user's real fonts — but the
   *   relevant font set is *Figma's*, which is Google Fonts plus system
   *   families, not whatever this machine happens to have installed. Measuring
   *   in a locally-substituted face while the deck names the declared one is
   *   the 0.5.0 overflow bug from the other side. Measured on
   *   london-underground-map: off, 45 of 188 elements diverge from the Node
   *   path (worst 81px); on, 3 (worst 69px).
   * @param {boolean} [opts.ensureInter=true] - See `ensureInter` below.
   * @param {Document} [opts.ownerDocument]
   * @param {Element} [opts.container] - Where the measurement iframe is put.
   * @param {(line: string) => void} [opts.onLog]
   */
  constructor({
    sourceHtml,
    flexAutoLayout = false,
    webFontPreload = true,
    ensureInter = true,
    ownerDocument,
    container,
    onLog,
  } = {}) {
    if (typeof sourceHtml !== 'string') {
      throw new Error('BrowserConversionHost: sourceHtml must be the export text');
    }
    // Deliberately does *not* create the iframe: an input that fails the
    // `__bundler` precondition must never reach a live realm, and the core
    // throws that precondition before it calls `openSurface`.
    this.sourceHtml = sourceHtml;
    this.media = new Map();   // filename → { filename, bytes }
    this.texts = new Map();   // name → string
    this.logLines = [];
    this._flexAutoLayout = flexAutoLayout;
    this._webFontPreload = webFontPreload;
    this._ensureInter = ensureInter;
    this._ownerDocument = ownerDocument;
    this._container = container;
    this._onLog = onLog;
  }

  // --- byte codecs ---------------------------------------------------------

  // `Buffer.from(b64, 'base64')` is lenient in three ways `atob` is not: it
  // ignores whitespace, tolerates missing padding, and accepts the base64url
  // alphabet. The input is `a.data` straight out of the export's own manifest
  // JSON, so a wrapped or unpadded payload would fail in the browser only.
  bytesFromBase64(b64) {
    let s = String(b64).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4;
    if (pad === 2) s += '==';
    else if (pad === 3) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  base64FromBytes(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += B64_CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
    }
    // Padded, standard alphabet, no newlines — `btoa` already is, and
    // `inlineSvgImages` puts the result straight into a data: URL.
    return btoa(bin);
  }

  // `fflate` rather than `DecompressionStream('gzip')`: the stream form costs
  // plumbing and is the only piece of this host with a browser-version floor.
  // The contract awaits this either way, so sync is legal.
  gunzip(bytes) {
    return gunzipSync(bytes);
  }

  async sha1Hex(bytes) {
    // Same hex mapping as the core's own payload in `convert-standalone.mjs`,
    // which produces the other side of this join. If the two ever disagree the
    // image map comes back empty and the conversion reports success with every
    // image missing, so they are kept spelled identically.
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    let out = '';
    for (const b of new Uint8Array(digest)) out += HEX[b];
    return out;
  }

  // --- artifact sink -------------------------------------------------------

  async putMedia(filename, bytes) {
    assertSafeName(filename);
    const ref = { filename, bytes };
    this.media.set(filename, ref);
    // No `mime`: Node's `putMedia` does not return one either, and the core
    // stamps it onto its own copy of the record immediately afterwards. A host
    // that guessed here would be the only source of a second, divergent value.
    return ref;
  }

  async putText(name, text) {
    assertSafeName(name);
    this.texts.set(name, text);
  }

  // --- html-string parsing -------------------------------------------------

  readTemplateMeta(templateHtml) {
    // An inert document: `DOMParser` does not run scripts and does not fetch
    // subresources, which is both correct and required — this is called on the
    // export's own template before anything is measured.
    const doc = new DOMParser().parseFromString(templateHtml, 'text/html');
    const titleTag = doc.querySelector('title');
    const snTag = doc.querySelector('script#speaker-notes');
    return {
      title: titleTag?.textContent?.trim() ?? null,
      // Left unparsed, as the contract requires, so both hosts fail the same
      // way on malformed JSON.
      speakerNotesJson: snTag ? snTag.textContent : null,
    };
  }

  // --- measurement realm ---------------------------------------------------

  async openSurface({ viewport }) {
    const surface = await openIframeSurface({
      sourceHtml: this.sourceHtml,
      viewport,
      ownerDocument: this._ownerDocument,
      container: this._container,
    });
    return surface;
  }

  /**
   * Called by `prepareForMeasurement` once the export has rehydrated, which is
   * the only moment this can work — see the comment at the call site.
   */
  async ensureReresolveFont(surface) {
    if (!this._ensureInter) return;
    try {
      await this.ensureInter(surface);
    } catch {
      // Never fatal: a missing Inter degrades fidelity, it does not stop a
      // conversion.
    }
  }

  /**
   * `reresolveSystemFontsToInter` runs unconditionally in the shared
   * preparation sequence and prepends `Inter,` to every system-font stack, but
   * the Google-Fonts preload that guarantees Inter exists is skipped whenever
   * `webFontPreload` is false — which is always, here. On a machine without
   * Inter installed the stack then falls through to the next family: geometry
   * is measured in the system font while the handoff still emits
   * `font: Inter`, which is the 0.5.0 overflow bug arriving from the other
   * side.
   *
   * So check for Inter specifically and load only that one family if it is
   * missing. This is the sole network request the browser path makes, it
   * carries no part of the export, and it is skippable with
   * `ensureInter: false`.
   */
  async ensureInter(surface) {
    const present = await surface.evaluate(({ realm }) => {
      const { document } = realm;
      // `document.fonts.check()` does NOT answer "is this family available".
      // It reports on registered FontFace objects, so a family with no
      // registered face — which is exactly the case we care about — returns
      // true, meaning "nothing to load". Measure instead: render against the
      // family with a fallback, then against a name that cannot exist with
      // the same fallback. Identical widths mean the family never applied.
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return true;
        const sample = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789';
        const measure = (family) => {
          ctx.font = `40px ${family}, monospace`;
          return ctx.measureText(sample).width;
        };
        const absent = measure('"OpenFigDefinitelyAbsentFamily"');
        return measure('Inter') !== absent;
      } catch {
        return true;
      }
    });
    if (present) return;
    this.log(
      'convert-html: Inter is not installed locally; fetching it from Google Fonts so text is ' +
      'measured in the face the deck will name. Pass ensureInter:false to skip (geometry will ' +
      'then be measured in a substitute font).',
    );
    try {
      await surface.loadWebFont('Inter', INTER_CSS_URL);
    } catch {
      this.log(
        'convert-html: Inter could not be fetched, so text on system-font stacks is measured in a ' +
        'substitute while the deck names Inter. Those elements may be sized wrongly. A blocked ' +
        'network or a Content-Security-Policy that disallows fonts.googleapis.com is the usual cause.',
      );
    }
  }

  // --- capabilities & diagnostics ------------------------------------------

  // On by default: parity is measured against the Node path, which preloads,
  // and the font set that matters is Figma's (Google Fonts + system), not this
  // machine's. Turning it off skips the whole-document `getComputedStyle` walk
  // that collects the families — the most expensive step of the preparation
  // sequence — at the cost of measuring in whatever faces happen to be local.
  get webFontPreload() {
    return this._webFontPreload;
  }

  get flexAutoLayout() {
    return this._flexAutoLayout;
  }

  // The core calls this once per warning line and *also* returns the
  // structured warnings, so the array is the product and the console is the
  // debug aid.
  log(line) {
    this.logLines.push(line);
    if (this._onLog) this._onLog(line);
    else console.warn(line);
  }
}

export { NOT_A_STANDALONE_EXPORT };
