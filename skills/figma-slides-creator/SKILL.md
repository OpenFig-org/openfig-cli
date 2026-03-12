---
name: figma-slides-creator
description: >
  Create, edit, and inspect Figma Slides .deck files. Use when the user asks to
  create a presentation, build a slide deck, edit slides, update text or images,
  clone or remove slides, or produce a .deck file for Figma Slides.
  Powered by FigmaTK under the hood.
metadata:
  version: "0.0.9"
---

# FigmaTK Skill

## ⚠️ Never open .deck files directly

`.deck` files are binary ZIP archives. **Never open, read, or display a `.deck` file** — it will show garbage bytes in the panel. To inspect or modify a `.deck` file, always use the CLI commands or Node.js API shown below.

To let the user view the result: tell them to **open the file in Figma Desktop** (`File → Open` or double-click the `.deck` file).

---

## Quick Reference

| Task | Approach |
|------|----------|
| Create a new deck from scratch | Use the high-level JS API (`lib/api.mjs`) |
| Edit text or images in an existing deck | Use MCP tools (`figmatk_update_text`, `figmatk_insert_image`) |
| Clone, remove, or restructure slides | Use MCP tools (`figmatk_clone_slide`, `figmatk_remove_slide`) |
| Inspect structure or read content | Use MCP tools (`figmatk_inspect`, `figmatk_list_text`) |

---

## Path A — Create from Scratch (High-Level API)

Use this when the user wants a new presentation. Write a Node.js script and execute it.

> **Import path:** `figmatk` is an npm package. Import from the installed package:
> ```javascript
> import { Deck } from 'figmatk';
> ```

```javascript
import { Deck } from 'figmatk';

const deck = await Deck.create('My Presentation');

const slide = deck.addBlankSlide();          // template blank slide auto-removed
slide.setBackground('Black');                // named color — see list below
slide.addText('Slide Title', {
  style: 'Title', color: 'White',
  x: 64, y: 80, width: 1792, align: 'LEFT'
});
slide.addText('Subtitle', {
  style: 'Body 1', color: 'Grey',
  x: 64, y: 240, width: 1200, align: 'LEFT'
});

await deck.save('/path/to/output.deck');
```

### ⚠️ Critical gotchas

| Issue | Wrong | Right |
|-------|-------|-------|
| `setBackground` with hex | `s.setBackground('#1A1A1A')` | `s.setBackground('Black')` |
| `setBackground` with raw RGB | `s.setBackground({ r:0.1, g:0.1, b:0.1 })` | `s.setBackground('Black')` — raw RGB silently renders white |
| Shape method signature | `s.addRectangle({ x:0, y:0, width:100 })` | `s.addRectangle(0, 0, 100, 100, opts)` |
| Shape fill color | `{ fill: '#F4900C' }` | `{ fill: hex('#F4900C') }` — use the hex() helper |
| `addLine` options | `{ strokeColor: ..., strokeWeight: 2 }` | `{ color: 'Black', weight: 2 }` |
| `align` value | `align: 'left'` | `align: 'LEFT'` (uppercase) |

### Hex color helper (for shape fills)

```javascript
function hex(h) {
  return { r: parseInt(h.slice(1,3),16)/255, g: parseInt(h.slice(3,5),16)/255, b: parseInt(h.slice(5,7),16)/255 };
}
// Usage: s.addRectangle(0, 0, 200, 50, { fill: hex('#F4900C') })
```

### Text styles

| Style | Size | Weight | Use for |
|-------|------|--------|---------|
| `Title` | 96pt | Bold | Slide title |
| `Header 1` | 60pt | Bold | Section headers |
| `Header 2` | 48pt | Bold | Sub-headers |
| `Header 3` | 36pt | Bold | In-slide headings |
| `Body 1` | 36pt | Regular | Primary body text |
| `Body 2` | 30pt | Regular | Secondary body text |
| `Body 3` | 24pt | Regular | Captions, labels |
| `Note` | 20pt | Regular | Footnotes, sources |

### Named colors for `setBackground()`

> **Case-sensitive.** `'Black'` works, `'black'` does not.

`'Black'`, `'White'`, `'Grey'`, `'Blue'`, `'Red'`, `'Yellow'`, `'Green'`, `'Orange'`, `'Pink'`, `'Purple'`, `'Teal'`, `'Violet'`, `'Persimmon'`, `'Pale Pink'`, `'Pale Blue'`, `'Pale Green'`, `'Pale Teal'`, `'Pale Purple'`, `'Pale Persimmon'`, `'Pale Violet'`, `'Pale Red'`, `'Pale Yellow'`

Use `'Black'` for dark backgrounds, `'White'` for light. For custom slide backgrounds, use the closest named color — **not hex**.

### Slide dimensions

1920 × 1080px. All positions and sizes in pixels.

### Slide methods (correct signatures)

```javascript
slide.setBackground(namedColor)                   // named color only — hex/raw RGB render white
slide.addText(text, opts)                         // opts: style, color (named or hex('#...')), x, y, width, align, bold, italic, fontSize
slide.addFrame(opts)                              // auto-layout: stackMode, spacing, x, y, width, height
slide.addRectangle(x, y, width, height, opts)    // opts: fill (named or {r,g,b}), opacity, cornerRadius
slide.addEllipse(x, y, width, height, opts)      // opts: fill, opacity
slide.addDiamond(x, y, width, height, opts)
slide.addTriangle(x, y, width, height, opts)
slide.addStar(x, y, width, height, opts)
slide.addLine(x1, y1, x2, y2, opts)             // opts: color, weight
slide.addImage(path, opts)                        // opts: x, y, width, height
slide.addTable(data, opts)                        // 2D string array; opts: x, y, width, colWidths, rowHeight
slide.addSVG(x, y, width, svgPathOrBuf, opts)
```

---

## Path B — Edit an Existing Deck (MCP Tools)

Use this when the user provides a `.deck` file to modify.

### Workflow

1. `figmatk_inspect` — understand the deck structure (node IDs, slide count, symbols)
2. `figmatk_list_text` — read current text and images per slide
3. `figmatk_list_overrides` — find the override keys for each symbol (what's editable)
4. `figmatk_update_text` — apply text changes
5. `figmatk_insert_image` — apply image changes
6. `figmatk_clone_slide` — duplicate a slide and populate it
7. `figmatk_remove_slide` — mark unwanted slides as REMOVED
8. Always write to a **new output path** — never overwrite the source

### MCP tool reference

| Tool | Purpose |
|------|---------|
| `figmatk_inspect` | Node hierarchy tree — structure, node IDs, slide count |
| `figmatk_list_text` | All text strings and image hashes per slide |
| `figmatk_list_overrides` | Editable override keys per symbol (component) |
| `figmatk_update_text` | Set text overrides on a slide instance |
| `figmatk_insert_image` | Set image fill override (handles SHA-1 hashing + thumbnail) |
| `figmatk_clone_slide` | Deep-clone a slide with new text and images |
| `figmatk_remove_slide` | Mark slides as REMOVED (never deleted) |
| `figmatk_roundtrip` | Decode + re-encode for pipeline validation |

---

## Design Philosophy

Every deck must look **intentionally designed**, not AI-generated.

### Colour

- Pick a bold palette for the **specific topic** — not a generic one.
- One dominant colour (60–70%) + 1–2 supporting tones + one sharp accent.
- Dark backgrounds on title/conclusion slides, light on content ("sandwich") — or fully dark for premium feel.

**Starter palettes** (use nearest named color for `setBackground`, hex helper for shapes):

| Theme | Background | Shape accent | Text |
|-------|-----------|-------------|------|
| Midnight | `'Black'` | `hex('#CADCFC')` | `'White'` |
| Forest | `'Green'` | `hex('#97BC62')` | `'White'` |
| Coral | `'Persimmon'` | `hex('#2F3C7E')` | `'White'` |
| Terracotta | `'Persimmon'` | `hex('#E7E8D1')` | `'White'` |
| Ocean | `'Blue'` | `hex('#21295C')` | `'White'` |
| Minimal | `'White'` | `hex('#36454F')` | `'Black'` |

### Layout

- Every slide needs at least **one visual element** — shape, image, SVG, or table.
- **Vary layouts** — never repeat the same structure slide after slide.
- Carry one visual motif through every slide (coloured accent bar, icon circles, etc.).

**Layout options:** two-column, icon+text rows, 2×2/2×3 grid, large stat callout, half-background image, timeline/steps.

### Typography

- Left-align body text. Centre only titles.
- Minimum 64px margin from slide edges. 24–48px between content blocks.

### Never do

- Repeat the same layout slide after slide
- Centre body text
- Use accent lines under slide titles (hallmark of AI-generated slides)
- Text-only slides
- Low-contrast text against background

---

## QA

1. Self-check: no placeholder text (`lorem ipsum`, `[title here]`) remains
2. Tell the user to open the `.deck` in Figma Desktop to catch rendering issues
3. Offer to fix anything they report

---

## Critical Format Rules

- Blank text must be `" "` (space), never `""` — empty string crashes Figma
- Image overrides need both a full-image hash and thumbnail hash (40-char hex SHA-1)
- Removed nodes: set `phase: 'REMOVED'`, never delete from `nodeChanges`
- Chunk 1 of `canvas.fig` must be zstd-compressed
- `thumbHash` must be `new Uint8Array(0)`, never `{}`
