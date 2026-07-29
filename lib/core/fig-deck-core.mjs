/**
 * FigDeckCore — reading, modifying and writing Figma .deck/.fig files, in
 * bytes only. Portable: no `node:` import, no Node global, no path anywhere.
 *
 * `./fig-deck.mjs` subclasses this and adds the filesystem — `fromDeckFile`,
 * `saveDeck`, `_materializeImages` and the rest of the members that need a
 * disk. That is the whole split: everything here is format work, everything
 * there is I/O, and the CLI keeps importing `FigDeck` from the same path it
 * always did.
 *
 * FORMAT RULES (hard-won):
 * - .deck = ZIP containing canvas.fig, thumbnail.png, meta.json, images/
 * - canvas.fig = prelude ("fig-deck" or "fig-kiwi") + version (uint32 LE)
 *   + length-prefixed chunks
 * - Chunk 0 = kiwi schema (deflateRaw compressed)
 * - Chunk 1 = message data (MUST be zstd compressed — Figma rejects deflateRaw)
 * - Chunk 2+ = optional additional data (pass through as-is)
 */
import { parseFigBinary } from 'openfig-core';
import { createEmptyDeckDoc, createPlaceholderThumbnail } from '../slides/empty-deck.mjs';
import { encodeBinarySchema } from 'kiwi-schema';
import { deflateRaw } from 'pako';
// `./zstd.mjs`, not `@foxglove/wasm-zstd` itself: the package's JS wrapper
// copies results out of the wasm heap with `Buffer`, so it throws in a
// browser. Same wasm, same bytes — see that file.
import { compress as zstdCompress, isLoaded as zstdReady } from './zstd.mjs';
import { unpackArchive, packArchive } from './archive.mjs';
import { nid, positionChar } from './node-helpers.mjs';
import { deckErrors } from './validate-deck.mjs';
import { deepClone } from './deep-clone.mjs';

const WASM_INIT_TIMEOUT_MS = 15_000;

export class FigDeckCore {
  constructor() {
    this.header = null;       // { prelude, version }
    this.schema = null;       // decoded kiwi binary schema
    this.compiledSchema = null;
    this.message = null;      // decoded message { nodeChanges, blobs, ... }
    this.rawFiles = [];       // original compressed chunks (for passthrough)
    this.nodeMap = new Map();  // "s:l" → node
    this.childrenMap = new Map(); // "s:l" → [child nodes]
    this.deckMeta = null;     // parsed meta.json (when loaded from .deck)
    this.deckThumbnail = null; // raw thumbnail PNG bytes (Uint8Array)
    this.images = new Map();  // "<rel>" → bytes, for decks loaded without a filesystem
    this.imagesDir = null;    // path to extracted images directory
    this._tempDir = null;     // temp dir for deck extraction
  }

  /**
   * Load from .deck archive bytes. Portable — no fs, no path, no Buffer.
   *
   * Image entries land in `this.images` as bytes. The Node wrapper
   * (`fromDeckFile`) materialises them onto disk afterwards, because
   * `imagesDir` is a path contract several consumers still read.
   *
   * @param {Uint8Array} bytes - .deck/.fig ZIP archive
   * @returns {FigDeck}
   */
  static fromDeckBytes(bytes) {
    // `new this()`, not `new FigDeckCore()`: `FigDeck.fromDeckBytes(...)` has
    // to come back Node-capable, or a caller that then asks for `saveDeck`
    // finds it missing on an object that looks like a FigDeck.
    const deck = new this();
    const entries = unpackArchive(bytes);

    const fig = entries.get('canvas.fig');
    if (!fig) {
      throw new Error('No canvas.fig found in deck archive');
    }
    deck._parseFig(fig);

    const meta = entries.get('meta.json');
    if (meta) {
      deck.deckMeta = JSON.parse(new TextDecoder().decode(meta));
    }

    const thumb = entries.get('thumbnail.png');
    if (thumb) {
      deck.deckThumbnail = thumb;
    }

    for (const [name, data] of entries) {
      if (name.startsWith('images/')) deck.images.set(name.slice('images/'.length), data);
    }

    return deck;
  }

  /**
   * Load from raw canvas.fig bytes. Portable — no fs, no path, no Buffer.
   * @param {Uint8Array} bytes
   * @returns {FigDeck}
   */
  static fromFigBytes(bytes) {
    const deck = new this();
    deck._parseFig(bytes);
    return deck;
  }

  /**
   * Create an empty .deck in memory — no seed file, no bundled theme content.
   * The returned FigDeck has a minimum-viable Slides hierarchy:
   *   DOCUMENT → CANVAS "Page 1" → SLIDE_GRID "Presentation" → SLIDE_ROW → SLIDE
   * Plus the auxiliary CANVAS "Internal Only Canvas".
   */
  static createEmpty(opts = {}) {
    const deck = new this();
    const doc = createEmptyDeckDoc(opts);
    // .deck files use the "fig-deck" prelude; createEmptyFigDoc returns
    // "fig-kiwi" (the .fig Design-file magic). Override for Slides.
    deck.header = { ...doc.header, prelude: 'fig-deck' };
    deck.schema = doc.schema;
    deck.compiledSchema = doc.compiledSchema;
    deck.message = {
      ...doc.message,
      sessionID: doc.message.sessionID ?? 0,
      ackID: doc.message.ackID ?? 0,
      blobs: doc.message.blobs ?? [],
    };
    deck.rawFiles = doc.rawChunks ?? [];
    deck.nodeMap = doc.nodeMap;
    deck.childrenMap = doc.childrenMap;
    const name = opts.name ?? 'Untitled';
    deck.deckMeta = {
      client_meta: {
        background_color: { r: 0.11764705926179886, g: 0.11764705926179886, b: 0.11764705926179886, a: 1 },
        thumbnail_size: { width: 400, height: 260 },
        render_coordinates: { x: 0, y: 0, width: 2400, height: 1560 },
      },
      file_name: name,
      developer_related_links: [],
      exported_at: new Date().toISOString(),
    };
    deck.deckThumbnail = createPlaceholderThumbnail();
    return deck;
  }

  /**
   * Parse a canvas.fig buffer.
   * Format: prelude (8 bytes ASCII) + version (uint32 LE) + N×(length uint32 LE + chunk bytes)
   * Known preludes: "fig-kiwi", "fig-deck", "fig-jam."
   */
  _parseFig(buf) {
    // `readFileSync` hands back a Buffer that is often a *view* into a larger
    // pooled ArrayBuffer, so `new Uint8Array(buf.buffer)` silently drops
    // byteOffset/byteLength and yields the whole pool — neighbouring memory,
    // not the file. Preserve the view's window instead.
    const bytes = ArrayBuffer.isView(buf)
      ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      : new Uint8Array(buf);
    const doc = parseFigBinary(bytes);
    this.header = doc.header;
    this.schema = doc.schema;
    this.compiledSchema = doc.compiledSchema;
    this.message = doc.message;
    this.rawFiles = doc.rawChunks;
    this.nodeMap = doc.nodeMap;
    this.childrenMap = doc.childrenMap;
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
   * Import SYMBOL nodes (and their full subtrees) from another FigDeck into this one.
   *
   * Handles:
   * - Deep cloning with full GUID remapping
   * - parentIndex.guid rebinding
   * - symbolData.symbolID remapping for nested INSTANCE nodes
   * - overrideKey remapping
   * - Image/blob file copying between decks
   * - Deduplication by componentKey
   *
   * @param {FigDeck} sourceDeck - The FigDeck to copy symbols from
   * @param {string[]} symbolIds - Array of symbol node IDs in "s:l" format (e.g., ['1:500', '1:600'])
   * @returns {Map<string, string>} Map of old ID → new ID for every remapped node
   */
  importSymbols(sourceDeck, symbolIds) {
    if (!sourceDeck || !symbolIds?.length) return new Map();

    // Build componentKey index for dedup in the target deck
    const existingByKey = new Map();
    for (const sym of this.getSymbols()) {
      if (sym.phase === 'REMOVED' || !sym.componentKey) continue;
      existingByKey.set(sym.componentKey, nid(sym));
    }

    // Find the Internal Only Canvas to parent imported symbols under
    const internalCanvas = this.message.nodeChanges.find(
      n => n.type === 'CANVAS' && n.name === 'Internal Only Canvas' && n.phase !== 'REMOVED'
    );
    if (!internalCanvas) {
      throw new Error('No "Internal Only Canvas" found in target deck');
    }
    const canvasId = nid(internalCanvas);

    let nextId = this.maxLocalID() + 1;
    const sessionId = 1;
    const globalIdMap = new Map(); // old "s:l" → new "s:l" across all imported symbols

    for (const symId of symbolIds) {
      const sourceSymbol = sourceDeck.getNode(symId);
      if (!sourceSymbol || sourceSymbol.type !== 'SYMBOL') {
        throw new Error(`SYMBOL not found in source deck: ${symId}`);
      }

      // Dedup: if target already has a symbol with the same componentKey, skip
      if (sourceSymbol.componentKey && existingByKey.has(sourceSymbol.componentKey)) {
        globalIdMap.set(symId, existingByKey.get(sourceSymbol.componentKey));
        continue;
      }

      // Collect the full subtree (DFS)
      const subtreeNodes = [];
      sourceDeck.walkTree(symId, node => {
        if (node.phase !== 'REMOVED') subtreeNodes.push(node);
      });

      // Build ID remap table for this subtree
      const idMap = new Map(); // old "s:l" → new guid { sessionID, localID }
      for (const node of subtreeNodes) {
        idMap.set(nid(node), { sessionID: sessionId, localID: nextId++ });
      }

      // Clone and remap each node
      const clonedNodes = subtreeNodes.map(node => {
        const clone = deepClone(node);
        const oldId = nid(node);
        const newGuid = idMap.get(oldId);
        if (newGuid) clone.guid = newGuid;

        // Root symbol → parent under Internal Only Canvas
        if (oldId === symId) {
          clone.parentIndex = {
            guid: deepClone(internalCanvas.guid),
            // Same fractional index as everywhere else; the inline arithmetic
            // this replaced had the overflow described in node-helpers.
            position: positionChar(this.getChildren(canvasId).length),
          };
        } else if (clone.parentIndex?.guid) {
          // Remap parent reference
          const parentOldId = `${clone.parentIndex.guid.sessionID}:${clone.parentIndex.guid.localID}`;
          const remappedParent = idMap.get(parentOldId);
          if (remappedParent) {
            clone.parentIndex = { ...clone.parentIndex, guid: deepClone(remappedParent) };
          }
        }

        // Remap symbolData.symbolID on INSTANCE nodes
        if (clone.type === 'INSTANCE' && clone.symbolData?.symbolID) {
          const sid = clone.symbolData.symbolID;
          const symRef = `${sid.sessionID}:${sid.localID}`;
          const remappedSym = idMap.get(symRef);
          if (remappedSym) {
            clone.symbolData.symbolID = deepClone(remappedSym);
          } else if (globalIdMap.has(symRef)) {
            // Reference to a previously imported symbol
            const newRef = globalIdMap.get(symRef);
            const [s, l] = newRef.split(':').map(Number);
            clone.symbolData.symbolID = { sessionID: s, localID: l };
          }
        }

        // Remap overrideKey
        if (clone.overrideKey) {
          const okOld = `${clone.overrideKey.sessionID}:${clone.overrideKey.localID}`;
          const remappedOk = idMap.get(okOld);
          if (remappedOk) {
            clone.overrideKey = deepClone(remappedOk);
          }
        }

        // Remap symbolOverrides guid paths
        if (clone.symbolOverrides) {
          for (const ov of clone.symbolOverrides) {
            if (ov.guidPath?.guids) {
              ov.guidPath.guids = ov.guidPath.guids.map(g => {
                const gOld = `${g.sessionID}:${g.localID}`;
                const remapped = idMap.get(gOld);
                return remapped ? deepClone(remapped) : g;
              });
            }
          }
        }

        // Remap derivedSymbolData references
        if (clone.derivedSymbolData) {
          for (const dsd of clone.derivedSymbolData) {
            if (dsd.symbolID) {
              const dsdOld = `${dsd.symbolID.sessionID}:${dsd.symbolID.localID}`;
              const remappedDsd = idMap.get(dsdOld);
              if (remappedDsd) {
                dsd.symbolID = deepClone(remappedDsd);
              }
            }
          }
        }

        // Remap blob indices (commandsBlob, vectorNetworkBlob, fillGeometry etc.)
        // Blobs in source deck reference positions in sourceDeck.message.blobs.
        // Copy each referenced blob to target and update the index.
        const remapBlobIndex = (idx) => {
          if (idx == null || idx < 0) return idx;
          if (!sourceDeck.message.blobs || idx >= sourceDeck.message.blobs.length) return idx;
          if (!this._blobRemap) this._blobRemap = new Map();
          if (this._blobRemap.has(idx)) return this._blobRemap.get(idx);
          const blob = sourceDeck.message.blobs[idx];
          if (!this.message.blobs) this.message.blobs = [];
          const newIdx = this.message.blobs.length;
          this.message.blobs.push(deepClone(blob));
          this._blobRemap.set(idx, newIdx);
          return newIdx;
        };

        // fillGeometry[].commandsBlob
        if (clone.fillGeometry) {
          for (const fg of clone.fillGeometry) {
            if (fg.commandsBlob != null) fg.commandsBlob = remapBlobIndex(fg.commandsBlob);
          }
        }
        // strokeGeometry[].commandsBlob
        if (clone.strokeGeometry) {
          for (const sg of clone.strokeGeometry) {
            if (sg.commandsBlob != null) sg.commandsBlob = remapBlobIndex(sg.commandsBlob);
          }
        }
        // vectorNetworkBlob (VECTOR nodes)
        if (clone.vectorNetworkBlob != null) {
          clone.vectorNetworkBlob = remapBlobIndex(clone.vectorNetworkBlob);
        }

        clone.phase = 'CREATED';
        delete clone.slideThumbnailHash;
        delete clone.editInfo;
        delete clone.prototypeInteractions;

        return clone;
      });

      // Clear blob remap cache after processing this symbol's subtree
      delete this._blobRemap;

      // Copy referenced images from source deck. The copy itself is a
      // filesystem operation — source and target both address their images by
      // `imagesDir` — so it is the one part of `importSymbols` that has to
      // live in the Node subclass. Everything above here is pure remapping.
      this._importImageAssets(sourceDeck, clonedNodes);

      // Add cloned nodes to target deck
      this.message.nodeChanges.push(...clonedNodes);

      // Record mappings
      for (const [oldId, newGuid] of idMap.entries()) {
        globalIdMap.set(oldId, `${newGuid.sessionID}:${newGuid.localID}`);
      }

      // Register componentKey for dedup of subsequent symbols in the same call
      if (sourceSymbol.componentKey) {
        const newSymId = `${idMap.get(symId).sessionID}:${idMap.get(symId).localID}`;
        existingByKey.set(sourceSymbol.componentKey, newSymId);
      }
    }

    this.rebuildMaps();
    return globalIdMap;
  }

  /**
   * Hook for `importSymbols`. A no-op without a filesystem: an in-memory deck
   * has no `imagesDir` to copy out of, and `./fig-deck.mjs` overrides this.
   *
   * @param {FigDeckCore} _sourceDeck
   * @param {object[]} _clonedNodes
   */
  _importImageAssets(_sourceDeck, _clonedNodes) {}

  /**
   * Encode message to canvas.fig binary.
   *
   * Async because the zstd encoder is WebAssembly and has to finish compiling
   * first. Chunk 1 must be zstd — Figma rejects deflateRaw there.
   */
  async encodeFig() {
    // A blocked or absent WebAssembly compile is a real failure mode — a CSP
    // without `wasm-unsafe-eval` stalls it — and an unbounded wait there is
    // indistinguishable from a hang. Name the stage instead.
    await Promise.race([
      zstdReady,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('zstd encoder (WebAssembly) failed to initialise')),
        WASM_INIT_TIMEOUT_MS,
      )),
    ]);

    const encodedMsg = this.compiledSchema.encodeMessage(this.message);
    const compSchema = deflateRaw(encodeBinarySchema(this.schema));
    const compMsg = new Uint8Array(zstdCompress(encodedMsg, 3));

    const prelude = this.header.prelude;
    const chunks = [compSchema, compMsg];
    // Pass through any additional chunks (chunk 2+)
    for (let i = 2; i < this.rawFiles.length; i++) {
      chunks.push(this.rawFiles[i]);
    }

    const headerSize = prelude.length + 4;
    const totalSize = chunks.reduce((sz, c) => sz + 4 + c.byteLength, headerSize);
    const buf = new Uint8Array(totalSize);
    // Always name the window: a DataView built from `.buffer` alone is
    // only correct for a freshly allocated array (see _parseFig).
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
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

    return buf;
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

      // Walk all descendants looking for TEXT nodes — follow INSTANCE → SYMBOL
      // links so we reach TEXT inside components (walkTree alone stops at INSTANCE).
      const walkIntoSymbols = (rootId, visited = new Set()) => {
        this.walkTree(rootId, (node) => {
          if (node.type === 'TEXT') {
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
          }
          if (node.type === 'INSTANCE' && node.symbolData?.symbolID) {
            const sid = node.symbolData.symbolID;
            const symNid = `${sid.sessionID}:${sid.localID}`;
            if (!visited.has(symNid)) {
              visited.add(symNid);
              walkIntoSymbols(symNid, visited);
            }
          }
        });
      };
      walkIntoSymbols(slideId);
    }

    for (const w of warnings) console.warn(`⚠️  ${w}`);
    return warnings;
  }

  /**
   * Encode the deck as .deck archive bytes. Portable — no fs, no path, no Buffer.
   *
   * Entry order matches what Figma writes: canvas.fig, thumbnail.png,
   * meta.json, then images/.
   *
   * @param {object} [opts]
   * @param {Uint8Array} [opts.thumbnail] - Overrides `this.deckThumbnail`
   * @param {object} [opts.meta] - Overrides `this.deckMeta`
   * @param {Map<string, Uint8Array>} [opts.images] - Overrides `this.images`
   * @returns {Promise<Uint8Array>}
   */
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.validate=true] - Refuse to emit a structurally
   *   invalid deck. Figma reports one line, "Internal error during import", and
   *   names nothing, so a defect that reaches a file costs hours to trace back.
   *   Failing here names the problem instead. Pass false only to write a known
   *   bad deck deliberately, e.g. to reproduce one.
   */
  async toDeckBytes(opts = {}) {
    if (opts.validate !== false) {
      const images = opts.images || this.images;
      const errors = deckErrors(this.message, {
        imageHashes: new Set([...images.keys()].map((k) => k.replace(/^images\//, ''))),
      });
      if (errors.length) {
        throw new Error(
          'openfig: refusing to write a deck Figma would reject —\n  ' +
          errors.map((e) => `${e.code}: ${e.message}`).join('\n  '),
        );
      }
    }
    const entries = new Map();
    entries.set('canvas.fig', await this.encodeFig());

    const thumb = opts.thumbnail || this.deckThumbnail;
    if (thumb) entries.set('thumbnail.png', thumb);

    const meta = opts.meta || this.deckMeta;
    if (meta) entries.set('meta.json', new TextEncoder().encode(JSON.stringify(meta)));

    const images = opts.images || this.images;
    for (const [rel, data] of images) entries.set(`images/${rel}`, data);

    return packArchive(entries);
  }
}
