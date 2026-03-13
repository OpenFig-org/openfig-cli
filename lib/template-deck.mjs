/**
 * template-deck — Clone slides from a Figma template and populate with content.
 *
 * Template decks use MODULE > SLIDE > (TEXT, FRAME, ...) structure.
 * Unlike generated decks, text is set directly on child nodes — not via symbolOverrides.
 */
import { FigDeck } from './fig-deck.mjs';
import { nid, removeNode } from './node-helpers.mjs';
import { deepClone } from './deep-clone.mjs';

/**
 * Inspect a template deck and return available layout slots.
 * Returns an array of { slideId, name, textFields: [{ nodeId, name }] }
 */
export async function listTemplateLayouts(templatePath) {
  const deck = await FigDeck.fromDeckFile(templatePath);
  const layouts = [];

  for (const slide of deck.getActiveSlides()) {
    const id = nid(slide);
    const textFields = [];
    const imagePlaceholders = [];

    deck.walkTree(id, (node) => {
      if (node.type === 'TEXT' && node.name && node.textData?.characters) {
        textFields.push({ nodeId: nid(node), name: node.name, preview: node.textData.characters.slice(0, 80) });
      }
      // Detect image placeholder areas: frames/shapes with IMAGE fill, or large empty frames
      const hasImageFill = node.fillPaints?.some(f => f.type === 'IMAGE');
      const isLargeFrame = (node.type === 'FRAME' || node.type === 'ROUNDED_RECTANGLE')
        && node.size?.x > 100 && node.size?.y > 100
        && deck.getChildren(nid(node)).filter(c => c.type !== 'FRAME').length === 0;
      if (hasImageFill || isLargeFrame) {
        imagePlaceholders.push({
          nodeId: nid(node),
          type: node.type,
          width: Math.round(node.size?.x ?? 0),
          height: Math.round(node.size?.y ?? 0),
          hasCurrentImage: hasImageFill,
        });
      }
    });

    layouts.push({ slideId: id, name: slide.name, textFields, imagePlaceholders });
  }

  return layouts;
}

/**
 * Create a new deck from a template by cherry-picking and populating slides.
 *
 * @param {string} templatePath  - Path to source .deck file
 * @param {string} outputPath    - Path to write output .deck file
 * @param {Array}  slideDefs     - [{ slideId: '1:74', text: { 'Title': 'Hello', 'Body 1': '...' } }]
 * @returns {number} bytes written
 */
export async function createFromTemplate(templatePath, outputPath, slideDefs) {
  const deck = await FigDeck.fromDeckFile(templatePath);

  // Record original MODULE/SLIDE IDs to remove after cloning
  const originalSlideIds = deck.getActiveSlides().map(s => nid(s));

  // Find SLIDE_ROW id (parent of MODULEs)
  const slideRowNode = deck.message.nodeChanges.find(n => n.type === 'SLIDE_ROW');
  if (!slideRowNode) throw new Error('No SLIDE_ROW found in template');
  const slideRowId = nid(slideRowNode);

  let nextId = deck.maxLocalID() + 1;
  const SESSION = 200; // fresh session ID for cloned nodes

  for (let defIdx = 0; defIdx < slideDefs.length; defIdx++) {
    const { slideId, text = {} } = slideDefs[defIdx];

    // Find the source SLIDE node
    const sourceSlide = deck.getNode(slideId);
    if (!sourceSlide) throw new Error(`Slide not found: ${slideId}`);

    // Find the parent MODULE (if present)
    const parentModuleId = sourceSlide.parentIndex?.guid
      ? `${sourceSlide.parentIndex.guid.sessionID}:${sourceSlide.parentIndex.guid.localID}`
      : null;
    const sourceModule = parentModuleId ? deck.getNode(parentModuleId) : null;

    // Collect all nodes in the subtree to clone (MODULE + SLIDE + all descendants)
    const rootId = sourceModule ? nid(sourceModule) : slideId;
    const subtreeNodes = [];
    deck.walkTree(rootId, (node) => subtreeNodes.push(node));

    // Build ID remap table: old "s:l" → new { sessionID, localID }
    const idMap = new Map();
    for (const node of subtreeNodes) {
      const oldId = nid(node);
      if (oldId) idMap.set(oldId, { sessionID: SESSION, localID: nextId++ });
    }

    // Deep-clone each node with remapped IDs
    const clonedNodes = subtreeNodes.map(node => {
      const clone = deepClone(node);

      // Remap own guid
      const newGuid = idMap.get(nid(node));
      if (newGuid) clone.guid = newGuid;

      // Remap parentIndex.guid if it's within the subtree
      if (clone.parentIndex?.guid) {
        const pid = `${clone.parentIndex.guid.sessionID}:${clone.parentIndex.guid.localID}`;
        const remapped = idMap.get(pid);
        if (remapped) {
          clone.parentIndex = { ...clone.parentIndex, guid: remapped };
        } else if (pid === slideRowId || pid === parentModuleId) {
          // Root node — attach to SLIDE_ROW
          clone.parentIndex = {
            guid: { sessionID: slideRowNode.guid.sessionID, localID: slideRowNode.guid.localID },
            position: String.fromCharCode(0x21 + (originalSlideIds.length + defIdx)),
          };
        }
      }

      clone.phase = 'CREATED';
      delete clone.slideThumbnailHash;
      delete clone.editInfo;
      delete clone.prototypeInteractions;

      return clone;
    });

    // Apply text overrides: find TEXT nodes by name, set characters
    const clonedSlideGuid = idMap.get(slideId);
    const clonedSlideId = clonedSlideGuid
      ? `${clonedSlideGuid.sessionID}:${clonedSlideGuid.localID}`
      : null;

    for (const clone of clonedNodes) {
      if (clone.type === 'TEXT' && clone.name && text[clone.name] !== undefined) {
        const val = text[clone.name];
        const chars = (val === '' || val == null) ? ' ' : val;
        if (!clone.textData) clone.textData = {};
        clone.textData.characters = chars;
        clone.textData.lines = chars.split('\n').map(() => ({
          lineType: 'PLAIN',
          styleId: 0,
          indentationLevel: 0,
          sourceDirectionality: 'AUTO',
          listStartOffset: 0,
          isFirstLineOfList: false,
        }));
        // Clear cached render — Figma uses derivedTextData for display,
        // deleting it forces re-render from characters on open
        delete clone.derivedTextData;
      }
    }

    deck.message.nodeChanges.push(...clonedNodes);
  }

  // Rebuild maps so we can walk the original slide subtrees
  deck.rebuildMaps();

  // Collect all node IDs in original slide subtrees to physically remove from nodeChanges.
  // phase=REMOVED is NOT used here — Figma ignores it for TEXT/FRAME nodes.
  const pruneIds = new Set();

  function collectSubtree(id) {
    if (pruneIds.has(id)) return;
    pruneIds.add(id);
    for (const child of deck.getChildren(id)) {
      collectSubtree(nid(child));
    }
  }

  for (const id of originalSlideIds) {
    const slide = deck.getNode(id);
    if (!slide) continue;

    if (slide.parentIndex?.guid) {
      const modId = `${slide.parentIndex.guid.sessionID}:${slide.parentIndex.guid.localID}`;
      const mod = deck.getNode(modId);
      if (mod?.type === 'MODULE') { collectSubtree(modId); continue; }
    }
    collectSubtree(id);
  }

  // Filter them out entirely — absent nodes render as non-existent in Figma
  deck.message.nodeChanges = deck.message.nodeChanges.filter(n => {
    const id = nid(n);
    return !id || !pruneIds.has(id);
  });

  deck.rebuildMaps();
  return deck.saveDeck(outputPath);
}
