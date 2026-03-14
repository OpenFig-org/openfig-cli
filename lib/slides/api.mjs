/**
 * openfig programmatic API
 *
 * High-level Deck / Slide / Symbol classes wrapping FigDeck.
 * Analogous to python-pptx's Presentation / Slide model.
 *
 * Phases implemented:
 *   Phase 1 — Read API       (Deck.open, deck.slides, slide.textNodes, slide.imageNodes)
 *   Phase 2 — Text write     (slide.setText, slide.setTexts)
 *   Phase 3 — Image write    (slide.setImage)
 *   Phase 4 — Slide mgmt     (deck.addSlide, deck.removeSlide, deck.moveSlide)
 *   Phase 5+ — Shape props   (not yet implemented)
 */

import { FigDeck } from '../core/fig-deck.mjs';
import { nid, parseId, positionChar } from '../core/node-helpers.mjs';
import { imageOv, hexToHash } from '../core/image-helpers.mjs';
import { deepClone } from '../core/deep-clone.mjs';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { getImageDimensions, generateThumbnail } from '../core/image-utils.mjs';

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

export class Deck {
  constructor(figDeck, sourcePath = null) {
    this._fd = figDeck;
    this._sourcePath = sourcePath;
  }

  /**
   * Open a .deck file.
   * @param {string} path
   * @returns {Promise<Deck>}
   */
  static async open(path) {
    const fd = await FigDeck.fromDeckFile(resolve(path));
    return new Deck(fd, resolve(path));
  }

  /**
   * Create a new blank deck from scratch.
   * Includes the Light Slides theme with all 8 text styles and 23 colors.
   *
   * @param {object} [opts]
   * @param {string} [opts.name] - Presentation name (default: 'Untitled')
   * @returns {Promise<Deck>}
   */
  static async create(opts = {}) {
    const templatePath = join(__dirname, 'blank-template.deck');
    const fd = await FigDeck.fromDeckFile(templatePath);
    fd.deckMeta = { file_name: opts.name ?? 'Untitled', version: '1' };
    const deck = new Deck(fd, null);
    // Remember the template's blank slide so addBlankSlide() can auto-remove it
    deck._templateSlide = fd.getActiveSlides().length ? fd.getSlide(1) : null;
    return deck;
  }

  /** Presentation metadata from meta.json */
  get meta() {
    return this._fd.deckMeta ?? {};
  }

  /** Ordered list of active (non-REMOVED) Slide objects */
  get slides() {
    return this._fd.getActiveSlides().map(n => new Slide(this._fd, n));
  }

  /** Get a single slide by 1-based index. Slide 1 is the first slide. */
  slide(n) {
    const slides = this.slides;
    if (n < 1 || n > slides.length) {
      throw new RangeError(`Slide ${n} out of range (1–${slides.length})`);
    }
    return slides[n - 1];
  }

  /** Slide width in px (read from first active SLIDE node). */
  get slideWidth() {
    const slides = this._fd.getActiveSlides();
    return slides.length ? slides[0].size?.x ?? 1920 : 1920;
  }

  /** Slide height in px (read from first active SLIDE node). */
  get slideHeight() {
    const slides = this._fd.getActiveSlides();
    return slides.length ? slides[0].size?.y ?? 1080 : 1080;
  }

  /** All SYMBOL nodes available as templates */
  get symbols() {
    return this._fd.getSymbols().map(n => new Symbol(this._fd, n));
  }

  /**
   * Save to a file. Defaults to overwriting the source path.
   * @param {string} [outPath]
   */
  async save(outPath) {
    const target = outPath ? resolve(outPath) : this._sourcePath;
    if (!target) throw new Error('No output path specified and no source path known');
    await this._fd.saveDeck(target);
  }

  // --- Phase 4: Slide management -------------------------------------------

  /**
   * Add a new blank slide (no template/symbol).
   * Use this for building slides from scratch with addText(), addImage(), etc.
   *
   * @param {object} [opts]
   * @param {string} [opts.name]       - Slide name (default: auto-numbered)
   * @param {string|object} [opts.background] - Named color or { r, g, b }
   * @returns {Slide}
   */
  addBlankSlide(opts = {}) {
    const fd = this._fd;

    // Clone structure from the first slide
    const templateSlide = fd.getActiveSlides()[0];
    if (!templateSlide) throw new Error('No slides to clone structure from');

    const slideRowId = templateSlide.parentIndex?.guid
      ? `${templateSlide.parentIndex.guid.sessionID}:${templateSlide.parentIndex.guid.localID}`
      : null;

    const localID = fd.maxLocalID() + 1;
    const activeCount = fd.getActiveSlides().length;

    const newSlide = deepClone(templateSlide);
    newSlide.guid = { sessionID: 1, localID };
    newSlide.name = opts.name ?? `${activeCount + 1}`;
    newSlide.phase = 'CREATED';
    delete newSlide.prototypeInteractions;
    delete newSlide.slideThumbnailHash;
    delete newSlide.editInfo;

    // Position in SLIDE_ROW
    if (slideRowId) {
      newSlide.parentIndex = {
        guid: parseId(slideRowId),
        position: positionChar(activeCount),
      };
    }

    // X transform position
    if (newSlide.transform) {
      newSlide.transform.m02 = activeCount * 2160;
    }

    // White background by default
    newSlide.fillPaints = [{
      type: 'SOLID',
      color: { r: 1, g: 1, b: 1, a: 1 },
      opacity: 1,
      visible: true,
      blendMode: 'NORMAL',
    }];

    fd.message.nodeChanges.push(newSlide);
    fd.rebuildMaps();

    // Auto-remove the original template blank slide on first addBlankSlide() call
    if (this._templateSlide) {
      this._templateSlide.phase = 'REMOVED';
      this._templateSlide = null;
      fd.rebuildMaps();
    }

    const slide = new Slide(fd, newSlide);

    if (opts.background) {
      slide.setBackground(opts.background);
    }

    return slide;
  }

  /**
   * Add a new slide by cloning a Symbol (template).
   * @param {Symbol} symbol   - Template to clone from
   * @param {object} [opts]
   * @param {Slide}  [opts.after]  - Insert after this slide (default: end)
   * @param {string} [opts.name]   - Slide name (default: symbol name)
   * @returns {Slide}
   */
  addSlide(symbol, opts = {}) {
    const fd = this._fd;

    // Find a representative slide that uses this symbol as a template source
    // to clone its SLIDE node structure (transform, size, etc.)
    const templateSlide = fd.getActiveSlides().find(s => {
      const inst = fd.getSlideInstance(nid(s));
      return inst?.symbolData?.symbolID &&
        nid({ guid: inst.symbolData.symbolID }) === nid(symbol._node);
    }) ?? fd.getActiveSlides()[0];

    if (!templateSlide) throw new Error('No slides to clone structure from');

    const templateInst = fd.getSlideInstance(nid(templateSlide));
    if (!templateInst) throw new Error('Template slide has no instance');

    const slideRowId = templateSlide.parentIndex?.guid
      ? `${templateSlide.parentIndex.guid.sessionID}:${templateSlide.parentIndex.guid.localID}`
      : null;

    // Assign new GUIDs
    let nextId = fd.maxLocalID() + 1;
    const slideLocalId = nextId++;
    const instLocalId = nextId++;

    // Clone SLIDE node
    const newSlide = deepClone(templateSlide);
    newSlide.guid = { sessionID: 1, localID: slideLocalId };
    newSlide.name = opts.name ?? symbol._node.name ?? 'New Slide';
    newSlide.phase = 'CREATED';
    delete newSlide.prototypeInteractions;
    delete newSlide.slideThumbnailHash;
    delete newSlide.editInfo;

    // Position in SLIDE_ROW
    if (slideRowId) {
      const activeCount = fd.getActiveSlides().length;
      const insertAt = opts.after
        ? fd.getActiveSlides().indexOf(opts.after._node) + 1
        : activeCount;
      newSlide.parentIndex = {
        guid: parseId(slideRowId),
        position: positionChar(insertAt),
      };
    }

    // X transform position
    if (newSlide.transform) {
      const activeCount = fd.getActiveSlides().length;
      newSlide.transform.m02 = activeCount * 2160;
    }

    // Clone INSTANCE node, pointing at the given symbol
    const newInst = deepClone(templateInst);
    newInst.guid = { sessionID: 1, localID: instLocalId };
    newInst.name = newSlide.name;
    newInst.phase = 'CREATED';
    newInst.parentIndex = { guid: { sessionID: 1, localID: slideLocalId }, position: '!' };
    newInst.symbolData = {
      symbolID: deepClone(symbol._node.guid),
      symbolOverrides: [],
      uniformScaleFactor: 1,
    };
    delete newInst.derivedSymbolData;
    delete newInst.derivedSymbolDataLayoutVersion;
    delete newInst.editInfo;

    fd.message.nodeChanges.push(newSlide);
    fd.message.nodeChanges.push(newInst);
    fd.rebuildMaps();

    return new Slide(fd, newSlide);
  }

  /**
   * Remove a slide (marks as REMOVED — never deletes from nodeChanges).
   * @param {Slide} slide
   */
  removeSlide(slide) {
    const node = slide._node;
    node.phase = 'REMOVED';
    delete node.prototypeInteractions;

    const inst = this._fd.getSlideInstance(nid(node));
    if (inst) {
      inst.phase = 'REMOVED';
      delete inst.prototypeInteractions;
    }
  }

  /**
   * Move a slide to a given index (0-based) in the active slide list.
   * Adjusts parentIndex.position characters to reorder.
   * @param {Slide} slide
   * @param {number} toIndex
   */
  moveSlide(slide, toIndex) {
    const active = this._fd.getActiveSlides();
    const fromIndex = active.indexOf(slide._node);
    if (fromIndex === -1) throw new Error('Slide not found in active slides');

    // Reorder array
    active.splice(fromIndex, 1);
    active.splice(toIndex, 0, slide._node);

    // Reassign position characters
    active.forEach((s, i) => {
      s.parentIndex.position = positionChar(i);
    });
  }
}

// ---------------------------------------------------------------------------
// Slide
// ---------------------------------------------------------------------------

export class Slide {
  constructor(figDeck, slideNode) {
    this._fd = figDeck;
    this._node = slideNode;
  }

  get name() { return this._node.name; }
  get guid() { return nid(this._node); }
  get index() { return this._fd.getActiveSlides().indexOf(this._node); }

  // --- Shape access ----------------------------------------------------------

  /**
   * All direct child nodes on this slide as Shape objects.
   * Use for reading/writing geometry, visibility, opacity on any node.
   * @returns {Shape[]}
   */
  get shapes() {
    return this._fd.getChildren(nid(this._node))
      .filter(n => n.phase !== 'REMOVED')
      .map(n => new Shape(n, this._fd));
  }

  // --- Slide background -----------------------------------------------------

  /**
   * Get or set the slide background color.
   *
   * Named color:     slide.setBackground('Blue')
   * Raw RGB:         slide.setBackground({ r: 1, g: 0, b: 0 })
   * Named + opacity: slide.setBackground('Red', { opacity: 0.5 })
   *
   * @param {string|object} color - Named color string or { r, g, b } (0-1)
   * @param {object} [opts]
   * @param {number} [opts.opacity] - Fill opacity 0-1 (default: 1)
   */
  setBackground(color, opts = {}) {
    const opacity = opts.opacity ?? 1;
    let rgb, colorVar;

    const parsed = parseColor(this._fd, color);
    rgb = { r: parsed.r, g: parsed.g, b: parsed.b, a: 1 };
    colorVar = parsed._guid ? {
      value: { alias: { guid: deepClone(parsed._guid) } },
      dataType: 'ALIAS',
      resolvedDataType: 'COLOR',
    } : undefined;

    const fill = {
      type: 'SOLID',
      color: rgb,
      opacity,
      visible: true,
      blendMode: 'NORMAL',
    };
    if (colorVar) fill.colorVar = colorVar;

    this._node.fillPaints = [fill];
  }

  /** Get the current background color as { r, g, b, a }. */
  get background() {
    const fill = this._node.fillPaints?.[0];
    if (!fill?.color) return null;
    return { ...fill.color };
  }

  /** The INSTANCE child of this slide */
  get _instance() {
    return this._fd.getSlideInstance(nid(this._node));
  }

  /** The SYMBOL this slide's instance references */
  get _symbol() {
    const inst = this._instance;
    if (!inst?.symbolData?.symbolID) return null;
    const { sessionID, localID } = inst.symbolData.symbolID;
    return this._fd.getNode(`${sessionID}:${localID}`);
  }

  /**
   * All TEXT nodes in the symbol that have an overrideKey,
   * merged with any active text overrides on this instance.
   * @returns {TextNode[]}
   */
  get textNodes() {
    const sym = this._symbol;
    if (!sym) return [];
    const nodes = [];
    this._fd.walkTree(nid(sym), (node) => {
      if (node.type === 'TEXT' && node.overrideKey) {
        const ov = this._findTextOverride(node.overrideKey);
        nodes.push(new TextNode(node, ov));
      }
    });
    return nodes;
  }

  /**
   * Image placeholder nodes in the symbol (ROUNDED_RECTANGLE with overrideKey).
   * @returns {ImageNode[]}
   */
  get imageNodes() {
    const sym = this._symbol;
    if (!sym) return [];
    const nodes = [];
    this._fd.walkTree(nid(sym), (node) => {
      if (node.overrideKey &&
          (node.type === 'ROUNDED_RECTANGLE' || node.type === 'RECTANGLE') &&
          node.fillPaints?.some(p => p.type === 'IMAGE')) {
        const ov = this._findImageOverride(node.overrideKey);
        nodes.push(new ImageNode(node, ov));
      }
    });
    return nodes;
  }

  // --- Phase 2: Text write --------------------------------------------------

  /**
   * Set text on a placeholder by name or override key string ("s:l").
   * @param {string} nameOrKey  - Node name (e.g. "Title") or key "57:48"
   * @param {string} value
   */
  setText(nameOrKey, value) {
    const key = this._resolveTextKey(nameOrKey);
    if (!key) throw new Error(`Text node not found: ${nameOrKey}`);

    const chars = (value === '' || value == null) ? ' ' : value;
    const overrides = this._ensureOverrides();
    const existing = this._findTextOverride(key);

    if (existing) {
      existing.textData.characters = chars;
    } else {
      overrides.push({ guidPath: { guids: [key] }, textData: { characters: chars } });
    }
  }

  /**
   * Set multiple text values at once.
   * @param {Record<string, string>} map  - { nameOrKey: value }
   */
  setTexts(map) {
    for (const [k, v] of Object.entries(map)) {
      this.setText(k, v);
    }
  }

  // --- Phase 3: Image write -------------------------------------------------

  /**
   * Set an image on a placeholder by name or override key string ("s:l").
   * Handles SHA-1 hashing, thumbnail generation, images/ dir management.
   * @param {string} nameOrKey  - Node name or key "57:48"
   * @param {string|Buffer} pathOrBuf
   */
  async setImage(nameOrKey, pathOrBuf) {
    const key = this._resolveImageKey(nameOrKey);
    if (!key) throw new Error(`Image node not found: ${nameOrKey}`);

    const imgBuf = typeof pathOrBuf === 'string'
      ? readFileSync(resolve(pathOrBuf))
      : pathOrBuf;
    const imgPath = typeof pathOrBuf === 'string' ? resolve(pathOrBuf) : null;

    const imgHash = sha1Hex(imgBuf);

    const { width, height } = await getImageDimensions(imgBuf);

    const tmpThumb = `/tmp/openfig_thumb_${Date.now()}.png`;
    await generateThumbnail(imgBuf, tmpThumb);
    const thumbHash = sha1Hex(readFileSync(tmpThumb));

    copyToImagesDir(this._fd, imgHash, imgPath ?? (() => {
      const tmp = `/tmp/openfig_img_${Date.now()}`;
      writeFileSync(tmp, imgBuf);
      return tmp;
    })());
    copyToImagesDir(this._fd, thumbHash, tmpThumb);

    const override = imageOv(key, imgHash, thumbHash, width, height);
    const overrides = this._ensureOverrides();

    // Replace existing image override for this key if present
    const existingIdx = overrides.findIndex(o =>
      o.fillPaints &&
      o.guidPath?.guids?.length >= 1 &&
      o.guidPath.guids[0].sessionID === key.sessionID &&
      o.guidPath.guids[0].localID === key.localID
    );
    if (existingIdx >= 0) {
      overrides.splice(existingIdx, 1, override);
    } else {
      overrides.push(override);
    }
  }

  // --- Internals ------------------------------------------------------------

  _ensureOverrides() {
    const inst = this._instance;
    if (!inst) throw new Error(`Slide ${this.guid} has no instance`);
    if (!inst.symbolData) inst.symbolData = {};
    if (!inst.symbolData.symbolOverrides) inst.symbolData.symbolOverrides = [];
    return inst.symbolData.symbolOverrides;
  }

  _findTextOverride(key) {
    const overrides = this._instance?.symbolData?.symbolOverrides ?? [];
    return overrides.find(o =>
      o.textData &&
      o.guidPath?.guids?.length === 1 &&
      o.guidPath.guids[0].sessionID === key.sessionID &&
      o.guidPath.guids[0].localID === key.localID
    ) ?? null;
  }

  _findImageOverride(key) {
    const overrides = this._instance?.symbolData?.symbolOverrides ?? [];
    return overrides.find(o =>
      o.fillPaints &&
      o.guidPath?.guids?.length >= 1 &&
      o.guidPath.guids[0].sessionID === key.sessionID &&
      o.guidPath.guids[0].localID === key.localID
    ) ?? null;
  }

  /** Resolve a name or "s:l" string to an overrideKey from the symbol tree. */
  _resolveTextKey(nameOrKey) {
    // Try as "s:l" string first
    if (/^\d+:\d+$/.test(nameOrKey)) return parseId(nameOrKey);

    const sym = this._symbol;
    if (!sym) return null;
    let found = null;
    this._fd.walkTree(nid(sym), (node) => {
      if (!found && node.type === 'TEXT' && node.name === nameOrKey && node.overrideKey) {
        found = node.overrideKey;
      }
    });
    return found;
  }

  // --- Phase 2.8: Shape creation (validated) --------------------------------

  /**
   * Add a rectangle (ROUNDED_RECTANGLE) directly to this slide.
   * Validated: fillGeometry not required, Figma recomputes it.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {object} [opts]
   * @param {object} [opts.fill]        - { r, g, b, a } normalized 0-1 (default white)
   * @param {string} [opts.name]        - Node name
   * @param {number} [opts.opacity]     - 0-1 (default 1)
   * @param {number} [opts.cornerRadius]- per-corner radius (default 0)
   * @returns {object} the raw node (for further manipulation)
   */
  addRectangle(x, y, width, height, opts = {}) {
    const fd = this._fd;
    const localID = fd.maxLocalID() + 1;
    const fill = parseColor(fd, opts.fill ?? 'White');

    const node = {
      guid: { sessionID: 1, localID },
      phase: 'CREATED',
      parentIndex: {
        guid: this._node.guid,
        position: positionChar(fd.getChildren(nid(this._node)).length),
      },
      type: 'ROUNDED_RECTANGLE',
      name: opts.name ?? 'Rectangle',
      visible: true,
      opacity: opts.opacity ?? 1,
      size: { x: width, y: height },
      transform: { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y },
      strokeWeight: 1,
      strokeAlign: 'INSIDE',
      strokeJoin: 'MITER',
      ...(opts.cornerRadius ? {
        cornerRadius: opts.cornerRadius,
        rectangleTopLeftCornerRadius: opts.cornerRadius,
        rectangleTopRightCornerRadius: opts.cornerRadius,
        rectangleBottomLeftCornerRadius: opts.cornerRadius,
        rectangleBottomRightCornerRadius: opts.cornerRadius,
      } : {}),
      fillPaints: [{
        type: 'SOLID',
        color: { r: fill.r, g: fill.g, b: fill.b, a: fill.a ?? 1 },
        opacity: 1,
        visible: true,
        blendMode: 'NORMAL',
      }],
    };

    fd.message.nodeChanges.push(node);
    fd.rebuildMaps();
    return node;
  }

  // --- Phase 2.8: Image placement --------------------------------------------

  /**
   * Add a freestanding image directly on this slide.
   * The image is placed as a ROUNDED_RECTANGLE with an IMAGE fill.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {string|Buffer} pathOrBuf - Image file path or Buffer
   * @param {object} [opts]
   * @param {string} [opts.name]        - Node name
   * @param {string} [opts.scaleMode]   - 'FILL' | 'FIT' | 'CROP' | 'TILE' (default: 'FILL')
   * @param {number} [opts.cornerRadius]- Corner radius (default: 0)
   * @returns {Promise<object>} the raw node
   */
  async addImage(pathOrBuf, opts = {}) {
    const fd = this._fd;
    const localID = fd.maxLocalID() + 1;

    const x = opts.x ?? 0;
    const y = opts.y ?? 0;
    const width = opts.width ?? 1920;
    const height = opts.height ?? 1080;

    const imgBuf = typeof pathOrBuf === 'string'
      ? readFileSync(resolve(pathOrBuf))
      : pathOrBuf;
    const imgPath = typeof pathOrBuf === 'string' ? resolve(pathOrBuf) : null;

    const imgHash = sha1Hex(imgBuf);
    const { width: origW, height: origH } = await getImageDimensions(imgBuf);

    // Generate thumbnail
    const tmpThumb = `/tmp/openfig_thumb_${Date.now()}.png`;
    await generateThumbnail(imgBuf, tmpThumb);
    const thumbHash = sha1Hex(readFileSync(tmpThumb));

    // Copy both to images dir
    if (imgPath) {
      copyToImagesDir(fd, imgHash, imgPath);
    } else {
      const tmpImg = `/tmp/openfig_img_${Date.now()}`;
      writeFileSync(tmpImg, imgBuf);
      copyToImagesDir(fd, imgHash, tmpImg);
    }
    copyToImagesDir(fd, thumbHash, tmpThumb);

    const node = {
      guid: { sessionID: 1, localID },
      phase: 'CREATED',
      parentIndex: {
        guid: this._node.guid,
        position: positionChar(fd.getChildren(nid(this._node)).length),
      },
      type: 'ROUNDED_RECTANGLE',
      name: opts.name ?? 'Image',
      visible: true,
      opacity: 1,
      proportionsConstrained: true,
      size: { x: width, y: height },
      transform: { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y },
      strokeWeight: 1,
      strokeAlign: 'INSIDE',
      strokeJoin: 'MITER',
      ...(opts.cornerRadius ? {
        cornerRadius: opts.cornerRadius,
        rectangleTopLeftCornerRadius: opts.cornerRadius,
        rectangleTopRightCornerRadius: opts.cornerRadius,
        rectangleBottomLeftCornerRadius: opts.cornerRadius,
        rectangleBottomRightCornerRadius: opts.cornerRadius,
      } : {}),
      fillPaints: [{
        type: 'IMAGE',
        opacity: 1,
        visible: true,
        blendMode: 'NORMAL',
        transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
        image: { hash: hexToHash(imgHash), name: imgHash },
        imageThumbnail: { hash: hexToHash(thumbHash), name: thumbHash },
        animationFrame: 0,
        imageScaleMode: opts.scaleMode ?? 'FILL',
        imageShouldColorManage: false,
        rotation: 0,
        scale: 0.5,
        originalImageWidth: origW,
        originalImageHeight: origH,
        thumbHash: new Uint8Array(0),
        altText: '',
      }],
    };

    fd.message.nodeChanges.push(node);
    fd.rebuildMaps();
    return node;
  }

  // --- Phase 2.8: Text creation (validated) ----------------------------------

  /**
   * Add a freestanding text node directly to this slide.
   *
   * Simple text:
   *   slide.addText('Hello World', { style: 'Title' })
   *   slide.addText('Body copy', { style: 'Body 1', color: { r: 1, g: 1, b: 1 } })
   *
   * Per-run formatting (bold, italic, underline, strikethrough, hyperlinks):
   *   slide.addText([
   *     { text: 'Normal ' },
   *     { text: 'bold', bold: true },
   *     { text: ' and ' },
   *     { text: 'italic', italic: true },
   *     { text: ' with a ' },
   *     { text: 'link', hyperlink: 'https://example.com' },
   *   ], { style: 'Body 1' })
   *
   * Lists — simple (all lines same type):
   *   slide.addText('One\nTwo\nThree', { style: 'Body 1', list: 'bullet' })
   *   slide.addText('One\nTwo\nThree', { style: 'Body 1', list: 'number' })
   *
   * Lists — per-run control (mixed types, nesting):
   *   slide.addText([
   *     { text: 'Heading\n' },
   *     { text: 'Bullet\n', bullet: true },
   *     { text: 'Nested\n', bullet: true, indent: 2 },
   *     { text: 'Numbered\n', number: true },
   *   ], { style: 'Body 1' })
   *
   * Custom font (detaches from named style):
   *   slide.addText('Custom', { font: 'Georgia', fontSize: 36 })
   *
   * @param {string|Array<{text:string, bold?:boolean, italic?:boolean,
   *         underline?:boolean, strikethrough?:boolean, hyperlink?:string}>} textOrRuns
   * @param {object} [opts]
   * @param {string} [opts.style]     - Named text style: 'Title', 'Header 1'-'Header 3',
   *                                     'Body 1'-'Body 3', 'Note'
   * @param {number} [opts.x]         - X position on slide (default: 128)
   * @param {number} [opts.y]         - Y position on slide (default: 128)
   * @param {number} [opts.width]     - Text box width (default: 1200)
   * @param {string} [opts.font]      - Font family (e.g. 'Georgia') — detaches style
   * @param {string} [opts.fontStyle] - Font style/weight (e.g. 'Bold', 'Italic') — detaches style
   * @param {number} [opts.fontSize]  - Font size — detaches style if no named style
   * @param {object} [opts.color]     - Fill color { r, g, b } normalized 0-1
   * @param {string} [opts.align]     - Horizontal alignment: 'LEFT' | 'CENTER' | 'RIGHT'
   * @param {string} [opts.list]      - List type for all lines: 'bullet' | 'number'
   * @param {string} [opts.name]      - Node name
   * @returns {object} the raw TEXT node
   */
  addText(textOrRuns, opts = {}) {
    const fd = this._fd;
    const localID = fd.maxLocalID() + 1;

    // Normalize input — string or array of runs
    const isRuns = Array.isArray(textOrRuns);
    const fullText = isRuns
      ? textOrRuns.map(r => r.text).join('')
      : textOrRuns;

    const styleDef = opts.style ? resolveTextStyle(fd, opts.style) : null;
    const isDetached = !!(opts.font || (!opts.style && opts.fontSize));

    // Resolve typography — from named style, or explicit, or defaults
    let fontName, fontSize, lineHeight, letterSpacing, textTracking, styleIdForText;

    if (styleDef && !isDetached) {
      // Use named style — inherit typography from the style definition node
      fontName = deepClone(styleDef.fontName);
      fontSize = styleDef.fontSize;
      lineHeight = deepClone(styleDef.lineHeight);
      letterSpacing = deepClone(styleDef.letterSpacing);
      textTracking = styleDef.textTracking ?? 0;
      styleIdForText = { guid: deepClone(styleDef.guid) };
    } else {
      // Detached or no style — explicit fields
      fontName = {
        family: opts.font ?? 'Inter',
        style: opts.fontStyle ?? 'Regular',
        postscript: '',
      };
      fontSize = opts.fontSize ?? 36;
      lineHeight = { value: 1.4, units: 'RAW' };
      letterSpacing = { value: 0, units: 'PERCENT' };
      textTracking = 0;
      styleIdForText = DETACHED_STYLE_ID;
    }

    // Allow overriding individual properties even with a named style
    if (opts.fontSize && styleDef && !isDetached) {
      fontSize = opts.fontSize;
    }

    const chars = (fullText === '' || fullText == null) ? ' ' : fullText;
    const textData = { characters: chars };

    // Build per-run formatting overrides
    if (isRuns && textOrRuns.some(r => r.bold || r.italic || r.underline || r.strikethrough || r.hyperlink)) {
      const overrides = buildRunOverrides(textOrRuns, fontName, styleIdForText);
      textData.styleOverrideTable = overrides.styleOverrideTable;
      textData.characterStyleIDs = overrides.characterStyleIDs;
    }

    // Build lines array for list/paragraph formatting
    const hasListRuns = isRuns && textOrRuns.some(r => r.bullet || r.number);
    if (opts.list || hasListRuns) {
      textData.lines = buildLines(chars, isRuns ? textOrRuns : null, opts.list);
    }

    const fillColor = parseColor(fd, opts.color ?? 'black');

    const node = {
      guid: { sessionID: 1, localID },
      phase: 'CREATED',
      parentIndex: {
        guid: this._node.guid,
        position: positionChar(fd.getChildren(nid(this._node)).length),
      },
      type: 'TEXT',
      name: opts.name ?? 'Text',
      visible: true,
      opacity: 1,
      size: { x: opts.width ?? 1200, y: opts.height ?? 50 },
      textAutoResize: opts.height ? 'NONE' : 'HEIGHT',
      transform: {
        m00: 1, m01: 0, m02: opts.x ?? 128,
        m10: 0, m11: 1, m12: opts.y ?? 128,
      },
      textData,
      fontName,
      fontSize,
      lineHeight,
      letterSpacing,
      textTracking,
      textAutoResize: 'HEIGHT',
      textAlignHorizontal: opts.align ?? 'LEFT',
      textAlignVertical: 'TOP',
      styleIdForText,
      fillPaints: [{
        type: 'SOLID',
        color: { r: fillColor.r, g: fillColor.g, b: fillColor.b, a: fillColor.a ?? 1 },
        opacity: 1,
        visible: true,
        blendMode: 'NORMAL',
      }],
      strokeWeight: 0,
      strokeAlign: 'OUTSIDE',
      strokeJoin: 'MITER',
    };

    fd.message.nodeChanges.push(node);
    fd.rebuildMaps();
    return node;
  }

  /**
   * Add an ellipse (SHAPE_WITH_TEXT with ELLIPSE type) to this slide.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {object} [opts]
   * @param {object} [opts.fill]   - { r, g, b } normalized 0-1 (default: white)
   * @param {string} [opts.name]   - Node name
   * @param {number} [opts.opacity] - 0-1 (default: 1)
   * @returns {object} the raw node
   */
  addEllipse(x, y, width, height, opts = {}) {
    return this._addShapeWithText('ELLIPSE', x, y, width, height, opts);
  }

  /**
   * Add a diamond shape to this slide.
   * @param {number} x  @param {number} y  @param {number} width  @param {number} height
   * @param {object} [opts] - Same as addEllipse
   * @returns {object} the raw node
   */
  addDiamond(x, y, width, height, opts = {}) {
    return this._addShapeWithText('DIAMOND', x, y, width, height, opts);
  }

  /**
   * Add a triangle shape to this slide.
   * @param {number} x  @param {number} y  @param {number} width  @param {number} height
   * @param {object} [opts] - Same as addEllipse
   * @returns {object} the raw node
   */
  addTriangle(x, y, width, height, opts = {}) {
    return this._addShapeWithText('TRIANGLE_UP', x, y, width, height, opts);
  }

  /**
   * Add a star shape to this slide.
   * @param {number} x  @param {number} y  @param {number} width  @param {number} height
   * @param {object} [opts] - Same as addEllipse
   * @returns {object} the raw node
   */
  addStar(x, y, width, height, opts = {}) {
    return this._addShapeWithText('STAR', x, y, width, height, opts);
  }

  /** Internal: create a SHAPE_WITH_TEXT node with the given sub-type. */
  _addShapeWithText(shapeType, x, y, width, height, opts = {}) {
    const fd = this._fd;
    const localID = fd.maxLocalID() + 1;
    const fill = parseColor(fd, opts.fill ?? 'White');
    const fillPaint = {
      type: 'SOLID',
      color: { r: fill.r, g: fill.g, b: fill.b, a: fill.a ?? 1 },
      opacity: 1, visible: true, blendMode: 'NORMAL',
    };
    const textFill = {
      type: 'SOLID',
      color: { r: 0, g: 0, b: 0, a: 1 },
      opacity: 1, visible: true, blendMode: 'NORMAL',
    };

    const node = {
      guid: { sessionID: 1, localID },
      phase: 'CREATED',
      parentIndex: {
        guid: this._node.guid,
        position: positionChar(fd.getChildren(nid(this._node)).length),
      },
      type: 'SHAPE_WITH_TEXT',
      name: opts.name ?? 'Shape',
      visible: true,
      opacity: opts.opacity ?? 1,
      size: { x: width, y: height },
      transform: { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y },
      shapeWithTextType: shapeType,
      shapeUserHeight: height,
      shapeTruncates: false,
      autoRename: true,
      frameMaskDisabled: true,
      nodeGenerationData: buildShapeNodeGenData(fillPaint, textFill),
    };

    fd.message.nodeChanges.push(node);
    fd.rebuildMaps();
    return node;
  }

  /**
   * Add a line to this slide.
   *
   * @param {number} x1 - Start X
   * @param {number} y1 - Start Y
   * @param {number} x2 - End X
   * @param {number} y2 - End Y
   * @param {object} [opts]
   * @param {object} [opts.color]  - { r, g, b } normalized 0-1 (default: black)
   * @param {number} [opts.weight] - Stroke weight (default: 2)
   * @param {string} [opts.name]   - Node name
   * @returns {object} the raw node
   */
  addLine(x1, y1, x2, y2, opts = {}) {
    const fd = this._fd;
    const localID = fd.maxLocalID() + 1;
    const color = parseColor(fd, opts.color ?? 'black');

    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.sqrt(dx * dx + dy * dy);
    const cos = length ? dx / length : 1;
    const sin = length ? dy / length : 0;

    const node = {
      guid: { sessionID: 1, localID },
      phase: 'CREATED',
      parentIndex: {
        guid: this._node.guid,
        position: positionChar(fd.getChildren(nid(this._node)).length),
      },
      type: 'LINE',
      name: opts.name ?? 'Line',
      visible: true,
      opacity: 1,
      size: { x: length, y: 0 },
      transform: { m00: cos, m01: -sin, m02: x1, m10: sin, m11: cos, m12: y1 },
      strokeWeight: opts.weight ?? 2,
      strokeAlign: 'CENTER',
      strokeJoin: 'MITER',
      strokePaints: [{
        type: 'SOLID',
        color: { r: color.r, g: color.g, b: color.b, a: color.a ?? 1 },
        opacity: 1,
        visible: true,
        blendMode: 'NORMAL',
      }],
    };

    fd.message.nodeChanges.push(node);
    fd.rebuildMaps();
    return node;
  }

  /**
   * Add a table to this slide.
   *
   * @param {number} x
   * @param {number} y
   * @param {string[][]} data - 2D array of cell strings, e.g. [['A','B'],['C','D']]
   * @param {object} [opts]
   * @param {number} [opts.colWidth]    - Width per column (default: 192)
   * @param {number} [opts.rowHeight]   - Height per row (default: auto)
   * @param {number} [opts.cornerRadius]- Table corner radius (default: 12)
   * @param {string} [opts.name]        - Node name
   * @returns {object} the raw TABLE node
   */
  addTable(x, y, data, opts = {}) {
    const fd = this._fd;
    let nextId = fd.maxLocalID() + 1;
    const tableLocalId = nextId++;

    const numRows = data.length;
    const numCols = data[0]?.length ?? 0;
    if (numRows === 0 || numCols === 0) throw new Error('Table data must have at least 1 row and 1 column');

    const colWidth = opts.colWidth ?? 192;
    const totalWidth = colWidth * numCols;
    const rowHeight = opts.rowHeight;

    // Assign IDs for rows and columns
    const rowIds = [];
    for (let r = 0; r < numRows; r++) rowIds.push({ sessionID: 1, localID: nextId++ });
    const colIds = [];
    for (let c = 0; c < numCols; c++) colIds.push({ sessionID: 1, localID: nextId++ });

    // Build cell text overrides
    const cellOverrides = [];
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < numCols; c++) {
        const text = data[r][c] ?? ' ';
        cellOverrides.push({
          guidPath: { guids: [{ sessionID: 40000000, localID: 1 }, rowIds[r], colIds[c]] },
          textData: {
            characters: text === '' ? ' ' : text,
            lines: [{ lineType: 'PLAIN', styleId: 0, indentationLevel: 0, sourceDirectionality: 'AUTO', listStartOffset: 0, isFirstLineOfList: false }],
          },
          textUserLayoutVersion: 5,
          textBidiVersion: 1,
        });
      }
    }

    // Cell text styling override
    const DETACHED = { guid: { sessionID: 4294967295, localID: 4294967295 } };
    const cellStyleBase = {
      styleIdForFill: DETACHED,
      styleIdForStrokeFill: DETACHED,
      styleIdForText: DETACHED,
      fontSize: 12,
      paragraphIndent: 0,
      paragraphSpacing: 0,
      textAlignHorizontal: 'LEFT',
      textAlignVertical: 'TOP',
      textCase: 'ORIGINAL',
      textDecoration: 'NONE',
      lineHeight: { value: 100, units: 'PERCENT' },
      fontName: { family: 'Inter', style: 'Regular', postscript: '' },
      letterSpacing: { value: 0, units: 'PERCENT' },
      fontVersion: '',
      leadingTrim: 'NONE',
      fontVariations: [],
      opacity: 1,
      dashPattern: [],
      cornerRadius: 0,
      strokeWeight: 1,
      strokeAlign: 'INSIDE',
      strokeCap: 'NONE',
      strokeJoin: 'MITER',
      effects: [],
      textDecorationSkipInk: true,
      textTracking: 0,
      listSpacing: 0,
    };

    const styleOverrides = [
      {
        ...cellStyleBase,
        guidPath: { guids: [{ sessionID: 40000000, localID: 2 }] },
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true, blendMode: 'NORMAL' }],
        strokePaints: [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85, a: 1 }, opacity: 1, visible: true, blendMode: 'NORMAL' }],
      },
      {
        ...cellStyleBase,
        guidPath: { guids: [{ sessionID: 40000000, localID: 3 }] },
        fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, blendMode: 'NORMAL' }],
        strokePaints: [],
      },
    ];

    // Default row height: estimate based on font size + padding
    const defaultRowHeight = rowHeight ?? 44;
    const totalHeight = defaultRowHeight * numRows;

    const node = {
      guid: { sessionID: 1, localID: tableLocalId },
      phase: 'CREATED',
      parentIndex: {
        guid: this._node.guid,
        position: positionChar(fd.getChildren(nid(this._node)).length),
      },
      type: 'TABLE',
      name: opts.name ?? 'Table',
      visible: true,
      opacity: 1,
      size: { x: totalWidth, y: totalHeight },
      transform: { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y },
      cornerRadius: opts.cornerRadius ?? 12,
      strokeWeight: 1,
      strokeAlign: 'INSIDE',
      strokeJoin: 'MITER',
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true, blendMode: 'NORMAL' }],
      frameMaskDisabled: true,
      nodeGenerationData: {
        overrides: [...cellOverrides, ...styleOverrides],
        useFineGrainedSyncing: false,
        diffOnlyRemovals: [],
      },
      tableRowPositions: { entries: rowIds.map((id, i) => ({ id, position: positionChar(i) })) },
      tableColumnPositions: { entries: colIds.map((id, i) => ({ id, position: positionChar(i) })) },
      tableRowHeights: { entries: rowHeight ? rowIds.map(id => ({ id, size: rowHeight })) : [] },
      tableColumnWidths: { entries: colIds.map(id => ({ id, size: colWidth })) },
    };

    fd.message.nodeChanges.push(node);
    fd.rebuildMaps();
    return node;
  }

  /**
   * Add an SVG vector graphic to this slide.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} width        - Display width on slide
   * @param {string} svgPathOrBuf - File path to .svg or SVG string
   * @param {object} [opts]
   * @param {object} [opts.fill]  - { r, g, b } fill color (default: black)
   * @param {number} [opts.opacity] - Fill opacity (default: 1)
   * @param {string} [opts.name]  - Node name
   * @returns {object} the raw FRAME node wrapping the VECTOR
   */
  addSVG(x, y, width, svgPathOrBuf, opts = {}) {
    const fd = this._fd;
    let nextId = fd.maxLocalID() + 1;

    // Read SVG
    let svgStr;
    if (svgPathOrBuf.includes('<svg')) {
      svgStr = svgPathOrBuf;
    } else {
      svgStr = readFileSync(svgPathOrBuf, 'utf8');
    }

    // Parse viewBox
    const vbMatch = svgStr.match(/viewBox="([^"]+)"/);
    if (!vbMatch) throw new Error('SVG must have a viewBox attribute');
    const vbParts = vbMatch[1].split(/\s+/).map(Number);
    const vbW = vbParts[2], vbH = vbParts[3];

    // Parse all <path d="..."> elements
    const pathDatas = [...svgStr.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(m => m[1]);
    if (pathDatas.length === 0) throw new Error('SVG contains no <path> elements');

    // Calculate proportional height
    const height = width * (vbH / vbW);
    const sx = width / vbW;
    const sy = height / vbH;

    // Parse SVG paths
    const allCmds = pathDatas.map(d => _parseSVGPath(d));

    // Build fillGeometry blobs (scaled to node size)
    const fillGeometry = [];
    for (const cmds of allCmds) {
      fd.message.blobs.push({ bytes: _encodeCommandsBlob(cmds, sx, sy) });
      fillGeometry.push({ windingRule: 'NONZERO', commandsBlob: fd.message.blobs.length - 1, styleID: 0 });
    }

    // Build vectorNetworkBlob (in SVG coordinate space)
    fd.message.blobs.push({ bytes: _buildVectorNetworkBlob(allCmds) });
    const vnbIdx = fd.message.blobs.length - 1;

    const fill = parseColor(fd, opts.fill ?? 'Black');
    const opacity = opts.opacity ?? 1;

    const frameId = nextId++;
    const vectorId = nextId++;

    const frameNode = {
      guid: { sessionID: 1, localID: frameId },
      phase: 'CREATED',
      parentIndex: {
        guid: this._node.guid,
        position: positionChar(fd.getChildren(nid(this._node)).length),
      },
      type: 'FRAME',
      name: opts.name ?? 'SVG',
      visible: true,
      opacity: 1,
      size: { x: width, y: height },
      transform: { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y },
      strokeWeight: 1,
      strokeAlign: 'INSIDE',
      strokeJoin: 'MITER',
      frameMaskDisabled: true,
    };

    const vectorNode = {
      guid: { sessionID: 1, localID: vectorId },
      phase: 'CREATED',
      parentIndex: { guid: { sessionID: 1, localID: frameId }, position: '!' },
      type: 'VECTOR',
      name: (opts.name ?? 'SVG') + '_vector',
      visible: true,
      opacity: 1,
      size: { x: width, y: height },
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      strokeWeight: 0,
      strokeAlign: 'INSIDE',
      strokeJoin: 'MITER',
      fillPaints: [{ type: 'SOLID', color: { r: fill.r, g: fill.g, b: fill.b, a: 1 }, opacity, visible: true, blendMode: 'NORMAL' }],
      fillGeometry,
      horizontalConstraint: 'SCALE',
      verticalConstraint: 'SCALE',
      vectorData: {
        vectorNetworkBlob: vnbIdx,
        normalizedSize: { x: vbW, y: vbH },
        styleOverrideTable: [],
      },
    };

    fd.message.nodeChanges.push(frameNode, vectorNode);
    fd.rebuildMaps();
    return frameNode;
  }

  /**
   * Add a FRAME (auto-layout container) to this slide.
   * Useful for grouping text nodes with automatic spacing.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {object} [opts]
   * @param {string} [opts.direction]  - 'VERTICAL' | 'HORIZONTAL' (default: 'VERTICAL')
   * @param {number} [opts.spacing]    - Gap between children in px (default: 24)
   * @param {string} [opts.name]       - Node name
   * @returns {Slide} a Slide-like wrapper so you can call addText() on the frame
   */
  addFrame(x, y, width, height, opts = {}) {
    const fd = this._fd;
    const localID = fd.maxLocalID() + 1;

    const node = {
      guid: { sessionID: 1, localID },
      phase: 'CREATED',
      parentIndex: {
        guid: this._node.guid,
        position: positionChar(fd.getChildren(nid(this._node)).length),
      },
      type: 'FRAME',
      name: opts.name ?? 'Frame',
      visible: true,
      opacity: 1,
      size: { x: width, y: height },
      transform: {
        m00: 1, m01: 0, m02: x,
        m10: 0, m11: 1, m12: y,
      },
      stackMode: opts.direction ?? 'VERTICAL',
      stackSpacing: opts.spacing ?? 24,
      frameMaskDisabled: true,
    };

    fd.message.nodeChanges.push(node);
    fd.rebuildMaps();

    // Return a Slide-like object so addText/addRectangle can be called on the frame
    return new FrameProxy(fd, node, this._node);
  }

  _resolveImageKey(nameOrKey) {
    if (/^\d+:\d+$/.test(nameOrKey)) return parseId(nameOrKey);

    const sym = this._symbol;
    if (!sym) return null;
    let found = null;
    this._fd.walkTree(nid(sym), (node) => {
      if (!found && node.overrideKey && node.name === nameOrKey &&
          (node.type === 'ROUNDED_RECTANGLE' || node.type === 'RECTANGLE')) {
        found = node.overrideKey;
      }
    });
    return found;
  }
}

// ---------------------------------------------------------------------------
// Symbol
// ---------------------------------------------------------------------------

export class Symbol {
  constructor(figDeck, symbolNode) {
    this._fd = figDeck;
    this._node = symbolNode;
  }

  get name() { return this._node.name; }
  get guid() { return nid(this._node); }

  /** Text slots defined in this symbol (nodes with overrideKey). */
  get textSlots() {
    const slots = [];
    this._fd.walkTree(nid(this._node), (node) => {
      if (node.type === 'TEXT' && node.overrideKey) {
        slots.push({ name: node.name, key: `${node.overrideKey.sessionID}:${node.overrideKey.localID}` });
      }
    });
    return slots;
  }

  /** Image slots defined in this symbol. */
  get imageSlots() {
    const slots = [];
    this._fd.walkTree(nid(this._node), (node) => {
      if (node.overrideKey &&
          (node.type === 'ROUNDED_RECTANGLE' || node.type === 'RECTANGLE') &&
          node.fillPaints?.some(p => p.type === 'IMAGE')) {
        slots.push({ name: node.name, key: `${node.overrideKey.sessionID}:${node.overrideKey.localID}` });
      }
    });
    return slots;
  }
}

// ---------------------------------------------------------------------------
// TextNode
// ---------------------------------------------------------------------------

export class TextNode {
  constructor(symbolNode, override = null) {
    this._node = symbolNode;
    this._override = override;
  }

  get name() { return this._node.name; }
  get key() { return `${this._node.overrideKey.sessionID}:${this._node.overrideKey.localID}`; }

  /** Current characters — override value if set, else default from symbol. */
  get characters() {
    if (this._override) return this._override.textData.characters;
    return this._node.textData?.characters ?? '';
  }
}

// ---------------------------------------------------------------------------
// ImageNode
// ---------------------------------------------------------------------------

export class ImageNode {
  constructor(symbolNode, override = null) {
    this._node = symbolNode;
    this._override = override;
  }

  get name() { return this._node.name; }
  get key() { return `${this._node.overrideKey.sessionID}:${this._node.overrideKey.localID}`; }

  /** SHA-1 hex of the current image, or null if not overridden. */
  get hashHex() {
    const fill = this._override?.fillPaints?.[0] ?? this._node.fillPaints?.[0];
    if (!fill?.image?.name) return null;
    return fill.image.name;
  }
}

// ---------------------------------------------------------------------------
// Shape — geometry wrapper for any node on a slide
// ---------------------------------------------------------------------------

export class Shape {
  constructor(node, figDeck = null) {
    this._node = node;
    this._fd = figDeck;
  }

  get name() { return this._node.name; }
  set name(v) { this._node.name = v; }
  get type() { return this._node.type; }
  get guid() { return nid(this._node); }

  get x() { return this._node.transform?.m02 ?? 0; }
  set x(v) { if (this._node.transform) this._node.transform.m02 = v; }

  get y() { return this._node.transform?.m12 ?? 0; }
  set y(v) { if (this._node.transform) this._node.transform.m12 = v; }

  get width() { return this._node.size?.x ?? 0; }
  set width(v) { if (this._node.size) this._node.size.x = v; }

  get height() { return this._node.size?.y ?? 0; }
  set height(v) { if (this._node.size) this._node.size.y = v; }

  /** Rotation in degrees (clockwise). */
  get rotation() {
    const t = this._node.transform;
    if (!t) return 0;
    return Math.round(Math.atan2(t.m10, t.m00) * 180 / Math.PI * 1000) / 1000;
  }
  set rotation(degrees) {
    const t = this._node.transform;
    if (!t) return;
    const rad = degrees * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    t.m00 = cos; t.m01 = -sin;
    t.m10 = sin; t.m11 = cos;
  }

  get visible() { return this._node.visible ?? true; }
  set visible(v) { this._node.visible = v; }

  get opacity() { return this._node.opacity ?? 1; }
  set opacity(v) { this._node.opacity = v; }

  // --- Fill ----------------------------------------------------------------

  /** Get the current fill color as { r, g, b, a } or null. */
  get fill() {
    let f;
    if (this._node.type === 'SHAPE_WITH_TEXT' && this._node.nodeGenerationData?.overrides?.length) {
      f = this._node.nodeGenerationData.overrides[0].fillPaints?.[0];
    } else {
      f = this._node.fillPaints?.[0];
    }
    if (!f?.color) return null;
    return { ...f.color };
  }

  /**
   * Set a solid fill color.
   * @param {object} color - { r, g, b } normalized 0-1
   * @param {object} [opts]
   * @param {number} [opts.opacity] - Fill opacity 0-1 (default: 1)
   */
  setFill(color, opts = {}) {
    const c = parseColor(this._fd, color);
    const paint = [{
      type: 'SOLID',
      color: { r: c.r, g: c.g, b: c.b, a: 1 },
      opacity: opts.opacity ?? 1,
      visible: true,
      blendMode: 'NORMAL',
    }];
    this._setShapeFill(paint);
  }

  /** Remove all fills. */
  removeFill() {
    this._setShapeFill([]);
  }

  /** Internal: set fillPaints on the correct target (nodeGenerationData for SHAPE_WITH_TEXT). */
  _setShapeFill(paints) {
    if (this._node.type === 'SHAPE_WITH_TEXT' && this._node.nodeGenerationData?.overrides?.length) {
      this._node.nodeGenerationData.overrides[0].fillPaints = paints;
    } else {
      this._node.fillPaints = paints;
    }
  }

  // --- Stroke --------------------------------------------------------------

  /** Get the current stroke as { r, g, b, a, weight } or null. */
  get stroke() {
    const s = this._node.strokePaints?.[0];
    if (!s?.color) return null;
    return { ...s.color, weight: this._node.strokeWeight ?? 0 };
  }

  /**
   * Set a solid stroke.
   * @param {object} color - { r, g, b } normalized 0-1
   * @param {object} [opts]
   * @param {number} [opts.weight] - Stroke weight in px (default: 2)
   * @param {string} [opts.align]  - 'INSIDE' | 'OUTSIDE' | 'CENTER' (default: 'INSIDE')
   */
  setStroke(color, opts = {}) {
    const c = parseColor(this._fd, color);
    this._node.strokePaints = [{
      type: 'SOLID',
      color: { r: c.r, g: c.g, b: c.b, a: 1 },
      opacity: 1,
      visible: true,
      blendMode: 'NORMAL',
    }];
    this._node.strokeWeight = opts.weight ?? 2;
    this._node.strokeAlign = opts.align ?? 'INSIDE';
  }

  /** Remove stroke. */
  removeStroke() {
    this._node.strokePaints = [];
    this._node.strokeWeight = 0;
  }

  // --- Image fill -----------------------------------------------------------

  /**
   * Set an image as the fill of this shape.
   *
   * @param {string|Buffer} pathOrBuf - Image file path or Buffer
   * @param {object} [opts]
   * @param {string} [opts.scaleMode] - 'FILL' | 'FIT' | 'CROP' | 'TILE' (default: 'FILL')
   * @returns {Promise<void>}
   */
  async setImageFill(pathOrBuf, opts = {}) {
    if (!this._fd) throw new Error('Shape requires FigDeck reference for image operations');

    const imgBuf = typeof pathOrBuf === 'string'
      ? readFileSync(resolve(pathOrBuf))
      : pathOrBuf;
    const imgPath = typeof pathOrBuf === 'string' ? resolve(pathOrBuf) : null;

    const imgHash = sha1Hex(imgBuf);
    const { width: origW, height: origH } = await getImageDimensions(imgBuf);

    const tmpThumb = `/tmp/openfig_thumb_${Date.now()}.png`;
    await generateThumbnail(imgBuf, tmpThumb);
    const thumbHash = sha1Hex(readFileSync(tmpThumb));

    if (imgPath) {
      copyToImagesDir(this._fd, imgHash, imgPath);
    } else {
      const tmpImg = `/tmp/openfig_img_${Date.now()}`;
      writeFileSync(tmpImg, imgBuf);
      copyToImagesDir(this._fd, imgHash, tmpImg);
    }
    copyToImagesDir(this._fd, thumbHash, tmpThumb);

    this._setShapeFill([{
      type: 'IMAGE',
      opacity: 1,
      visible: true,
      blendMode: 'NORMAL',
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      image: { hash: hexToHash(imgHash), name: imgHash },
      imageThumbnail: { hash: hexToHash(thumbHash), name: thumbHash },
      animationFrame: 0,
      imageScaleMode: opts.scaleMode ?? 'FILL',
      imageShouldColorManage: false,
      rotation: 0,
      scale: 0.5,
      originalImageWidth: origW,
      originalImageHeight: origH,
      thumbHash: new Uint8Array(0),
      altText: '',
    }]);
  }
}

// ---------------------------------------------------------------------------
// FrameProxy — lets you call addText/addRectangle on a FRAME node
// ---------------------------------------------------------------------------

class FrameProxy {
  constructor(figDeck, frameNode, slideNode) {
    this._fd = figDeck;
    this._node = frameNode;
    this._slideNode = slideNode;
  }

  get guid() { return nid(this._node); }

  /**
   * Add a text node inside this frame.
   * Position is relative to the frame (auto-layout handles placement).
   */
  addText(text, opts = {}) {
    // Override position to 0,0 — frame auto-layout handles positioning
    return Slide.prototype.addText.call(this, text, { ...opts, x: 0, y: 0 });
  }

  addRectangle(x, y, width, height, opts = {}) {
    return Slide.prototype.addRectangle.call(this, x, y, width, height, opts);
  }

  async addImage(pathOrBuf, opts = {}) {
    return Slide.prototype.addImage.call(this, pathOrBuf, opts);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sentinel GUID for detached styles (0xFFFFFFFF:0xFFFFFFFF) */
const DETACHED_STYLE_ID = {
  guid: { sessionID: 4294967295, localID: 4294967295 }
};

/**
 * Find a named text style definition node in the deck.
 * Looks for publishable TEXT nodes with matching name (e.g. 'Title', 'Body 1').
 * Returns the node so we can read its typography fields and guid.
 */
function resolveTextStyle(fd, styleName) {
  const nodes = fd.message.nodeChanges;
  // Find the publishable style token (characters "Ag", isPublishable true)
  const match = nodes.find(n =>
    n.type === 'TEXT' &&
    n.isPublishable === true &&
    n.name === styleName
  );
  if (match) return match;

  // Fallback: try the preview nodes (characters "Rag 123")
  const preview = nodes.find(n =>
    n.type === 'TEXT' &&
    n.name === styleName &&
    n.locked === true &&
    n.visible === false
  );
  if (preview) return preview;

  throw new Error(`Unknown text style: "${styleName}". Available: Title, Header 1, Header 2, Header 3, Body 1, Body 2, Body 3, Note`);
}

// Designer-friendly color aliases → hex
const DESIGNER_COLORS = {
  // Neutrals
  white: '#FFFFFF', black: '#000000', cream: '#F5F0E8', ivory: '#FFFFF0',
  charcoal: '#36454F', smoke: '#F5F5F5', silver: '#C0C0C0', ash: '#B2BEB5',
  // Blues
  navy: '#1E2761', midnight: '#0D1B2A', cobalt: '#0047AB', sky: '#87CEEB',
  teal: '#008080', cyan: '#00BCD4', steel: '#4682B4', denim: '#1560BD',
  // Greens
  forest: '#2C5F2D', sage: '#A7BEAE', mint: '#98FF98', olive: '#808000',
  emerald: '#50C878', moss: '#8A9A5B', lime: '#32CD32',
  // Reds / warm
  coral: '#F96167', crimson: '#DC143C', rose: '#FF007F', blush: '#FFB6C1',
  burgundy: '#800020', brick: '#CB4154', salmon: '#FA8072',
  terracotta: '#B85042', rust: '#B7410E', sand: '#E7E8D1',
  amber: '#FFBF00', gold: '#FFD700', saffron: '#F4C430', peach: '#FFCBA4',
  // Purples
  lavender: '#E6E6FA', violet: '#8B00FF', plum: '#DDA0DD',
  mauve: '#E0B0FF', indigo: '#4B0082', grape: '#6F2DA8', purple: '#800080',
};

function _hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0,2),16)/255, g: parseInt(h.slice(2,4),16)/255, b: parseInt(h.slice(4,6),16)/255 };
}

/**
 * Resolve any color value to { r, g, b } (0-1) plus optional colorVar for Figma variables.
 * Accepts:
 *   - Designer alias:  'teal', 'coral', 'navy', 'midnight', ...
 *   - Hex string:      '#E63946' or 'E63946'
 *   - Figma theme:     'Blue', 'Red', 'Slate', ... (from Light Slides variables)
 *   - Raw object:      { r, g, b } normalized 0-1
 */
function parseColor(fd, color) {
  if (!color && color !== 0) return { r: 0, g: 0, b: 0 };
  if (typeof color === 'object') return { r: color.r, g: color.g, b: color.b };
  if (typeof color === 'string') {
    // Hex string
    if (/^#?[0-9a-fA-F]{6}$/.test(color)) return _hexToRgb(color);
    // Figma theme variable first (exact match, preserves colorVar binding for slides)
    try {
      const variable = resolveColorVariable(fd, color);
      return { r: variable.r, g: variable.g, b: variable.b, _guid: variable.guid };
    } catch (_) {}
    // Designer alias fallback (case-insensitive)
    const alias = DESIGNER_COLORS[color.toLowerCase()];
    if (alias) return _hexToRgb(alias);
    throw new Error(`Unknown color: "${color}". Use a Light Slides name ('Black', 'Teal'), a designer alias ('navy', 'coral'), or a hex string ('#E63946').`);
  }
  throw new Error(`Invalid color: ${JSON.stringify(color)}`);
}

/**
 * Resolve a named color (e.g. 'Blue', 'Red') to its VARIABLE node.
 * Returns { guid, r, g, b } from the Light Slides color variable set.
 */
function resolveColorVariable(fd, colorName) {
  const nodes = fd.message.nodeChanges;
  const variable = nodes.find(n =>
    n.type === 'VARIABLE' &&
    n.name === colorName &&
    n.variableResolvedType === 'COLOR'
  );
  if (!variable) {
    const available = nodes
      .filter(n => n.type === 'VARIABLE' && n.variableResolvedType === 'COLOR')
      .map(n => n.name);
    throw new Error(`Unknown color: "${colorName}". Available: ${available.join(', ')}`);
  }
  const val = variable.variableDataValues?.entries?.[0]?.variableData?.value?.colorValue;
  if (!val) {
    throw new Error(`Color variable "${colorName}" has no color value`);
  }
  return { guid: variable.guid, r: val.r, g: val.g, b: val.b };
}

/**
 * Build styleOverrideTable + characterStyleIDs from an array of text runs.
 * Each unique formatting combination gets its own styleID.
 */
function buildRunOverrides(runs, baseFontName, styleIdForText) {
  const styleOverrideTable = [];
  const characterStyleIDs = [];
  const styleMap = new Map(); // formatKey → styleID
  let nextStyleID = 1;

  for (const run of runs) {
    const hasFormat = run.bold || run.italic || run.underline || run.strikethrough || run.hyperlink;

    if (!hasFormat) {
      // Plain text — styleID 0 (base style)
      for (let i = 0; i < run.text.length; i++) characterStyleIDs.push(0);
      continue;
    }

    // Build a key for this unique formatting combination
    const key = `${run.bold ? 'b' : ''}${run.italic ? 'i' : ''}${run.underline ? 'u' : ''}${run.strikethrough ? 's' : ''}${run.hyperlink ? 'h:' + run.hyperlink : ''}`;

    if (!styleMap.has(key)) {
      const styleID = nextStyleID++;
      styleMap.set(key, styleID);

      const entry = {
        styleID,
        isOverrideOverTextStyle: true,
        styleIdForText: deepClone(styleIdForText),
      };

      // Derive font style from base + bold/italic flags
      if (run.bold || run.italic) {
        const baseLower = baseFontName.style.toLowerCase();
        const baseBold = baseLower.includes('bold');
        const baseItalic = baseLower.includes('italic');
        const wantBold = run.bold || baseBold;
        const wantItalic = run.italic || baseItalic;

        let style;
        if (wantBold && wantItalic) style = 'Bold Italic';
        else if (wantBold) style = 'Bold';
        else if (wantItalic) style = 'Italic';
        else style = 'Regular';

        entry.fontName = { family: baseFontName.family, style, postscript: '' };
        entry.fontVersion = '1';
        if (wantBold) entry.semanticWeight = 'BOLD';
        if (wantItalic) entry.semanticItalic = 'ITALIC';
      }

      // Text decoration
      if (run.hyperlink) {
        entry.textDecoration = 'UNDERLINE';
        entry.hyperlink = { url: run.hyperlink };
        entry.textDecorationSkipInk = true;
      } else if (run.underline) {
        entry.textDecoration = 'UNDERLINE';
        entry.textDecorationSkipInk = true;
      } else if (run.strikethrough) {
        entry.textDecoration = 'STRIKETHROUGH';
      }

      styleOverrideTable.push(entry);
    }

    const styleID = styleMap.get(key);
    for (let i = 0; i < run.text.length; i++) characterStyleIDs.push(styleID);
  }

  return { styleOverrideTable, characterStyleIDs };
}

/**
 * Build the `lines` array for list/paragraph formatting.
 * One entry per \n-delimited line in `characters`.
 *
 * @param {string} characters - The full text (with \n line breaks)
 * @param {Array|null} runs - Run objects (with bullet/number/indent), or null for simple mode
 * @param {string|null} listType - 'bullet' or 'number' for simple all-lines mode
 */
function buildLines(characters, runs, listType) {
  const textLines = characters.split('\n');
  const lines = [];

  if (!runs) {
    // Simple mode: opts.list applies to all lines
    const lt = listType === 'number' ? 'ORDERED_LIST' : 'UNORDERED_LIST';
    for (let i = 0; i < textLines.length; i++) {
      const isTrailingEmpty = i === textLines.length - 1 && textLines[i] === '';
      lines.push({
        lineType: isTrailingEmpty ? 'PLAIN' : lt,
        styleId: 0,
        indentationLevel: isTrailingEmpty ? 0 : 1,
        sourceDirectionality: 'AUTO',
        listStartOffset: 0,
        isFirstLineOfList: !isTrailingEmpty && (i === 0 || lines[i - 1].lineType === 'PLAIN'),
      });
    }
    return lines;
  }

  // Per-run mode: map each line to the run that contains its first character
  const lineStartPositions = [];
  let pos = 0;
  for (const line of textLines) {
    lineStartPositions.push(pos);
    pos += line.length + 1; // +1 for \n
  }

  // Build a map: character position → run index
  const runStarts = [];
  let rPos = 0;
  for (let i = 0; i < runs.length; i++) {
    runStarts.push(rPos);
    rPos += runs[i].text.length;
  }

  for (let i = 0; i < textLines.length; i++) {
    const lineStart = lineStartPositions[i];

    // Find the run that contains this line's first character
    let runIdx = 0;
    for (let r = runs.length - 1; r >= 0; r--) {
      if (runStarts[r] <= lineStart) { runIdx = r; break; }
    }
    const run = runs[runIdx];

    let lineType = 'PLAIN';
    let indentationLevel = 0;

    if (run.bullet) {
      lineType = 'UNORDERED_LIST';
      indentationLevel = run.indent ?? 1;
    } else if (run.number) {
      lineType = 'ORDERED_LIST';
      indentationLevel = run.indent ?? 1;
    }

    // Trailing empty line after last \n → PLAIN
    if (i === textLines.length - 1 && textLines[i] === '' && lineType !== 'PLAIN') {
      lineType = 'PLAIN';
      indentationLevel = 0;
    }

    // isFirstLineOfList: true when list type or indent changes
    let isFirstLineOfList = false;
    if (lineType !== 'PLAIN') {
      if (i === 0 ||
          lines[i - 1].lineType !== lineType ||
          lines[i - 1].indentationLevel !== indentationLevel) {
        isFirstLineOfList = true;
      }
    }

    lines.push({
      lineType,
      styleId: 0,
      indentationLevel,
      sourceDirectionality: 'AUTO',
      listStartOffset: 0,
      isFirstLineOfList,
    });
  }

  return lines;
}

/**
 * Build the nodeGenerationData required for SHAPE_WITH_TEXT nodes.
 * Two override entries: [0] = shape background, [1] = inner text.
 */
function buildShapeNodeGenData(shapeFillPaint, textFillPaint) {
  const DETACHED = { guid: { sessionID: 4294967295, localID: 4294967295 } };
  const baseOverride = {
    styleIdForFill: DETACHED,
    styleIdForStrokeFill: DETACHED,
    styleIdForText: DETACHED,
    fontSize: 12,
    paragraphIndent: 0,
    paragraphSpacing: 0,
    textAlignHorizontal: 'CENTER',
    textAlignVertical: 'TOP',
    textCase: 'ORIGINAL',
    textDecoration: 'NONE',
    lineHeight: { value: 100, units: 'PERCENT' },
    fontName: { family: 'Inter', style: 'Regular', postscript: '' },
    letterSpacing: { value: 0, units: 'PERCENT' },
    fontVersion: '',
    leadingTrim: 'NONE',
    fontVariations: [],
    opacity: 1,
    dashPattern: [],
    cornerRadius: 0,
    strokeWeight: 1,
    strokeAlign: 'INSIDE',
    strokeCap: 'NONE',
    strokeJoin: 'MITER',
    strokePaints: [],
    effects: [],
    textDecorationSkipInk: true,
    rectangleTopLeftCornerRadius: 0,
    rectangleTopRightCornerRadius: 0,
    rectangleBottomLeftCornerRadius: 0,
    rectangleBottomRightCornerRadius: 0,
    rectangleCornerRadiiIndependent: false,
    textTracking: 0,
    listSpacing: 0,
  };

  return {
    overrides: [
      {
        ...baseOverride,
        guidPath: { guids: [{ sessionID: 40000000, localID: 0 }] },
        fillPaints: [shapeFillPaint],
      },
      {
        ...baseOverride,
        guidPath: { guids: [{ sessionID: 40000000, localID: 1 }] },
        strokeAlign: 'OUTSIDE',
        fillPaints: [textFillPaint],
      },
    ],
    useFineGrainedSyncing: false,
    diffOnlyRemovals: [],
  };
}

// --- SVG import helpers ---

function _parseSVGPath(d) {
  const tokens = [];
  const re = /([MmLlCcSsHhVvZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    if (m[1]) tokens.push(m[1]);
    else tokens.push(parseFloat(m[2]));
  }
  const cmds = [];
  let i = 0, cx = 0, cy = 0, startX = 0, startY = 0, prevC2x = 0, prevC2y = 0, cmd = '';
  const num = () => tokens[i++];
  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') cmd = tokens[i++];
    switch (cmd) {
      case 'M': cx = num(); cy = num(); startX = cx; startY = cy; cmds.push({ type: 'M', x: cx, y: cy }); cmd = 'L'; break;
      case 'm': cx += num(); cy += num(); startX = cx; startY = cy; cmds.push({ type: 'M', x: cx, y: cy }); cmd = 'l'; break;
      case 'L': cx = num(); cy = num(); cmds.push({ type: 'L', x: cx, y: cy }); break;
      case 'l': cx += num(); cy += num(); cmds.push({ type: 'L', x: cx, y: cy }); break;
      case 'H': cx = num(); cmds.push({ type: 'L', x: cx, y: cy }); break;
      case 'h': cx += num(); cmds.push({ type: 'L', x: cx, y: cy }); break;
      case 'V': cy = num(); cmds.push({ type: 'L', x: cx, y: cy }); break;
      case 'v': cy += num(); cmds.push({ type: 'L', x: cx, y: cy }); break;
      case 'C': { const c1x=num(),c1y=num(),c2x=num(),c2y=num(); cx=num(); cy=num(); prevC2x=c2x; prevC2y=c2y; cmds.push({type:'C',c1x,c1y,c2x,c2y,x:cx,y:cy}); break; }
      case 'c': { const c1x=cx+num(),c1y=cy+num(),c2x=cx+num(),c2y=cy+num(); cx+=num(); cy+=num(); prevC2x=c2x; prevC2y=c2y; cmds.push({type:'C',c1x,c1y,c2x,c2y,x:cx,y:cy}); break; }
      case 'S': { const c1x=2*cx-prevC2x,c1y=2*cy-prevC2y,c2x=num(),c2y=num(); cx=num(); cy=num(); prevC2x=c2x; prevC2y=c2y; cmds.push({type:'C',c1x,c1y,c2x,c2y,x:cx,y:cy}); break; }
      case 's': { const c1x=2*cx-prevC2x,c1y=2*cy-prevC2y,c2x=cx+num(),c2y=cy+num(); cx+=num(); cy+=num(); prevC2x=c2x; prevC2y=c2y; cmds.push({type:'C',c1x,c1y,c2x,c2y,x:cx,y:cy}); break; }
      case 'Z': case 'z': cmds.push({ type: 'Z' }); cx = startX; cy = startY; break;
      default: i++; break;
    }
  }
  return cmds;
}

function _encodeCommandsBlob(cmds, sx, sy) {
  let size = 0;
  for (const c of cmds) { size += 1; if (c.type === 'M' || c.type === 'L') size += 8; else if (c.type === 'C') size += 24; }
  const buf = Buffer.alloc(size);
  let off = 0;
  for (const c of cmds) {
    switch (c.type) {
      case 'M': buf[off++] = 1; buf.writeFloatLE(c.x * sx, off); off += 4; buf.writeFloatLE(c.y * sy, off); off += 4; break;
      case 'L': buf[off++] = 2; buf.writeFloatLE(c.x * sx, off); off += 4; buf.writeFloatLE(c.y * sy, off); off += 4; break;
      case 'C': buf[off++] = 4;
        buf.writeFloatLE(c.c1x * sx, off); off += 4; buf.writeFloatLE(c.c1y * sy, off); off += 4;
        buf.writeFloatLE(c.c2x * sx, off); off += 4; buf.writeFloatLE(c.c2y * sy, off); off += 4;
        buf.writeFloatLE(c.x * sx, off); off += 4; buf.writeFloatLE(c.y * sy, off); off += 4; break;
      case 'Z': buf[off++] = 0; break;
    }
  }
  return new Uint8Array(buf.buffer, 0, off);
}

function _buildVectorNetworkBlob(allPathCmds) {
  const vertices = [];
  const segments = [];
  const regions = [];

  for (const pathCmds of allPathCmds) {
    const regionSegs = [];
    let firstVtx = -1, prevVtx = -1, prevX = 0, prevY = 0;

    for (const c of pathCmds) {
      if (c.type === 'M') {
        const vi = vertices.length;
        vertices.push({ x: c.x, y: c.y });
        firstVtx = vi; prevVtx = vi; prevX = c.x; prevY = c.y;
      } else if (c.type === 'L') {
        const vi = vertices.length;
        vertices.push({ x: c.x, y: c.y });
        if (prevVtx >= 0) {
          regionSegs.push(segments.length);
          segments.push({ s: prevVtx, tsx: 0, tsy: 0, e: vi, tex: 0, tey: 0, t: 0 });
        }
        prevVtx = vi; prevX = c.x; prevY = c.y;
      } else if (c.type === 'C') {
        const vi = vertices.length;
        vertices.push({ x: c.x, y: c.y });
        if (prevVtx >= 0) {
          regionSegs.push(segments.length);
          segments.push({ s: prevVtx, tsx: c.c1x - prevX, tsy: c.c1y - prevY, e: vi, tex: c.c2x - c.x, tey: c.c2y - c.y, t: 4 });
        }
        prevVtx = vi; prevX = c.x; prevY = c.y;
      } else if (c.type === 'Z') {
        if (prevVtx >= 0 && prevVtx !== firstVtx) {
          regionSegs.push(segments.length);
          segments.push({ s: prevVtx, tsx: 0, tsy: 0, e: firstVtx, tex: 0, tey: 0, t: 0 });
        }
        prevVtx = firstVtx; prevX = vertices[firstVtx].x; prevY = vertices[firstVtx].y;
      }
    }
    regions.push(regionSegs);
  }

  // Calculate size: header(16) + vertices(12 each) + segments(28 each) + regions(variable)
  let regSize = 0;
  for (const r of regions) regSize += 4 + 4 + r.length * 4 + 4; // numLoops + segCount + indices + windingRule
  const totalSize = 16 + vertices.length * 12 + segments.length * 28 + regSize;
  const buf = Buffer.alloc(totalSize);
  let off = 0;

  // Header
  buf.writeUInt32LE(vertices.length, off); off += 4;
  buf.writeUInt32LE(segments.length, off); off += 4;
  buf.writeUInt32LE(regions.length, off); off += 4;
  buf.writeUInt32LE(1, off); off += 4;

  // Vertices: x(f32) y(f32) handleMirroring(u32)
  for (const v of vertices) {
    buf.writeFloatLE(v.x, off); off += 4;
    buf.writeFloatLE(v.y, off); off += 4;
    buf.writeUInt32LE(4, off); off += 4;
  }

  // Segments: start(u32) tsx(f32) tsy(f32) end(u32) tex(f32) tey(f32) type(u32)
  for (const s of segments) {
    buf.writeUInt32LE(s.s, off); off += 4;
    buf.writeFloatLE(s.tsx, off); off += 4;
    buf.writeFloatLE(s.tsy, off); off += 4;
    buf.writeUInt32LE(s.e, off); off += 4;
    buf.writeFloatLE(s.tex, off); off += 4;
    buf.writeFloatLE(s.tey, off); off += 4;
    buf.writeUInt32LE(s.t, off); off += 4;
  }

  // Regions: numLoops(u32) segCount(u32) segIndices(u32*n) windingRule(u32)
  for (const r of regions) {
    buf.writeUInt32LE(1, off); off += 4; // numLoops = 1
    buf.writeUInt32LE(r.length, off); off += 4;
    for (const si of r) { buf.writeUInt32LE(si, off); off += 4; }
    buf.writeUInt32LE(1, off); off += 4; // windingRule = NONZERO
  }

  return new Uint8Array(buf.buffer, 0, off);
}

function sha1Hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

function copyToImagesDir(fd, hash, srcPath) {
  if (!fd.imagesDir) {
    fd.imagesDir = `/tmp/openfig_images_${Date.now()}`;
    mkdirSync(fd.imagesDir, { recursive: true });
  }
  const dest = join(fd.imagesDir, hash);
  if (!existsSync(dest)) copyFileSync(srcPath, dest);
}
