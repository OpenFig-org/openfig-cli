/**
 * Zero-seed .deck construction.
 *
 * Builds a document from code with no bundled seed file. The base document
 * (DOCUMENT + two CANVAS nodes) comes from openfig-core's
 * `createEmptyFigDoc()`. On top we author the Slides scaffolding
 * (SLIDE_GRID, SLIDE_ROW, SLIDE) and an OpenFig-authored neutral theme:
 *   - TEXT styles: "Heading", "Body", "Caption"
 *   - VARIABLE_SET "OpenFig default" with Ink / Paper / Accent variables
 *   - DOCUMENT theme wiring: themeID, slideThemeMap, sourceLibraryKey
 *
 * Every string and numeric value is authored by this project.
 */

import { createEmptyFigDoc } from 'openfig-core';
import { deflateSync } from 'node:zlib';

const IDENTITY = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const BASE = {
  phase: 'CREATED',
  visible: true,
  opacity: 1,
  strokeWeight: 0,
  strokeAlign: 'CENTER',
  strokeJoin: 'BEVEL',
  transform: IDENTITY,
};

const SLIDE_WIDTH = 1920;
const SLIDE_HEIGHT = 1080;
const GRID_PADDING = 240;
const GRID_WIDTH = SLIDE_WIDTH + GRID_PADDING * 2;
const GRID_HEIGHT = SLIDE_HEIGHT + GRID_PADDING * 2;

// Theme GUIDs live in sessionID=1 to keep them distinct from structural
// scaffolding (session 0) and from user-added content (future sessions).
const THEME_SESSION = 1;
const TEXT_HEADING_ID = 10;
const TEXT_BODY_ID = 11;
const TEXT_CAPTION_ID = 12;
const VSET_ID = 20;
const VAR_INK_ID = 21;
const VAR_PAPER_ID = 22;
const VAR_ACCENT_ID = 23;
const MODE_ID = 1;

const INTERNAL_CANVAS_PARENT = {
  guid: { sessionID: 0, localID: 2 },
  // Child sort positions use single ASCII-printable characters as fractional
  // indices (the format orders siblings by lexical comparison of these strings).
};

const THEME_VERSION = '1:0';
const THEME_LIBRARY_KEY = 'lk-openfig-default-v1';

function textStyleNode(localID, name, sortPos, { fontSize, fontFamily, fontStyle, postscript }) {
  return {
    ...BASE,
    guid: { sessionID: THEME_SESSION, localID },
    parentIndex: { guid: INTERNAL_CANVAS_PARENT.guid, position: sortPos },
    type: 'TEXT',
    name,
    isPublishable: true,
    styleType: 'TEXT',
    version: THEME_VERSION,
    userFacingVersion: THEME_VERSION,
    sortPosition: sortPos,
    fontSize,
    textAlignVertical: 'TOP',
    lineHeight: { value: 1.2, units: 'RAW' },
    fontName: { family: fontFamily, style: fontStyle, postscript },
    textData: {
      characters: 'Rag 123',
      lines: [
        {
          lineType: 'PLAIN',
          styleId: 0,
          indentationLevel: 0,
          sourceDirectionality: 'AUTO',
          listStartOffset: 0,
          isFirstLineOfList: false,
        },
      ],
    },
  };
}

function variableSetNode() {
  return {
    ...BASE,
    guid: { sessionID: THEME_SESSION, localID: VSET_ID },
    parentIndex: { guid: INTERNAL_CANVAS_PARENT.guid, position: '9' },
    type: 'VARIABLE_SET',
    name: 'OpenFig default',
    isPublishable: true,
    version: THEME_VERSION,
    userFacingVersion: THEME_VERSION,
    visible: false,
    locked: true,
    opacity: 0,
    variableSetModes: [
      {
        id: { sessionID: THEME_SESSION, localID: MODE_ID },
        name: 'Mode 1',
        sortPosition: '!',
      },
    ],
  };
}

function colorVariableNode(localID, name, sortPos, { r, g, b }) {
  return {
    ...BASE,
    guid: { sessionID: THEME_SESSION, localID },
    parentIndex: { guid: INTERNAL_CANVAS_PARENT.guid, position: sortPos },
    type: 'VARIABLE',
    name,
    isPublishable: true,
    version: THEME_VERSION,
    sortPosition: sortPos,
    visible: false,
    locked: true,
    opacity: 0,
    variableSetID: { guid: { sessionID: THEME_SESSION, localID: VSET_ID } },
    variableResolvedType: 'COLOR',
    variableDataValues: {
      entries: [
        {
          modeID: { sessionID: THEME_SESSION, localID: MODE_ID },
          variableData: {
            value: { colorValue: { r, g, b, a: 1 } },
            dataType: 'COLOR',
            resolvedDataType: 'COLOR',
          },
        },
      ],
    },
  };
}

/**
 * Generate a minimal 400×260 solid-white PNG placeholder for the deck's
 * thumbnail.png entry. The .deck format requires a thumbnail.png entry in
 * the zip archive alongside canvas.fig and meta.json.
 *
 * @returns {Buffer} PNG bytes
 */
export function createPlaceholderThumbnail(width = 400, height = 260) {
  const row = Buffer.alloc(1 + width * 3, 0xff); row[0] = 0;
  const raw = Buffer.alloc(height * row.length);
  for (let i = 0; i < height; i++) row.copy(raw, i * row.length);
  const idat = deflateSync(raw);

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xFF] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Build an empty FigDocument for a Slides presentation.
 *
 * Returns a FigDocument (from openfig-core) with its message.nodeChanges
 * populated to contain:
 *   - DOCUMENT (0:0) — with themeID, slideThemeMap, sourceLibraryKey
 *   - CANVAS "Page 1" (0:1)
 *   - CANVAS "Internal Only Canvas" (0:2)
 *   - SLIDE_GRID "Presentation" (0:3)
 *   - SLIDE_ROW "Row" (0:4)
 *   - SLIDE "1" (0:5)
 *   - TEXT styles "Heading" / "Body" / "Caption" (1:10..12)
 *   - VARIABLE_SET "OpenFig default" (1:20)
 *   - VARIABLE nodes Ink / Paper / Accent (1:21..23)
 *
 * @param {object} [opts]
 * @param {string} [opts.name]
 * @returns {import('openfig-core').FigDocument}
 */
export function createEmptyDeckDoc(_opts = {}) {
  const doc = createEmptyFigDoc();

  // Normalize CANVAS sort positions so Page 1 sorts first and the
  // Internal Only Canvas sorts last.
  for (const node of doc.message.nodeChanges) {
    if (node.type !== 'CANVAS') continue;
    if (node.name === 'Page 1') node.parentIndex.position = '!';
    else if (node.name === 'Internal Only Canvas') node.parentIndex.position = '~';
  }

  // Slides scaffolding (session 0).
  const slideGrid = {
    ...BASE,
    guid: { sessionID: 0, localID: 3 },
    type: 'SLIDE_GRID',
    name: 'Presentation',
    parentIndex: { guid: { sessionID: 0, localID: 1 }, position: '!' },
    size: { x: GRID_WIDTH, y: GRID_HEIGHT },
    stackMode: 'VERTICAL',
    stackSpacing: 600,
    stackHorizontalPadding: GRID_PADDING,
    stackVerticalPadding: GRID_PADDING,
    stackPaddingRight: GRID_PADDING,
    stackPaddingBottom: GRID_PADDING,
    frameMaskDisabled: true,
    stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
  };

  const slideRow = {
    ...BASE,
    guid: { sessionID: 0, localID: 4 },
    type: 'SLIDE_ROW',
    name: 'Row',
    parentIndex: { guid: { sessionID: 0, localID: 3 }, position: '!' },
    size: { x: SLIDE_WIDTH, y: SLIDE_HEIGHT },
    transform: { m00: 1, m01: 0, m02: GRID_PADDING, m10: 0, m11: 1, m12: GRID_PADDING },
    strokeWeight: 1,
    strokeAlign: 'INSIDE',
    strokeJoin: 'MITER',
    stackMode: 'HORIZONTAL',
    stackSpacing: 240,
    stackCounterSpacing: 240,
    stackChildAlignSelf: 'STRETCH',
    stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
    stackPrimarySizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
    stackWrap: 'WRAP',
    frameMaskDisabled: true,
    hasBeenManuallyRenamed: false,
    fillPaints: [
      { type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0, visible: true, blendMode: 'NORMAL' },
    ],
    // `y: Infinity` represents an unconstrained vertical maximum for the
    // stack container. JSON.stringify serializes it as `null`; the kiwi
    // encoder accepts Infinity directly.
    maxSize: { value: { x: 43440, y: Infinity } },
  };

  const slide = {
    ...BASE,
    guid: { sessionID: 0, localID: 5 },
    type: 'SLIDE',
    name: '1',
    parentIndex: { guid: { sessionID: 0, localID: 4 }, position: '!' },
    size: { x: SLIDE_WIDTH, y: SLIDE_HEIGHT },
    strokeWeight: 1,
    strokeAlign: 'INSIDE',
    strokeJoin: 'MITER',
    fillPaints: [
      {
        type: 'SOLID',
        color: { r: 1, g: 1, b: 1, a: 1 },
        opacity: 1,
        visible: true,
        blendMode: 'NORMAL',
      },
    ],
    stackHorizontalPadding: 168,
    stackVerticalPadding: 128,
    stackPaddingRight: 168,
    stackPaddingBottom: 128,
    frameMaskDisabled: false,
    overrideKey: { sessionID: 4294967295, localID: 4294967295 },
    sourceLibraryKey: THEME_LIBRARY_KEY,
    themeID: { guid: { sessionID: THEME_SESSION, localID: VSET_ID } },
    slideSpeakerNotes: '{"root":{"children":[{"children":[],"direction":null,"format":"","textFormat":null,"indent":0,"type":"paragraph","version":1,"textStyle":""}],"direction":null,"format":"","indent":0,"type":"root","version":1}}',
  };

  // OpenFig-authored neutral theme (session 1). All names and numeric values
  // are defined in this file; none are derived from any other presentation.
  const heading = textStyleNode(TEXT_HEADING_ID, 'Heading', '"', {
    fontSize: 72, fontFamily: 'Inter', fontStyle: 'Bold', postscript: 'Inter-Bold',
  });
  const body = textStyleNode(TEXT_BODY_ID, 'Body', '#', {
    fontSize: 36, fontFamily: 'Inter', fontStyle: 'Regular', postscript: 'Inter-Regular',
  });
  const caption = textStyleNode(TEXT_CAPTION_ID, 'Caption', '$', {
    fontSize: 24, fontFamily: 'Inter', fontStyle: 'Regular', postscript: 'Inter-Regular',
  });

  const vset = variableSetNode();
  const varInk = colorVariableNode(VAR_INK_ID, 'Ink', ':', { r: 0.1, g: 0.1, b: 0.1 });
  const varPaper = colorVariableNode(VAR_PAPER_ID, 'Paper', ';', { r: 1, g: 1, b: 1 });
  const varAccent = colorVariableNode(VAR_ACCENT_ID, 'Accent', '<', { r: 0.25, g: 0.5, b: 0.85 });

  // Attach theme metadata to DOCUMENT.
  const documentNode = doc.message.nodeChanges.find((n) => n.type === 'DOCUMENT');
  documentNode.sourceLibraryKey = THEME_LIBRARY_KEY;
  documentNode.themeID = { guid: { sessionID: THEME_SESSION, localID: VSET_ID } };
  documentNode.slideThemeMap = {
    entries: [
      {
        themeId: { guid: { sessionID: THEME_SESSION, localID: VSET_ID } },
        themeProps: {
          themeVersion: THEME_VERSION,
          variableSetId: { guid: { sessionID: THEME_SESSION, localID: VSET_ID } },
          textStyleIds: [
            { guid: { sessionID: THEME_SESSION, localID: TEXT_HEADING_ID } },
            { guid: { sessionID: THEME_SESSION, localID: TEXT_BODY_ID } },
            { guid: { sessionID: THEME_SESSION, localID: TEXT_CAPTION_ID } },
          ],
          subscribedThemeRef: { key: '', version: '' },
          schemaVersion: 1,
          isGeneratedFromDesign: false,
        },
      },
    ],
  };

  doc.message.nodeChanges.push(
    slideGrid,
    slideRow,
    slide,
    heading,
    body,
    caption,
    vset,
    varInk,
    varPaper,
    varAccent,
  );

  // Rebuild convenience maps.
  doc.nodeMap = new Map();
  doc.childrenMap = new Map();
  for (const node of doc.message.nodeChanges) {
    const id = `${node.guid.sessionID}:${node.guid.localID}`;
    doc.nodeMap.set(id, node);
  }
  for (const node of doc.message.nodeChanges) {
    if (!node.parentIndex?.guid) continue;
    const pid = `${node.parentIndex.guid.sessionID}:${node.parentIndex.guid.localID}`;
    if (!doc.childrenMap.has(pid)) doc.childrenMap.set(pid, []);
    doc.childrenMap.get(pid).push(node);
  }

  return doc;
}
