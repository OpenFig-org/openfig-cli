---
name: figma-slides-creator
description: >
  Create, populate, edit, and inspect Figma Slides .deck files. Use when the
  user wants a finished presentation deck, wants to fill an existing template
  with content, or wants to edit a non-template deck's text, images, or slide
  order. Do not use this skill to author reusable templates themselves.
  Powered by FigmaTK under the hood.
metadata:
  version: "0.3.0"
---

# Figma Slides Creator

Use this skill for the default workflow: take an existing template and build a new presentation from it. For authoring reusable templates themselves, use `skills/figma-template-builder/SKILL.md`.

## Skill Boundary

Use this skill when the outcome is a finished deck for immediate use.

Switch to `skills/figma-template-builder/SKILL.md` when the user wants to:

- build a reusable template
- define layouts or placeholders
- rename slots for future sessions
- derive a new template system from references or examples

## ⚠️ Never open .deck files directly

`.deck` files are binary ZIP archives. **Never open, read, or display a `.deck` file** — it will show garbage bytes in the panel. To inspect or modify a `.deck` file, always use the CLI commands or Node.js API shown below.

To let the user view the result: tell them to **open the file in Figma Desktop** (`File → Open` or double-click the `.deck` file).

---

## Quick Reference

| Task | Approach |
|------|----------|
| Create from scratch | **Path A** — `figmatk_create_deck` MCP tool |
| Create from a `.deck` template | **Path B** — `figmatk_list_template_layouts` + `figmatk_create_from_template` |
| Author a reusable template | Use `skills/figma-template-builder/SKILL.md` |
| Edit text or images in an existing deck | `figmatk_update_text`, `figmatk_insert_image` |
| Clone, remove, or restructure slides | `figmatk_clone_slide`, `figmatk_remove_slide` |
| Inspect structure or read content | `figmatk_inspect`, `figmatk_list_text` |

---

## File locations — always use /tmp

**All files go in `/tmp/`** — scripts, output decks, images, everything. Never write to the Desktop, Documents, Downloads, or any user directory. Never create intermediate notes or reference markdown files. Just build and save the deck.

## Default Workflow

1. Inspect the template or deck.
2. Pick the minimum set of layouts or edits needed.
3. Populate text slots first, then image slots.
4. Save to a new `/tmp/` output path.
5. Sanity-check the result with `figmatk_list_text` or by opening it in Figma Desktop.

---

## Path B — Create from a Template (preferred when user provides a .deck file)

Use this path when the user provides a `.deck` template file. The output deck inherits all fonts, colors, spacing, and visual design from the template verbatim.

### Step 1 — Inspect the template

```
figmatk_list_template_layouts("/path/to/template.deck")
```

Returns a catalog of all available slide layouts. Each entry includes:
- `slideId` — the ID to reference this layout
- Layout state — `draft` or `published`
- Text slots — explicit `slot:text:*` fields when present, otherwise fallback text candidates
- Image slots — explicit `slot:image:*` fields when present, otherwise fallback image candidates
- Node IDs — usable for direct targeting when the template has not been fully annotated yet

**Read the catalog carefully before picking layouts:**
- Prefer layouts with explicit slot metadata when available
- Match each slide's purpose to your content; the existing copy is often the best hint
- Use slot names first, then node IDs, then raw node names when populating content
- If a layout exposes no explicit image slots, treat heuristic image candidates as weaker signals and avoid overwriting decorative sample imagery unless the user clearly wants that

### Step 2 — Create the deck

```
figmatk_create_from_template({
  template: "/path/to/template.deck",
  output: "/tmp/my-deck.deck",
  slides: [
    { slideId: "1:74",  text: { "title": "My Company" } },
    { slideId: "1:112", text: { "header": "The problem.", "body": "Description here." }, images: { "hero_image": "/tmp/problem-photo.jpg" } },
    { slideId: "1:643", text: { "title": "Thank you!" } }
  ]
})
```

Only pass slots or node IDs that exist in the layout's catalog. Extra keys are silently ignored.

---

## Path A — Create from Scratch (MCP tool — no template)

**Always use this path.** No npm install, no scripts, no workspace setup.

Call `figmatk_create_deck` with a structured slide description:

```json
{
  "output": "/tmp/my-deck.deck",
  "title": "My Presentation",
  "theme": "midnight",
  "slides": [
    { "type": "title",   "title": "My Presentation", "subtitle": "A subtitle" },
    { "type": "bullets", "title": "Key Points", "bullets": ["Point one", "Point two", "Point three"] },
    { "type": "two-column", "title": "Comparison", "leftText": "Left side content", "rightText": "Right side content" },
    { "type": "stat",    "title": "By the numbers", "stat": "42%", "caption": "of users prefer this" },
    { "type": "image-full", "image": "/tmp/photo.jpg", "title": "Caption text" },
    { "type": "closing", "title": "Thank you", "subtitle": "Questions?" }
  ]
}
```

### Slide types

| Type | Fields |
|------|--------|
| `title` | `title`, `subtitle` |
| `bullets` | `title`, `bullets` (array) |
| `two-column` | `title`, `leftText`, `rightText`, `image` (right side) |
| `stat` | `title`, `stat` (big number), `caption` |
| `image-full` | `image` (path), `title`, `body` (overlay text) |
| `closing` | `title`, `subtitle` |

### Themes

`midnight` · `ocean` · `forest` · `coral` · `terracotta` · `minimal`

Each theme handles backgrounds, accent colors, and text colors automatically.

---

## Path A2 — Create from Scratch (Node.js script fallback)

Only use this if `figmatk_create_deck` is unavailable or you need layout control beyond what the MCP tool offers.

### Step 1 — Set up workspace (MANDATORY — never skip)

```bash
[ -d /tmp/figmatk-ws/node_modules ] || (mkdir -p /tmp/figmatk-ws && cd /tmp/figmatk-ws && npm init -y && npm install figmatk)
```

### Step 2 — Write script to `/tmp/figmatk-ws/deck.mjs`

**Always use bare specifier** `import { Deck } from 'figmatk'` — never a file path.

```javascript
import { Deck } from 'figmatk';

function hex(h) {
  return { r: parseInt(h.slice(1,3),16)/255, g: parseInt(h.slice(3,5),16)/255, b: parseInt(h.slice(5,7),16)/255 };
}

const deck = await Deck.create('My Presentation');
const slide = deck.addBlankSlide();
slide.setBackground('Black');
slide.addText('Slide Title', { style: 'Title', color: 'White', x: 64, y: 80, width: 1792, align: 'LEFT' });
await deck.save('/tmp/my-presentation.deck');
console.log('Done');
```

### Step 3 — Run

```bash
node /tmp/figmatk-ws/deck.mjs
```

### ⚠️ Critical gotchas

| Issue | Wrong | Right |
|-------|-------|-------|
| `setBackground` with hex | `s.setBackground('#1A1A1A')` | `s.setBackground('Black')` |
| `setBackground` with raw RGB | `s.setBackground({ r:0.1, g:0.1, b:0.1 })` | `s.setBackground('Black')` — raw RGB silently renders white |
| Shape method signature | `s.addRectangle({ x:0, y:0, width:100 })` | `s.addRectangle(0, 0, 100, 100, opts)` |
| Shape fill color | `{ fill: { r:1, g:0, b:0 } }` | `{ fill: '#F4900C' }` or `{ fill: 'Red' }` — hex strings and named colors work directly |
| `addLine` options | `{ strokeColor: ..., strokeWeight: 2 }` | `{ color: 'Black', weight: 2 }` |
| `align` value | `align: 'left'` | `align: 'LEFT'` (uppercase) |
| `addImage` without await | `slide.addImage('/tmp/photo.jpg')` | `await slide.addImage('/tmp/photo.jpg')` — async, images silently missing without await |
| `addImage` old signature | `await slide.addImage(x, y, w, h, path)` | `await slide.addImage(path, { x, y, width, height })` — path is first arg now |

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

### Colors for `setBackground()`

Accepts named colors, hex strings, or designer aliases — **when using figmatk 0.0.12+ from the workspace install**.

**Named colors** (case-sensitive, from the Light Slides theme):

`'Black'`, `'White'`, `'Grey'`, `'Blue'`, `'Red'`, `'Yellow'`, `'Green'`, `'Orange'`, `'Pink'`, `'Purple'`, `'Teal'`, `'Violet'`, `'Persimmon'`, `'Pale Pink'`, `'Pale Blue'`, `'Pale Green'`, `'Pale Teal'`, `'Pale Purple'`, `'Pale Persimmon'`, `'Pale Violet'`, `'Pale Red'`, `'Pale Yellow'`

**Hex strings** (0.0.12+): `slide.setBackground('#C8102E')`

**Designer aliases** (0.0.12+): `slide.setBackground('navy')`, `slide.setBackground('coral')`, `slide.setBackground('terracotta')` etc.

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
await slide.addImage(pathOrBuf, opts)    // ⚠️ ASYNC — must use await; opts: x, y, width, height (default: full slide 1920×1080), cornerRadius, opacity
slide.addTable(x, y, data, opts)                  // 2D string array; opts: width, colWidths, rowHeight
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
| `figmatk_create_deck` | **Create a new deck from scratch** — no npm install needed |
| `figmatk_inspect` | Node hierarchy tree — structure, node IDs, slide count |
| `figmatk_list_text` | All text strings and image hashes per slide |
| `figmatk_list_overrides` | Editable override keys per symbol (component) |
| `figmatk_update_text` | Set text overrides on a slide instance |
| `figmatk_insert_image` | Set image fill override (handles SHA-1 hashing + thumbnail) |
| `figmatk_clone_slide` | Deep-clone a slide with new text and images |
| `figmatk_remove_slide` | Mark slides as REMOVED (never deleted) |
| `figmatk_roundtrip` | Decode + re-encode for pipeline validation |

## Final Checks

Before finishing, prefer at least one of these:

- `figmatk_list_text` on the output deck
- `figmatk_roundtrip` if the deck went through multiple edits
- a manual open check in Figma Desktop when the user is validating upload/render behavior

---

## Design Philosophy

Think like a **professional PowerPoint designer**, not an AI generating slides. Every deck must feel like it was made by a human who spent a day on it.

### Deck structure — use this template every time

A proper deck has a clear spine. Follow this slide order:

| # | Slide type | Purpose |
|---|-----------|---------|
| 1 | **Title** | Dark bg, big title, subtitle, presenter name |
| 2 | **Agenda / Overview** | 3–5 bullet topics, light bg |
| 3–N | **Content slides** | Vary layout each slide — see below |
| N+1 | **Section divider** (optional) | Bold colour block to signal a new chapter |
| Last | **Closing / CTA** | Dark bg mirrors title slide — "Thank you", next steps, contact |

The title and closing slides must use the **same dark background** — this creates the "sandwich" effect that makes decks feel complete.

### Consistent visual motif — pick one and use it on every slide

Choose one repeating element and place it consistently across all content slides:

- **Top accent bar**: `addRectangle(0, 0, 1920, 8, { fill: hex('#...') })` — full-width coloured strip at top
- **Left colour panel**: tall rectangle on the left third, text floats right
- **Corner badge**: small filled circle or square in bottom-right with slide number or logo
- **Bottom rule**: thin full-width line at y=1040

Without a motif, slides look unrelated. With one, the deck feels designed.

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

### Layout — vary every slide

Each content slide should use a **different layout type**. Never repeat the same structure back-to-back.

| Layout | When to use |
|--------|------------|
| Two-column | Comparison, pros/cons, text + image |
| 2×2 or 2×3 grid | Features, icons, categories |
| Large stat callout | One big number + explanation |
| Half-background image | Photo-rich slides |
| Timeline / steps | Process, history, roadmap |
| Icon + text rows | Lists that need visual weight |
| Full-bleed image | Impact moment, section break |

Every slide needs at least **one visual element** — shape, image, SVG, or table. No text-only slides.

### Typography

- Left-align body text. Centre only titles on title/closing slides.
- Minimum 64px margin from slide edges. 24–48px between content blocks.
- Use `Header 2` or `Header 3` for slide titles on content slides (not `Title` — that's for the title slide only).
- **Body text: max 2 sentences per text block.** Text boxes have fixed heights — overflow gets clipped. If you have more to say, use a bullet list or split across slides.
- **Bullets: max 6 items, max 8 words per bullet.** Longer bullets wrap and push content off-slide.

### Never do

- Repeat the same layout slide after slide
- Centre body text
- Use accent lines under slide titles (hallmark of AI-generated slides)
- Text-only slides
- Low-contrast text against background — **match image tone to slide palette**: dark/moody images on light-background slides make text unreadable; pick a bright image or switch to a dark-background layout
- Skip the closing slide — it makes the deck feel unfinished
- Put long paragraphs in body/caption fields — text overflows the container

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
