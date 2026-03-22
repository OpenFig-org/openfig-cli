# openfig API — Feature Map

Maps every python-pptx feature to its openfig equivalent.
Used to drive spec and phase planning.

## Categories

| Symbol | Meaning |
|--------|---------|
| ✅ Direct | Same concept, straightforward mapping |
| ⭐ Richer | Figma does this better / differently — worth going beyond pptx |
| ❌ Skip | No Figma Slides equivalent, omit |
| 🔬 Unknown | Figma has it internally but format is unvalidated — needs investigation |

---

## Presentation

| python-pptx | Category | openfig API | Notes |
|-------------|----------|-------------|-------|
| `Presentation('file.pptx')` | ✅ Direct | `Deck.open('file.deck')` | Phase 1 — done |
| `Presentation()` new blank | ✅ Direct | `Deck.create()` | Done — creates from bundled blank template |
| `prs.save('out.pptx')` | ✅ Direct | `deck.save('out.deck')` | Phase 1 — done |
| `slide_width`, `slide_height` | ✅ Direct | `deck.slideWidth`, `deck.slideHeight` | Read-only — validated from SLIDE node size |
| Core metadata (title, author, etc.) | ✅ Direct | `deck.meta.file_name` | Only `file_name` + `version` in `meta.json`; no rich metadata |

---

## Slides

| python-pptx | Category | openfig API | Notes |
|-------------|----------|-------------|-------|
| `slides.add_slide(layout)` | ✅ Direct | `deck.addSlide(symbol)` | Phase 4 — done |
| `slides[0]` | ✅ Direct | `deck.slides[0]` | Phase 1 — done |
| Remove slide | ✅ Direct | `deck.removeSlide(slide)` | Phase 4 — done |
| Reorder slides | ✅ Direct | `deck.moveSlide(slide, index)` | Phase 4 — done |
| `slide.background` fill | ✅ Direct | `slide.setBackground(color)` | Validated — named colors or RGB |
| Notes slide | 🔬 Unknown | `slide.notes` | Unknown if Figma Slides has a notes equivalent |
| `slide.slide_layout` | ⭐ Richer | `slide.symbol` | In Figma, the "layout" is a full SYMBOL with overrideable slots |

---

## Slide Layouts & Masters

| python-pptx | Category | openfig API | Notes |
|-------------|----------|-------------|-------|
| `prs.slide_layouts` | ⭐ Richer | `deck.symbols` | Figma SYMBOLs are richer than pptx layouts — full component model |
| `slide_layout.placeholders` | ⭐ Richer | `symbol.textSlots`, `symbol.imageSlots` | Phase 1 — done |
| Slide master | ⭐ Richer | `deck.master` (future) | Figma has SYMBOL masters + COMPONENT_SET variants |
| Notes master | 🔬 Unknown | — | Unknown if applicable |

---

## Shapes — General

| python-pptx | Category | openfig API | Notes |
|-------------|----------|-------------|-------|
| `shape.left`, `top`, `width`, `height` | ✅ Direct | `shape.x`, `shape.y`, `shape.width`, `shape.height` | Validated — read/write via transform + size |
| `shape.rotation` | ✅ Direct | `shape.rotation` | Validated — read/write via transform matrix |
| `shape.name` | ✅ Direct | `shape.name` | Validated — read/write |
| `shape.visible` | ✅ Direct | `shape.visible` | Validated |
| `shape.fill` | ✅ Direct | `shape.setFill(color)` | Validated — solid RGB, routes to nodeGenerationData for SHAPE_WITH_TEXT |
| `shape.line` (outline) | ✅ Direct | `shape.setStroke(color, opts)` | Validated — color, weight, align |
| `shapes.add_shape(type, ...)` | ✅ Direct | `slide.addRectangle/Ellipse/Diamond/Triangle/Star(...)` | Validated — ROUNDED_RECTANGLE + SHAPE_WITH_TEXT variants |
| `shapes.add_textbox(...)` | ✅ Direct | `slide.addText(text, opts)` | Validated — TEXT node with styles |
| `shapes.add_connector(...)` | ✅ Direct | `slide.addLine(x1, y1, x2, y2)` | Validated — LINE node |
| `shapes.add_group_shape()` | 🔬 Unknown | `slide.addGroup()` | GROUP node — unvalidated |
| SVG import | ✅ Direct | `slide.addSVG(x, y, w, path, opts)` | Validated — FRAME+VECTOR with fillGeometry + vectorNetworkBlob |
| Freeform shape | 🔬 Unknown | `slide.addVector(...)` | VECTOR node with blob geometry — unvalidated |
| OLE objects | ❌ Skip | — | No Figma equivalent |

---

## Placeholders

| python-pptx | Category | openfig API | Notes |
|-------------|----------|-------------|-------|
| Title placeholder | ⭐ Richer | `slide.setText('Title', value)` | Symbol override by node name — Phase 2 done |
| Body placeholder | ⭐ Richer | `slide.setText('Body', value)` | Phase 2 done |
| Picture placeholder | ⭐ Richer | `slide.setImage('Photo', path)` | Phase 3 done |
| `placeholder.insert_picture(path)` | ✅ Direct | `slide.setImage(name, path)` | Phase 3 done |
| Table placeholder | 🔬 Unknown | `slide.setTable(name, data)` | TABLE nodes exist but no placeholder equivalent yet |
| Chart placeholder | ❌ Skip | — | Figma Slides has no native chart nodes |

---

## Text

| python-pptx | Category | openfig API | Notes |
|-------------|----------|-------------|-------|
| `text_frame.text` read | ✅ Direct | `textNode.characters` | Phase 1 — done |
| Set text content | ✅ Direct | `slide.setText(name, value)` | Phase 2 — done |
| Batch set text | ✅ Direct | `slide.setTexts({name: value})` | Phase 2 — done |
| `paragraph.alignment` | ✅ Direct | `addText(..., { align: 'CENTER' })` | Validated — LEFT, CENTER, RIGHT, JUSTIFIED |
| `paragraph.level` (bullets) | ✅ Direct | `addText(..., { list: 'bullet' })` | Validated — bullet + numbered, with indent levels |
| `paragraph.line_spacing` | 🔬 Unknown | `para.lineSpacing` | On TEXT node style; unvalidated |
| `paragraph.space_before/after` | 🔬 Unknown | `para.spaceBefore`, `para.spaceAfter` | Unvalidated |
| `run.font.name` | ✅ Direct | `addText(..., { font: 'Georgia' })` | Validated — custom font detaches from style |
| `run.font.size` | ✅ Direct | `addText(..., { fontSize: 48 })` | Validated |
| `run.font.bold/italic` | ✅ Direct | `[{ text: 'bold', bold: true }]` | Validated — per-run via styleOverrideTable |
| `run.font.color` | ✅ Direct | `addText(..., { color: { r,g,b } })` | Validated — whole-text and per-run |
| `run.font.underline` | ✅ Direct | `[{ text: 'u', underline: true }]` | Validated — per-run textDecoration |
| `run.hyperlink.address` | ✅ Direct | `[{ text: 'link', hyperlink: 'url' }]` | Validated — per-run hyperlink |
| `text_frame.vertical_anchor` | 🔬 Unknown | `textFrame.verticalAlign` | Unvalidated |
| `text_frame.word_wrap` | 🔬 Unknown | `textFrame.wordWrap` | Unvalidated |
| `text_frame.auto_size` | ⭐ Richer | `textFrame.autoSize` | Figma has auto-layout which is more powerful |
| `text_frame.columns` | 🔬 Unknown | — | Unknown if Figma Slides supports text columns |

---

## Fill

| python-pptx | Category | openfig API | Notes |
|-------------|----------|-------------|-------|
| Solid fill | ✅ Direct | `shape.setFill({ r, g, b })` | Validated — fillPaints on nodes |
| Gradient fill | 🔬 Unknown | `shape.fill.gradient(stops)` | Unvalidated |
| Pattern fill | ❌ Skip | — | No pattern fill concept in Figma |
| Picture fill | ✅ Direct | `shape.setImageFill(path)` | Validated — works on ROUNDED_RECTANGLE + SHAPE_WITH_TEXT |
| No fill / transparent | ✅ Direct | `shape.removeFill()` | Validated — empties fillPaints |
| Opacity | ✅ Direct | `shape.opacity = 0.5` | Validated |

---

## Line / Border

| python-pptx | Category | openfig API | Notes |
|-------------|----------|-------------|-------|
| Line color | ✅ Direct | `shape.setStroke({ r, g, b })` | Validated — strokePaints on nodes |
| Line width | ✅ Direct | `shape.setStroke(color, { weight: 8 })` | Validated |
| Dash style | 🔬 Unknown | `shape.stroke.dash` | Unknown if Figma stores dash style in this format |
| No stroke | ✅ Direct | `shape.removeStroke()` | Validated |

---

## Charts

| python-pptx | Category | openfig API | Notes |
|-------------|----------|-------------|-------|
| All chart types | ❌ Skip | — | Figma Slides has no native chart nodes |

---

## Tables

| python-pptx | Category | openfig API | Notes |
|-------------|----------|-------------|-------|
| `add_table(rows, cols, ...)` | ✅ Direct | `slide.addTable(x, y, data, opts)` | Validated — TABLE node with nodeGenerationData overrides |
| Cell text | ✅ Direct | via `data[][]` in addTable | Validated — per-cell text at guidPath 40000000:1 > row > col |
| Cell fill | 🔬 Unknown | per-cell fill override | Format known (40000000:0 > row > col) but API not yet exposed |
| Merge cells | 🔬 Unknown | `cell.merge(other)` | Unknown if Figma has cell merge concept |
| Row/col sizing | ✅ Direct | `opts.colWidth`, `opts.rowHeight` | Validated — tableColumnWidths / tableRowHeights |

---

## Images

| python-pptx | Category | openfig API | Notes |
|-------------|----------|-------------|-------|
| `add_picture(path, l, t, w, h)` | ✅ Direct | `slide.addImage(x, y, w, h, path)` | Validated — freestanding ROUNDED_RECTANGLE with IMAGE fill |
| `insert_picture` into placeholder | ✅ Direct | `slide.setImage(name, path)` | Phase 3 — done |
| Auto aspect-ratio preserve | ✅ Direct | handled in `setImage` | Phase 3 — done |
| SHA-1 hash + thumbnail | ✅ Direct | handled internally | Phase 3 — done |

---

## Figma-Only (no pptx equivalent)

These have no python-pptx counterpart but are natural targets for openfig.

| Feature | openfig API | Phase | Notes |
|---------|-------------|-------|-------|
| Component variants (`COMPONENT_SET`) | `deck.componentSets` | Future | Multiple layout variants per template |
| Design variables / tokens | `deck.variables` | Future | `VARIABLE_SET`, `VARIABLE` nodes |
| Auto-layout frames | `frame.autoLayout` | Future | Figma's layout engine — far more powerful than pptx text columns |
| Prototype interactions / animations | `slide.interactions` | Future | `prototypeInteractions` on nodes; format unvalidated |
| Slide grid layout | `deck.grid` | Future | `SLIDE_GRID` + `SLIDE_ROW` structure |
| Multiple pages | `deck.pages` | Future | Multiple CANVAS nodes — unknown if Figma Slides uses these |

---

## Summary

| Category | Count |
|----------|-------|
| ✅ Direct — done and validated | ~38 |
| ⭐ Richer — Figma exceeds pptx | ~6 |
| 🔬 Unknown — needs format validation | ~12 |
| ❌ Skip | ~5 |

Most python-pptx features now have validated openfig equivalents. The remaining
🔬 items are mostly advanced formatting (gradients, dash styles, paragraph spacing,
cell merge, groups, freeform shapes).
