/**
 * clone-slide — Duplicate a template slide with new content.
 *
 * Usage: node cli.mjs clone-slide <file.deck> -o <output.deck>
 *        --template <slideId|name> --name <newName>
 *        [--after <slideId>] [--set key=value ...] [--set-image key=path ...]
 */
import { FigDeck } from '../../lib/core/fig-deck.mjs';
import { nid, parseId, positionChar } from '../../lib/core/node-helpers.mjs';
import { imageOv } from '../../lib/core/image-helpers.mjs';
import { deepClone } from '../../lib/core/deep-clone.mjs';
import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';
import { getImageDimensions, generateThumbnail } from '../../lib/core/image-utils.mjs';

function sha1Hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

export async function run(args, flags) {
  const file = args[0];
  const outPath = flags.o || flags.output;
  const templateRef = flags.template;
  const newName = flags.name || 'New Slide';
  const sets = Array.isArray(flags.set) ? flags.set : (flags.set ? [flags.set] : []);
  const setImages = Array.isArray(flags['set-image']) ? flags['set-image'] : (flags['set-image'] ? [flags['set-image']] : []);

  if (!file || !outPath || !templateRef) {
    console.error('Usage: clone-slide <file.deck> -o <out.deck> --template <id|name> --name <name> [--set key=val ...] [--set-image key=path ...]');
    process.exit(1);
  }

  const deck = await FigDeck.fromDeckFile(file);

  // Find template slide
  const tmplSlide = findSlide(deck, templateRef);
  if (!tmplSlide) { console.error(`Template slide not found: ${templateRef}`); process.exit(1); }

  const tmplInst = deck.getSlideInstance(nid(tmplSlide));
  if (!tmplInst) { console.error(`No instance on template slide`); process.exit(1); }

  // Detect MODULE wrapper: SLIDE_ROW → MODULE → SLIDE
  const tmplParentId = tmplSlide.parentIndex?.guid
    ? `${tmplSlide.parentIndex.guid.sessionID}:${tmplSlide.parentIndex.guid.localID}`
    : null;
  const tmplParent = tmplParentId ? deck.getNode(tmplParentId) : null;
  const hasModule = tmplParent?.type === 'MODULE';
  const slideRowId = hasModule
    ? (tmplParent.parentIndex?.guid
        ? `${tmplParent.parentIndex.guid.sessionID}:${tmplParent.parentIndex.guid.localID}`
        : null)
    : tmplParentId;

  // Generate new IDs
  let nextId = deck.maxLocalID() + 1;
  const moduleId = hasModule ? nextId++ : null;
  const slideId = nextId++;
  const instId = nextId++;

  // Create new MODULE wrapper if template uses one
  let newModule = null;
  if (hasModule && slideRowId) {
    const activeCount = deck.getActiveSlides().length;
    newModule = {
      guid: { sessionID: 1, localID: moduleId },
      phase: 'CREATED',
      type: 'MODULE',
      name: newName,
      isPublishable: true,
      version: tmplParent.version,
      userFacingVersion: tmplParent.userFacingVersion,
      visible: true,
      opacity: 1,
      size: deepClone(tmplParent.size ?? { x: 1920, y: 1080 }),
      transform: deepClone(tmplParent.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }),
      strokeWeight: 1,
      strokeAlign: 'INSIDE',
      strokeJoin: 'MITER',
      fillPaints: deepClone(tmplParent.fillPaints ?? [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true, blendMode: 'NORMAL' }]),
      fillGeometry: deepClone(tmplParent.fillGeometry ?? [{ windingRule: 'NONZERO', commandsBlob: 13, styleID: 0 }]),
      frameMaskDisabled: false,
      parentIndex: {
        guid: parseId(slideRowId),
        position: positionChar(activeCount),
      },
    };
  }

  // Clone slide node
  const newSlide = deepClone(tmplSlide);
  newSlide.guid = { sessionID: 1, localID: slideId };
  newSlide.name = newName;
  newSlide.phase = 'CREATED';
  if (hasModule && newModule) {
    // Parent to the new MODULE
    newSlide.parentIndex = {
      guid: { sessionID: 1, localID: moduleId },
      position: '!',
    };
  } else if (slideRowId) {
    const activeCount = deck.getActiveSlides().length;
    newSlide.parentIndex = {
      guid: parseId(slideRowId),
      position: positionChar(activeCount),
    };
  }
  delete newSlide.prototypeInteractions;
  delete newSlide.slideThumbnailHash;
  delete newSlide.editInfo;

  // Clone instance
  const newInst = deepClone(tmplInst);
  newInst.guid = { sessionID: 1, localID: instId };
  newInst.name = newName;
  newInst.phase = 'CREATED';
  newInst.parentIndex = { guid: { sessionID: 1, localID: slideId }, position: '!' };
  newInst.symbolData = {
    symbolID: deepClone(tmplInst.symbolData?.symbolID),
    symbolOverrides: [],
    uniformScaleFactor: 1,
  };
  delete newInst.derivedSymbolData;
  delete newInst.derivedSymbolDataLayoutVersion;
  delete newInst.editInfo;

  // Clone sibling nodes (non-INSTANCE children of template slide, e.g. logo vectors)
  const tmplSlideId = nid(tmplSlide);
  const tmplInstId = nid(tmplInst);
  const tmplChildren = deck.childrenMap.get(tmplSlideId) || [];
  const siblingNodes = [];
  const idRemap = new Map();

  for (const child of tmplChildren) {
    if (nid(child) === tmplInstId) continue;
    if (child.phase === 'REMOVED') continue;

    // Collect this node and all descendants
    const subtree = [];
    function collectSubtree(nodeId) {
      const node = deck.getNode(nodeId);
      if (!node || node.phase === 'REMOVED') return;
      subtree.push(node);
      const kids = deck.childrenMap.get(nodeId) || [];
      for (const kid of kids) collectSubtree(nid(kid));
    }
    collectSubtree(nid(child));

    // Clone each node with new IDs, re-parenting to new slide
    for (const node of subtree) {
      const oldId = nid(node);
      const newLocalId = nextId++;
      idRemap.set(oldId, newLocalId);

      const cloned = deepClone(node);
      cloned.guid = { sessionID: 1, localID: newLocalId };
      cloned.phase = 'CREATED';
      delete cloned.editInfo;

      if (cloned.parentIndex?.guid) {
        const parentOldId = `${cloned.parentIndex.guid.sessionID}:${cloned.parentIndex.guid.localID}`;
        if (parentOldId === tmplSlideId) {
          cloned.parentIndex.guid = { sessionID: 1, localID: slideId };
        } else if (idRemap.has(parentOldId)) {
          cloned.parentIndex.guid = { sessionID: 1, localID: idRemap.get(parentOldId) };
        }
      }
      siblingNodes.push(cloned);
    }
  }

  // Apply text overrides
  for (const pair of sets) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) continue;
    const key = parseId(pair.substring(0, eqIdx));
    let value = pair.substring(eqIdx + 1);
    if (value === '') value = ' ';
    newInst.symbolData.symbolOverrides.push({
      guidPath: { guids: [key] },
      textData: { characters: value },
    });
  }

  // Apply image overrides
  for (const pair of setImages) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) continue;
    const key = parseId(pair.substring(0, eqIdx));
    const imgPath = resolve(pair.substring(eqIdx + 1));

    const imgBuf = readFileSync(imgPath);
    const imgHash = sha1Hex(imgBuf);
    const { width: w, height: h } = await getImageDimensions(imgPath);

    const tmpThumb = `/tmp/openfig_thumb_${Date.now()}.png`;
    await generateThumbnail(imgPath, tmpThumb);
    const thumbHash = sha1Hex(readFileSync(tmpThumb));

    copyToImages(deck, imgHash, imgPath);
    copyToImages(deck, thumbHash, tmpThumb);

    newInst.symbolData.symbolOverrides.push(
      imageOv(key, imgHash, thumbHash, w, h)
    );
  }

  // Set slide position
  const activeSlides = deck.getActiveSlides();
  const xOffset = activeSlides.length * 2160;
  if (newModule?.transform) {
    newModule.transform.m02 = xOffset;
  }
  if (newSlide.transform) {
    newSlide.transform.m02 = hasModule ? 0 : xOffset;
  }

  // Push to nodeChanges
  if (newModule) {
    deck.message.nodeChanges.push(newModule);
  }
  deck.message.nodeChanges.push(newSlide);
  deck.message.nodeChanges.push(newInst);
  for (const sib of siblingNodes) {
    deck.message.nodeChanges.push(sib);
  }
  deck.rebuildMaps();

  const moduleNote = newModule ? ` + MODULE 1:${moduleId}` : '';
  const sibNote = siblingNodes.length ? `, ${siblingNodes.length} sibling node(s)` : '';
  console.log(`Cloned slide "${tmplSlide.name}" → "${newName}" (1:${slideId} + 1:${instId}${moduleNote}${sibNote})`);
  console.log(`  ${sets.length} text override(s), ${setImages.length} image override(s)`);

  const bytes = await deck.saveDeck(outPath);
  console.log(`Saved: ${outPath} (${bytes} bytes)`);
}

function copyToImages(deck, hash, srcPath) {
  if (!deck.imagesDir) {
    deck.imagesDir = `/tmp/openfig_images_${Date.now()}`;
    mkdirSync(deck.imagesDir, { recursive: true });
  }
  const dest = join(deck.imagesDir, hash);
  if (!existsSync(dest)) {
    copyFileSync(srcPath, dest);
  }
}

function findSlide(deck, ref) {
  const byId = deck.getNode(ref);
  if (byId?.type === 'SLIDE') return byId;
  return deck.getSlides().find(s => s.name === ref);
}
