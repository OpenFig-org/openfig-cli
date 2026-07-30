# What Figma actually does

Observed compatibility behavior for `.deck` files. Figma's public Plugin and
REST APIs describe a narrower surface than the file format carries, so this
document also records relevant file-format behavior.

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

Figma applies variable weights continuously:

| written | relative ink |
|---|---|
| `Regular`, no variation | 1.000 |
| `Regular` + wght 500 | 1.263 |
| `Regular` + wght 600 | 1.392 |
| `Bold`, no variation | 1.480 |

Four distinct, monotonically increasing values: the axis is applied
**continuously**, not snapped to the nearest named instance.

Three further properties hold:

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

### Native Color Adjust is self-contained

A native adjusted image contains one ordinary IMAGE paint over its original
asset. The adjustments are serialized directly on that paint:

```json
{
  "paintFilter": {
    "exposure": 0.23,
    "contrast": -0.15,
    "vibrance": 0.43,
    "temperature": 0,
    "tint": 0.20,
    "highlights": 0.32,
    "shadows": -0.39
  }
}
```

There was no adjusted image asset, second fill, shader ID, effect, plugin data,
library reference, or account-bound resource. The archive contained only the
original JPEG and its 320×240 thumbnail. The UI label **Saturation** therefore
maps to the kiwi field `vibrance`.

OpenFig preserves each `paintFilter` value through a decode/re-encode
round-trip. Native Color Adjust is therefore writable by OpenFig and editable
after import while remaining self-contained and independent of hosted shaders.

### Exposure is a tone curve, not a gain

The important part is not that it is non-linear in CSS brightness — it is that
the two are different *kinds* of operation. CSS `brightness(m)` multiplies every
channel by m, identically at every tone, then clips values that leave the
channel range. Figma's exposure lifts shadows hard and rolls highlights off
against the ceiling. CSS's clipping means brightness does not necessarily
expand a real photograph's measured spread even though the unclipped operation
is a gain; the reliable distinction is the shape of the two transfer functions.

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

### What the two together can and cannot reproduce

The exposure mismatch has been isolated on the real slide 7 photograph, with no
grayscale, contrast, or blend mode. Each host's filtered result was divided by
its own unfiltered reference first, removing static differences in JPEG colour
management, crop, and PDF resampling:

| CSS brightness | Figma exposure | mean effect error | spread effect error |
|---|---|---|---|
| 1.18 | 0.1034 | -1.9% | **-16.9%** |
| 1.55 | 0.3292 | -4.0% | **-30.8%** |

The unfiltered Figma and Chromium references agreed to -0.21% in mean and +0.76%
in spread, so the filtered deltas are not a baseline-rendering mismatch. At
`brightness(1.55)`, CSS clipping makes the photograph's spread contract by
about 6.8% (15.73 → 14.66); Figma exposure contracts it by about 35.5%
(15.86 → 10.23). The earlier shorthand that CSS brightness necessarily
"expands spread by 1.55×" was therefore wrong for clipped photographic content.
The measured cause is narrower and stronger: **Figma exposure compresses this
histogram far more than CSS's linear gain followed by clipping.**

On the converted fixture, compared with the design reference:

| region | mean vs design | stdev vs design |
|---|---|---|
| portrait crop, `grayscale(1) contrast(1.12) brightness(1.18)` | −3.9% | −3.0% |
| photo band, `grayscale(1) contrast(1.15) brightness(1.55)` | +1.5% | −15.9% |

These remain useful end-to-end observations, but the slide 7 row is not a
filter-only measurement. The source uses `object-position: 50% 58%` and a
directional `mask-image`; the converted node is center-cropped and has no mask.
The two regions therefore contain different source pixels and alpha coverage.
That separate conversion gap is tracked as openfig-cli#19. The isolated
brightness result above remains valid because each host's filtered image was
normalized against its own unfiltered rendering before comparison.

Highlights and Shadows provide more native compensation than Contrast alone.
On a neutral ramp for the complete slide 7 chain, the current mapping
(`vibrance: -1`, `contrast: 0.5`, `exposure: 0.3292`) and the best tested
refinement measured:

| native treatment | ramp RMSE | mean vs CSS | spread vs CSS |
|---|---:|---:|---:|
| current mapping | 14.61 | +1.26% | −14.45% |
| add `highlights: 1`, `shadows: -0.75` | **9.43** | **−0.17%** | −6.64% |
| add `highlights: 1`, `shadows: -1` | 9.59 | −1.13% | **−4.96%** |

The first refinement cuts transfer-curve RMSE by 35% and is the best overall
curve match tested; the second preserves slightly more spread at the cost of
mean accuracy. Neither is exact, and this one strong-brightness chain is not
enough to define a general mapping for every `brightness()` value. It does prove
that the current native approximation has measurable room to improve without
baking the image. A production mapping still needs calibration across the
supported brightness range, followed by end-to-end validation after #19 is
fixed. Tracked as openfig-cli#20.

### Contrast clamps at ±0.5, and its range is narrow

Two facts define the native range.

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

Mean luminance does not characterize contrast: contrast moves spread rather
than average. The relevant quantity here is the fitted transfer-curve slope.

### `vibrance` is Saturation

Named `vibrance` in the schema, shown as **Saturation** in the UI. Its effect
on *mean luminance* is almost nil, so a flat luminance reading is not evidence
that a field is dead — it has to be checked visually or with a colour metric.

The endpoint used for CSS `grayscale(1)` is verified: `vibrance: -1` fully
desaturates. Across saturated colours and neutral controls:

| vibrance | mean coloured-patch chroma vs reference |
|---|---|
| 0 | 1.0000 |
| -0.25 | 0.6436 |
| -0.5 | 0.4235 |
| -0.75 | 0.2200 |
| -1 | **0.0000** |

At `-1`, every saturated patch exported with exactly equal R, G, and B values;
maximum residual chroma was 0 and the neutral-control noise floor was also 0.
Therefore `grayscale(1) → vibrance: -1` is valid and residual colour cannot
explain the filtered photo's spread deficit. This establishes the full
desaturation endpoint, not that partial CSS `grayscale(amount)` values follow
the same curve as partial negative vibrance.

`contrast` responds but weakly on mean luminance, because contrast changes
spread rather than average. It is **not** calibrated; see the open issues.

### Blend modes are a 1:1 rename of CSS

`BlendMode` covers MULTIPLY, SCREEN, OVERLAY, DARKEN, LIGHTEN, COLOR_DODGE,
COLOR_BURN, HARD_LIGHT, SOFT_LIGHT, DIFFERENCE, EXCLUSION, HUE, SATURATION,
COLOR, and LUMINOSITY — the same operations CSS `mix-blend-mode` has. The schema
also names `LINEAR_DODGE` and `LINEAR_BURN`, but they are not safe aliases for
CSS `plus-lighter` and `plus-darker`: the additive image probes below rendered
unchanged. The converter therefore leaves those two CSS modes unmapped.

### Custom shaders prove capability, not portable delivery

Figma does support programmable image effects. They are a separate feature from
the native **Color adjust** panel, which is why the limits above do not describe
the full rendering model.

The public Plugin API exposes shaders through
[`listAvailableShaders`](https://developers.figma.com/docs/plugins/api/properties/figma-listavailableshaders/)
and [`importShaderById`](https://developers.figma.com/docs/plugins/api/Shader/).
After a shader has been imported into the file, a plugin can attach it to
`node.effects` as a `SHADER` effect and assign its editable properties by
property-definition ID.

A three-operation shader can implement the CSS primitives directly in sRGB:

```text
brightness(a): rgb = clamp(rgb * a)
contrast(a):   rgb = clamp((rgb - 0.5) * a + 0.5)
grayscale(a):  rgb = mix(rgb, dot(rgb, [0.2126, 0.7152, 0.0722]), a)
```

The shader exposes an Operation dropdown and an Amount slider. Its native
results match the equations after byte rounding:

| probe | representative Figma result |
|---|---|
| 50% grayscale of red | `(155, 27, 27)` |
| 150% brightness of `(116, 116, 116)` | `(174, 174, 174)` |
| 50% contrast of black / white | `(64, 64, 64)` / `(191, 191, 191)` |
| 50% contrast, then 150% brightness of `(116, 116, 116)` | `(183, 183, 183)` |

The last sample also establishes execution order: Figma applies shader effects
from top to bottom in the Effects list. Writing one shader instance per parsed
CSS operation therefore preserves CSS's left-to-right chain order.

Figma Design-to-Slides transfer preserves both instances, their order, and
their control values. The public Plugin API and binary format use different
names for the same object:

| public Plugin API | `.deck` kiwi message |
|---|---|
| effect type `SHADER` | `EffectType.CUSTOM` |
| shader `id` | `customEffectId.assetRef` |
| `properties` | `componentPropAssignments` |
| imported shader metadata | hidden `CODE_COMPONENT` with `codeObjectType: CUSTOM_EFFECT` |

Files containing the effect use a 627-definition kiwi schema; OpenFig's current
authored schema has 550 definitions and lacks the custom-effect fields. Schema
support is therefore a concrete implementation task, not an unknown rendering
problem.

There is one decisive distribution constraint. The `.deck` contains the
versioned shader reference and property definitions, but not the shader source.
The hidden `CODE_COMPONENT` had no `sourceCode` or `blobRef`, and the archive
contained no shader file. This agrees with Figma's API contract: a shader must
be owned by the user or available through a subscribed library before it can be
imported.

Therefore the shader proves that Figma's renderer is capable of the exact
operation, but it is **not an access-independent OpenFig solution**. A generated
deck must not depend on a particular Figma user, library subscription, plugin,
API session, or remotely hosted effect.

The access-independent, editable implementation is Figma's native
`paintFilter`. OpenFig keeps the untouched source as the node's single IMAGE
paint and writes calibrated Exposure, Contrast, and Saturation values onto it.
The deck opens already adjusted, and a designer can continue editing those
values in Figma's standard Color Adjust panel. No plugin, library, shader,
second image payload, or user action is required.

This deliberately prioritizes post-conversion editability over byte-identical
CSS rendering. Figma's transfer functions and fixed adjustment pipeline cannot
preserve every CSS curve or arbitrary operation order. OpenFig maps
`brightness()`, `contrast()`, `grayscale()`, and `saturate()` to the closest
native controls. A chain containing an operation with no native field, such as
`sepia()`, is reported instead of silently baking the photograph. The two
legacy alpha-mask operations `invert(1)` and `brightness(0) invert(1)` remain
raster fallbacks because Figma exposes no equivalent adjustment.

Standard native layer combinations do not add a fourth exact option. Two-copy
Plus Lighter probes, tested both as stacked image paints and stacked nodes,
produced ramp pixels identical to the unfiltered reference. Adding Highlights
and Shadows to Exposure improved a brightness-ramp fit but did not reproduce it:

| CSS target | native treatment | ramp MAE | maximum channel error |
|---|---|---:|---:|
| `brightness(1.18)` | Exposure only | 7.13 | 27 |
| `brightness(1.18)` | Exposure + Highlights/Shadows | 2.53 | 15 |
| `brightness(1.55)` | Exposure only | 13.84 | 30 |
| `brightness(1.55)` | Exposure + Highlights/Shadows | 4.41 | 19 |

Those controls are useful approximation levers, not an exact implementation.
They are nevertheless the product implementation because they preserve the
original asset and Figma-native editability. Automatic reversible dual-fill
baking is not the default and should not be presented as the portable solution.

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

`test/fixtures/standalone-html/the-carbon-question/` holds the standalone
design source and its design-reference PDF. Compare it with an approved
compatibility-reference PDF at the same pixel dimensions:

```
pdftoppm -r 192 -gray The-Carbon-Question.claude-design.pdf gt   # 720pt page
pdftoppm -r 72  -gray <compatibility-reference>.pdf fg           # 1920pt page
```

Both DPIs are needed — the pages are different sizes, and rendering both at the
same DPI compares different scales and says nothing.

A slide near **8** mean absolute difference is ordinary antialiasing and
font-metric divergence. Well above it is worth investigating: that comparison
is what surfaced a photo reaching the deck unfiltered, on a slide sitting at
18 where its neighbours sat at 6.

### But a pixel difference does not measure layout fidelity

**MAE mostly ranks how much text a slide has.** It counts every antialiased glyph
edge, and the two renderers disagree slightly on every one of them, so a dense
appendix slide scores worse than a chart slide even when both are correct.

Measured, and worth keeping because it cost a wrong conclusion. A real defect was
found on the densest slide of a 23-slide deck: a paragraph wrapped one word early
in Figma, shifting every line below it. Fixed and confirmed by eye — content,
wrapping and line breaks then matched the design exactly. The slide's MAE did not
move at all: **10.0 before, 10.0 after.** Of that 10.0, about 1.4 was a two-pixel
registration offset in the comparison itself, and the rest was glyph rasterisation
on a slide carrying more text than any other. A control slide with less text sat
at 2.2 through the same pipeline.

The same reading also produced a false lead. Ranking slides by MAE nominated
21, 04, 18, 20 and 06 as "worst, probably more to find" — that list is simply the
five most text-heavy slides. The one genuinely broken slide the user reported
(a label wrapping onto two lines and colliding with the caption below) sat
**mid-pack at 2.4**.

So use MAE for what it is good at — a photo that lost its filter, a missing
element, a shifted block — and not for line breaking or text placement. For those,
compare the things that actually encode them:

- **wrap points**: the text of each rendered line, or the count of lines per
  paragraph
- **text extents**: the ink bounding box of a run against its emitted box
- **element positions**: node geometry against the design's own coordinates

Those would have flagged the one-word difference immediately and stayed quiet
about the other 22 slides.

### Ink bands per element: the instrument that works

Read a column of the render row by row, count dark pixels, and group the runs.
Each run is one element's ink, so the same slide compared against the design
gives a per-element error instead of one number for the page.

Proven on the slide that prompted this. Whole-page MAE rated it **2.4,
"excellent"**, while a display number sat 10px out of place and crowded the label
under it:

| element | design | before | after |
|---|---|---|---|
| title, 52px | 90–129 | 90–130 | 89–129 |
| pie chart | 304–590 | 304–590 | 304–590 |
| **80px number** | 624–683 | 634–693 (**+10**) | **624–683** |
| label, 22/30 | 708–724 | 706–721 (−2) | 708–723 |
| caption, 22/30 | 816–832 | 814–829 (−2) | 816–831 |

The gap between the number and its label: 25px in the design, 13px before, 25px
after. Every element within 1px, five of eight exact.

It also predicts. The three errors above were derived from Chromium's ink offset
within each element box *before* anything was changed — −10px, +2px, +2px — and
matched the three measured errors. A summary metric cannot do that, because it
cannot say which element is wrong or by how much.

```js
// ink rows in a column, grouped into bands
const { data, info } = await sharp(png).greyscale().raw()
  .toBuffer({ resolveWithObject: true });
for (let y = 0; y < info.height; y++) {
  let ink = 0;
  for (let x = x0; x < x1; x++) if (data[y * info.width + x] < 190) ink++;
  rows.push(ink);   // >= 3 is a row with content; runs of them are elements
}
```

Pick a column that contains one stack of elements — a full-width scan merges
everything into one band. Compare the design and the export at the same pixel
size, and remember the design page may be letterboxed.

---

## What a Claude Design export does

Not Figma behavior, but the other half of the conversion.

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
