# python-pptx Feature Reference

Used as a design reference for the openfig programmatic API.
Each feature listed here is a candidate for an equivalent in openfig's `Deck` / `Slide` API.

---

## Presentation

- Open existing file: `Presentation('file.pptx')`
- Create new (blank): `Presentation()`
- Save to path: `prs.save('out.pptx')`
- Save to file-like object (BytesIO)
- Slide dimensions: `slide_width`, `slide_height` (EMUs)
- Core metadata: `title`, `author`, `subject`, `keywords`, `category`, `comments`,
  `created`, `modified`, `last_modified_by`, `last_printed`, `revision`,
  `content_status`, `identifier`, `language`, `version`

---

## Slides

- Add slide from layout: `slides.add_slide(layout)`
- Access by index: `slides[0]`
- Slide background fill
- Notes slide (speaker notes per slide)
- Slide layout reference
- Slide master reference

---

## Slide Layouts & Masters

- Collection of layouts (typically 9): Title, Title+Content, Blank, Two-Content,
  Comparison, Title Only, etc.
- Slide master (presentation-wide formatting)
- Notes master (controls all notes slide appearance)
- Placeholder inheritance from layout → master

---

## Shape Types

| Shape | API |
|-------|-----|
| Auto shapes (180+ presets) | `shapes.add_shape(type, l, t, w, h)` |
| Text boxes | `shapes.add_textbox(l, t, w, h)` |
| Pictures | `shapes.add_picture(path, l, t, w, h)` |
| Tables | `shapes.add_table(rows, cols, l, t, w, h)` |
| Charts | `shapes.add_chart(type, l, t, w, h, data)` |
| Connectors | `shapes.add_connector(type, x1, y1, x2, y2)` |
| Group shapes | `shapes.add_group_shape()` |
| Freeform | `shapes.build_freeform(x, y)` + moveTo/lineTo |
| OLE objects | `shapes.add_ole_object(progId, ...)` |
| Placeholders | title, body, picture, table, chart, OleObject |

**All shapes:** `left`, `top`, `width`, `height`, `rotation`, `name`, `shape_type`

---

## Text

### Text Frame
- Vertical anchor (top / middle / bottom)
- Word wrap on/off
- Auto-size (none / shape to fit text / text to fit shape)
- Margins (top, bottom, left, right)
- Column count

### Paragraph
- Alignment: left, center, right, justify
- Indent level (0–8, drives bullet hierarchy)
- Line spacing
- Space before / space after

### Run (character-level)
- Font name
- Font size
- Bold, italic, underline, strikethrough
- Color (RGB)
- Kerning
- All-caps, small-caps
- Hyperlink URL

---

## Fill

Applies to shapes and table cells.

| Type | Notes |
|------|-------|
| Solid | RGB foreground color |
| Gradient | Angle + multi-stop color ramp |
| Pattern | Foreground + background color tile |
| Picture | Image cropped to shape boundary |
| Background | Inherit from slide background |

---

## Line / Border

- Color (RGB)
- Width
- Dash style (solid, dashed, dotted, dash-dot, etc.)
- Compound style (single, double, thick-thin, etc.)
- End cap (round, square, flat)
- Join type (round, bevel, miter)

Applies to shape outlines and individual table cell borders.

---

## Charts

### Types
- Bar / Column (clustered, stacked, percent-stacked, 3D variants)
- Line (with/without markers, stacked variants)
- Pie / Doughnut (exploded variants)
- Area (stacked, percent-stacked, 3D variants)
- Scatter / XY (lines, markers, smoothed)
- Bubble
- Radar (markers, filled)

### Properties
- Chart title
- Legend (position, visibility)
- Series data (categories + values)
- Change chart type after creation

---

## Tables

- Create: `add_table(rows, cols, l, t, w, h)`
- Access cell: `table.cell(row, col)`
- Cell content: text only (no nested shapes)
- Merge cells: `cell.merge(other)`
- Split merged: `merge_origin.split()`
- Row height, column width
- Cell fill (solid, gradient, pattern, picture)
- Cell borders (color, width, style per edge)
- Cell text formatting (full paragraph/run support)

---

## Images / Pictures

- Add by file path or file-like object
- Optional explicit width/height (preserves aspect ratio if omitted)
- Picture placeholder smart-insert: `insert_picture(path)` — auto-crops to fit
- Picture fill on any shape: `fill.user_picture(path)`
- Supported formats: JPEG, PNG, GIF, BMP, TIFF

---

## Notes

- Access per slide: `slide.notes_slide`
- Edit text: `notes_slide.notes_text_frame`
- Full paragraph/run formatting
- Notes master controls global appearance

---

## Not Supported in python-pptx

| Feature | Status |
|---------|--------|
| Animations / transitions | Not implemented |
| Sections | Not exposed (requires raw XML) |
| SmartArt | Opaque XML blobs, no API |
| Embedded video | Not supported |
