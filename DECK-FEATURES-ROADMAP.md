# Deck Features Roadmap

Tracks fidelity gaps uncovered when building real decks through the zero-seed
`Deck.create()` → slide-primitive API path. Each entry lists the shortfall,
the impact on output fidelity, and a sketch of what the fix looks like.

Discovered while implementing the Claude Designer handoff bundle
`OpenFig Demo Deck` (12-slide "Design of the London Underground Map" fixture).

## Reference fixture

The handoff bundle lives at
`test/fixtures/designer-bundles/london-underground-map/`:

- `README.md` — Claude Designer handoff README (design tokens, per-slide layout)
- `manifest.json` — structured per-element data (positions, colours, typography, speaker notes)
- `London Underground Map.html` — authoritative HTML/CSS visual reference
- `deck-stage.js` — deck shell component (not used by the builder)
- `media/` — all raster + vector assets referenced by slides

Use this fixture as the end-to-end acceptance target: a future
`Deck.fromManifest()` should be able to consume `manifest.json` and emit a
`.deck` that matches `London Underground Map.html` pixel-for-pixel as the
roadmap gaps below get closed.

## Typography

### Custom font embedding
- **Gap:** Decks cannot ship their own fonts. Requested families that are not
  on Figma's built-in list fall back silently.
- **Impact:** The fixture uses EB Garamond (display) and Calibri (body).
  Neither is shipped — output renders in Figma's substitute (closest serif /
  sans), visibly different from the HTML reference.
- **Fix sketch:** Honour a `fonts` map in `manifest.json` / `Deck.create`
  options; embed WOFF2 payloads in the `.deck` zip under `fonts/` and
  register them in the canvas-fig message.

### ~~`letter-spacing` / tracking~~ ✅ CLOSED
- **Shipped:** `opts.letterSpacing` on `addText`. Number → `{ value, units:
  'PIXELS' }`; raw `{ value, units }` object also accepted.
- **Verified:** slide-1 `LONDON` @ 12px, `UNDERGROUND MAP` @ 10px, byline @
  14px all render at the intended tracking.

### ~~`line-height`~~ ✅ CLOSED
- **Shipped:** `opts.lineHeight` on `addText`. Number < 10 → `RAW` multiplier,
  ≥ 10 → `PIXELS`; raw `{ value, units }` object also accepted.

### ~~Per-run colour overrides~~ ✅ CLOSED
- **Shipped:** `buildRunOverrides` now accepts `run.color` and emits a
  per-styleID `fillPaints` override in the `styleOverrideTable`.
- **Verified:** slide-1 byline (`HARRY BECK` white / `·` red / `1933` pale
  blue) now ships as a single TEXT node with three coloured runs.

## Shapes & strokes

### ~~Rectangle strokes~~ ✅ CLOSED
- **Shipped:** `addRectangle` accepts `opts.stroke`, `opts.strokeWeight`,
  `opts.strokeAlign`, `opts.dashPattern`, `opts.opacity`. Mirrors the options
  already on `addLine` and `_addShapeWithText`.

### ~~Curves / Bézier paths~~ ✅ CLOSED
- **Shipped:** `slide.addPath(d, opts)` parses M / L / H / V / C / S / Q / T /
  Z commands and emits a `VECTOR` node with `strokePaints` + `strokeGeometry`
  + `vectorNetworkBlob`. Open and closed paths both supported; quadratic
  Béziers are converted to cubic on import.
- **Verified:** slide-11 Bakerloo / District curved spokes now render.

### ~~Dashed lines~~ ✅ CLOSED
- **Shipped:** `addLine` accepts `opts.dashPattern = [on, off, ...]` and
  passes it straight to the node's `dashPattern` field. `opts.stroke` is now
  an alias for `opts.color`, matching `addRectangle`.

### Ellipse / circle stroke (no-fill)
- **Gap:** `addEllipse` sets a solid fill; there is no way to draw a
  stroke-only ring.
- **Impact:** Slide 11 needs four concentric grey rings and a gold Circle
  Line ring. Current workaround is to stack a slightly-smaller white ellipse
  on top to fake the ring — adds noise to the node tree and only works on
  white backgrounds.
- **Fix sketch:** Accept `opts.stroke`, `opts.strokeWeight`, `opts.fill: null`
  or `'none'`. Matches SVG semantics.

### ~~Opacity on TEXT~~ ✅ CLOSED
- **Shipped:** `addText` accepts `opts.opacity` (0–1) and writes it straight
  to the TEXT node's `opacity` field.

## Images

### SVG images
- **Gap:** `Slide.addImage` expects a raster buffer (PNG / JPG). SVG inputs
  would need to be rasterized first.
- **Impact:** The slide-1 Underground roundel is an SVG in the handoff
  bundle. Current workaround is to substitute `image-10-1.png` (Central-line
  roundel) which is thematically close but not the same artwork.
- **Fix sketch:** Detect SVG content and rasterize on the fly (sharp /
  resvg-js), or support a native VECTOR node pathway.

## Charts / data visualisation

### Area / gradient fills
- **Gap:** No `addPath` or `addPolygon` with gradient-fill support.
- **Impact:** Slide 6 chart uses a `linearGradient` under the line. Current
  build skips the gradient fill entirely.
- **Fix sketch:** Add `addPath(d, opts)` that accepts `fill: { type: 'GRADIENT_LINEAR', stops: [...] }`.

### High-level chart helper
- **Gap:** No `addChart(...)` primitive — building a chart means hand-laying
  axis lines, ticks, labels, dots and line segments as individual nodes.
- **Impact:** Slide 6 required ~40 individual primitive calls to fake what
  the source expresses in one SVG block. The manifest even specifies
  `"type": "chart"` with a complete data array.
- **Fix sketch:** Add `slide.addChart({ type: 'area', data, xLabels, yAxis, annotations })` that emits the same primitives consistently.

## Composite / structural

### ~~Speaker notes~~ ✅ CLOSED
- **Shipped:** `slide.setSpeakerNotes(text)` / `slide.getSpeakerNotes()`.
  Writes to the `SLIDE.slideSpeakerNotes` field (field ID 389 in the Figma
  Kiwi schema).
- **Verified:** the London Underground Map build script loads all 12
  `speakerNotes` entries from `manifest.json` and attaches them.

### Slide frames / groups
- **Gap:** `addFrame` exists but is rarely exercised; no helper for
  reusable card / callout templates.
- **Impact:** Slide 4 (four cards) and slide 7 (five timeline cards) both
  re-emit the same block of primitives per card. A `card({ bar, title,
  body })` helper would halve the build script.
- **Fix sketch:** Ship a small `lib/slides/components.mjs` with reusable
  `card`, `timelineStep`, `factColumn`, `statCallout` builders.

### Table cell formatting
- **Gap:** `addTable` takes a flat 2D array of strings. No per-cell font,
  colour, background, or inline shape (swatch) control.
- **Impact:** Slide 8 table needs alternating row backgrounds (`#F5F1E8` /
  white), header row with navy background + white text, and an inline
  coloured swatch in the "Swatch" column. None of that is expressible —
  the current build falls back to a plain all-default table and emits the
  colour as the literal string (`"■ Brown"`).
- **Fix sketch:** Accept `rows: [{ cells: [{ text, background, color,
  swatch, font, bold }]}]` or a separate `formatCell(row, col, opts)`.

## Meta / tooling

### Manifest-driven builds
- **Gap:** No high-level `Deck.fromManifest(path)` that consumes the
  structured `manifest.json` shape produced by Claude Designer.
- **Impact:** Every handoff bundle needs a bespoke build script. The
  manifest already encodes positions, colours, typography, and speaker
  notes — we should be able to round-trip it.
- **Fix sketch:** Ship a `lib/slides/manifest.mjs` with a schema definition
  (TS types, JSON Schema) and a renderer that maps element `type` → API
  calls. Roadmap entries above fold in as the renderer grows.
