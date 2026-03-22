# openfig Programmatic API — Specification

## Vision

A high-level JS API for reading and writing Figma Slides `.deck` files,
built on top of openfig's existing `FigDeck` codec layer.
Analogous to python-pptx in scope and design philosophy.

See `docs/feature-map.md` for the full python-pptx → openfig feature mapping
that drives this spec. See `docs/format/` for the `.deck` file format specification.
Reusable template authoring and module-backed template instantiation are documented separately in [mcp.md](mcp.md) and [template-workflows.md](template-workflows.md); this page focuses on the higher-level `Deck` / `Slide` editing API.

---

## Design Principles

1. **Slides-mode-first.** The primary consumer is an AI system building presentations.
   Default to high-level abstractions: named text styles (Title, Header 1-3, Body 1-3,
   Note), named colors from the palette, and template overrides. Raw Design-mode control
   (custom fonts, exact RGB, manual positioning) is available as optional overrides
   but not the primary interface.

2. **Validate before expanding.** Not all `.deck` format fields are fully documented.
   Don't assume a field works in Figma until a roundtrip test confirms it.

3. **Fail loudly on unknowns.** Unvalidated operations throw `NotImplementedError`
   with a clear message. No silent no-ops.

4. **One validation gate per feature.** Test a feature in isolation, confirm it
   survives a Figma close/reopen cycle, then ship it. Don't over-test.

5. **Phases map to confidence, not complexity.** Phase 1 = known-good. Phase 2 =
   needs investigation. Phase 3 = Figma-richer-than-pptx territory.

---

## Architecture

```
openfig/
├── lib/
│   ├── fig-deck.mjs        # codec layer (FigDeck)
│   ├── node-helpers.mjs    # nid, parseId, ov, positionChar, etc.
│   ├── image-helpers.mjs   # imageOv, hexToHash, hashToHex
│   ├── image-utils.mjs     # sharp-based getImageDimensions, generateThumbnail
│   ├── deep-clone.mjs      # typed-array-safe deepClone
│   ├── api.mjs             # Deck, Slide, Symbol, TextNode, ImageNode, FrameProxy
│   └── blank-template.deck # bundled blank deck for Deck.create()
├── docs/format/            # .deck file format specification
└── commands/               # CLI commands (unchanged)
```

The API layer (`api.mjs`) is a pure wrapper — it adds no new codec logic,
only a clean object model on top of `FigDeck`.

---

## Phase 0 — Foundation ✅ Implemented

Codec pipeline, ZIP handling, roundtrip. Implemented in `lib/fig-deck.mjs`.

**Exit criterion:** Any `.deck` file can be opened, left unchanged, saved,
and reopened in Figma without corruption.

---

## Phase 1 — Direct Features ✅ Implemented

**Goal:** All ✅ Direct features from the feature map — 1:1 equivalents of
python-pptx where the format is already understood.
No format research needed; proven by existing openfig commands.

Implemented in `lib/api.mjs` as `Deck`, `Slide`, `Symbol`, `TextNode`, `ImageNode`.

### 1.1 — Open / Save / Create / Meta ✅ Validated

```js
import { Deck } from 'openfig'

// Open existing
const deck = await Deck.open('slides.deck')

// Create from scratch (includes Light Slides theme, 8 text styles, 23 colors)
const deck = await Deck.create({ name: 'My Presentation' })

deck.meta.file_name     // str
deck.meta.version       // str

await deck.save()               // overwrite source
await deck.save('output.deck')  // new path
```

### 1.2 — Slides

```js
deck.slides              // Slide[], ordered, non-REMOVED only
deck.symbols             // Symbol[], all available templates

const slide = deck.slides[0]
slide.name               // str
slide.index              // int (0-based)
slide.guid               // str "sessionID:localID"
```

### 1.3 — Symbol slots (template introspection)

```js
const sym = deck.symbols[0]
sym.name                 // str
sym.textSlots            // [{ name, key }]
sym.imageSlots           // [{ name, key }]
```

### 1.4 — Read text & image content

```js
slide.textNodes          // TextNode[]
textNode.name            // str (node name in Figma)
textNode.key             // str "sessionID:localID"
textNode.characters      // str (override value if set, else symbol default)

slide.imageNodes         // ImageNode[]
imageNode.name           // str
imageNode.key            // str
imageNode.hashHex        // str (40-char SHA-1) or null
```

### 1.5 — Set text (via symbolOverrides)

```js
slide.setText('Title', 'Hello World')       // by node name
slide.setText('57:48', 'Hello World')       // by override key
slide.setTexts({ Title: 'A', Body: 'B' })   // batch
```

Rules enforced:
- `''` replaced with `' '` — empty string crashes Figma
- Only `characters` written to `textData` — no `lines` array

### 1.6 — Set image (via symbolOverrides)

```js
slide.setImage('Photo', 'hero.jpg')         // by node name
slide.setImage('75:126', 'hero.jpg')        // by override key
slide.setImage('Photo', buffer)             // Buffer also accepted
```

Handled automatically:
- SHA-1 hash of full image
- Thumbnail generation (~320px via `sharp`)
- Both written to `images/` dir in ZIP
- `styleIdForFill` sentinel `0xFFFFFFFF:0xFFFFFFFF` always set
- `thumbHash: new Uint8Array(0)` always set
- `imageScaleMode` defaults to `FILL`

### 1.7 — Slide management

```js
// Add from template — clones a symbol as a new slide
const slide = deck.addSlide(sym)
const slide = deck.addSlide(sym, { after: deck.slides[2] })
const slide = deck.addSlide(sym, { name: 'My Slide' })

// Add blank — no template, build from scratch             ✅ Validated
const slide = deck.addBlankSlide()
const slide = deck.addBlankSlide({ name: 'Custom', background: 'Blue' })

// Remove — sets phase REMOVED, never filters nodeChanges
deck.removeSlide(slide)

// Reorder
deck.moveSlide(slide, 0)      // move to front
```

**Exit criterion for Phase 1:** All operations above work across ≥3 different
`.deck` fixtures. Inventory reads are stable. Text + image roundtrips verified
in Figma.

> **Status:** Code complete. Core operations validated in Figma.

---

## Phase 2 — Unknown Territory (Research & Validate) ✅ Complete

**Goal:** Investigate the 🔬 Unknown features from the feature map.
Each item is a mini research task: write a test, confirm in Figma, then ship.

**Rule:** Each sub-phase is independent. A failure in 2.3 does not block 2.4.
Document failures explicitly — a known-broken feature is better than a silent one.

**Validation method for all Phase 2 items:**
1. Write the minimal possible test (one property, one shape, one slide)
2. Save and open in Figma
3. Confirm the value took effect
4. Confirm a close/reopen cycle preserves it
5. Only then add to API surface

---

### 2.1 — Shape geometry (read + write) ✅ Validated

```js
slide.shapes                     // Shape[] — all direct children
const shape = slide.shapes[0]

shape.x                          // read — transform.m02
shape.y                          // transform.m12
shape.width                      // size.x
shape.height                     // size.y
shape.rotation                   // degrees (from transform matrix)

shape.x = 100                    // write
shape.width = 500
shape.rotation = 45
```

---

### 2.2 — Shape visibility + opacity ✅ Validated

```js
shape.visible = false            // hides node
shape.opacity = 0.5              // 50% transparent
shape.name = 'New Name'          // rename
```

---

### 2.3 — Shape fill ✅ Validated

```js
shape.fill                                    // read: { r, g, b, a } or null
shape.setFill({ r: 1, g: 0, b: 0 })         // solid RGB
shape.setFill({ r: 0.5, g: 0, b: 0.8 }, { opacity: 0.5 })  // with opacity
shape.removeFill()                            // transparent
```

---

### 2.4 — Shape stroke ✅ Validated

```js
shape.stroke                                  // read: { r, g, b, a, weight } or null
shape.setStroke({ r: 0, g: 0, b: 1 }, { weight: 8 })  // solid, 8px
shape.setStroke({ r: 1, g: 0, b: 0 }, { weight: 4, align: 'OUTSIDE' })
shape.removeStroke()
```

---

### 2.5 — Text creation & formatting ✅ Validated (basic) / 🔬 (advanced)

**Implemented and validated in Figma:**

```js
// Named text styles (Slides-mode-first)
slide.addText('Hello World', { style: 'Title' })                    // ✅
slide.addText('Body copy', { style: 'Body 1' })                     // ✅
slide.addText('Centered', { style: 'Header 2', align: 'CENTER' })   // ✅

// Custom font (detaches from named style)
slide.addText('Custom', { font: 'Georgia', fontStyle: 'Bold', fontSize: 48 })  // ✅

// Colors
slide.addText('Colored', { style: 'Title', color: { r: 1, g: 0, b: 0 } })     // ✅

// Auto-layout frame with text children
const frame = slide.addFrame(128, 400, 1200, 200, { spacing: 24 })              // ✅
frame.addText('Title', { style: 'Title' })                                       // ✅
frame.addText('Body', { style: 'Body 1' })                                       // ✅
```

Available named styles: Title, Header 1, Header 2, Header 3, Body 1, Body 2, Body 3, Note.

**Validated (advanced):**
- Per-run formatting ✅ — bold, italic, bold+italic via `styleOverrideTable` + `characterStyleIDs`
- Text decoration ✅ — underline (`textDecoration: 'UNDERLINE'`), strikethrough (`textDecoration: 'STRIKETHROUGH'`)
- Hyperlinks ✅ — `hyperlink: { url }` on style override entry

```js
slide.addText([
  { text: 'Normal ' },
  { text: 'bold', bold: true },
  { text: ' and ' },
  { text: 'italic', italic: true },
  { text: ' with ' },
  { text: 'a link', hyperlink: 'https://example.com' },
], { style: 'Body 1' })
```

**Validated (lists):**
- Bullet lists ✅ — `list: 'bullet'` or per-run `{ bullet: true }`
- Numbered lists ✅ — `list: 'number'` or per-run `{ number: true }`
- Nested lists ✅ — `indent: 2` for sub-items (auto a/b/c numbering at level 2)

```js
slide.addText('One\nTwo\nThree\n', { style: 'Body 1', list: 'bullet' })

slide.addText([
  { text: 'Heading\n' },
  { text: 'Item\n', bullet: true },
  { text: 'Sub-item\n', bullet: true, indent: 2 },
], { style: 'Body 1' })
```

**Still unknown:**
- Paragraph-level spacing and indentation

---

### 2.6 — Slide background ✅ Validated

```js
slide.setBackground('Blue')                    // named color
slide.setBackground({ r: 0.1, g: 0.1, b: 0.3 })  // raw RGB
slide.setBackground('Red', { opacity: 0.5 })  // with opacity
slide.background                               // read: { r, g, b, a }
```

Named colors resolve from the Light Slides VARIABLE nodes.
Image backgrounds not yet investigated.

---

### 2.7 — Slide dimensions ✅ Validated

```js
deck.slideWidth    // read — 1920
deck.slideHeight   // read — 1080
```

Read-only. Derived from the first SLIDE node's `size` field.

---

### 2.8 — Shape creation 🔬

Each shape type is its own investigation. Do not combine until each is
individually confirmed.

```js
// Preferred — named styles and colors
slide.addText('Hello', { style: 'Title' })                      // ✅ format learned
slide.addText('Body', { style: 'Body 1', color: 'Blue' })       // named color
slide.addRectangle(x, y, width, height, { fill: 'Red' })        // ✅ validated
slide.addEllipse(x, y, width, height, { fill: 'Teal' })
slide.addFrame(x, y, width, height)                              // ✅ format learned
slide.addLine(x1, y1, x2, y2)
slide.addImage(x, y, width, height, 'image.jpg')                // freestanding, not override

// Raw overrides still available
slide.addRectangle(x, y, w, h, { fill: { r: 0.5, g: 0, b: 0 } })
```

**Status:**
- `addRectangle` — ✅ validated, ROUNDED_RECTANGLE node
- `addText` — ✅ validated (named styles, custom fonts, colors, alignment, runs, lists)
- `addFrame` — ✅ validated (auto-layout vertical/horizontal)
- `addEllipse` — ✅ validated, SHAPE_WITH_TEXT with ELLIPSE type
- `addDiamond` — ✅ validated, SHAPE_WITH_TEXT with DIAMOND type
- `addTriangle` — ✅ validated, SHAPE_WITH_TEXT with TRIANGLE_UP type
- `addStar` — ✅ validated, SHAPE_WITH_TEXT with STAR type
- `addLine` — ✅ validated, LINE node with point-to-point transform
- `addImage` (freestanding) — ✅ validated, ROUNDED_RECTANGLE with IMAGE fillPaint

---

### 2.9 — Picture fill on shapes ✅ Validated

```js
const shape = slide.shapes.find(s => s.name === 'MyRect');
await shape.setImageFill('texture.jpg');
await shape.setImageFill(buffer, { scaleMode: 'FIT' });
```

Works on both ROUNDED_RECTANGLE (top-level fillPaints) and
SHAPE_WITH_TEXT (nodeGenerationData.overrides[0].fillPaints).

---

### 2.10 — Hyperlinks on text runs ✅ Validated

```js
slide.addText([
  { text: 'Click ', },
  { text: 'here', hyperlink: 'https://example.com' },
], { style: 'Body 1' })
```

Per-run `hyperlink` field on style override entry.

---

### 2.11 — Tables ✅ Validated

```js
slide.addTable(x, y, [
  ['Name', 'Role', 'Status'],
  ['Alice', 'Engineer', 'Active'],
  ['Bob', 'Designer', 'On Leave'],
], { name: 'Team', colWidth: 192, rowHeight: 44, cornerRadius: 12 })
```

TABLE node with no children. Cell data stored in `nodeGenerationData.overrides`:
- `40000000:0 > rowID > colID` — per-cell background fill (optional)
- `40000000:1 > rowID > colID` — per-cell text content
- `40000000:2` — default cell style (fill, stroke, font settings)
- `40000000:3` — default text style

Row/column structure via `tableRowPositions`, `tableColumnPositions`,
`tableRowHeights`, `tableColumnWidths` on the TABLE node.

---

### 2.12 — SVG Import ✅ Validated

```js
slide.addSVG(x, y, width, '/path/to/graphic.svg', {
  fill: { r: 0.6, g: 0.9, b: 0.6 },
  name: 'Logo',
})
```

Imports SVG `<path>` elements as a FRAME + VECTOR node pair. Supports
M, L, H, V, C, S, Z commands (absolute and relative). The SVG path data
is encoded into two blob types:

- **fillGeometry commandsBlob** — path commands scaled to node size.
  Format: `01`=moveTo(x,y) `02`=lineTo(x,y) `04`=cubicTo(6 floats) `00`=close.
- **vectorNetworkBlob** — editable vector network in SVG coordinate space.
  Format: header(4×u32: vtxCount, segCount, regionCount, styleCount),
  vertices(x·f32, y·f32, mirror·u32), segments(28B: start·u32, tsx·f32, tsy·f32,
  end·u32, tex·f32, tey·f32, type·u32), regions(numLoops, {segCount, indices[]},
  windingRule per region).

Height is calculated proportionally from the SVG viewBox aspect ratio.

---

## Phase 3 — Richer Than pptx ⭐ Future

**Goal:** Features where Figma exceeds python-pptx. No pptx analogue —
these are openfig-native capabilities. Each needs its own format investigation.

These are unscheduled. Each becomes its own mini-spec when prioritised.

| Feature | API sketch | Notes |
|---------|-----------|-------|
| Component variants | `deck.componentSets` | `COMPONENT_SET` nodes — multiple layout variants |
| Design variables / tokens | `deck.variables.get(name)` | `VARIABLE_SET` + `VARIABLE` nodes |
| Auto-layout frames | `frame.autoLayout = {...}` | Figma layout engine — far beyond pptx text columns |
| Prototype interactions | `slide.interactions` | `prototypeInteractions` on nodes |
| Slide grid structure | `deck.grid` | `SLIDE_GRID` + `SLIDE_ROW` — multi-row decks |
| Multi-page decks | `deck.pages` | Multiple CANVAS nodes |
| Symbol definition editing | `sym.editSlot(name, ...)` | Modify the master, not just instances |

---

## Explicitly Out of Scope

From the feature map — these have no Figma Slides equivalent:

| python-pptx feature | Reason skipped |
|---------------------|---------------|
| Charts | No native chart nodes in Figma Slides |
| OLE objects | No embedded document concept |
| SmartArt | No equivalent |
| Table placeholder | Tables exist as TABLE nodes; no placeholder equivalent — use `addTable()` directly |
| Notes slide | Unknown if equivalent exists |

---

## API Summary

```js
import { Deck } from 'openfig'

// Create / open / save
const deck = await Deck.create({ name: 'My Deck' })     // ✅ from scratch
const deck = await Deck.open('slides.deck')               // ✅ existing file
await deck.save('output.deck')                             // ✅

// Meta
deck.meta.file_name
deck.meta.version

// Slides + symbols
deck.slides                                                // ✅ Slide[]
deck.symbols                                               // ✅ Symbol[]

// Slide properties
slide.name                                                 // ✅
slide.index                                                // ✅
slide.guid                                                 // ✅
slide.setBackground('Blue')                                // ✅ named or RGB
slide.background                                           // ✅ read { r, g, b, a }

// Template overrides (symbol instances)
slide.setText('Title', 'Hello')                            // ✅
slide.setTexts({ Title: 'A', Body: 'B' })                 // ✅
slide.setImage('Photo', 'hero.jpg')                        // ✅
slide.textNodes                                            // ✅ TextNode[]
slide.imageNodes                                           // ✅ ImageNode[]

// Direct creation (freestanding nodes on slide)
slide.addText('Hello', { style: 'Title', color: { r: 1, g: 1, b: 1 } })  // ✅
slide.addText('Custom', { font: 'Georgia', fontSize: 48 })                // ✅
slide.addRectangle(x, y, w, h, { fill: { r: 1, g: 0, b: 0 } })          // ✅
slide.addFrame(x, y, w, h, { direction: 'VERTICAL', spacing: 24 })       // ✅
slide.addEllipse(x, y, w, h)                              // ✅
slide.addDiamond(x, y, w, h)                              // ✅
slide.addTriangle(x, y, w, h)                             // ✅
slide.addStar(x, y, w, h)                                 // ✅
slide.addLine(x1, y1, x2, y2)                             // ✅
slide.addTable(x, y, data, { colWidth, rowHeight })        // ✅
slide.addSVG(x, y, w, 'graphic.svg', { fill })             // ✅
await slide.addImage(x, y, w, h, 'photo.jpg')              // ✅

// Slide management
deck.addSlide(sym, { after: slide, name: 'New' })         // ✅
deck.addBlankSlide({ name: 'Custom', background: 'Blue' })// ✅
deck.removeSlide(slide)                                    // ✅
deck.moveSlide(slide, 0)                                   // ✅
```

---

## Known Unknowns

| Area | Risk | Mitigation |
|------|------|------------|
| kiwi field coverage | Fields may be silently dropped on encode | Roundtrip-test every phase |
| SYMBOL structure variability | Cloning may break for some templates | Test with ≥5 different `.deck` fixtures |
| Text formatting via overrides vs direct | Two paths may behave differently | Test both independently in Phase 2.5 |
| Position string ordering at scale | ASCII char ordering has a ceiling | Test with 20+ slides |
| Multi-page decks | Spec assumes single CANVAS | Detect and throw on open |
