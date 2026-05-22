# Changelog

All notable changes to `openfig-cli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.4.6]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.6
[0.4.5]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.5
[0.4.4]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.4
[0.4.3]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.3
[0.4.2]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.2
[0.4.1]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.1
[0.4.0]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.4.0
[0.3.31]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v0.3.31
