# Deck compatibility notes

Observed compatibility behavior for `.deck` files. Figma's public Plugin and
REST APIs describe a narrower surface than the file format carries, so this
document also records relevant file-format behavior.

*Method.* Everything below is observed from files this project writes and
reads: OpenFig generates a `.deck`, round-trips it, and measures the exported
result. Schema and API details come from Figma's published documentation and
from the structures the files carry themselves.

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

*Observed:* the replacement dropdown offers only the styles a family has —
Regular and Italic for Instrument Serif, no Bold.

### A weight in Google Fonts is not a named instance in Figma

Google serves Space Grotesk at 300, 400, 500, 600 and 700. Figma's font picker
offers Light, Regular, Medium and Bold for it — **no SemiBold**. So Google's
weight list cannot be used to decide which style names are safe to write.

The same pattern holds across families in the published font data: some expose
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

## Vector networks (`vectorNetworkBlob`)

`vectorData.vectorNetworkBlob` is the editable vector network: vertices,
segments carrying bezier tangent deltas, and regions grouping segment indices
into closed loops. Figma does not document the binary format; the layout below
is verified byte-exact on reference blobs (43 across 7 files, format
versions 101 and 106). It applies to `.fig` and `.deck` alike.

```
header   12B : vertexCount  segmentCount  regionCount        (u32 × 3)
vertex   12B : styleID(u32)  x(f32)  y(f32)
segment  28B : word0(u32)  startVertex(u32)  tsx(f32)  tsy(f32)
              endVertex(u32)  tex(f32)  tey(f32)
region       : packed(u32)  numLoops(u32)
               per loop: segCount(u32) + segIndex(u32) × segCount
```

`packed` decodes as `windingRule = packed & 1` and `styleID = packed >> 1`; in
every reference region `packed === 1`.

### Curve-ness is in the tangents, not a type field

The segment's leading `word0` is `0` on curved and straight segments alike —
verified on a deliberately straight 64-byte fixture and on curved segments
throughout. Same value, opposite geometry, so it cannot be a segment type. A
segment is straight **iff all four tangent components are zero**; otherwise it
is a cubic. The rasterizer once classified on that word and flattened every
curve into a polygon wherever the vector network was the only geometry
(stroke-only nodes). Pinned by `test/rasterizer/decode-vnb.test.mjs`.

### The vertex word is a styleOverrideTable index, not padding

The vertex's leading word is a `styleID` — an index into the node's
`vectorData.styleOverrideTable`, where `0` means "no override". Observed values
are `0`, `1` and `2`. It does not affect rendered geometry, but it is not padding
— a byte-identical round-trip of `curvy-squiggle.fig` failed at 13 of 16 vertex
slots until the value was preserved verbatim. openfig's own encoder once wrote
`4` here, a value Figma never emits.

It was read as a handle-mirroring enum for a long time, and that reading was
untestable against real-world files: the only non-zero value anywhere in the
corpus was `1`, and `VectorMirror.ANGLE` is also `1`. Adding a fixture with 26,491
more segments did not help, because the field simply never varied. A purpose-made
file settled it — three pen-tool points with the middle vertex given a corner
radius of 20 — whose vertices read `[0, 2, 1]` against a table entry
`{styleID: 2, cornerRadius: 20}`.

The general lesson, which cost most of a session: **a field that is constant
across all your evidence cannot be identified by gathering more of it.** Author
the smallest input that forces it to vary.

### A rotated layout looks correct until you round-trip it

openfig's original encoders wrote a one-word rotation of this layout: a 16-byte
header, vertices as `[x, y, mirroring]`, segments as `[startVertex, …, type]`,
and a per-region trailing word. The extra header word and the field rotation
cancel, so x/y and tangents land at **identical absolute offsets** under both
layouts. Decoded coordinates look right, the byte count comes out exact, and
even a geometry comparison against a trusted oracle agrees — none of these can
distinguish the layouts. Two things can: a blob with `regionCount == 0` (its
total size then pins the header at 12 bytes), and a byte-identical
decode→re-encode round-trip. The round-trip is the acceptance criterion
openfig-core now holds the format to (43/43), because it needs no theory of what
each field means — only that we put back what we found.

There are **two** emitters, and both now write the layout above. `openfig-core`'s
`encodeVectorNetworkBlob` is the library API; `_buildVectorNetworkBlob` in
`lib/slides/api-core.mjs` is the one every `.deck` this CLI produces actually goes
through, and it builds vector networks independently rather than calling into
openfig-core. Fixing only the library would have left every user-facing deck
carrying the old fingerprint, so the two are pinned separately:
`test/slides/vector-network-layout.test.mjs` holds this package's emitter to the
layout, and openfig-core's round-trip test holds the library's.

Note that byte-exact consumption alone does not pin the field order — a rotated
vertex record has the same 12-byte stride and still consumes the blob exactly.
That test also asserts the decoded coordinates span a real bounding box, which is
what a rotation actually breaks: it reads an integer word where a float belongs
and the geometry collapses.

*Method note:* the rotated layout was a durability cliff, not a rendering bug.
The format is undocumented; Figma has every incentive to stay compatible with
bytes its own libraries write and none to preserve anything else. A single scan
for the value `4` separated openfig-written files from reference ones, and
the region block was worse than a fingerprint — it was a structure Figma would
misparse on import. "No harm observed today" is the weakest available guarantee
for an undocumented format; byte-identical round-tripping is the one that holds
even where the format is not fully understood.

---

## Image paints

### `paintFilter` is read; `filterColorAdjust` is ignored

`Paint` carries both. Round-tripping a deck with `exposure` swept from -1 to 1
through each field:

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

Measured on an exported 32-band ramp deck at exposure 0.5:

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

The exposure mismatch also appears with no grayscale, contrast, or blend mode:

| CSS brightness | native Exposure | mean effect error | spread effect error |
|---|---|---|---|
| 1.18 | 0.1034 | -1.9% | **-16.9%** |
| 1.55 | 0.3292 | -4.0% | **-30.8%** |

At `brightness(1.55)`, CSS clipping makes the photograph's spread contract by
about 6.8% (15.73 → 14.66); native Exposure contracts it by about 35.5%
(15.86 → 10.23). The earlier shorthand that CSS brightness necessarily
"expands spread by 1.55×" was therefore wrong for clipped photographic content.
The relevant cause is narrower and stronger: **native Exposure compresses this
histogram far more than CSS's linear gain followed by clipping.**

On the converted fixture, compared with the design reference:

| region | mean vs design | stdev vs design |
|---|---|---|
| portrait crop, `grayscale(1) contrast(1.12) brightness(1.18)` | −3.9% | −3.0% |
| photo band, `grayscale(1) contrast(1.15) brightness(1.55)` | +1.5% | −15.9% |

These remain useful historical end-to-end observations, but the slide 7 row
was not a filter-only measurement. At the time, the source's
`object-position: 50% 58%` and directional `mask-image` were dropped, so the two
regions contained different source pixels and alpha coverage.

The converter writes the percentage position as the native image crop
transform and represents a single linear `mask-image` as an editable ALPHA mask
with gradient stops. The original image bytes and `paintFilter` remain editable.
The old `+1.5% / −15.9%` pair therefore should not be treated as the current
residual.

Highlights and Shadows provide more native compensation than Contrast alone.
For the complete strong-brightness chain, the previous mapping
(`vibrance: -1`, `contrast: 0.5`, `exposure: 0.3292`) and the best tested
refinement measured:

| native treatment | ramp RMSE | mean vs CSS | spread vs CSS |
|---|---:|---:|---:|
| current mapping | 14.61 | +1.26% | −14.45% |
| add `highlights: 1`, `shadows: -0.75` | **9.43** | **−0.17%** | −6.64% |
| add `highlights: 1`, `shadows: -1` | 9.59 | −1.13% | **−4.96%** |

The first refinement cuts transfer-curve RMSE by 35% and is the best overall
curve match tested; the second preserves slightly more spread at the cost of
mean accuracy.

The production mapping uses two brightening anchors:

| CSS brightness | Exposure | Highlights | Shadows | reason |
|---|---:|---:|---:|---|
| 1.18 | 0.1000 | 0.55 | -0.15 | mild brightness fit |
| 1.55 | 0.3292 | 1.00 | -0.75 | best complete-chain fit |

Values between identity, 1.18, and 1.55 are linearly interpolated. Above 1.55,
Highlights and Shadows clamp at the strong anchor while the calibrated Exposure
curve continues; brightness at or below 1 keeps the pre-existing Exposure-only
path. This makes the refinement automatic and bounded rather than applying the
slide 7 values to every image.

On the isolated photograph at the mild anchor, the extra controls move mean
effect error from -1.90% to +0.09% and spread effect error from -16.86% to
-3.05%. The output is still one original IMAGE paint with editable
`paintFilter` values. No pixels are baked and no hosted resource or user action
is required.

### Five-photo generalization check

The two anchors above were subsequently checked against five CC0 photographs
chosen to exercise different histograms: a low-key monochrome portrait,
daylight landscape, night scene, high-dynamic-range interior, and an extremely
saturated orange flower. Every page placed the CSS pixel target beside the
original photograph carrying the editable native mapping. Unfiltered control
pairs were byte-identical after export, so the reported residual is the filter
translation rather than crop or measurement noise.

| condition | photos | mean absolute mean error | mean absolute spread error |
|---|---:|---:|---:|
| unfiltered control | 5 | 0.00% | 0.00% |
| `brightness(1.18)`, current tone refinement | 5 | 1.83% | 3.06% |
| same, excluding the saturated flower | 4 | **0.37%** | **0.27%** |
| `grayscale(1) contrast(1.15) brightness(1.55)` | 5 | 5.52% | 10.69% |

The strong chain remains a structural approximation: every photograph had too
little spread, from -6.09% to -18.83%, even when its mean was close. This is the
same native Contrast and Exposure ceiling described above, now observed across
dark, bright, neutral, and saturated photographs rather than one fixture.

The mild chain generalizes exceptionally well to four photographs, but the
saturated flower is a real outlier: +7.70% mean, +14.23% spread, and a visible
shift from saturated orange toward pale red. An Exposure-only candidate improves
that image to +2.81% mean and -2.68% spread. It is **not** a safe global
replacement: across all five photographs its mean absolute spread error is
5.04%, and it loses 7.96% of the landscape's spread and 8.67% of the interior's.

The outlier has a deterministic color-space signal. CSS `grayscale(1)` computes
its weighted matrix directly on gamma-encoded RGB. Native full desaturation
preserves linear-light luminance and encodes the resulting neutral value back
to sRGB. The existing synthetic color-patch probe therefore produces very
different gray levels while reaching zero chroma in both cases:

| source patch | CSS gray | native gray | native vs CSS |
|---|---:|---:|---:|
| red | 68.2 | 116 | +70.0% |
| blue | 39.0 | 73 | +87.1% |
| magenta | 83.2 | 132 | +58.6% |
| orange | 119.7 | 137 | +14.4% |
| yellow | 217.0 | 224 | +3.2% |

Across the normalized stock photographs, mean absolute CSS-vs-native grayscale
difference is 0 to 1.18 levels for the first four and 15.06 for the flower.
The flower's mean gray is 134.00 under the CSS matrix and 149.06 under the
native linear-light transform. Bright red and magenta photographs show that
the whole-image difference alone is not a safe selector: their large difference
does not mean that removing the native Highlights correction improves them.

### Eleven-photo source-aware validation

The production selector therefore measures where the difference occurs, not
only how large it is. It decodes an aspect-preserving sample no larger than
64 pixels on its longest side and compares the CSS gamma-encoded grayscale
value with linear-light luminance. Each absolute per-pixel difference is
weighted continuously by the CSS gray level: no contribution below level 96,
full contribution at level 160, and a linear fade between them. Transparent
pixels are weighted by alpha.

That highlight-weighted difference predicts when the native Highlights
correction will amplify a source-color mismatch. Ordinary photographs and the
dark red and magenta sources measure 0–0.81 levels; blue sky measures 2.37,
mixed bright colors 3.61, and the bright saturated flower 8.97. OpenFig maps
that signal continuously from zero risk at 2 levels to full risk at 6 levels.
A complementary whole-image band handles a large difference concentrated
below highlights: it fades from zero at 15 levels to full at 22, gated by the
inverse highlight risk. This separates the magenta source at 23 levels from the
next non-highlight source at 9.15 without testing its hue or identity.

For color-preserving brightening, the risk attenuates the extra Exposure
correction, Highlights, and Shadows toward the calibrated Exposure-only
treatment. It is not a binary image classification:

- zero risk retains the established global tone fit;
- intermediate risk blends continuously between the two fits;
- full risk uses Exposure only;
- strong below-highlight risk adds the measured bounded Exposure/Shadow
  correction while retaining Highlights;
- partial grayscale scales the source influence by the color that remains;
- full grayscale keeps the existing complete-chain calibration.

If source decoding fails, conversion falls back to the established global tone
fit. Analysis changes only the numeric `paintFilter`; the original image stays
the node's one IMAGE asset. There is no baked replacement, second image,
network request, hosted resource, user toggle, or post-import step. The same
64-pixel analysis and thresholds run in the Node and browser conversion hosts.
Across the eleven public sources, their reported profile values differ by at
most 0.38 of one 8-bit level, inside the documented 0.5-level host tolerance;
every source remains on the same side of the selector boundaries.

The selector was checked on eleven CC0 photographs spanning neutral scenes,
dark and bright histograms, skin, red, blue, magenta, green, and mixed
saturated colors. Unmodified control pairs were identical, establishing zero
crop or comparison noise.

| condition | photos | mean absolute mean error | mean absolute spread error | mean RMSE | mean SSIM | worst RMSE |
|---|---:|---:|---:|---:|---:|---:|
| unmodified control | 11 | 0.00% | 0.00% | 0.00 | 1.0000 | 0.00 |
| previous global mapping | 11 | 2.29% | 2.80% | 13.41 | 0.9908 | 48.29 |
| automatic source-aware mapping | 11 | **1.04%** | **1.24%** | **11.61** | **0.9926** | **35.32** |
| Exposure-only everywhere | 11 | 2.55% | 7.75% | 11.90 | 0.9888 | 35.32 |

On the saturated flower, source-aware mapping moves mean/spread error from
`+7.70% / +14.23%` to `+2.81% / -2.68%`. On mixed bright colors it moves
`+3.30% / +6.00%` to `+1.93% / +0.53%`; blue sky improves modestly. The red,
green, skin, and four neutral photographs retain the global mapping, avoiding
the regressions an Exposure-only global policy causes. The below-highlight path
moves magenta from `+7.96% / -3.41%` to `-0.88% / -2.89%`.

Every automatic result is inside the validation gate: the worst absolute mean
discrepancy is 2.81% and the worst absolute spread discrepancy is 3.80%, both
below 5%. This remains a calibrated approximation rather than pixel identity;
the native transfer functions still cannot express the CSS operation exactly.

The reproducible builders and scorer are
`scripts/build-paint-filter-stock-probe.mjs` and
`scripts/measure-paint-filter-stock-probe.mjs`. The source-aware mode includes
the unmodified controls, previous global mapping, automatic selector, and
Exposure-only comparison.

Public-domain source record:

- [Bearded man smoking pipe](https://commons.wikimedia.org/wiki/File:Bearded_man_smoking_pipe-3013924.jpg) - CC0 1.0
- [Landscape, north Euboea, Greece](https://commons.wikimedia.org/wiki/File:Landscape_north_Euboea_Greece.jpg) - CC0 1.0
- [Snowfall over Brofjorden and Preemraff](https://commons.wikimedia.org/wiki/File:Snowfall_at_night_over_Brofjorden_and_Preemraff_oil_refinery.jpg) - CC0 1.0
- [Interior of Sainte-Anne-de-Beaupre](https://commons.wikimedia.org/wiki/File:Interior_of_the_Basilica_of_Sainte-Anne-de-Beaupr%C3%A9.jpg) - CC0 1.0
- [Gazania krebsiana](https://commons.wikimedia.org/wiki/File:Gazania_krebsiana,_Quebec_city,_Quebec,_Canada_131.jpg) - CC0 1.0
- [Blooming red flower](https://commons.wikimedia.org/wiki/File:Blooming_red_flower.jpg) - CC0 1.0
- [Blue sky image](https://commons.wikimedia.org/wiki/File:Blue_sky_image.jpg) - CC0 1.0
- [Magenta color rose](https://commons.wikimedia.org/wiki/File:Magenta_color_rose.jpg) - CC0 1.0
- [Green leaves 1](https://commons.wikimedia.org/wiki/File:Green_leaves_1.jpg) - CC0 1.0
- [Portrait (90606475)](https://commons.wikimedia.org/wiki/File:Portrait_(90606475).jpeg) - CC0 1.0
- [Colorful Bell Peppers](https://commons.wikimedia.org/wiki/File:Colorful_Bell_Peppers_(Unsplash).jpg) - CC0 1.0

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

`contrast` responds weakly on mean luminance because contrast changes spread
rather than average. Its slope mapping is calibrated above.

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
Plus Lighter arrangements, as stacked image paints or stacked nodes, leave the
ramp unchanged. Adding Highlights and Shadows to Exposure improves a
brightness-only ramp but does not reproduce it:

| CSS target | treatment | ramp MAE | maximum channel error |
|---|---|---:|---:|
| `brightness(1.18)` | Exposure only | 7.13 | 27 |
| `brightness(1.18)` | best brightness-only tone fit | 2.53 | 15 |
| `brightness(1.55)` | Exposure only | 13.84 | 30 |
| `brightness(1.55)` | best brightness-only tone fit | 4.41 | 19 |

Those controls are approximation levers, not an exact implementation. They are
the product implementation because they preserve the original asset and native
editability. Automatic reversible dual-fill baking is not the default and
should not be presented as the portable solution.

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
