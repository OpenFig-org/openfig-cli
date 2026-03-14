/**
 * template-deck — Inspect, author, wrap, and instantiate Figma Slides templates.
 *
 * Template workflows now cover two structural states:
 * - Draft templates:      SLIDE_ROW -> SLIDE -> ...
 * - Published templates:  SLIDE_ROW -> MODULE -> SLIDE -> ...
 */
import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { Deck } from './api.mjs';
import { deepClone } from '../core/deep-clone.mjs';
import { FigDeck } from '../core/fig-deck.mjs';
import { hexToHash } from '../core/image-helpers.mjs';
import { getImageDimensions, generateThumbnail } from '../core/image-utils.mjs';
import { nid, positionChar } from '../core/node-helpers.mjs';

export const LAYOUT_PREFIX = 'layout:';
export const TEXT_SLOT_PREFIX = 'slot:text:';
export const IMAGE_SLOT_PREFIX = 'slot:image:';
export const FIXED_IMAGE_PREFIX = 'fixed:image:';

const INTERNAL_CANVAS_NAME = 'Internal Only Canvas';
const MODULE_VERSION = '1:37';
const DEFAULT_ROW_GAP = 2160;

/**
 * Inspect a template deck and return available layouts plus explicit slot metadata.
 */
export async function listTemplateLayouts(templatePath, opts = {}) {
  const deck = await FigDeck.fromDeckFile(templatePath);
  return describeTemplateLayouts(deck, opts);
}

/**
 * Create a new draft template deck from scratch.
 */
export async function createDraftTemplate(outputPath, opts = {}) {
  const title = opts.title ?? 'Untitled';
  const layoutNames = Array.isArray(opts.layouts) && opts.layouts.length
    ? opts.layouts
    : ['cover'];

  const deck = await Deck.create({ name: title });
  for (const name of layoutNames) {
    deck.addBlankSlide({ name: normalizeLayoutName(name) });
  }

  await deck.save(outputPath);
  return statSync(resolve(outputPath)).size;
}

/**
 * Add or update explicit layout/slot metadata on an existing draft or published template.
 */
export async function annotateTemplateLayout(path, outputPath, opts = {}) {
  const deck = await FigDeck.fromDeckFile(path);
  const slide = deck.getNode(opts.slideId);
  if (!slide || slide.type !== 'SLIDE') {
    throw new Error(`Slide not found: ${opts.slideId}`);
  }

  const module = getParentModule(deck, slide);
  if (opts.layoutName) {
    const layoutName = normalizeLayoutName(opts.layoutName);
    slide.name = layoutName;
    if (module) module.name = layoutName;
  }

  renameNodes(deck, opts.textSlots, TEXT_SLOT_PREFIX);
  renameNodes(deck, opts.imageSlots, IMAGE_SLOT_PREFIX);
  renameNodes(deck, opts.fixedImages, FIXED_IMAGE_PREFIX);

  return deck.saveDeck(outputPath);
}

/**
 * Convert draft slides into publish-like module-backed layouts.
 */
export async function publishTemplateDraft(path, outputPath, opts = {}) {
  const deck = await FigDeck.fromDeckFile(path);
  const targetIds = new Set(opts.slideIds ?? []);
  const layouts = describeTemplateLayouts(deck);
  const draftLayouts = layouts.filter(layout => layout.state === 'draft');
  const targets = targetIds.size
    ? draftLayouts.filter(layout => targetIds.has(layout.slideId))
    : draftLayouts;

  if (!targets.length) {
    throw new Error('No draft template slides found to wrap');
  }

  let nextId = deck.maxLocalID() + 1;
  for (const layout of targets) {
    const slide = deck.getNode(layout.slideId);
    if (!slide) continue;

    const row = deck.getNode(layout.rowId);
    if (!row) {
      throw new Error(`Slide row not found for ${layout.slideId}`);
    }

    const moduleGuid = { sessionID: slide.guid.sessionID, localID: nextId++ };
    const module = createModuleWrapper(slide, moduleGuid);
    module.parentIndex = deepClone(slide.parentIndex);

    slide.parentIndex = { guid: deepClone(moduleGuid), position: '!' };

    deck.message.nodeChanges.push(module);
  }

  deck.rebuildMaps();
  return deck.saveDeck(outputPath);
}

/**
 * Create a new deck from a template by cherry-picking and populating layouts.
 *
 * @param {string} templatePath
 * @param {string} outputPath
 * @param {Array<{slideId: string, text?: Record<string, string>, images?: Record<string, string>}>} slideDefs
 */
export async function createFromTemplate(templatePath, outputPath, slideDefs) {
  const deck = await FigDeck.fromDeckFile(templatePath);
  const layouts = describeTemplateLayouts(deck);
  const layoutBySlideId = new Map(layouts.map(layout => [layout.slideId, layout]));
  const mainRows = getMainSlideRows(deck);
  const targetRow = mainRows[0];

  if (!targetRow) {
    throw new Error('No main-canvas SLIDE_ROW found in template');
  }

  let nextId = deck.maxLocalID() + 1;
  const sessionId = 200;

  for (let defIdx = 0; defIdx < slideDefs.length; defIdx++) {
    const def = slideDefs[defIdx];
    const sourceLayout = layoutBySlideId.get(def.slideId);
    if (!sourceLayout) throw new Error(`Layout not found: ${def.slideId}`);

    const rootId = sourceLayout.moduleId ?? sourceLayout.slideId;
    const subtreeNodes = [];
    deck.walkTree(rootId, node => {
      if (node.phase !== 'REMOVED') subtreeNodes.push(node);
    });

    const idMap = new Map();
    for (const node of subtreeNodes) {
      idMap.set(nid(node), { sessionID: sessionId, localID: nextId++ });
    }

    const reverseIdMap = new Map();
    for (const [oldId, guid] of idMap.entries()) {
      reverseIdMap.set(`${guid.sessionID}:${guid.localID}`, oldId);
    }

    const clonedNodes = subtreeNodes.map(node => {
      const clone = deepClone(node);
      const oldId = nid(node);
      const newGuid = idMap.get(oldId);
      if (newGuid) clone.guid = newGuid;

      if (oldId === rootId) {
        clone.parentIndex = {
          guid: deepClone(targetRow.guid),
          position: positionChar(defIdx),
        };
        if (clone.transform) {
          clone.transform.m02 = defIdx * DEFAULT_ROW_GAP;
        }
      } else if (clone.parentIndex?.guid) {
        const parentId = `${clone.parentIndex.guid.sessionID}:${clone.parentIndex.guid.localID}`;
        const remappedParent = idMap.get(parentId);
        if (remappedParent) {
          clone.parentIndex = { ...clone.parentIndex, guid: remappedParent };
        }
      }

      clone.phase = 'CREATED';
      delete clone.slideThumbnailHash;
      delete clone.editInfo;
      delete clone.prototypeInteractions;

      return clone;
    });

    for (const clone of clonedNodes) {
      const originalId = reverseIdMap.get(nid(clone));
      const textValue = pickMappedValue(def.text, candidateTextKeys(sourceLayout, clone, originalId));
      if (textValue !== undefined) {
        applyTextValue(clone, textValue);
      }

      const imagePath = pickMappedValue(def.images, candidateImageKeys(sourceLayout, clone, originalId));
      if (imagePath !== undefined) {
        await applyImageValue(deck, clone, imagePath);
      }
    }

    deck.message.nodeChanges.push(...clonedNodes);
  }

  deck.rebuildMaps();

  const pruneIds = new Set();
  for (const layout of layouts) {
    collectSubtree(deck, layout.moduleId ?? layout.slideId, pruneIds);
  }

  const targetRowId = nid(targetRow);
  const extraRowIds = new Set(mainRows.slice(1).map(row => nid(row)));

  deck.message.nodeChanges = deck.message.nodeChanges.filter(node => {
    const id = nid(node);
    if (!id) return true;
    if (pruneIds.has(id)) return false;
    if (id !== targetRowId && extraRowIds.has(id)) return false;
    return true;
  });

  deck.rebuildMaps();
  return deck.saveDeck(outputPath);
}

function describeTemplateLayouts(deck, opts = {}) {
  const includeInternal = Boolean(opts.includeInternal);
  const rows = includeInternal
    ? deck.message.nodeChanges.filter(node => node.type === 'SLIDE_ROW' && node.phase !== 'REMOVED')
    : getMainSlideRows(deck);

  const layouts = [];
  for (const row of rows) {
    for (const layout of getRowLayouts(deck, row)) {
      layouts.push(describeLayout(deck, layout, row));
    }
  }
  return layouts;
}

function getMainSlideRows(deck) {
  return deck.message.nodeChanges.filter(node => {
    if (node.type !== 'SLIDE_ROW' || node.phase === 'REMOVED') return false;
    const canvas = getAncestorCanvas(deck, node);
    return !isInternalCanvas(canvas);
  });
}

function getRowLayouts(deck, row) {
  const layouts = [];
  for (const child of deck.getChildren(nid(row))) {
    if (child.phase === 'REMOVED') continue;
    if (child.type === 'MODULE') {
      for (const maybeSlide of deck.getChildren(nid(child))) {
        if (maybeSlide.phase === 'REMOVED' || maybeSlide.type !== 'SLIDE') continue;
        layouts.push({ slide: maybeSlide, module: child });
      }
      continue;
    }
    if (child.type === 'SLIDE') {
      layouts.push({ slide: child, module: null });
    }
  }
  return layouts;
}

function describeLayout(deck, layout, row) {
  const rootId = layout.module ? nid(layout.module) : nid(layout.slide);
  const slotDiscovery = discoverSlots(deck, rootId);
  const nameSource = layout.module?.name || layout.slide.name || layout.slide.name || 'Untitled';
  const canonicalName = stripLayoutPrefix(nameSource);

  return {
    slideId: nid(layout.slide),
    moduleId: layout.module ? nid(layout.module) : null,
    rowId: nid(row),
    rowName: row.name || 'Slide row',
    name: canonicalName,
    rawName: nameSource,
    state: layout.module ? 'published' : 'draft',
    hasExplicitSlotMetadata: slotDiscovery.hasExplicitSlotMetadata,
    slots: [...slotDiscovery.textSlots, ...slotDiscovery.imageSlots],
    textFields: slotDiscovery.textSlots.map(slot => ({
      nodeId: slot.nodeId,
      name: slot.name,
      preview: slot.preview,
      source: slot.source,
    })),
    imagePlaceholders: slotDiscovery.imageSlots.map(slot => ({
      nodeId: slot.nodeId,
      name: slot.name,
      type: slot.nodeType,
      width: slot.width,
      height: slot.height,
      hasCurrentImage: slot.hasCurrentImage,
      source: slot.source,
    })),
  };
}

/**
 * Walk the node tree like deck.walkTree, but follow INSTANCE → SYMBOL links.
 * When an INSTANCE node is encountered, its referenced SYMBOL's children are
 * also walked so that slots inside published template components are discovered.
 */
function walkTreeThroughInstances(deck, rootId, visitor, depth = 0, visited = new Set()) {
  if (!rootId || visited.has(rootId)) return;
  visited.add(rootId);

  const node = deck.getNode(rootId);
  if (!node || node.phase === 'REMOVED') return;
  visitor(node, depth);

  // Follow INSTANCE → SYMBOL: walk the SYMBOL's children
  if (node.type === 'INSTANCE' && node.symbolData?.symbolID) {
    const sid = node.symbolData.symbolID;
    const symNid = `${sid.sessionID}:${sid.localID}`;
    for (const child of deck.getChildren(symNid)) {
      walkTreeThroughInstances(deck, nid(child), visitor, depth + 1, visited);
    }
  }

  // Walk direct children
  for (const child of deck.getChildren(rootId)) {
    walkTreeThroughInstances(deck, nid(child), visitor, depth + 1, visited);
  }
}

function discoverSlots(deck, rootId) {
  const explicitTextSlots = [];
  const explicitImageSlots = [];
  const fallbackTextSlots = [];
  const fallbackImageSlots = [];

  walkTreeThroughInstances(deck, rootId, node => {
    const textSlotName = parsePrefixedName(node.name, TEXT_SLOT_PREFIX);
    if (textSlotName) {
      const slot = describeTextSlot(node, textSlotName, 'explicit');
      if (slot) explicitTextSlots.push(slot);
      return;
    }

    const imageSlotName = parsePrefixedName(node.name, IMAGE_SLOT_PREFIX);
    if (imageSlotName) {
      const slot = describeImageSlot(node, imageSlotName, 'explicit');
      if (slot) explicitImageSlots.push(slot);
      return;
    }

    if (parsePrefixedName(node.name, FIXED_IMAGE_PREFIX)) {
      return;
    }

    const fallbackText = describeFallbackTextSlot(node);
    if (fallbackText) fallbackTextSlots.push(fallbackText);

    const fallbackImage = describeFallbackImageSlot(deck, node);
    if (fallbackImage) fallbackImageSlots.push(fallbackImage);
  });

  const hasExplicitSlotMetadata = explicitTextSlots.length > 0 || explicitImageSlots.length > 0;

  return {
    hasExplicitSlotMetadata,
    textSlots: explicitTextSlots.length ? explicitTextSlots : fallbackTextSlots,
    imageSlots: hasExplicitSlotMetadata ? explicitImageSlots : fallbackImageSlots,
  };
}

function describeFallbackTextSlot(node) {
  if (node.type === 'TEXT' && node.name) {
    return describeTextSlot(node, node.name, 'heuristic');
  }

  if (node.type === 'SHAPE_WITH_TEXT' && node.nodeGenerationData?.overrides?.length) {
    return {
      type: 'text',
      nodeId: nid(node),
      name: `#${nid(node)}`,
      preview: firstShapeText(node),
      source: 'heuristic',
      nodeType: node.type,
    };
  }

  return null;
}

function describeTextSlot(node, name, source) {
  if (node.type === 'TEXT') {
    return {
      type: 'text',
      nodeId: nid(node),
      name,
      preview: (node.textData?.characters ?? '').slice(0, 80),
      source,
      nodeType: node.type,
    };
  }

  if (node.type === 'SHAPE_WITH_TEXT') {
    return {
      type: 'text',
      nodeId: nid(node),
      name,
      preview: firstShapeText(node),
      source,
      nodeType: node.type,
    };
  }

  return null;
}

function describeFallbackImageSlot(deck, node) {
  if (node.name && parsePrefixedName(node.name, FIXED_IMAGE_PREFIX)) return null;
  const hasImageFill = node.fillPaints?.some(fill => fill.type === 'IMAGE');
  const isLargeEmptyFrame = (node.type === 'FRAME' || node.type === 'ROUNDED_RECTANGLE')
    && (node.size?.x ?? 0) > 100
    && (node.size?.y ?? 0) > 100
    && deck.getChildren(nid(node)).filter(child => child.phase !== 'REMOVED').length === 0;

  if (!hasImageFill && !isLargeEmptyFrame) return null;

  return describeImageSlot(node, `#${nid(node)}`, 'heuristic');
}

function describeImageSlot(node, name, source) {
  const hasImageFill = node.fillPaints?.some(fill => fill.type === 'IMAGE') ?? false;
  return {
    type: 'image',
    nodeId: nid(node),
    name,
    source,
    nodeType: node.type,
    width: Math.round(node.size?.x ?? 0),
    height: Math.round(node.size?.y ?? 0),
    hasCurrentImage: hasImageFill,
  };
}

function candidateTextKeys(layout, node, originalId) {
  const keys = [];
  const field = layout.textFields.find(entry => entry.nodeId === originalId);
  if (field?.name) keys.push(field.name);
  if (originalId) {
    keys.push(originalId);
    keys.push(`#${originalId}`);
  }
  if (node.name) keys.push(node.name);
  return dedupe(keys);
}

function candidateImageKeys(layout, node, originalId) {
  const keys = [];
  const field = layout.imagePlaceholders.find(entry => entry.nodeId === originalId);
  if (field?.name) keys.push(field.name);
  if (originalId) {
    keys.push(originalId);
    keys.push(`#${originalId}`);
  }
  if (node.name) keys.push(node.name);
  return dedupe(keys);
}

function pickMappedValue(map, keys) {
  if (!map) return undefined;
  for (const key of keys) {
    if (key in map) return map[key];
  }
  return undefined;
}

function applyTextValue(node, text) {
  const chars = text === '' || text == null ? ' ' : text;

  if (node.type === 'TEXT') {
    if (!node.textData) node.textData = {};
    node.textData.characters = chars;
    node.textData.lines = chars.split('\n').map(() => ({
      lineType: 'PLAIN',
      styleId: 0,
      indentationLevel: 0,
      sourceDirectionality: 'AUTO',
      listStartOffset: 0,
      isFirstLineOfList: false,
    }));
    delete node.derivedTextData;
    return;
  }

  if (node.type === 'SHAPE_WITH_TEXT' && node.nodeGenerationData?.overrides) {
    for (const override of node.nodeGenerationData.overrides) {
      if (!override.textData) continue;
      override.textData.characters = chars;
      override.textData.lines = chars.split('\n').map(() => ({
        lineType: 'PLAIN',
        styleId: 0,
        indentationLevel: 0,
        sourceDirectionality: 'AUTO',
        listStartOffset: 0,
        isFirstLineOfList: false,
      }));
    }
    delete node.derivedImmutableFrameData;
  }
}

async function applyImageValue(deck, node, imagePath) {
  const absPath = resolve(imagePath);
  const imgBuf = readFileSync(absPath);
  const imgHash = sha1Hex(imgBuf);
  const { width, height } = await getImageDimensions(imgBuf);

  const tmpThumb = `/tmp/openfig_thumb_${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
  await generateThumbnail(imgBuf, tmpThumb);
  const thumbHash = sha1Hex(readFileSync(tmpThumb));

  copyToImagesDir(deck, imgHash, absPath);
  copyToImagesDir(deck, thumbHash, tmpThumb);

  const fill = {
    type: 'IMAGE',
    opacity: 1,
    visible: true,
    blendMode: 'NORMAL',
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    image: { hash: hexToHash(imgHash), name: imgHash },
    imageThumbnail: { hash: hexToHash(thumbHash), name: thumbHash },
    animationFrame: 0,
    imageScaleMode: existingImageScaleMode(node) ?? 'FILL',
    imageShouldColorManage: false,
    rotation: 0,
    scale: 0.5,
    originalImageWidth: width,
    originalImageHeight: height,
    thumbHash: new Uint8Array(0),
    altText: '',
  };

  if (node.fillPaints?.length) {
    const idx = node.fillPaints.findIndex(paint => paint.type === 'IMAGE');
    if (idx >= 0) {
      node.fillPaints.splice(idx, 1, fill);
    } else {
      node.fillPaints = [fill];
    }
  } else {
    node.fillPaints = [fill];
  }

  delete node.derivedImmutableFrameData;
}

function collectSubtree(deck, rootId, seen) {
  if (!rootId || seen.has(rootId)) return;
  seen.add(rootId);
  for (const child of deck.getChildren(rootId)) {
    collectSubtree(deck, nid(child), seen);
  }
}

function renameNodes(deck, map, prefix) {
  if (!map) return;
  for (const [nodeId, name] of Object.entries(map)) {
    const node = deck.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    node.name = `${prefix}${stripPrefix(name)}`;
  }
}

function createModuleWrapper(slide, moduleGuid) {
  return {
    guid: deepClone(moduleGuid),
    phase: 'CREATED',
    type: 'MODULE',
    name: slide.name ?? 'layout',
    isPublishable: true,
    version: MODULE_VERSION,
    userFacingVersion: MODULE_VERSION,
    visible: true,
    opacity: 1,
    size: deepClone(slide.size ?? { x: 1920, y: 1080 }),
    transform: { m00: 1, m01: 0, m02: slide.transform?.m02 ?? 0, m10: 0, m11: 1, m12: slide.transform?.m12 ?? 0 },
    strokeWeight: 1,
    strokeAlign: 'INSIDE',
    strokeJoin: 'MITER',
    fillPaints: deepClone(slide.fillPaints ?? [{
      type: 'SOLID',
      color: { r: 1, g: 1, b: 1, a: 1 },
      opacity: 1,
      visible: true,
      blendMode: 'NORMAL',
    }]),
    fillGeometry: [{
      windingRule: 'NONZERO',
      commandsBlob: 13,
      styleID: 0,
    }],
    frameMaskDisabled: false,
  };
}

function getParentModule(deck, slide) {
  if (!slide?.parentIndex?.guid) return null;
  const parent = deck.getNode(guidId(slide.parentIndex.guid));
  return parent?.type === 'MODULE' ? parent : null;
}

function getAncestorCanvas(deck, node) {
  let current = node;
  while (current?.parentIndex?.guid) {
    const parent = deck.getNode(guidId(current.parentIndex.guid));
    if (!parent) return null;
    if (parent.type === 'CANVAS') return parent;
    current = parent;
  }
  return null;
}

function isInternalCanvas(canvas) {
  return canvas?.name === INTERNAL_CANVAS_NAME;
}

function parsePrefixedName(value, prefix) {
  if (!value || !value.startsWith(prefix)) return null;
  return stripPrefix(value.slice(prefix.length));
}

function normalizeLayoutName(value) {
  const stripped = stripLayoutPrefix(value || 'layout');
  return `${LAYOUT_PREFIX}${stripped}`;
}

function stripLayoutPrefix(value) {
  return parsePrefixedName(value, LAYOUT_PREFIX) ?? stripPrefix(value);
}

function stripPrefix(value) {
  return String(value ?? '').trim().replace(/^(layout:|slot:text:|slot:image:|fixed:image:)/, '');
}

function firstShapeText(node) {
  const text = node.nodeGenerationData?.overrides?.find(override => override.textData?.characters)?.textData?.characters ?? '';
  return text.trim().slice(0, 80);
}

function existingImageScaleMode(node) {
  return node.fillPaints?.find(fill => fill.type === 'IMAGE')?.imageScaleMode;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function guidId(guid) {
  return guid ? `${guid.sessionID}:${guid.localID}` : null;
}

function sha1Hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

function copyToImagesDir(deck, hash, srcPath) {
  if (!deck.imagesDir) {
    deck.imagesDir = `/tmp/openfig_images_${Date.now()}`;
    mkdirSync(deck.imagesDir, { recursive: true });
  }
  const dest = join(deck.imagesDir, hash);
  if (!existsSync(dest)) copyFileSync(srcPath, dest);
}
