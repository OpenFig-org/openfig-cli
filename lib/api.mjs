/**
 * figmatk programmatic API
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

import { FigDeck } from './fig-deck.mjs';
import { nid, parseId, positionChar } from './node-helpers.mjs';
import { imageOv, hexToHash } from './image-helpers.mjs';
import { deepClone } from './deep-clone.mjs';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { getImageDimensions, generateThumbnail } from './image-utils.mjs';

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
    return new Deck(fd, null);
  }

  /** Presentation metadata from meta.json */
  get meta() {
    return this._fd.deckMeta ?? {};
  }

  /** Ordered list of active (non-REMOVED) Slide objects */
  get slides() {
    return this._fd.getActiveSlides().map(n => new Slide(this._fd, n));
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

    const slide = new Slide(fd, newSlide);

    // Apply background if specified
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

    if (typeof color === 'string') {
      const variable = resolveColorVariable(this._fd, color);
      rgb = { r: variable.r, g: variable.g, b: variable.b, a: 1 };
      colorVar = {
        value: { alias: { guid: deepClone(variable.guid) } },
        dataType: 'ALIAS',
        resolvedDataType: 'COLOR',
      };
    } else {
      rgb = { r: color.r, g: color.g, b: color.b, a: color.a ?? 1 };
      colorVar = undefined;
    }

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

    const tmpThumb = `/tmp/figmatk_thumb_${Date.now()}.png`;
    await generateThumbnail(imgBuf, tmpThumb);
    const thumbHash = sha1Hex(readFileSync(tmpThumb));

    copyToImagesDir(this._fd, imgHash, imgPath ?? (() => {
      const tmp = `/tmp/figmatk_img_${Date.now()}`;
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
    const fill = opts.fill ?? { r: 1, g: 1, b: 1, a: 1 };

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
  async addImage(x, y, width, height, pathOrBuf, opts = {}) {
    const fd = this._fd;
    const localID = fd.maxLocalID() + 1;

    const imgBuf = typeof pathOrBuf === 'string'
      ? readFileSync(resolve(pathOrBuf))
      : pathOrBuf;
    const imgPath = typeof pathOrBuf === 'string' ? resolve(pathOrBuf) : null;

    const imgHash = sha1Hex(imgBuf);
    const { width: origW, height: origH } = await getImageDimensions(imgBuf);

    // Generate thumbnail
    const tmpThumb = `/tmp/figmatk_thumb_${Date.now()}.png`;
    await generateThumbnail(imgBuf, tmpThumb);
    const thumbHash = sha1Hex(readFileSync(tmpThumb));

    // Copy both to images dir
    if (imgPath) {
      copyToImagesDir(fd, imgHash, imgPath);
    } else {
      const tmpImg = `/tmp/figmatk_img_${Date.now()}`;
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

    const fillColor = opts.color ?? { r: 0, g: 0, b: 0 };

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
      size: { x: opts.width ?? 1200, y: 50 },  // height will be recomputed by Figma
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

  async addImage(x, y, width, height, pathOrBuf, opts = {}) {
    return Slide.prototype.addImage.call(this, x, y, width, height, pathOrBuf, opts);
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

/**
 * Resolve a named color (e.g. 'Blue', 'Red') to its VARIABLE node.
 * Returns { guid, r, g, b } from the Light Slides color variable set.
 */
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

function sha1Hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

function copyToImagesDir(fd, hash, srcPath) {
  if (!fd.imagesDir) {
    fd.imagesDir = `/tmp/figmatk_images_${Date.now()}`;
    mkdirSync(fd.imagesDir, { recursive: true });
  }
  const dest = join(fd.imagesDir, hash);
  if (!existsSync(dest)) copyFileSync(srcPath, dest);
}
