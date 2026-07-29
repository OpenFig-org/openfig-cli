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

### Exposure is not linear in CSS brightness

Measured, as a multiple of the unadjusted image:

| exposure | luminance ratio |
|---|---|
| -1 | 0.155 |
| -0.5 | 0.436 |
| -0.25 | 0.684 |
| 0 | 1.000 |
| 0.25 | 1.351 |
| 0.5 | 1.697 |
| 1 | 2.259 |

So CSS `brightness(1.55)` is exposure **0.394**, not 0.55. The table lives in
`element-dispatch.mjs` as `EXPOSURE_CURVE`.

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
