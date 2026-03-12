#!/usr/bin/env node
/**
 * FigmaTK MCP Server — exposes deck manipulation as tools for Claude Cowork / Claude Code.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FigDeck } from './lib/fig-deck.mjs';
import { nid, ov, nestedOv, removeNode, parseId, positionChar } from './lib/node-helpers.mjs';
import { imageOv, hexToHash, hashToHex } from './lib/image-helpers.mjs';
import { deepClone } from './lib/deep-clone.mjs';

const server = new McpServer({
  name: 'figmatk',
  version: '0.0.3',
});

// ── inspect ─────────────────────────────────────────────────────────────
server.tool(
  'figmatk_inspect',
  'Show the node hierarchy tree of a Figma .deck or .fig file',
  { path: z.string().describe('Path to .deck or .fig file') },
  async ({ path }) => {
    const deck = await FigDeck.fromDeckFile(path);
    const lines = [];
    const doc = deck.message.nodeChanges.find(n => n.type === 'DOCUMENT');
    if (!doc) return { content: [{ type: 'text', text: 'No DOCUMENT node found' }] };

    function walk(nodeId, indent) {
      const node = deck.getNode(nodeId);
      if (!node || node.phase === 'REMOVED') return;
      const id = nid(node);
      const name = node.name || '';
      const type = node.type || '?';
      lines.push(`${' '.repeat(indent)}${type} ${id} "${name}"`);
      const children = deck.childrenMap.get(nodeId) || [];
      for (const child of children) walk(nid(child), indent + 2);
    }
    walk(nid(doc), 0);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── list-text ───────────────────────────────────────────────────────────
server.tool(
  'figmatk_list_text',
  'List all text and image content per slide in a .deck file',
  { path: z.string().describe('Path to .deck or .fig file') },
  async ({ path }) => {
    const deck = await FigDeck.fromDeckFile(path);
    const lines = [];
    const slides = deck.getSlides();
    for (const slide of slides) {
      if (slide.phase === 'REMOVED') continue;
      const id = nid(slide);
      lines.push(`\n── Slide ${id} "${slide.name || ''}" ──`);
      const inst = deck.getSlideInstance(id);
      if (!inst?.symbolData?.symbolOverrides) continue;
      for (const ov of inst.symbolData.symbolOverrides) {
        const key = ov.guidPath?.guids?.[0];
        const keyStr = key ? `${key.sessionID}:${key.localID}` : '?';
        if (ov.textData?.characters) {
          lines.push(`  [text] ${keyStr}: ${ov.textData.characters.substring(0, 120)}`);
        }
        if (ov.fillPaints?.length) {
          for (const p of ov.fillPaints) {
            if (p.image?.hash) {
              lines.push(`  [image] ${keyStr}: ${hashToHex(p.image.hash)}`);
            }
          }
        }
      }
    }
    return { content: [{ type: 'text', text: lines.join('\n') || 'No slides found' }] };
  }
);

// ── list-overrides ──────────────────────────────────────────────────────
server.tool(
  'figmatk_list_overrides',
  'List editable override keys for each symbol in the deck',
  { path: z.string().describe('Path to .deck or .fig file') },
  async ({ path }) => {
    const deck = await FigDeck.fromDeckFile(path);
    const lines = [];
    const symbols = deck.getSymbols();
    for (const sym of symbols) {
      const id = nid(sym);
      lines.push(`\nSymbol ${id} "${sym.name || ''}"`);
      const children = deck.childrenMap.get(id) || [];
      function walkChildren(nodeId, depth) {
        const node = deck.getNode(nodeId);
        if (!node || node.phase === 'REMOVED') return;
        const cid = nid(node);
        const type = node.type || '?';
        const name = node.name || '';
        if (type === 'TEXT' || (node.fillPaints?.some(p => p.type === 'IMAGE'))) {
          lines.push(`  ${'  '.repeat(depth)}${type} ${cid} "${name}"`);
        }
        const kids = deck.childrenMap.get(cid) || [];
        for (const kid of kids) walkChildren(nid(kid), depth + 1);
      }
      for (const child of children) walkChildren(nid(child), 0);
    }
    return { content: [{ type: 'text', text: lines.join('\n') || 'No symbols found' }] };
  }
);

// ── update-text ─────────────────────────────────────────────────────────
server.tool(
  'figmatk_update_text',
  'Apply text overrides to a slide instance. Pass key=value pairs.',
  {
    path: z.string().describe('Path to .deck file'),
    output: z.string().describe('Output .deck path'),
    instanceId: z.string().describe('Instance node ID (e.g. "1:1631")'),
    overrides: z.record(z.string()).describe('Object of overrideKey: text pairs, e.g. {"75:127": "Hello"}'),
  },
  async ({ path, output, instanceId, overrides }) => {
    const deck = await FigDeck.fromDeckFile(path);
    const inst = deck.getNode(instanceId);
    if (!inst) return { content: [{ type: 'text', text: `Instance ${instanceId} not found` }] };
    if (!inst.symbolData) inst.symbolData = { symbolOverrides: [] };
    if (!inst.symbolData.symbolOverrides) inst.symbolData.symbolOverrides = [];

    for (const [key, text] of Object.entries(overrides)) {
      const [s, l] = key.split(':').map(Number);
      inst.symbolData.symbolOverrides.push(ov({ sessionID: s, localID: l }, text));
    }

    const bytes = await deck.saveDeck(output);
    return { content: [{ type: 'text', text: `Saved ${output} (${bytes} bytes), ${Object.keys(overrides).length} text overrides applied` }] };
  }
);

// ── insert-image ────────────────────────────────────────────────────────
server.tool(
  'figmatk_insert_image',
  'Apply an image fill override to a slide instance',
  {
    path: z.string().describe('Path to .deck file'),
    output: z.string().describe('Output .deck path'),
    instanceId: z.string().describe('Instance node ID'),
    targetKey: z.string().describe('Override key for the image rectangle (e.g. "75:126")'),
    imageHash: z.string().describe('40-char hex SHA-1 hash of the full image'),
    thumbHash: z.string().describe('40-char hex SHA-1 hash of the thumbnail'),
    width: z.number().describe('Image width in pixels'),
    height: z.number().describe('Image height in pixels'),
    imagesDir: z.string().optional().describe('Path to images directory to include in deck'),
  },
  async ({ path, output, instanceId, targetKey, imageHash, thumbHash, width, height, imagesDir }) => {
    const deck = await FigDeck.fromDeckFile(path);
    const inst = deck.getNode(instanceId);
    if (!inst) return { content: [{ type: 'text', text: `Instance ${instanceId} not found` }] };
    if (!inst.symbolData) inst.symbolData = { symbolOverrides: [] };
    if (!inst.symbolData.symbolOverrides) inst.symbolData.symbolOverrides = [];

    const [s, l] = targetKey.split(':').map(Number);
    inst.symbolData.symbolOverrides.push(
      imageOv({ sessionID: s, localID: l }, imageHash, thumbHash, width, height)
    );

    const opts = imagesDir ? { imagesDir } : {};
    const bytes = await deck.saveDeck(output, opts);
    return { content: [{ type: 'text', text: `Saved ${output} (${bytes} bytes), image override applied` }] };
  }
);

// ── clone-slide ─────────────────────────────────────────────────────────
server.tool(
  'figmatk_clone_slide',
  'Duplicate a slide from the deck',
  {
    path: z.string().describe('Path to .deck file'),
    output: z.string().describe('Output .deck path'),
    slideId: z.string().describe('Source slide node ID to clone'),
  },
  async ({ path, output, slideId }) => {
    const deck = await FigDeck.fromDeckFile(path);
    const slide = deck.getNode(slideId);
    if (!slide) return { content: [{ type: 'text', text: `Slide ${slideId} not found` }] };

    let nextId = deck.maxLocalID() + 1;
    const newSlide = deepClone(slide);
    const newSlideId = nextId++;
    newSlide.guid = { sessionID: 1, localID: newSlideId };
    newSlide.phase = 'CREATED';
    delete newSlide.prototypeInteractions;
    delete newSlide.slideThumbnailHash;
    delete newSlide.editInfo;

    const inst = deck.getSlideInstance(slideId);
    if (inst) {
      const newInst = deepClone(inst);
      newInst.guid = { sessionID: 1, localID: nextId++ };
      newInst.phase = 'CREATED';
      newInst.parentIndex = { guid: { sessionID: 1, localID: newSlideId }, position: '!' };
      delete newInst.derivedSymbolData;
      delete newInst.derivedSymbolDataLayoutVersion;
      delete newInst.editInfo;
      deck.message.nodeChanges.push(newInst);
    }

    deck.message.nodeChanges.push(newSlide);
    deck.rebuildMaps();

    const bytes = await deck.saveDeck(output);
    return { content: [{ type: 'text', text: `Cloned slide ${slideId} → 1:${newSlideId}. Saved ${output} (${bytes} bytes)` }] };
  }
);

// ── remove-slide ────────────────────────────────────────────────────────
server.tool(
  'figmatk_remove_slide',
  'Mark a slide as REMOVED',
  {
    path: z.string().describe('Path to .deck file'),
    output: z.string().describe('Output .deck path'),
    slideId: z.string().describe('Slide node ID to remove'),
  },
  async ({ path, output, slideId }) => {
    const deck = await FigDeck.fromDeckFile(path);
    const slide = deck.getNode(slideId);
    if (!slide) return { content: [{ type: 'text', text: `Slide ${slideId} not found` }] };
    removeNode(slide);
    const inst = deck.getSlideInstance(slideId);
    if (inst) removeNode(inst);

    const bytes = await deck.saveDeck(output);
    return { content: [{ type: 'text', text: `Removed slide ${slideId}. Saved ${output} (${bytes} bytes)` }] };
  }
);

// ── roundtrip ───────────────────────────────────────────────────────────
server.tool(
  'figmatk_roundtrip',
  'Decode and re-encode a .deck file to validate the pipeline',
  {
    path: z.string().describe('Path to input .deck file'),
    output: z.string().describe('Path to output .deck file'),
  },
  async ({ path, output }) => {
    const deck = await FigDeck.fromDeckFile(path);
    const bytes = await deck.saveDeck(output);
    return { content: [{ type: 'text', text: `Roundtrip complete: ${output} (${bytes} bytes)` }] };
  }
);

// ── Start server ────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
