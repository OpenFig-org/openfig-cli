/**
 * FigDeck — the Node face of `./fig-deck-core.mjs`.
 *
 * The format work (parse, encode, validate, `toDeckBytes`) is portable and
 * lives in the core; this adds the filesystem, and nothing else. The naming is
 * inverted on purpose — the core takes the new name and `FigDeck` keeps this
 * path and this export — so every `bin/*`, `lib/rasterizer/*` and
 * `mcp-server.mjs` call site, and the `openfig-cli/deck` package export, are
 * untouched.
 *
 * Static factories in the core use `new this()`, so `FigDeck.fromDeckBytes()`
 * still returns something with `saveDeck` on it.
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync, copyFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { FigDeckCore } from './fig-deck-core.mjs';
import { looksLikeZip } from './archive.mjs';
import { hashToHex } from './image-helpers.mjs';

export { FigDeckCore };

export class FigDeck extends FigDeckCore {
  /**
   * Load from a .deck file (ZIP archive).
   */
  static async fromDeckFile(deckPath) {
    const deck = this.fromDeckBytes(readFileSync(resolve(deckPath)));
    deck._materializeImages();
    return deck;
  }

  /**
   * Load from a raw .fig file.
   */
  static fromFigFile(figPath) {
    return this.fromFigBytes(readFileSync(resolve(figPath)));
  }

  /**
   * Load from a file, automatically detecting if it is a ZIP archive (.deck or zipped .fig)
   * or a raw .fig binary by inspecting the magic bytes.
   */
  static async fromFile(filePath) {
    const buf = readFileSync(resolve(filePath));
    if (looksLikeZip(buf)) {
      return this.fromDeckFile(filePath);
    } else {
      return this.fromFigBytes(buf);
    }
  }

  /**
   * Save as a .deck (ZIP archive).
   * @param {string} outPath - Output file path
   * @param {object} opts - { imagesDir, thumbnail, meta }
   */
  async saveDeck(outPath, opts = {}) {
    this.validate();
    const bytes = await this.toDeckBytes(opts);
    writeFileSync(resolve(outPath), bytes);
  }

  /**
   * Save just the canvas.fig binary.
   */
  async saveFig(outPath) {
    writeFileSync(resolve(outPath), await this.encodeFig());
  }

  /**
   * Write `this.images` into a temp directory and point `imagesDir` at it.
   *
   * `imagesDir` is a filesystem-path contract read by the rasterizer, the CLI
   * and the MCP server, so a Node-loaded deck still gets a real directory —
   * the same work `unzip` did, done in-process. Images then live in exactly
   * one place, so `this.images` is cleared.
   *
   * One deliberate divergence from `unzip`: a Figma-authored deck carries a
   * bare zero-length `images/` directory entry even when it has no images, and
   * `unzip` used to leave that empty directory behind, so `imagesDir` pointed
   * at nothing. Here such a deck keeps `imagesDir === null`, which every
   * consumer treats the same way as an empty directory.
   */
  _materializeImages() {
    if (this.images.size === 0) return;
    if (!this._tempDir) this._tempDir = mkdtempSync(join(tmpdir(), 'openfig_'));
    const imgDir = join(this._tempDir, 'images');
    mkdirSync(imgDir, { recursive: true });
    // Entry names come from the archive, so they are attacker-controlled: a
    // `.deck` is a document people receive from others. `join()` resolves
    // `..`, so an entry like `images/../../../.zshrc` would escape the temp
    // directory and overwrite an arbitrary file — reachable from every command
    // that opens a deck, including read-only ones. `unzip` refused such paths;
    // doing this in-process means enforcing containment ourselves.
    const prefix = resolve(imgDir) + sep;
    for (const [rel, data] of this.images) {
      const dest = resolve(imgDir, rel);
      if (!dest.startsWith(prefix)) {
        throw new Error(`Unsafe archive entry escapes the images directory: ${rel}`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
    }
    this.images.clear();
    this.imagesDir = imgDir;
  }

  /**
   * Build the images map for `toDeckBytes`, overlaying whatever is on disk on
   * top of any in-memory entries. The disk walk is the Node-only half of the
   * write path; `toDeckBytes` itself never sees a path.
   *
   * @param {string} [dirOverride] - `opts.imagesDir` from `saveDeck`
   * @returns {Map<string, Uint8Array>}
   */
  /**
   * Node's `toDeckBytes`: default the images to whatever is on disk.
   *
   * `_materializeImages()` spills a file-opened deck's images to `imagesDir`
   * and empties `this.images`, so the core — which only knows about the map —
   * would write a deck with no `images/` entries at all. `saveDeck` passed the
   * collected images in explicitly and was therefore correct; every other
   * caller, including the public `toBytes()`, was not, and produced a deck
   * Figma renders with blank image fills.
   */
  async toDeckBytes(opts = {}) {
    return super.toDeckBytes({
      ...opts,
      images: opts.images ?? this._collectImages(opts.imagesDir),
    });
  }

  _collectImages(dirOverride) {
    const images = new Map(this.images);
    const imgDir = dirOverride || this.imagesDir;
    if (imgDir && existsSync(imgDir)) {
      for (const entry of readdirSync(imgDir, { withFileTypes: true, recursive: true })) {
        if (entry.isFile()) {
          const fullPath = join(entry.parentPath ?? entry.path, entry.name);
          const rel = fullPath.slice(imgDir.length + 1).replace(/\\/g, '/');
          images.set(rel, readFileSync(fullPath));
        }
      }
    }
    return images;
  }

  /**
   * `importSymbols`' image-copy step. Both decks address their images by
   * `imagesDir`, so this is filesystem work start to finish and is the one
   * part of `importSymbols` the core cannot carry.
   *
   * @param {FigDeck} sourceDeck
   * @param {object[]} clonedNodes
   */
  _importImageAssets(sourceDeck, clonedNodes) {
    if (!sourceDeck.imagesDir) return;
    if (!this.imagesDir) {
      // Create a temp images dir for the target deck
      const tmp = this._tempDir || mkdtempSync(join(tmpdir(), 'openfig_'));
      if (!this._tempDir) this._tempDir = tmp;
      this.imagesDir = join(tmp, 'images');
      mkdirSync(this.imagesDir, { recursive: true });
    }

    const copyImagePaint = (paint) => {
      if (!paint) return;
      if (paint.type === 'IMAGE' || paint.image) {
        // Files on disk are named by SHA1 hex hash, not image.name (which is human-readable)
        const hash = paint.image?.hash?.length ? hashToHex(paint.image.hash) : null;
        if (hash) this._copyImageAsset(sourceDeck.imagesDir, hash);
      }
      if (paint.imageThumbnail) {
        const tHash = paint.imageThumbnail.hash?.length ? hashToHex(paint.imageThumbnail.hash) : null;
        if (tHash) this._copyImageAsset(sourceDeck.imagesDir, tHash);
      }
    };

    for (const clone of clonedNodes) {
      // Copy IMAGE fills from node fillPaints
      if (clone.fillPaints) {
        for (const paint of clone.fillPaints) copyImagePaint(paint);
      }
      // Copy images from symbolOverrides (INSTANCE nodes)
      if (clone.symbolData?.symbolOverrides) {
        for (const ov of clone.symbolData.symbolOverrides) {
          if (ov.fillPaints) {
            for (const paint of ov.fillPaints) copyImagePaint(paint);
          }
        }
      }
    }
  }

  /**
   * Copy an image asset file from a source images directory to this deck's images directory.
   * @param {string} srcImagesDir - Source images directory
   * @param {string} fileName - Image file name (hash)
   */
  _copyImageAsset(srcImagesDir, fileName) {
    if (!fileName || !this.imagesDir) return;
    const srcPath = join(srcImagesDir, fileName);
    const destPath = join(this.imagesDir, fileName);
    if (existsSync(srcPath) && !existsSync(destPath)) {
      copyFileSync(srcPath, destPath);
    }
  }
}
