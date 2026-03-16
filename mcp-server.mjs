#!/usr/bin/env node
/**
 * OpenFig MCP Server — exposes deck manipulation as tools for Claude Cowork / Claude Code.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import packageJson from './package.json' with { type: 'json' };
import { FigDeck } from './lib/core/fig-deck.mjs';
import { Deck } from './lib/slides/api.mjs';
import { slideToSvg } from './lib/rasterizer/svg-builder.mjs';
import { svgToPng } from './lib/rasterizer/deck-rasterizer.mjs';
import { resolveFonts } from './lib/rasterizer/font-resolver.mjs';
import {
  annotateTemplateLayout,
  createDraftTemplate,
  createFromTemplate,
  listTemplateLayouts,
  publishTemplateDraft,
} from './lib/slides/template-deck.mjs';
import { nid, ov, removeNode } from './lib/core/node-helpers.mjs';
import { imageOv, hashToHex } from './lib/core/image-helpers.mjs';
import { deepClone } from './lib/core/deep-clone.mjs';
import { searchImages, downloadImage } from './lib/images/search.mjs';

const server = new McpServer({
  name: 'openfig',
  version: packageJson.version,
});

// ── inspect ─────────────────────────────────────────────────────────────
server.tool(
  'openfig_inspect',
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
  'openfig_list_text',
  'List visible text and image content per slide in a .deck file, including direct slide nodes and instance overrides.',
  { path: z.string().describe('Path to .deck or .fig file') },
  async ({ path }) => {
    const deck = await FigDeck.fromDeckFile(path);
    const lines = [];
    const slides = deck.getSlides();
    for (const slide of slides) {
      if (slide.phase === 'REMOVED') continue;
      const id = nid(slide);
      lines.push(`\n── Slide ${id} "${slide.name || ''}" ──`);

      const directLines = [];
      deck.walkTree(id, (node, depth) => {
        if (depth === 0 || node.phase === 'REMOVED') return;
        if (node.type === 'TEXT' && node.textData?.characters) {
          directLines.push(`  [text-node] ${nid(node)} "${node.name || ''}": ${node.textData.characters}`);
        }
        if (node.type === 'SHAPE_WITH_TEXT' && node.nodeGenerationData?.overrides) {
          for (const override of node.nodeGenerationData.overrides) {
            if (override.textData?.characters) {
              directLines.push(`  [shape-text] ${nid(node)} "${node.name || ''}": ${override.textData.characters}`);
              break;
            }
          }
        }
        const imageFill = node.fillPaints?.find(p => p.type === 'IMAGE' && p.image?.hash);
        if (imageFill) {
          directLines.push(`  [image-node] ${nid(node)} "${node.name || ''}": ${hashToHex(imageFill.image.hash)}`);
        }
      });

      lines.push(...directLines);

      const inst = deck.getSlideInstance(id);
      if (!inst?.symbolData?.symbolOverrides) continue;
      for (const ov of inst.symbolData.symbolOverrides) {
        const key = ov.guidPath?.guids?.[0];
        const keyStr = key ? `${key.sessionID}:${key.localID}` : '?';
        if (ov.textData?.characters) {
          lines.push(`  [text-override] ${keyStr}: ${ov.textData.characters}`);
        }
        if (ov.fillPaints?.length) {
          for (const p of ov.fillPaints) {
            if (p.image?.hash) {
              lines.push(`  [image-override] ${keyStr}: ${hashToHex(p.image.hash)}`);
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
  'openfig_list_overrides',
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
        const key = node.overrideKey ? `${node.overrideKey.sessionID}:${node.overrideKey.localID}` : null;
        const type = node.type || '?';
        const name = node.name || '';
        if (key && (type === 'TEXT' || node.fillPaints?.some(p => p.type === 'IMAGE'))) {
          lines.push(`  ${'  '.repeat(depth)}${type} ${key} "${name}"`);
        }
        const kids = deck.childrenMap.get(nid(node)) || [];
        for (const kid of kids) walkChildren(nid(kid), depth + 1);
      }
      for (const child of children) walkChildren(nid(child), 0);
    }
    return { content: [{ type: 'text', text: lines.join('\n') || 'No symbols found' }] };
  }
);

// ── update-text ─────────────────────────────────────────────────────────
server.tool(
  'openfig_update_text',
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
      const nextOverride = ov({ sessionID: s, localID: l }, text);
      const existingIdx = inst.symbolData.symbolOverrides.findIndex(entry =>
        entry.guidPath?.guids?.length >= 1 &&
        entry.guidPath.guids[0].sessionID === s &&
        entry.guidPath.guids[0].localID === l &&
        entry.textData
      );
      if (existingIdx >= 0) {
        inst.symbolData.symbolOverrides.splice(existingIdx, 1, nextOverride);
      } else {
        inst.symbolData.symbolOverrides.push(nextOverride);
      }
    }

    const bytes = await deck.saveDeck(output);
    return { content: [{ type: 'text', text: `Saved ${output} (${bytes} bytes), ${Object.keys(overrides).length} text overrides applied` }] };
  }
);

// ── insert-image ────────────────────────────────────────────────────────
server.tool(
  'openfig_insert_image',
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
    const nextOverride = imageOv({ sessionID: s, localID: l }, imageHash, thumbHash, width, height);
    const existingIdx = inst.symbolData.symbolOverrides.findIndex(entry =>
      entry.guidPath?.guids?.length >= 1 &&
      entry.guidPath.guids[0].sessionID === s &&
      entry.guidPath.guids[0].localID === l &&
      entry.fillPaints
    );
    if (existingIdx >= 0) {
      inst.symbolData.symbolOverrides.splice(existingIdx, 1, nextOverride);
    } else {
      inst.symbolData.symbolOverrides.push(nextOverride);
    }

    const opts = imagesDir ? { imagesDir } : {};
    const bytes = await deck.saveDeck(output, opts);
    return { content: [{ type: 'text', text: `Saved ${output} (${bytes} bytes), image override applied` }] };
  }
);

// ── clone-slide ─────────────────────────────────────────────────────────
import { run as cloneSlideRun } from './bin/commands/clone-slide.mjs';

server.tool(
  'openfig_clone_slide',
  'Duplicate a slide from the deck',
  {
    path: z.string().describe('Path to .deck file'),
    output: z.string().describe('Output .deck path'),
    slideId: z.string().describe('Source slide node ID or name to clone'),
    name: z.string().optional().describe('Name for the new slide'),
    set: z.array(z.string()).optional().describe('Text overrides as "nodeId=value" pairs'),
    setImage: z.array(z.string()).optional().describe('Image overrides as "nodeId=path" pairs'),
  },
  async ({ path, output, slideId, name, set, setImage }) => {
    const logs = [];
    const origLog = console.log;
    const origError = console.error;
    const origExit = process.exit;
    console.log = (...a) => logs.push(a.join(' '));
    console.error = (...a) => logs.push(a.join(' '));
    process.exit = (code) => { throw new Error(`exit:${code}`); };
    try {
      await cloneSlideRun(
        [path],
        {
          o: output,
          template: slideId,
          name: name || 'New Slide',
          set: set || [],
          'set-image': setImage || [],
        }
      );
    } catch (e) {
      if (!e.message?.startsWith('exit:')) logs.push(`Error: ${e.message}`);
    } finally {
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
    }
    return { content: [{ type: 'text', text: logs.join('\n') }] };
  }
);

// ── remove-slide ────────────────────────────────────────────────────────
server.tool(
  'openfig_remove_slide',
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
  'openfig_roundtrip',
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

// ── create-deck ─────────────────────────────────────────────────────────
const THEMES = {
  midnight:   { dark: 'Black',     light: 'White',          accent: { r: 0.792, g: 0.863, b: 0.988 }, textDark: 'White', textLight: 'Black' },
  ocean:      { dark: 'Blue',      light: 'Pale Blue',      accent: { r: 0.129, g: 0.161, b: 0.361 }, textDark: 'White', textLight: 'Black' },
  forest:     { dark: 'Green',     light: 'Pale Green',     accent: { r: 0.592, g: 0.737, b: 0.384 }, textDark: 'White', textLight: 'Black' },
  coral:      { dark: 'Persimmon', light: 'Pale Persimmon', accent: { r: 0.184, g: 0.235, b: 0.494 }, textDark: 'White', textLight: 'Black' },
  terracotta: { dark: 'Persimmon', light: 'Pale Persimmon', accent: { r: 0.906, g: 0.910, b: 0.820 }, textDark: 'White', textLight: 'Black' },
  minimal:    { dark: 'Black',     light: 'White',          accent: { r: 0.212, g: 0.271, b: 0.310 }, textDark: 'White', textLight: 'Black' },
};

const SlideSchema = z.object({
  type: z.enum(['title', 'bullets', 'two-column', 'stat', 'image-full', 'closing']),
  title:      z.string().optional(),
  subtitle:   z.string().optional(),
  body:       z.string().optional(),
  bullets:    z.array(z.string()).optional(),
  stat:       z.string().optional(),
  caption:    z.string().optional(),
  image:      z.string().optional().describe('Absolute path to image file'),
  leftText:   z.string().optional(),
  rightText:  z.string().optional(),
  background: z.string().optional().describe('Override background (named color)'),
});

server.tool(
  'openfig_create_deck',
  'Create a new Figma Slides .deck file from a structured description. No npm install needed — runs directly in the MCP server.',
  {
    output: z.string().describe('Output path for the .deck file, e.g. /tmp/my-deck.deck'),
    title:  z.string().describe('Deck title'),
    theme:  z.string().optional().describe('Theme: midnight | ocean | forest | coral | terracotta | minimal (default: midnight)'),
    slides: z.array(SlideSchema).describe('Slides to create'),
  },
  async ({ output, title, theme, slides }) => {
    const t = THEMES[theme ?? 'midnight'] ?? THEMES.midnight;
    const deck = await Deck.create(title);

    for (const s of slides) {
      const slide = deck.addBlankSlide();
      const isDark = ['title', 'closing', 'stat', 'image-full'].includes(s.type);
      const bg = s.background ?? (isDark ? t.dark : t.light);
      const fg = isDark ? t.textDark : t.textLight;
      slide.setBackground(bg);

      if (s.type === 'title' || s.type === 'closing') {
        slide.addRectangle(0, 0, 1920, 8, { fill: t.accent });
        if (s.title)    slide.addText(s.title,    { style: 'Title',  color: fg, x: 80, y: 360, width: 1760, align: 'CENTER' });
        if (s.subtitle) slide.addText(s.subtitle, { style: 'Body 1', color: fg, x: 80, y: 540, width: 1760, align: 'CENTER' });

      } else if (s.type === 'bullets') {
        slide.addRectangle(0, 0, 1920, 8, { fill: t.accent });
        if (s.title) slide.addText(s.title, { style: 'Header 2', color: fg, x: 80, y: 80, width: 1760, align: 'LEFT' });
        const items = s.bullets ?? (s.body ? s.body.split('\n') : []);
        let y = 240;
        for (const item of items) {
          slide.addRectangle(80, y + 10, 12, 12, { fill: t.accent });
          slide.addText(item, { style: 'Body 1', color: fg, x: 116, y, width: 1724, align: 'LEFT' });
          y += 80;
        }

      } else if (s.type === 'two-column') {
        slide.addRectangle(0, 0, 1920, 8, { fill: t.accent });
        if (s.title) slide.addText(s.title, { style: 'Header 2', color: fg, x: 80, y: 80, width: 1760, align: 'LEFT' });
        slide.addRectangle(960, 200, 4, 800, { fill: t.accent });
        if (s.leftText)  slide.addText(s.leftText,  { style: 'Body 1', color: fg, x: 80,   y: 240, width: 840, align: 'LEFT' });
        if (s.rightText) slide.addText(s.rightText, { style: 'Body 1', color: fg, x: 1004, y: 240, width: 836, align: 'LEFT' });
        if (s.image) await slide.addImage(s.image, { x: 1004, y: 200, width: 836, height: 800 });

      } else if (s.type === 'stat') {
        slide.addRectangle(0, 0, 1920, 8, { fill: t.accent });
        if (s.title)   slide.addText(s.title,   { style: 'Header 2', color: fg, x: 80, y: 80,  width: 1760, align: 'LEFT' });
        if (s.stat)    slide.addText(s.stat,    { style: 'Title',    color: fg, x: 80, y: 300, width: 1760, align: 'CENTER' });
        if (s.caption) slide.addText(s.caption, { style: 'Body 1',   color: fg, x: 80, y: 720, width: 1760, align: 'CENTER' });

      } else if (s.type === 'image-full') {
        if (s.image) await slide.addImage(s.image, { x: 0, y: 0, width: 1920, height: 1080 });
        if (s.title || s.body) {
          slide.addRectangle(0, 680, 1920, 400, { fill: { r: 0, g: 0, b: 0 }, opacity: 0.7 });
          if (s.title) slide.addText(s.title, { style: 'Header 1', color: 'White', x: 80, y: 720, width: 1760, align: 'LEFT' });
          if (s.body)  slide.addText(s.body,  { style: 'Body 1',   color: 'White', x: 80, y: 880, width: 1760, align: 'LEFT' });
        }
      }
    }

    await deck.save(output);
    return { content: [{ type: 'text', text: `Created ${output} — ${slides.length} slides. Open in Figma Desktop.` }] };
  }
);

// ── openfig_list_template_layouts ────────────────────────────────────────
server.tool(
  'openfig_create_template_draft',
  'Create a new draft template deck. Draft templates are normal slide decks; later annotate slots and publish-wrap them into module-backed layouts.',
  {
    output: z.string().describe('Output path for the draft template .deck file'),
    title: z.string().describe('Template deck title'),
    layouts: z.array(z.string()).optional().describe('Optional ordered list of layout names to create, e.g. ["cover", "agenda", "section"]'),
  },
  async ({ output, title, layouts }) => {
    const bytes = await createDraftTemplate(output, { title, layouts });
    return { content: [{ type: 'text', text: `Created draft template ${output} (${bytes} bytes). Use openfig_annotate_template_layout to mark layout and slot names.` }] };
  }
);

server.tool(
  'openfig_annotate_template_layout',
  'Add explicit layout and slot metadata to a draft or published template. Use openfig_inspect or openfig_list_template_layouts first to get slide and node IDs.',
  {
    path: z.string().describe('Path to the source .deck file'),
    output: z.string().describe('Output path for the updated .deck file'),
    slideId: z.string().describe('Slide node ID to annotate'),
    layoutName: z.string().optional().describe('Logical layout name without the layout: prefix, e.g. "cover"'),
    textSlots: z.record(z.string()).optional().describe('Map of nodeId -> text slot name, e.g. {"1:120": "title"}'),
    imageSlots: z.record(z.string()).optional().describe('Map of nodeId -> image slot name, e.g. {"1:144": "hero_image"}'),
    fixedImages: z.record(z.string()).optional().describe('Map of nodeId -> fixed image label for decorative/sample content'),
  },
  async ({ path, output, slideId, layoutName, textSlots, imageSlots, fixedImages }) => {
    const bytes = await annotateTemplateLayout(path, output, { slideId, layoutName, textSlots, imageSlots, fixedImages });
    return { content: [{ type: 'text', text: `Annotated slide ${slideId}. Saved ${output} (${bytes} bytes).` }] };
  }
);

server.tool(
  'openfig_publish_template_draft',
  'Wrap draft template slides in publish-like MODULE nodes while preserving the slide subtree and internal canvas assets.',
  {
    path: z.string().describe('Path to the draft template .deck file'),
    output: z.string().describe('Output path for the wrapped .deck file'),
    slideIds: z.array(z.string()).optional().describe('Optional list of draft slide IDs to wrap. Defaults to every draft layout on the main canvas.'),
  },
  async ({ path, output, slideIds }) => {
    const bytes = await publishTemplateDraft(path, output, { slideIds });
    return { content: [{ type: 'text', text: `Publish-wrapped draft template to ${output} (${bytes} bytes).` }] };
  }
);

server.tool(
  'openfig_list_template_layouts',
  'Inspect a template or draft template .deck file and return a layout library catalog with explicit text/image slot metadata. Use this to inventory candidate layouts, classify what each layout is for, and choose a subset before calling openfig_create_from_template. Do not edit, remove, or reorder the source template as a way to build the output deck.',
  {
    template: z.string().describe('Path to the .deck template file'),
  },
  async ({ template }) => {
    const layouts = await listTemplateLayouts(template);
    const lines = layouts.map(l => {
      const textSlots = l.textFields.map(f => `    - ${f.name} (${f.nodeId}, ${f.source}): "${f.preview}"`).join('\n');
      const imageSlots = l.imagePlaceholders.map(f => `    - ${f.name} (${f.nodeId}, ${f.source}, ${f.width}x${f.height})${f.hasCurrentImage ? ' [image]' : ''}`).join('\n');
      return [
        `Layout "${l.name}" [${l.slideId}]`,
        `  state: ${l.state}${l.moduleId ? `, module ${l.moduleId}` : ''}, row ${l.rowId}`,
        `  explicit slots: ${l.hasExplicitSlotMetadata ? 'yes' : 'no'}`,
        textSlots ? `  text slots:\n${textSlots}` : '  text slots: (none)',
        imageSlots ? `  image slots:\n${imageSlots}` : '  image slots: (none)',
      ].join('\n');
    });
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  }
);

// ── openfig_create_from_template ─────────────────────────────────────────
server.tool(
  'openfig_create_from_template',
  'Create a new Figma Slides deck by selecting any ordered subset of layouts from a draft, published, or publish-like template .deck file and populating explicit text/image slots. The slides array defines the output order. This clones the chosen layouts into a new deck; do not remove, reorder, or mutate the source template to build the result. Works with flat-frame template slides as well as module-backed layouts, and preserves colors, fonts, internal assets, and special nodes.',
  {
    template: z.string().describe('Path to the source .deck template file'),
    output:   z.string().describe('Output path for the new .deck file (use /tmp/)'),
    slides: z.array(z.object({
      slideId: z.string().describe('Slide ID from openfig_list_template_layouts (e.g. "1:74")'),
      text:    z.record(z.string()).optional().describe('Map of text slot/name/nodeId -> value (e.g. { "title": "My Company" })'),
      images:  z.record(z.string()).optional().describe('Map of image slot/name/nodeId -> absolute image path (e.g. { "hero_image": "/tmp/photo.jpg" })'),
    })).describe('Ordered subset of template layouts to include in the output deck. The array order becomes the output deck order, regardless of the template\'s original order.'),
  },
  async ({ template, output, slides }) => {
    const bytes = await createFromTemplate(template, output, slides);
    return { content: [{ type: 'text', text: `Created ${output} — ${slides.length} slides (${bytes} bytes). Open in Figma Desktop.` }] };
  }
);

// ── render-slide ───────────────────────────────────────────────────────
server.tool(
  'openfig_render_slide',
  'Render a slide from a .deck file to an image. Without output path, returns inline WebP for visual QA. With output path, saves full PNG. Default is 1920×1080; use width (pixels) or scale (e.g. "50%") to resize.',
  {
    path: z.string().describe('Path to .deck file'),
    slide: z.number().int().min(1).describe('Slide number (1-based)'),
    output: z.string().optional().describe('Optional output path to save the PNG file (full resolution)'),
    width: z.number().int().optional().describe('Output width in pixels (height scales proportionally)'),
    scale: z.string().optional().describe('Scale as percentage, e.g. "50%" or "25%"'),
  },
  async ({ path, slide, output, width, scale }) => {
    const deck = await FigDeck.fromDeckFile(path);
    await resolveFonts(deck, { quiet: true });
    const slides = deck.getActiveSlides();

    if (slide > slides.length) {
      return { content: [{ type: 'text', text: `Slide ${slide} does not exist — deck has ${slides.length} slides` }] };
    }

    const svg = slideToSvg(deck, deck.getSlide(slide));

    // Build render options
    const renderOpts = {};
    if (width) {
      renderOpts.width = width;
    } else if (scale) {
      const pct = parseFloat(scale.replace('%', ''));
      if (!isNaN(pct) && pct > 0) renderOpts.scale = pct / 100;
    }

    const png = await svgToPng(svg, renderOpts);
    const buf = Buffer.from(png);

    if (output) {
      const { writeFileSync } = await import('fs');
      writeFileSync(output, buf);
      return { content: [{ type: 'text', text: `Rendered slide ${slide} → ${output} (${buf.length} bytes)` }] };
    }

    // For inline display: convert to WebP (much smaller) via sharp
    // Default to width=800 if no size specified to stay under MCP 1MB limit
    const sharp = (await import('sharp')).default;
    let img = sharp(buf);
    if (!width && !scale) img = img.resize(800);
    const webp = await img.webp({ quality: 80 }).toBuffer();

    return {
      content: [{
        type: 'image',
        data: webp.toString('base64'),
        mimeType: 'image/webp',
      }],
    };
  }
);

// ── search_images ────────────────────────────────────────────────────────
server.tool(
  'search_images',
  'Search for images by keyword. Returns a numbered list of results with URLs, dimensions, and source. Use this to find filler or placeholder images for slides.',
  {
    query: z.string().describe('Search query, e.g. "modern office sustainability"'),
    count: z.number().optional().describe('Number of results to return (default: 10, max: 20)'),
  },
  async ({ query, count = 10 }) => {
    const results = await searchImages(query, count);
    const lines = results.map((r, i) =>
      `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Size: ${r.width}×${r.height} | Source: ${r.source}`
    );
    return { content: [{ type: 'text', text: lines.join('\n\n') || 'No results found' }] };
  }
);

// ── download_image ───────────────────────────────────────────────────────
server.tool(
  'download_image',
  'Download an image from a URL to the project images/ folder. Returns the local file path. Always show the user the downloaded path before inserting into a slide.',
  {
    url:        z.string().describe('Image URL to download'),
    filename:   z.string().optional().describe('Output filename (default: derived from URL)'),
    output_dir: z.string().optional().describe('Directory to save into (default: ./images/ relative to cwd)'),
  },
  async ({ url, filename, output_dir }) => {
    const outPath = await downloadImage(url, filename, output_dir);
    return { content: [{ type: 'text', text: `Downloaded to: ${outPath}` }] };
  }
);

// ── Start server ────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
