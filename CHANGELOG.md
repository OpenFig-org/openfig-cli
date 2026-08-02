# Changelog

All notable changes to `openfig-cli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-08-02

### Fixed

- **Contrast lint compared every text node against the slide background instead of what is actually painted behind it.** Light text on a dark card was measured against the white slide and flagged as low-contrast — up to 37 false warnings on a single fixture. The check now carries an effective background through the tree walk and resolves the nearest painted ancestor. Solid fills update the comparison colour; image and gradient fills suppress the check for their subtree, since there is no meaningful ratio against a non-uniform backdrop. (#7)
- **Zero-opacity fills were treated as opaque black by the contrast lint.** `FlexContainer` frames default to `{ opacity: 0, visible: true }` fills, which overrode the real slide background for every descendant text node — the main source of the false warnings above. Paints with `opacity === 0` are now skipped so the parent background shows through.
- **A bold request could resolve onto a weight the family does not ship.** `mapFontStyle` and the measurement surface each encoded the same two-weight vocabulary independently and had already drifted: the clamp picked a weight the handoff then wrote as `"Bold"`, naming a face that does not exist. Both now derive from a single `NAMEABLE_WEIGHTS` constant in `font-normalize.mjs`. (#8)
- **Curved vector paths rendered as straight-line polygons wherever a node's only geometry was its `vectorNetworkBlob`.** The rasterizer classified a segment as a straight line by reading a word out of the segment record and testing it against zero. In Figma-authored blobs that word is `0` on curved segments too, so the curvature was discarded and the path collapsed to a polygon with the correct endpoints. A segment is straight if and only if all four bezier tangent components are zero — there is no segment-type field. This affected stroke-only vectors, which carry neither `fillGeometry` nor `strokeGeometry`, in both `.deck` and `.fig`. It went unnoticed because openfig's own emitter wrote a non-zero value in that word, so the old rule happened to classify openfig-produced geometry correctly and no fixture exposed it.

### Changed

- **Emitted `vectorNetworkBlob` bytes now match the layout Figma itself writes.** `_buildVectorNetworkBlob` previously wrote a one-word rotation of that layout — a 16-byte header, vertices as `[x, y, mirroring]`, segments as `[startVertex, …, type]`, and a per-region trailing word — plus the constant `4` in the mirroring and type slots, a value that appears in none of the reference blobs. The rotation cancels for coordinates, so files opened and rendered correctly, but the structure was distinguishable from Figma's own on inspection and the region block would not have read back the same way. Output is now a 12-byte header, `[styleID, x, y]` vertices, `[word0, startVertex, tsx, tsy, endVertex, tex, tey]` segments, and regions as `[styleID<<1|windingRule, numLoops, (segCount, indices)…]`. Rendering is unaffected: the rasterizer reference reports are pixel-identical.
- **Vector network and path-command encoding now come from `openfig-core`.** This package carried its own `vectorNetworkBlob` encoder, its own decoder, and a byte-for-byte duplicate of `encodeCommandsBlob`. That duplication is what allowed a wrong layout to live in one copy while the other was right — each looked self-consistent because it only ever round-tripped against itself. `lib/slides/api-core.mjs` now contains no raw byte manipulation at all, and `decodeVnb` is a thin adapter that scales coordinates and emits path commands. Verified equivalent before removal: emitted bytes identical across filled, multi-subpath and open stroked paths, and rendering unchanged at 0 of 2,073,600 pixels.
- **`decodeVnb` returns `null` when a blob will not parse.** Previously it stopped mid-walk and emitted whatever it had read. Geometry that cannot be accounted for byte-for-byte now falls through to the caller's placeholder rather than being rendered half-read.
- **Requires `openfig-core` ^0.4.1**, up from ^0.3.8 — for the aligned encoder, the corrected sub-path grouping, and the `emitRegions` option that open stroked paths need.

### Added

- **Conformance tests for the vector network binary format.** `test/slides/vector-network-layout.test.mjs` holds the deck emitter to Figma's layout, and `test/rasterizer/decode-vnb.test.mjs` pins curve classification. Both build blobs deliberately rather than reading fixtures, because no fixture reaches these paths with Figma-authored geometry. Byte-exact consumption alone does not pin the field order — a rotated record has the same stride and still consumes the blob exactly — so the layout test also asserts that decoded coordinates span a real bounding box, which is what a rotation actually breaks.
- `docs/figma-behaviour.md` documents the verified format, why byte accounting and geometry comparison both fail to discriminate rotated layouts, and which of the two emitters produces user-facing decks.

## [0.5.1] - 2026-07-27

### Fixed

- **Reading a `.deck` or `.fig` could parse unrelated memory instead of the file.** `canvas.fig` was handed to the parser as `new Uint8Array(buf.buffer)`, which discards a Buffer's `byteOffset` and `byteLength`. `readFileSync` routinely returns a Buffer that is a *view* into a shared pool — in one observed case a 26,643-byte file sat at offset 960 of a 65,536-byte backing buffer — so the parser received the whole pool from offset 0 and read whatever happened to be adjacent in memory. Symptoms varied with pool contents: `Unknown prelude: …`, `Offset is outside the bounds of the DataView`, or silently wrong data. Because pooling depends on allocation history, failures moved between runs and between files, which made it look like unrelated flakiness in several commands (`inspect`, `list-text`, `create-deck`, `deck-to-fig`, and the rasterizer). It affected any file whose read happened to be pooled, not any particular size or format.

### Changed

- `packageManager` is pinned to npm. The repo tracks `package-lock.json`, but stray `pnpm-lock.yaml` / `pnpm-workspace.yaml` files had appeared alongside it, leaving the toolchain ambiguous and local installs resolving stale versions.

## [0.5.0] - 2026-07-27

### Added

- **`convert-html`: CSS `conic-gradient` is converted to vector geometry.** Pie and donut charts in Claude Design decks are drawn as a `conic-gradient` on a `border-radius: 50%` element — there is no SVG to extract. Previously the layer was skipped, and because such elements usually have a transparent `background-color`, *nothing at all* was emitted for them: the chart vanished silently. Cones are now emitted as wedge paths and routed through the SVG pipeline, so each slice becomes a selectable Figma VECTOR node with crisp edges at any zoom. Hard stops produce one exact wedge per segment; genuine colour ramps are subdivided. Handles `from <angle>`, `at <position>`, and stop positions in `%`, `deg`, `turn`, `rad`, and `grad`.
- **`convert-html`: unsupported `background-image` functions now warn.** Previously any layer that was not `linear-gradient`, `radial-gradient`, or `url()` was dropped without a word, so a missing visual looked like a clean conversion.

### Fixed

- **SVG element and group transforms are applied instead of discarded.** The shape parser never read `transform` attributes and did not descend into `<g>` at all, so geometry under `<g transform="translate(...)">` or a per-path `matrix(...)` collapsed toward the SVG origin — icons rendered mangled, or disappeared. Enclosing group transforms are now recovered and composed with each element's own transform, then baked into the shape's coordinates. Affects every `.deck` and `.fig` conversion that vectorizes SVG.
- **`convert-html`: slides are measured at true 1920×1080 scale.** A standalone whose viewer renders the slide inside a scaling stage (fitting it beside presenter chrome) yielded geometry at roughly 90% of true size — every coordinate uniformly wrong, with the error growing away from the origin. The converter now grows the measurement viewport until the slide reports its own CSS size 1:1.
- **`convert-html`: fonts bundled in the export now load.** Asset URLs were rewritten for `<img>` elements only, never for `@font-face` rules, so every bundled face failed to load and Chromium silently substituted. Text was measured in the wrong typeface, producing subtly wrong wrap points and box heights.

### Changed

- **`convert-html` loads the standalone as authored rather than replaying its tweak state.** 0.4.7 reproduced the export's runtime in Node — the `quoteStyle` / `dividerBg` / icon-visibility mapping and the `--t-icon-*` variables. That mapping was written against one deck's markup and encoded its class names and section titles, so it did not generalise. The converter now runs the page's own runtime, which applies the same tweaks in the page's own vocabulary, and the hardcoded replay is gone. The saved tweak state is still honoured; `__bundler/ext_resources` and `__bundler/page_order` are now handled too, as a side effect of letting the page rehydrate itself.

## [0.4.7] - 2026-05-26

### Fixed

- **`convert-html`: SVG `currentColor` now resolves to the element's computed color.** Vectorized SVG paths using `fill`/`stroke="currentColor"` (e.g. adaptive logos and icons) previously failed conversion with `Unknown color: "currentColor"`. The extractor now captures each SVG's computed CSS `color` and substitutes it before vectorizing, so an icon renders light on a dark slide and dark on a light one.
- **`convert-html`: saved deck tweak state is replayed before extraction.** The exported `__bundler/template` is the DOM *before* the design tool applies the user's saved tweaks (`TWEAK_DEFAULTS`). These are now replayed — `quoteStyle`, `dividerBg`, `.method-icon` visibility, and the `--t-icon-size` / `--t-icon-scale` / `--t-kf-num-size` vars — so the rendered deck matches the design. Fixes a phantom box drawn around quote callouts when `quoteStyle: "top"` was set.
- **`convert-html`: hard-break labels that overflow their column now wrap.** A text leaf containing a `<br>` was always marked `noWrap`; when a segment between breaks was wider than its (e.g. fixed-width) column it overflowed into adjacent content. `noWrap` is now kept only when each authored line fits — otherwise the text reflows within its measured width.

## [0.4.6] - 2026-05-22

### Added

- **`openfig deck-to-fig` command** — Convert a Figma Slides `.deck` file into a standard Figma Design `.fig` file. Visual slides scaffolding is flattened, and components are baked/flattened with overrides into visual frames arranged as a canvas row/grid.
- **Unified ZIP/Binary auto-detection** — `FigDeck.fromFile()` unified loader automatically detects zipped `.fig`/`.deck` packages versus raw Kiwi binaries by inspecting magic bytes.

### Fixed

- **CLI Inspect/List Commands** — Restored compatibility of `inspect`, `list-text`, and `list-overrides` commands when reading standard zipped `.fig` files exported from Figma.

## [0.4.5] - 2026-05-21

### Changed

- **`convert-html`: font alias map now derived from FreeDesktop's
  `30-metric-aliases.conf`** (the canonical open-source list of
  metric-compatible font pairs that ships with fontconfig and underlies
  Linux/ChromeOS/LibreOffice font substitution). A new refresh script
  fetches the upstream config, parses the alias declarations, and keeps
  only the substitutes Figma actually serves. Surviving aliases are
  still Calibri→Carlito and Cambria→Caladea, but the provenance is now
  upstream rather than hand-typed, so new pairs land automatically the
  next time the refresh script runs.
- **Figma-availability set consolidated into a single JSON.** The
  previously-inline system-core list (Inter, Arial, Helvetica, …) is
  now baked into `lib/slides/figma-available-fonts.json` by the refresh
  script, making the JSON the single source of truth for "what Figma
  can resolve."

## [0.4.4] - 2026-05-21

### Fixed

- **`convert-html`: alias proprietary fonts and widen Figma availability check.**
  Decks emitted from Claude Design HTML opened with a missing-font dialog
  when the source CSS used proprietary system fonts (Calibri, Cambria) that
  Figma cannot load. The font normalizer now walks the full CSS font stack
  and:
  1. substitutes metric-compatible OFL clones — `Calibri → Carlito`,
     `Cambria → Caladea` — so layout is preserved;
  2. otherwise picks the first family Figma is known to have, checked
     against the full Google Fonts catalog (~1900 families, vendored as
     JSON, regenerated via `scripts/refresh-figma-available-fonts.mjs`)
     plus the system core (Inter, Arial, Helvetica, Times, etc.);
  3. falls back to the first portable token only when nothing in the stack
     is resolvable, letting Figma's font picker handle the rest.

  Also eliminates the spurious "likely not available" warning that fired
  on common Google Fonts (e.g. EB Garamond) under the previous hand-curated
  30-entry allowlist. HTML and SVG-text paths now share the same
  `lib/slides/font-normalize.mjs` so the dispatcher can't reintroduce a
  raw CSS stack.

## [0.4.3] - 2026-05-21

### Fixed

- **`convert-html`: bake CSS `invert(1)` filters into raster image bytes.**
  Logos that Claude Design ships as black assets and recolors via
  `filter: invert(1)` (or compound `brightness(0) invert(1)`) no longer
  render as black on dark slides. Image bytes are now inverted via sharp
  before embedding, and a warning surfaces any other CSS filter we don't
  bake yet.
- **`convert-html`: preserve `image/svg+xml` assets as native Figma vectors.**
  SVG assets referenced through the runtime blob-URL manifest were
  previously routed through the raster `<img>` path and baked to pixels.
  They're now inlined as `data:` URLs in the browser stage so the existing
  SVG-vector path picks them up and emits Figma VECTOR nodes — crisp at any
  zoom. The same `invert(1)` / `brightness(0) invert(1)` filters apply by
  rewriting fill/stroke colors directly in the SVG markup.

## [0.4.2] - 2026-04-28

### Changed

- README: screenshots compressed and display widths constrained for faster
  page loads on npmjs.com.

## [0.4.1] - 2026-04-28

### Added

- README: Claude Design HTML export workflow (the standalone-HTML → `.deck`
  flow added in 0.4.0).

## [0.4.0] - 2026-04-28

### Added

- **`openfig convert-html` command** — convert a Claude Design standalone
  HTML export into a native `.deck` file. Text, images, vectors, layouts,
  and speaker notes carry through as editable Figma Slides nodes.
- **`openfig_convert_html` MCP tool** — same conversion exposed to MCP
  clients (Claude Cowork etc.).
- **Zero-seed `.deck` creation** — `openfig create-deck` and
  `FigDeck.createEmpty()` produce a fully programmatic deck without
  requiring a seed template.
- **Chromium-based layout extraction** — the standalone-HTML converter
  drives Playwright/Chromium so CSS layout is browser-faithful, replacing
  the previous hand-rolled CSS engine.
- **Broader SVG shape coverage in the handoff stage** — polyline, polygon,
  rect, ellipse, gradient fills, and concatenated/relative path commands.
- **CSS variable resolution** — `var(--name)` references resolve through
  the captured `:root` token values before handoff.
- **`::before` / `::after` pseudo-elements** rendered as text/shape nodes.
- **Inline rich-text flows** coalesced into single richText elements so
  mid-sentence weight/style changes stay together.

### Fixed

- Text wrapping near slide right edge for large `noWrap` text.
- Font measurement: Playwright now uses Inter for metrics that match
  Figma's substitution behaviour; system-font stacks are forced onto
  Inter pre-measurement.
- `SHAPE_WITH_TEXT` containers no longer absorb their inline SVG/IMG
  children as text leaves.
- Empty inline elements with CSS-only geometry are imported as shapes
  rather than being dropped.
- Straight-line shapes emit as VECTOR paths so `strokeAlign` is honoured
  (previously rasterised inconsistently).
- Multi-line `noWrap` captions: `WIDTH_AND_HEIGHT` sizing keeps the box
  tight to content.
- CSS `vertical-align` honoured on text elements.
- SVG opacity attribute and direct text inside containers preserved.
- SVG subpath separation preserved for vector wordmarks (no more glyph
  merging).
- Converter warnings surface unsupported CSS so unknown constructs are
  visible at convert time instead of silently dropped.

## [0.3.31] - 2026-03-16

Pre-`convert-html` baseline. Earlier 0.3.x versions are not catalogued
here; see `git log --tags='*0.3.*'` for the full history.

[0.6.0]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.6.0
[0.5.1]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.5.1
[0.5.0]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.5.0
[0.4.7]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.7
[0.4.6]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.6
[0.4.5]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.5
[0.4.4]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.4
[0.4.3]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.3
[0.4.2]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.2
[0.4.1]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.1
[0.4.0]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.0
[0.3.31]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.3.31
