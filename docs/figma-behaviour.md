# What Figma actually does

Observed compatibility behavior for `.deck` files.
The relevant behavior extends beyond what is
inferred from documentation — Figma documents almost none of it, and the two
public APIs (plugin and REST) describe a narrower surface than the file format
carries.

Each section records the resulting behavior rather than
trusted.

---

## Fonts

### Figma never synthesises bold or italic

A browser asked for a weight a family does not ship renders a synthetic bold —
it smears the glyphs — and reports `font-weight: 700` as though nothing were
wrong. Figma has no equivalent. It matches the exact `(family, style)` string
or opens the missing-font dialog.

Consequence: a deck must never name a face the family lacks. Instrument Serif
ships one weight; `Instrument Serif Bold` is not a font. Space Grotesk ships no
italic.

*Measured:* Figma's own replacement dropdown offers only the styles a family
has — Regular and Italic for Instrument Serif, no Bold.

### A weight in Google Fonts is not a named instance in Figma

Google serves Space Grotesk at 300, 400, 500, 600 and 700. Figma's font picker
offers Light, Regular, Medium and Bold for it — **no SemiBold**. So Google's
weight list cannot be used to decide which style names are safe to write.

Figma's own font-file archive shows the same thing across families: some expose
the full nine-step ladder, others four or five, and the count comes from the
font's own named instances rather than any fixed scheme.

### Style names are single words

`SemiBold`, `ExtraBold`, `ExtraLight` — not `Semi Bold`. Consistent across
Figma's published font data.

### Variable-font weight works, and is honoured properly

`NodeChange.fontVariations` — `{ axisTag, axisName, value }`, where `axisTag`
is the OpenType tag packed as a uint (`wght` = 2003265652).

Measured, by ink density in a compatibility-reference output:

| written | relative ink |
|---|---|
| `Regular`, no variation | 1.000 |
| `Regular` + wght 500 | 1.263 |
| `Regular` + wght 600 | 1.392 |
| `Bold`, no variation | 1.480 |

Four distinct, monotonically increasing values: the axis is applied
**continuously**, not snapped to the nearest named instance.

Three further properties, each measured:

- **Inert without the axis.** Instrument Serif has no `wght` axis; with and
  without a variation it renders byte-identically. So writing one is safe
  generally, not only for variable families.
- **It overrides the base style, in both directions.** `Bold` + wght 400
  renders identically to plain `Regular`. So the style name and the variation
  can be chosen independently — the name for missing-font safety, the variation
  for fidelity.
- **It survives editing.** A file saved by Figma after retyping the text still
  carried `Weight=600` and rendered at the same stem width as its untouched
  twin.

It works on **run-level style overrides** as well as on nodes: a run written
`Bold` + wght 400 measures the same as plain Regular.

*Method note:* total ink and first-glyph ink are worthless once the text
differs — comparing the `C` of one string against the `H` of another looks
exactly like a weight change. **Median stem width** is glyph-independent and is
the metric to use.

### Empty PostScript names cause substitution

`FontName.postscript` left empty makes Figma substitute a fallback even when
the family is present. Synthesise `Family-Style` (`Inter-Bold`,
`EBGaramond-Regular`) at every site, node-level and run-level alike.

---

## Sibling ordering

`parentIndex.position` is a fractional index that Figma compares **as a
string**. It must stay within printable ASCII, `!` (0x21) to `~` (0x7E).

A character outside that range rejects the **whole file** — not the node — with
`Internal error during import`. Nothing else reports it: the archive is intact,
the message parses, GUIDs are unique, no references dangle, and the deck
round-trips through our own reader unchanged.

Because positions are compared as strings, a naive overflow into a second
character reorders siblings: `"!"` sorts before `"!!"` sorts before `'"'`. The
scheme in `node-helpers.mjs` reserves `~` as a continuation marker so any
longer string sorts after every shorter one.

A bare `~` is a legitimate position and appears on the canvas in working decks.

---

## Image paints

### `paintFilter` is read; `filterColorAdjust` is ignored

`Paint` carries both. Sweeping `exposure` from -1 to 1 through each:

| field | luminance across the sweep |
|---|---|
| `paintFilter.exposure` | 9.5 → 138.5 |
| `filterColorAdjust.exposure` | 61.3 at every value — inert |

`filterColorAdjust` is also a kiwi **STRUCT**, so every field is required and a
partial object fails encoding outright. `paintFilter` is a MESSAGE and takes
partials.

### `paintFilter.brightness` does nothing

Inert at every value from -1 to 1. Figma's UI has no brightness control — the
control is **Exposure**. Mapping CSS `brightness()` onto `brightness` produces
an image that never brightens, which stays invisible until something else
darkens it.

### Exposure is a tone curve, not a gain

The important part is not that it is non-linear in CSS brightness — it is that
the two are different *kinds* of operation. CSS `brightness(m)` multiplies every
channel by m, identically at every tone. Figma's exposure lifts shadows hard and
rolls highlights off against the ceiling.

Measured on a 32-band ramp at exposure 0.5:

| input | 8 | 62 | 124 | 185 | 247 |
|---|---|---|---|---|---|
| output | 23 | 151 | 220 | 244 | 254 |
| ratio | 2.88 | 2.44 | 1.77 | 1.32 | 1.03 |

The per-tone multiplier spans 1.75 at that setting and 6.08 at exposure 1. So no
single exposure value reproduces a CSS brightness at every tone, and a residual
error against a browser render is **inherent rather than un-converged**. What can
be chosen is where the two agree; `EXPOSURE_CURVE` anchors on mid-tone (input 124
of 255), where photographic content concentrates.

| exposure | mid-tone ratio |
|---|---|
| -1 | 0.129 |
| -0.5 | 0.379 |
| -0.25 | 0.629 |
| 0 | 1.000 |
| 0.25 | 1.427 |
| 0.5 | 1.774 |
| 1 | 2.024 |

*Method note:* an earlier table measured mean luminance over a photograph and
recorded exposure 1 as 2.259. That conflated the curve with the histogram of what
was measured, and read high or low depending on how much of the image clipped —
the same setting reads 2.024 at mid-tone and 1.821 as a whole-ramp mean. A ramp
measures the curve; a photograph measures the curve *and* the photograph.

### Contrast clamps at ±0.5, and its range is narrow

Two facts, both from the same ramp export.

**Values beyond ±0.5 do nothing.** `-1`, `-0.75` and `-0.5` produce
byte-identical output; so do `0.5`, `0.75` and `1`.

**The reachable range is slope 0.767 to 1.115.**

| contrast | slope | pivot |
|---|---|---|
| -0.5 | 0.767 | 112.5 |
| -0.25 | 0.807 | 112.0 |
| 0 | 1.000 | — |
| 0.25 | 1.097 | 100.2 |
| 0.5 | 1.115 | 99.8 |

Note the pivot: near 100 for positive values and 112 for negative, not the 127.5
midpoint CSS stretches about. And CSS `contrast(1.15)` asks for slope 1.15, which
Figma **cannot reach at all** — strong values are clamped to the closest
reachable setting.

This is why mapping `contrast` as `amount - 1` was wrong twice over: it wrote
0.15 where the measured slope at 0.15 is about 1.058, and it would write values
up to 1 that do nothing past 0.5. `CONTRAST_CURVE` in `element-dispatch.mjs` is
the measured inverse.

*Method note:* mean luminance cannot measure contrast — it moves spread, not
average, and a full sweep read 69.8, 68.0, 61.3, 62.0, 62.2. Fitting a slope to a
banded grey ramp measures it directly. `scripts/build-paint-filter-probe.mjs`
builds the probe and `scripts/measure-paint-filter-probe.mjs` reads the export;
`test/core/probe-measurement.test.mjs` checks the instrument against ramps with
a known slope before either is trusted.

### `vibrance` is Saturation

Named `vibrance` in the schema, shown as **Saturation** in the UI. Its effect
on *mean luminance* is almost nil, so a flat luminance reading is not evidence
that a field is dead — it has to be checked visually or with a colour metric.

`contrast` responds but weakly on mean luminance, because contrast changes
spread rather than average. It is **not** calibrated; see the open issues.

### Blend modes are a 1:1 rename of CSS

`BlendMode` covers MULTIPLY, SCREEN, OVERLAY, DARKEN, LIGHTEN, COLOR_DODGE,
COLOR_BURN, HARD_LIGHT, SOFT_LIGHT, DIFFERENCE, EXCLUSION, HUE, SATURATION,
COLOR, LUMINOSITY — the same operations CSS `mix-blend-mode` has. Only
`plus-lighter` and `plus-darker` have no counterpart.

---

## Diagnosing an import that fails

Figma reports one line, `Internal error during import`, and names nothing.

The import dialog reports **per file** ("1 of 3 files imported"), so many
candidate decks can be tested in a single drag. That turns an opaque failure
into a bisection.

- Cut `<section>` elements out of the export's own `__bundler/template` to
  isolate slides. `remove-slide` only *marks* slides REMOVED and leaves their
  nodes in the file, so it cannot answer whether a slide's content is at fault.
  When re-embedding the template, escape every `</` as `</` or the payload
  closes the surrounding `<script>` early.
- Then thin the deck itself. **Verify first that a no-op round-trip still
  imports**, or the experiment measures the tooling rather than the deck.
- When dropping nodes, prune what they own. Blobs are referenced by index from
  any field named `*Blob`; leaving them behind keeps the quantity under test
  unchanged and produces a false negative.

`lib/core/validate-deck.mjs` runs on every write and catches this class before
a file is produced. Extend it when a new form of corruption appears — it is
worth more than a unit test, because it checks the output rather than our
agreement with ourselves.

---

## Comparing against the design

`test/fixtures/standalone-html/the-carbon-question/` holds both the standalone
export and the Claude Design PDF of the same deck. Render both to the same
pixel dimensions and compare per slide:

```
pdftoppm -r 192 -gray The-Carbon-Question.claude-design.pdf gt   # 720pt page
pdftoppm -r 72  -gray <compatibility-reference>.pdf fg                      # 1920pt page
```

Both DPIs are needed — the pages are different sizes, and rendering both at the
same DPI compares different scales and says nothing.

A slide near **8** mean absolute difference is ordinary antialiasing and
font-metric divergence. Well above it is worth investigating: that comparison
is what surfaced a photo reaching the deck unfiltered, on a slide sitting at
18 where its neighbours sat at 6.

---

## What a Claude Design export does

Not Figma behaviour, but the other half of the conversion, and measured the
same way.

### The slide may render at a fraction of the size it lays out at

A standalone export can put its slide inside a `deck-stage` custom element
whose shadow root holds a `div.canvas` carrying `transform: scale(...)`.
Measured on one export: `<section>` reported an `offsetWidth` of 1920 and a
`getBoundingClientRect().width` of 1732 — 0.902 — at viewport widths of 1920,
2128 and 2359 alike. It does not size itself to the viewport, so resizing the
surface to make the slide fit never converges and never reports a problem.

The failure is quiet in a specific way: `getBoundingClientRect()` sees the
transform and `getComputedStyle().fontSize` does not, so every coordinate
shrinks by 10% while every font size stays as authored. Nothing looks broken in
isolation. The user's description was "printed on a frame that was too small".

Two things about undoing it:

- **The transform is applied after first paint.** Anything that measures
  earlier — including a fit loop running before fonts load — reads a scale of
  exactly 1 and finds nothing to do.
- **An inline override is not enough.** The stage owns that element's style
  attribute and rewrites `style.transform` on its own schedule, which discards
  an inline `!important` along with the rest of the declaration. An author rule
  marked `!important` outranks any inline declaration that is not, so the
  override belongs in a stylesheet — and in the node's own root, since a rule
  in the document does not cross a shadow boundary.

Both are pinned in `test/slides/stage-scale-neutralize.test.mjs`.

### Blob references are the thing to check after any node-copying transform

`convertDeckToFig` used to renumber the blob table while remapping only three
fields — `fillGeometry`, `strokeGeometry` and `vectorNetworkBlob` — and missing
`derivedTextData.glyphs[].commandsBlob`, the cached glyph outlines and the bulk
of the references in a text-heavy deck. One fixture went from 73 blobs to 1
with node fields still pointing at indices up to 72, another from 245 to 36
with references up to 244.

Nothing in the file looks wrong when this happens. The archive is intact, the
message parses, every GUID is unique and no parent dangles — the only symptom
is `Internal error during import`. Worse than a reference pointing at nothing
is one that still lands in range: it resolves to the wrong blob and renders
silently as the wrong shape.

Fixed in openfig-core 0.3.8 by remapping every field named `*Blob` in a single
pass over the finished nodes, which is also why it must be the only pass: a
field remapped twice reads an output index as a source index.
`lib/core/validate-deck.mjs` checks this on every write.
