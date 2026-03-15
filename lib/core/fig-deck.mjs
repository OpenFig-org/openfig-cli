/**
 * FigDeck — Core class for reading, modifying, and writing Figma .deck/.fig files.
 *
 * FORMAT RULES (hard-won):
 * - .deck = ZIP containing canvas.fig, thumbnail.png, meta.json, images/
 * - canvas.fig = prelude ("fig-deck" or "fig-kiwi") + version (uint32 LE)
 *   + length-prefixed chunks
 * - Chunk 0 = kiwi schema (deflateRaw compressed)
 * - Chunk 1 = message data (MUST be zstd compressed — Figma rejects deflateRaw)
 * - Chunk 2+ = optional additional data (pass through as-is)
 */
import { decodeBinarySchema, compileSchema, encodeBinarySchema } from 'kiwi-schema';
import { decompress } from 'fzstd';
import { inflateRaw, deflateRaw } from 'pako';
import { ZstdCodec } from 'zstd-codec';
import yazl from 'yazl';
import { readFileSync, createWriteStream, existsSync, mkdtempSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { nid } from './node-helpers.mjs';

export class FigDeck {
  constructor() {
    this.header = null;       // { prelude, version }
    this.schema = null;       // decoded kiwi binary schema
    this.compiledSchema = null;
    this.message = null;      // decoded message { nodeChanges, blobs, ... }
    this.rawFiles = [];       // original compressed chunks (for passthrough)
    this.nodeMap = new Map();  // "s:l" → node
    this.childrenMap = new Map(); // "s:l" → [child nodes]
    this.deckMeta = null;     // parsed meta.json (when loaded from .deck)
    this.deckThumbnail = null; // raw thumbnail PNG bytes
    this.imagesDir = null;    // path to extracted images directory
    this._tempDir = null;     // temp dir for deck extraction
  }

  /**
   * Load from a .deck file (ZIP archive).
   */
  static async fromDeckFile(deckPath) {
    const deck = new FigDeck();
    const absPath = resolve(deckPath);

    // Extract to temp dir
    const tmp = mkdtempSync(join(tmpdir(), 'openfig_'));
    execSync(`unzip -o "${absPath}" -d "${tmp}"`, { stdio: 'pipe' });
    deck._tempDir = tmp;

    // Read canvas.fig
    const figPath = join(tmp, 'canvas.fig');
    if (!existsSync(figPath)) {
      throw new Error('No canvas.fig found in deck archive');
    }
    deck._parseFig(readFileSync(figPath));

    // Read meta.json
    const metaPath = join(tmp, 'meta.json');
    if (existsSync(metaPath)) {
      deck.deckMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
    }

    // Read thumbnail
    const thumbPath = join(tmp, 'thumbnail.png');
    if (existsSync(thumbPath)) {
      deck.deckThumbnail = readFileSync(thumbPath);
    }

    // Record images dir
    const imgDir = join(tmp, 'images');
    if (existsSync(imgDir)) {
      deck.imagesDir = imgDir;
    }

    return deck;
  }

  /**
   * Load from a raw .fig file.
   */
  static fromFigFile(figPath) {
    const deck = new FigDeck();
    deck._parseFig(readFileSync(resolve(figPath)));
    return deck;
  }

  /**
   * Parse a canvas.fig buffer.
   * Format: prelude (8 bytes ASCII) + version (uint32 LE) + N×(length uint32 LE + chunk bytes)
   * Known preludes: "fig-kiwi", "fig-deck", "fig-jam."
   */
  _parseFig(buf) {
    const data = new Uint8Array(buf.buffer ?? buf);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Read 8-byte prelude
    const prelude = String.fromCharCode(...data.subarray(0, 8));
    const version = view.getUint32(8, true);
    this.header = { prelude, version };

    // Read length-prefixed chunks
    const files = [];
    let off = 12;
    while (off < data.byteLength) {
      const len = view.getUint32(off, true);
      off += 4;
      files.push(data.subarray(off, off + len));
      off += len;
    }
    this.rawFiles = files;

    // Chunk 0: schema (always deflateRaw)
    const schemaData = inflateRaw(files[0]);
    this.schema = decodeBinarySchema(schemaData);
    this.compiledSchema = compileSchema(this.schema);

    // Chunk 1: message (zstd or deflateRaw — auto-detect)
    let msgData;
    if (files[1][0] === 0x28 && files[1][1] === 0xb5 &&
        files[1][2] === 0x2f && files[1][3] === 0xfd) {
      msgData = decompress(files[1]); // zstd
    } else {
      msgData = inflateRaw(files[1]); // deflateRaw fallback
    }
    this.message = this.compiledSchema.decodeMessage(msgData);

    this.rebuildMaps();
  }

  /**
   * Rebuild nodeMap and childrenMap from message.nodeChanges.
   */
  rebuildMaps() {
    this.nodeMap.clear();
    this.childrenMap.clear();

    for (const node of this.message.nodeChanges) {
      const id = nid(node);
      if (id) this.nodeMap.set(id, node);
    }

    for (const node of this.message.nodeChanges) {
      if (!node.parentIndex?.guid) continue;
      const pid = `${node.parentIndex.guid.sessionID}:${node.parentIndex.guid.localID}`;
      if (!this.childrenMap.has(pid)) this.childrenMap.set(pid, []);
      this.childrenMap.get(pid).push(node);
    }
  }

  /** Get node by string ID "s:l" */
  getNode(id) {
    return this.nodeMap.get(id);
  }

  /** Get children of a node by string ID */
  getChildren(id) {
    return this.childrenMap.get(id) || [];
  }

  /** Get all SLIDE nodes */
  getSlides() {
    return this.message.nodeChanges.filter(n => n.type === 'SLIDE');
  }

  /** Get only active (non-REMOVED) slides */
  getActiveSlides() {
    return this.getSlides().filter(n => n.phase !== 'REMOVED');
  }

  /** Get a single active slide by 1-based index. Slide 1 is the first slide. */
  getSlide(n) {
    const slides = this.getActiveSlides();
    if (n < 1 || n > slides.length) {
      throw new RangeError(`Slide ${n} out of range (1–${slides.length})`);
    }
    return slides[n - 1];
  }

  /** Get user-facing CANVAS nodes (pages), sorted by position. Excludes Figma's internal canvas. */
  getPages() {
    return this.message.nodeChanges
      .filter(n => n.type === 'CANVAS' && n.phase !== 'REMOVED' && n.name !== 'Internal Only Canvas')
      .sort((a, b) => (a.parentIndex?.position ?? '').localeCompare(b.parentIndex?.position ?? ''));
  }

  /** Get a single page by 1-based index. Page 1 is the first page. */
  getPage(n) {
    const pages = this.getPages();
    if (n < 1 || n > pages.length) {
      throw new RangeError(`Page ${n} out of range (1–${pages.length})`);
    }
    return pages[n - 1];
  }

  /** Get all INSTANCE nodes */
  getInstances() {
    return this.message.nodeChanges.filter(n => n.type === 'INSTANCE');
  }

  /** Get all SYMBOL nodes */
  getSymbols() {
    return this.message.nodeChanges.filter(n => n.type === 'SYMBOL');
  }

  /** Find the INSTANCE child of a SLIDE */
  getSlideInstance(slideId) {
    const children = this.getChildren(slideId);
    return children.find(c => c.type === 'INSTANCE');
  }

  /** Highest localID in use (for generating new IDs) */
  maxLocalID() {
    let max = 0;
    for (const node of this.message.nodeChanges) {
      if (node.guid?.localID > max) max = node.guid.localID;
    }
    return max;
  }

  /**
   * DFS walk from a root node.
   * @param {string} rootId - "s:l" format
   * @param {Function} visitor - (node, depth) => void
   */
  walkTree(rootId, visitor, depth = 0) {
    const node = this.getNode(rootId);
    if (!node) return;
    visitor(node, depth);
    for (const child of this.getChildren(rootId)) {
      this.walkTree(nid(child), visitor, depth + 1);
    }
  }

  /**
   * Encode message to canvas.fig binary.
   * Returns a Promise<Uint8Array> because zstd-codec uses callbacks.
   */
  encodeFig() {
    return new Promise((resolve, reject) => {
      ZstdCodec.run(zstd => {
        try {
          const z = new zstd.Simple();

          const encodedMsg = this.compiledSchema.encodeMessage(this.message);
          const compSchema = deflateRaw(encodeBinarySchema(this.schema));
          const compMsg = z.compress(encodedMsg, 3);

          const prelude = this.header.prelude;
          const chunks = [compSchema, compMsg];
          // Pass through any additional chunks (chunk 2+)
          for (let i = 2; i < this.rawFiles.length; i++) {
            chunks.push(this.rawFiles[i]);
          }

          const headerSize = prelude.length + 4;
          const totalSize = chunks.reduce((sz, c) => sz + 4 + c.byteLength, headerSize);
          const buf = new Uint8Array(totalSize);
          const view = new DataView(buf.buffer);
          const enc = new TextEncoder();

          let off = 0;
          off = enc.encodeInto(prelude, buf).written;
          view.setUint32(off, this.header.version, true);
          off += 4;

          for (const chunk of chunks) {
            view.setUint32(off, chunk.byteLength, true);
            off += 4;
            buf.set(chunk, off);
            off += chunk.byteLength;
          }

          resolve(buf);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /**
   * Validate deck integrity before saving. Warns about issues that would
   * cause Figma to fail silently (blank slides, missing symbols, etc.).
   */
  validate() {
    const warnings = [];
    const symbols = this.getSymbols().filter(s => s.phase !== 'REMOVED');

    // Check for variant name / variantPropSpecs mismatch
    const byKey = new Map();
    for (const sym of symbols) {
      if (!sym.componentKey) continue;
      if (!byKey.has(sym.componentKey)) byKey.set(sym.componentKey, []);
      byKey.get(sym.componentKey).push(sym);
    }
    for (const [key, variants] of byKey) {
      if (variants.length < 2) continue;
      const specValues = new Set();
      for (const sym of variants) {
        if (sym.variantPropSpecs) {
          for (const spec of sym.variantPropSpecs) specValues.add(spec.value);
        }
      }
      for (const sym of variants) {
        const parts = (sym.name || '').split(', ').map(p => p.split('=')[1]).filter(Boolean);
        for (const val of parts) {
          if (!specValues.has(val)) {
            const id = `${sym.guid.sessionID}:${sym.guid.localID}`;
            warnings.push(`SYMBOL ${id} "${sym.name}": variant value "${val}" not in variantPropSpecs — Figma will show blank slides`);
          }
        }
      }
    }

    // Check for instances referencing missing symbols
    for (const node of this.message.nodeChanges) {
      if (node.type !== 'INSTANCE' || node.phase === 'REMOVED') continue;
      const sid = node.symbolData?.symbolID;
      if (!sid) continue;
      const symId = `${sid.sessionID}:${sid.localID}`;
      const sym = this.getNode(symId);
      if (!sym || sym.type !== 'SYMBOL') {
        const nid = `${node.guid.sessionID}:${node.guid.localID}`;
        warnings.push(`INSTANCE ${nid} "${node.name}": references missing SYMBOL ${symId}`);
      }
    }

    // --- Color contrast validation ---
    // WCAG relative luminance
    function luminance(r, g, b) {
      const [rs, gs, bs] = [r, g, b].map(c =>
        c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      );
      return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    }

    function contrastRatio(l1, l2) {
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    function extractColor(paints) {
      if (!paints || paints.length === 0) return null;
      const paint = paints[0];
      if (paint.color) return paint.color;
      return null;
    }

    for (const slide of this.getActiveSlides()) {
      const slideId = nid(slide);
      // Get background color: from fillPaints or default white
      const bgPaints = slide.fillPaints;
      const bgColor = extractColor(bgPaints) || { r: 1, g: 1, b: 1 };
      const bgLum = luminance(bgColor.r, bgColor.g, bgColor.b);

      // Walk all descendants looking for TEXT nodes
      this.walkTree(slideId, (node) => {
        if (node.type !== 'TEXT') return;
        const textPaints = node.fillPaints;
        const textColor = extractColor(textPaints);
        if (!textColor) return;

        const textLum = luminance(textColor.r, textColor.g, textColor.b);
        const ratio = contrastRatio(bgLum, textLum);

        if (ratio < 2) {
          const nodeId = nid(node);
          let msg = `TEXT ${nodeId} "${node.name || ''}": contrast ratio ${ratio.toFixed(2)}:1 against slide background is below 2:1`;
          if (node.colorVar) {
            msg += ` (uses colorVar "${node.colorVar}" — may resolve differently in Figma)`;
          }
          warnings.push(msg);
        }
      });
    }

    for (const w of warnings) console.warn(`⚠️  ${w}`);
    return warnings;
  }

  /**
   * Save as a .deck (ZIP archive).
   * @param {string} outPath - Output file path
   * @param {object} opts - { imagesDir, thumbnail, meta }
   */
  async saveDeck(outPath, opts = {}) {
    this.validate();
    const figBuf = await this.encodeFig();
    const absOut = resolve(outPath);

    return new Promise((resolveP, reject) => {
      const zipfile = new yazl.ZipFile();

      // canvas.fig
      const figBytes = Buffer.from(figBuf);
      zipfile.addBuffer(figBytes, 'canvas.fig');

      // thumbnail.png
      const thumb = opts.thumbnail || this.deckThumbnail;
      if (thumb) zipfile.addBuffer(Buffer.from(thumb), 'thumbnail.png');

      // meta.json
      const meta = opts.meta || this.deckMeta;
      if (meta) zipfile.addBuffer(Buffer.from(JSON.stringify(meta)), 'meta.json');

      // images/
      const imgDir = opts.imagesDir || this.imagesDir;
      if (imgDir && existsSync(imgDir)) {
        for (const entry of readdirSync(imgDir, { withFileTypes: true, recursive: true })) {
          if (entry.isFile()) {
            const fullPath = join(entry.parentPath ?? entry.path, entry.name);
            const rel = fullPath.slice(imgDir.length + 1).replace(/\\/g, '/');
            zipfile.addBuffer(readFileSync(fullPath), `images/${rel}`);
          }
        }
      }

      zipfile.end();
      const output = createWriteStream(absOut);
      output.on('close', resolveP);
      output.on('error', reject);
      zipfile.outputStream.pipe(output);
    });
  }

  /**
   * Save just the canvas.fig binary.
   */
  async saveFig(outPath) {
    const buf = await this.encodeFig();
    const { writeFileSync } = await import('fs');
    writeFileSync(resolve(outPath), buf);
  }
}
