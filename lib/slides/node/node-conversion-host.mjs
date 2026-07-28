/**
 * The Node implementation of the conversion host (`../core/host-contract.mjs`).
 *
 * Everything the core is not allowed to know about lives here: the filesystem,
 * `Buffer`, `node:zlib`, `node:crypto`, `node-html-parser`, Playwright, and
 * the environment variables that switch behaviour.
 *
 * The artifact sink writes a handoff bundle layout that
 * `../handoff/bundle-loader.mjs` re-discovers by scanning, so the layout is a
 * contract rather than an implementation detail: `manifest.json` sits directly
 * in the scratch root, media lands in `media/<uuid>.<ext>`, and `template.html`
 * stays the only `.html` in the root (the loader takes the first one it finds).
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { gunzipSync } from 'zlib';
import { parse as parseHtml } from 'node-html-parser';
import { openPlaywrightSurface } from '../playwright-layout.mjs';

// `filename` is built from a key in the export's own JSON, so it is
// attacker-controlled: a uuid of `../../../../etc/cron.d/x` would otherwise
// escape the scratch directory, since `join()` resolves `..`. Mirrors the
// containment check on the archive read path in `core/fig-deck.mjs`.
function assertSafeName(filename) {
  if (typeof filename !== 'string' || filename === '') {
    throw new Error(`Unsafe media filename: ${JSON.stringify(filename)}`);
  }
  if (filename.includes('/') || filename.includes('\\') || filename.split(/[\\/]/).includes('..') || filename === '..') {
    throw new Error(`Unsafe media filename escapes the media directory: ${filename}`);
  }
}

export class NodeConversionHost {
  /**
   * @param {object} opts
   * @param {string} opts.sourcePath - The standalone export on disk; the
   *   surface loads this file, not the template string, so the export's own
   *   runtime rehydrates itself exactly as authored.
   * @param {string} opts.scratchDir - Bundle root for the emitted artifacts.
   */
  constructor({ sourcePath, scratchDir }) {
    this.sourcePath = sourcePath;
    this.scratchDir = scratchDir;
    this.mediaDir = join(scratchDir, 'media');
    mkdirSync(scratchDir, { recursive: true });
    // Created unconditionally, as `decodeAssets` used to, so an export with no
    // assets still produces the same bundle layout.
    mkdirSync(this.mediaDir, { recursive: true });
  }

  // --- byte codecs ---------------------------------------------------------

  bytesFromBase64(b64) {
    return Buffer.from(b64, 'base64');
  }

  base64FromBytes(bytes) {
    return Buffer.from(bytes).toString('base64');
  }

  gunzip(bytes) {
    return gunzipSync(bytes);
  }

  async sha1Hex(bytes) {
    return createHash('sha1').update(bytes).digest('hex');
  }

  // --- artifact sink -------------------------------------------------------

  async putMedia(filename, bytes) {
    assertSafeName(filename);
    const path = join(this.mediaDir, filename);
    writeFileSync(path, bytes);
    return { filename, path };
  }

  async putText(name, text) {
    assertSafeName(name);
    writeFileSync(join(this.scratchDir, name), text);
  }

  // --- html-string parsing -------------------------------------------------

  readTemplateMeta(templateHtml) {
    const doc = parseHtml(templateHtml, { lowerCaseTagName: false, comment: false });
    const titleTag = doc.querySelector('title');
    const snTag = doc.querySelector('script#speaker-notes');
    return {
      title: titleTag?.textContent?.trim() ?? null,
      speakerNotesJson: snTag ? snTag.textContent : null,
    };
  }

  // --- measurement realm ---------------------------------------------------

  async openSurface({ viewport }) {
    return openPlaywrightSurface(this.sourcePath, viewport);
  }

  // --- capabilities & diagnostics ------------------------------------------

  // Headless Chromium falls back to system faces for the export's own
  // @font-face urls, so the Node path preloads the declared families from
  // Google Fonts. OPENFIG_NO_FONT_PRELOAD=1 skips it (offline or airgapped CI).
  get webFontPreload() {
    return process.env.OPENFIG_NO_FONT_PRELOAD !== '1';
  }

  get flexAutoLayout() {
    return Boolean(process.env.OPENFIG_FLEX_AUTO_LAYOUT);
  }

  log(line) {
    process.stderr.write(line + '\n');
  }
}
