# python-figma-deck — Open Specification

## Vision

A Python library for programmatic read/write of Figma Slides `.deck` files,
analogous to `python-pptx` for `.pptx` files. Full round-trip fidelity. Clean,
Pythonic API.

---

## Design Principles

1. **Validate before expanding.** The `.deck` format is partially reverse-engineered.
   Don't assume a field works in Figma until a roundtrip test proves it. Each phase
   has an explicit exit criterion before the next begins.

2. **Roundtrip safety first.** Every write operation must be tested by opening the
   output in Figma. Silent failures (images that don't render, text that reverts) are
   worse than loud errors.

3. **Fail loudly on unknowns.** Operations touching unvalidated format territory raise
   `NotImplementedError` or emit a clear warning. No silent no-ops.

4. **Ship useful early.** Phases 0–3 cover the most common real-world use cases
   (read content, set text, set images). Phase 4+ is progressive enhancement.

5. **Don't over-test.** Each phase needs one clear validation gate, not exhaustive
   coverage. Move on when the core behavior is confirmed.

---

## Architecture

```
python-figma-deck/
├── bridge/
│   └── codec.js          # Node.js: decode/encode canvas.fig ↔ JSON (thin wrapper around openfig logic)
├── figma_deck/
│   ├── _codec.py         # Subprocess bridge: call codec.js, marshal JSON
│   ├── _io.py            # ZIP read/write, images/ dir management
│   ├── deck.py           # Deck class
│   ├── slide.py          # Slide class
│   ├── shapes.py         # TextNode, ImageNode, Shape, etc.
│   └── symbols.py        # Symbol / template resolution
└── tests/
    └── fixtures/         # Real .deck files for roundtrip validation
```

**Runtime dependencies:**
- `zstandard` — zstd compression (chunk 1 write)
- `Pillow` — thumbnail generation for image writes
- Node.js 18+ — codec bridge (kiwi encode/decode; no Python kiwi impl exists)

**Python 3.10+**

---

## Phases

---

### Phase 0 — Foundation

**Goal:** Prove the full pipeline works end-to-end before building any API.

**Deliverables:**
- `codec.js` bridge: accepts a `.deck` path, outputs decoded JSON to stdout; accepts
  JSON + output path, writes encoded `.deck`
- `_codec.py`: subprocess wrapper (encode/decode)
- `_io.py`: ZIP unpack/repack (`canvas.fig`, `thumbnail.png`, `meta.json`, `images/`)
- `Deck._load()` / `Deck._save()` internal methods
- Roundtrip smoke test: open → no changes → save → open in Figma

**Exit criterion:** 3 structurally different `.deck` files roundtrip without any
corruption or Figma import error.

**Risks:**
- codec.js must preserve the original kiwi schema (chunk 0) verbatim — never regenerate
- Chunk 2+ must pass through untouched
- ZIP must use store mode (uncompressed), matching Figma's output

---

### Phase 1 — Read API

**Goal:** Introspect any `.deck` file from Python. Read-only — no writes.

**Deliverables:**
```python
deck = Deck.open("slides.deck")

deck.meta.file_name          # str
deck.meta.version            # str

deck.slides                  # list[Slide], ordered
deck.symbols                 # list[Symbol] — available templates/layouts

slide = deck.slides[0]
slide.name                   # str
slide.index                  # int
slide.guid                   # str "sessionID:localID"

slide.text_nodes             # list[TextNode]
text_node.characters         # str
text_node.override_key       # dict {sessionID, localID}
text_node.name               # str (node name in Figma)

slide.image_nodes            # list[ImageNode]
image_node.hash_hex          # str (40-char SHA-1)
image_node.override_key      # dict

deck.raw_nodes               # escape hatch: full nodeChanges array
```

**Exit criterion:** Can print a complete content inventory (all text + image hashes)
of any `.deck` file. Inventory is stable across repeated opens of the same file.

---

### Phase 2 — Text Write

**Goal:** Modify text content via `symbolOverrides`. This path is the most validated
in the codebase — openfig already does it reliably.

**Deliverables:**
```python
slide.set_text("title", "Hello World")
slide.set_text("body", "Content here")

# Batch
slide.set_texts({"title": "A", "body": "B"})
```

**Rules enforced:**
- Empty string `""` rejected — use `" "` instead (Figma crash)
- `textData` contains only `characters` — no `lines` array
- Nested overrides (`guidPath.guids` with multiple entries) supported

**Exit criterion:** Set text on every text placeholder type found across the test
fixture `.deck` files. Verify correct render in Figma for each.

---

### Phase 3 — Image Write

**Goal:** Replace image fills on placeholder nodes. Also well-validated by openfig.

**Deliverables:**
```python
slide.set_image("photo", "hero.jpg")
slide.set_image("photo", image_bytes)     # also accepts bytes
```

**Internals handled automatically:**
- SHA-1 hash of full image
- Thumbnail generation (~320px wide PNG via Pillow)
- SHA-1 hash of thumbnail
- Both files written to `images/` dir in ZIP
- `styleIdForFill` sentinel (`0xFFFFFFFF:0xFFFFFFFF`) always included
- `thumbHash` set to `Uint8Array(0)` (not `{}`)
- `imageScaleMode` defaults to `FILL`

**Exit criterion:** Set images on all known image placeholder types across fixtures.
Verify images render (not blank) in Figma. Test both JPEG and PNG inputs.

---

### Phase 4 — Slide Management

**Goal:** Add, remove, and reorder slides.

**Deliverables:**
```python
# Add (clones a symbol/template)
new_slide = deck.add_slide(template=deck.symbols[0])
new_slide = deck.add_slide(template=deck.symbols[0], after=deck.slides[2])

# Remove
deck.remove_slide(slide)          # sets phase REMOVED, does not filter

# Reorder
deck.move_slide(slide, index=0)
```

**Internals handled automatically:**
- New GUIDs: `sessionID=1`, `localID` incremented beyond `maxLocalID()`
- `phase: 'CREATED'` on new SLIDE + INSTANCE nodes
- `parentIndex` wired correctly (SLIDE → SLIDE_ROW, INSTANCE → SLIDE)
- Transform x-position: `slide_index × 2160`
- Cached fields deleted: `derivedSymbolData`, `derivedSymbolDataLayoutVersion`,
  `slideThumbnailHash`, `editInfo`, `prototypeInteractions`
- `symbolData` set with target symbol's ID and empty `symbolOverrides`
- Deep clone uses typed-array-safe method (not `JSON.parse/stringify`)

**Exit criterion:** Add 10 slides, remove 3 non-adjacent slides, reorder 2 slides.
Verify correct slide count, order, and content in Figma.

---

### Phase 5 — Shape Properties _(Experimental)_

**Goal:** Read and modify geometry + appearance of existing shapes. Format territory
here is largely unknown. Validate each property in isolation before combining.

**Deliverables (gated individually):**
```python
shape = slide.shapes[0]

# Geometry
shape.x, shape.y             # position (read/write)
shape.width, shape.height    # size (read/write)
shape.rotation               # degrees (read/write)

# Appearance
shape.opacity                # 0.0–1.0
shape.fill.solid(r, g, b)    # solid color fill
shape.fill.none()            # remove fill
shape.visible                # bool
```

**Validation gate:** Each property is tested in isolation on a single shape type
before any combination is attempted. A property is not considered "shipped" until
confirmed working in Figma.

**Exit criterion:** Each listed property independently verified on at least one
shape type. Known-broken properties documented explicitly.

---

### Phase 6 — Shape Creation _(Experimental)_

**Goal:** Add new shapes to slides. Highest risk — most unknown format territory.

**Deliverables (gated individually):**
```python
slide.add_text_box(x, y, width, height, text="")
slide.add_rectangle(x, y, width, height)
slide.add_frame(x, y, width, height)
slide.add_image(x, y, width, height, "image.jpg")  # freestanding, not override
```

**Validation gate:** Each shape type created in a blank slide, saved, and verified
in Figma before the next type is attempted.

**Exit criterion:** Each shape type independently verified. No shape creation is
considered stable until it survives a Figma close/reopen cycle.

---

### Phase 7 — Advanced _(Future / Unscheduled)_

Items below are not blocked but have no delivery date. Each needs its own
format investigation before spec can be written.

- Slide background (fill, gradient, image)
- Prototype interactions / animations
- Design variables / tokens (`VARIABLE_SET`, `VARIABLE` nodes)
- Connector shapes
- Master / symbol definition editing
- Notes equivalent (if Figma Slides has one)
- Multi-page decks (multiple CANVAS nodes)
- Export: `.deck` → image per slide (via Figma API, not local)

---

## Target API Summary

```python
from figma_deck import Deck

deck = Deck.open("presentation.deck")

# Meta
deck.meta.file_name
deck.meta.version

# Slides
deck.slides                  # list[Slide]
deck.symbols                 # list[Symbol]

# Slide read
slide = deck.slides[0]
slide.name
slide.index
slide.text_nodes             # list[TextNode]
slide.image_nodes            # list[ImageNode]
slide.shapes                 # list[Shape]  (Phase 5+)

# Text write (Phase 2)
slide.set_text("title", "Hello")
slide.set_texts({"title": "A", "body": "B"})

# Image write (Phase 3)
slide.set_image("photo", "hero.jpg")

# Slide management (Phase 4)
new_slide = deck.add_slide(template=deck.symbols[0])
deck.remove_slide(slide)
deck.move_slide(slide, index=0)

# Shape properties (Phase 5)
shape.x, shape.y, shape.width, shape.height
shape.fill.solid(255, 0, 0)

# Shape creation (Phase 6)
slide.add_text_box(x, y, w, h, "text")
slide.add_rectangle(x, y, w, h)

# Save
deck.save("output.deck")
deck.save()                  # overwrite original
```

---

## Known Unknowns

| Area | Risk | Mitigation |
|------|------|------------|
| Full kiwi field set | Fields present in real files but not in schema may be dropped | Roundtrip-test all phases |
| SYMBOL structure variability | Template cloning may break for some layouts | Test with ≥5 structurally different .deck files |
| Shape field semantics (Phase 5+) | Wrong field values crash Figma silently | Test each field in isolation |
| Freestanding image nodes vs override images | Two code paths, both need validation | Test independently |
| Position string encoding | ASCII ordering may have edge cases at scale | Test with 20+ slides in one row |
| Multiple CANVAS nodes | Spec assumes single page — unknown if multi-page decks exist | Detect and raise NotImplementedError |
