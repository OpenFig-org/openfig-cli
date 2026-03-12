# figmatk Programmatic API — Specification

## Vision

A high-level JS API for reading and writing Figma Slides `.deck` files,
built on top of figmatk's existing `FigDeck` codec layer.
Analogous to python-pptx in scope and design philosophy.

See `docs/feature-map.md` for the full python-pptx → figmatk feature mapping
that drives this spec. See `docs/format/` for the `.deck` file format specification.

---

## Design Principles

1. **Slides-mode-first.** The primary consumer is an AI system building presentations.
   Default to high-level abstractions: named text styles (Title, Header 1-3, Body 1-3,
   Note), named colors from the palette, and template overrides. Raw Design-mode control
   (custom fonts, exact RGB, manual positioning) is available as optional overrides
   but not the primary interface.

2. **Validate before expanding.** The `.deck` format is partially reverse-engineered.
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
figmatk/
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
No format research needed; proven by existing figmatk commands.

Implemented in `lib/api.mjs` as `Deck`, `Slide`, `Symbol`, `TextNode`, `ImageNode`.

### 1.1 — Open / Save / Create / Meta ✅ Validated

```js
import { Deck } from 'figmatk'

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

## Phase 2 — Unknown Territory (Research & Validate) 🔬 In Progress

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

### 2.3 — Shape fill 🔬

```js
shape.fill.solid(255, 0, 0)       // solid RGB
shape.fill.none()                  // remove fill
shape.fill.opacity(0.5)            // fill opacity
```

**Investigate:** `fillPaints` array on shape nodes. Solid fill is simplest —
start there. Gradient after solid is confirmed.

---

### 2.4 — Shape stroke 🔬

```js
shape.stroke.color(0, 0, 0)
shape.stroke.weight(2)
shape.stroke.none()
```

**Investigate:** `strokePaints` + `strokeWeight` fields. Confirm each
independently.

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

### 2.7 — Slide dimensions 🔬

```js
deck.slideWidth    // read
deck.slideHeight   // read
```

**Investigate:** Where are slide dimensions stored? Likely on CANVAS or
SLIDE_GRID node. Start read-only — write is risky.

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
- `addText` — ✅ validated (named styles, custom fonts, colors, alignment)
- `addFrame` — ✅ validated (auto-layout vertical/horizontal)
- `addEllipse` — ❓ needs reference deck
- `addLine` — ❓ needs reference deck
- `addImage` (freestanding) — ✅ validated, ROUNDED_RECTANGLE with IMAGE fillPaint

---

### 2.9 — Picture fill on shapes 🔬

```js
shape.fill.image('texture.jpg')
```

**Investigate:** Different from image placeholder override — this is a
`fillPaints` entry with `type: 'IMAGE'` directly on the shape node,
not via `symbolOverrides`.

---

### 2.10 — Hyperlinks on text runs 🔬

```js
run.hyperlink = 'https://example.com'
```

**Investigate:** Figma has link nodes; format for text run hyperlinks unknown.

---

## Phase 3 — Richer Than pptx ⭐ Future

**Goal:** Features where Figma exceeds python-pptx. No pptx analogue —
these are figmatk-native capabilities. Each needs its own format investigation.

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
| Table placeholder | Unknown if Figma Slides supports tables at all — investigate in Phase 2 if needed |
| Notes slide | Unknown if equivalent exists |

---

## API Summary

```js
import { Deck } from 'figmatk'

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
slide.addEllipse(x, y, w, h)                              // ❓ not yet
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
