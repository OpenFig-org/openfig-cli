# Fonts

## How resvg-wasm Matches Fonts

resvg-wasm is the SVG-to-PNG renderer. It does **not** load system fonts — all
fonts must be provided as buffers at render time via the `fontBuffers` option.

resvg matches SVG `font-family` attributes against the font's **internal name
table** (OpenType nameID 1 = family name). This means:

- The CSS/file name doesn't matter — only the name inside the binary font file
- If nameID 1 says `"Inter Medium"` but your SVG says `font-family="Inter"`,
  resvg **will not match** that font
- Fonts must have the exact family name that the SVG will reference

This is why some fonts need patching (see Darker Grotesque below).

## Built-in Fonts

The rasterizer ships with these fonts, loaded automatically:

| Font | Weights | Source | Notes |
|------|---------|--------|-------|
| Inter | 400, 500, 600, 700 normal + 400, 700 italic | `fonts/inter-v3-*.woff2` | Figma's bundled version (v3.015) |
| Darker Grotesque | 400, 500, 600, 700 | `fonts/darker-grotesque-patched-*.woff2` | Patched nameID 1 |
| Irish Grover | 400 | `@fontsource/irish-grover` | nameID 1 already matches |

## Inter v3 vs v4 — Why It Matters

Figma bundles **Inter v3.015** as a variable font (`Inter.var.woff2`, axes: `wght`
100-900, `slnt` -10 to 0). This is the version used for all "Inter" text in Figma.

`@fontsource/inter` ships **v4.x**, which has redesigned italic glyphs — most
noticeably the lowercase "a" changes from a two-story form to a single-story form.
This is visually obvious in side-by-side comparison and measurably drops SSIM.

### Version detection

The rasterizer checks for Inter v3 static fonts in `lib/rasterizer/fonts/`:

```
inter-v3-400-normal.woff2
inter-v3-500-normal.woff2
inter-v3-600-normal.woff2
inter-v3-700-normal.woff2
inter-v3-400-italic.woff2
inter-v3-700-italic.woff2
inter-v3-meta.json          ← {"version": "Version 3.015;git-7f5c04026"}
```

If all 6 files are present, they're used. The meta file's `version` field is
compared against `KNOWN_FIGMA_INTER_VERSION` — a mismatch emits a stderr warning
but is not a hard error (different Figma versions may bundle slightly different
Inter builds).

If v3 fonts are missing, the rasterizer falls back to `@fontsource/inter` (v4.x)
with a warning to stderr. Rendering still works, but italic glyphs will differ.

### How the v3 fonts were generated

1. **400 Regular, 700 Bold, 400 Italic, 700 Bold Italic** — from the
   [Inter 3.15 release](https://github.com/rsms/inter/releases/tag/v3.15)
   static WOFF2 files. These have nameID 1 = `"Inter"` and work directly.

2. **500 Medium, 600 SemiBold** — The release ZIP has these as `"Inter Medium"`
   and `"Inter Semi Bold"` (nameID 1), which resvg can't match as `font-family="Inter"`.
   These were generated using fontTools `varLib.instancer` from `Inter.var.woff2`:

   ```bash
   pip install fonttools brotli
   fonttools varLib.instancer Inter.var.woff2 wght=500 slnt=0  # → Medium
   fonttools varLib.instancer Inter.var.woff2 wght=600 slnt=0  # → SemiBold
   ```

   After instancing, nameIDs 1/2/4/6 were patched to `"Inter"` and OS/2
   `usWeightClass` set to the correct value (500, 600).

### Version string: nameID 5

The authoritative version signal is OpenType **nameID 5** (version string).
For Figma's bundled Inter: `"Version 3.015;git-7f5c04026"`. This is stored in
`inter-v3-meta.json` and checked at load time.

We use version strings rather than hash-based detection because building a
database of known font hashes doesn't scale — there are too many valid font
builds for any given family.

## Darker Grotesque — Google Fonts Source + Name Patching

**Important**: `@fontsource/darker-grotesque` WOFF2 files have visibly thinner
glyph outlines than the Google Fonts TTF originals, despite the same version
string (`Version 1.000;gftools[0.9.28]`). Figma downloads from Google Fonts,
so we must use those TTFs as the source.

The patched WOFF2 files in `fonts/darker-grotesque-patched-*.woff2` are:

1. **Downloaded from Google Fonts API** as TTF (the authoritative source)
2. **nameID 1 patched** from weight-specific names (e.g. `"Darker Grotesque Medium"`)
   to just `"Darker Grotesque"` so resvg can match `font-family="Darker Grotesque"`
3. **Converted to WOFF2** via fontTools

The `usWeightClass` in the OS/2 table is preserved from the original (400, 500,
600, 700), so resvg selects the correct weight file.

### Why not @fontsource?

@fontsource repackages Google Fonts but may re-encode or subset the font files.
The resulting WOFF2 files can have different glyph outlines from the originals.
For Darker Grotesque, this manifests as noticeably thinner strokes — weight 500
from @fontsource looks like 400 from Google Fonts. Using the Google Fonts TTFs
directly fixed SSIM for slide 7 from 0.72 to 0.99.

## Automatic Font Resolution

When a `.deck` uses fonts not bundled with the rasterizer, `resolveFonts()` can
find and register them automatically — no manual setup needed.

```javascript
import { resolveFonts } from './font-resolver.mjs';

const deck = await FigDeck.fromDeckFile('slides.deck');
const { resolved, failed } = await resolveFonts(deck);
// resolved: ["Roboto", "Montserrat"]  — downloaded + registered
// failed:   ["MyCustomFont"]          — not found anywhere
const pngs = await renderDeck(deck);
```

### Resolution pipeline

For each font family used in the deck (that isn't already built-in):

```
1. Cache hit?     ~/.openfig/fonts/<family>-<weight>-normal.ttf
       ↓ miss
2. Google Fonts   fetch CSS API → download TTF → patch nameID 1 → cache
       ↓ miss
3. System fonts   scan OS font dirs for matching files → register
       ↓ miss
4. Fallback       render in Inter (default), emit warning to stderr
```

### Step 1: Deck scanning

`scanDeckFonts(deck)` walks every node and collects `Map<family, Set<weight>>`.
It reads font info from:

- `node.fontName.family` + `node.fontName.style` (TEXT nodes)
- `textData.styleOverrideTable[].fontName` (per-run style overrides)
- `nodeGenerationData.overrides[1].fontName` (SHAPE_WITH_TEXT nodes)

Weight is derived from the style string: "Bold" → 700, "Medium" → 500,
"SemiBold" → 600, etc. Unrecognized styles default to 400.

### Step 2: Google Fonts download

Fetches the [Google Fonts CSS2 API](https://fonts.googleapis.com/css2):

```
GET /css2?family=Roboto:wght@400;500;700
User-Agent: Mozilla/5.0          ← required to get TTF (not WOFF2)
```

The CSS response contains `@font-face` blocks with TTF URLs per weight.
Each TTF is downloaded and **nameID 1 is patched** to the bare family name
so resvg can match `font-family="Roboto"` (Google Fonts TTFs often have
weight-specific nameID 1 like "Roboto Medium").

### Step 3: nameID patching (zero-dependency TTF patcher)

The patcher is a ~150 LOC pure-JS implementation that:

1. Reads the TTF offset table and table directory
2. Rebuilds the `name` table with nameID 1 and 16 set to the target family
3. Handles both Windows/Unicode (UTF-16BE) and Mac (Latin-1) platform encodings
4. Reconstructs the full TTF: offset table + table directory + table data
5. Recalculates all table checksums + `head.checksumAdjustment`

**Format guards:**

- **sfVersion check** — only patches plain TTF (`0x00010000`) and OTF/CFF
  (`OTTO`). TrueType Collections (`ttcf`), WOFF (`wOFF`), and WOFF2 (`wOF2`)
  are returned unpatched with a stderr warning.
- **Name table format check** — only patches format 0 name tables. Format 1
  (with language tag records) is returned unmodified with a warning.

These guards are sufficient for Google Fonts (always format 0 TTF) and won't
silently corrupt exotic formats.

### Step 4: System font fallback

If Google Fonts doesn't have the font (e.g. a commercial or custom font), the
resolver searches OS font directories:

| Platform | Directories |
|----------|-------------|
| macOS | `/System/Library/Fonts`, `/Library/Fonts`, `~/Library/Fonts` |
| Windows | `C:\Windows\Fonts`, `~\AppData\Local\Microsoft\Windows\Fonts` |
| Linux | `/usr/share/fonts`, `/usr/local/share/fonts`, `~/.local/share/fonts` |

The scanner matches filenames heuristically against the family name (strips
spaces, tries dash/underscore variants) and weight names ("Bold", "Medium",
etc.).

**TTC support:** macOS stores many system fonts as `.ttc` (TrueType Collection)
files — e.g. `Helvetica.ttc` bundles Regular, Bold, Light, etc. in one file.
TTC files are registered directly with resvg (which parses all fonts inside and
matches by internal nameID). They are not patched — system fonts already have
correct family names. A small sentinel file is written to cache so subsequent
runs don't re-scan.

### Step 5: Cache

Resolved fonts are cached at `~/.openfig/fonts/`:

```
~/.openfig/fonts/
  roboto-400-normal.ttf       ← patched TTF from Google Fonts
  roboto-700-normal.ttf
  helvetica-400-normal.ttf    ← TTC sentinel (points to system file)
```

The cache is per-family-per-weight. On subsequent renders, cached fonts are
loaded directly without network requests or filesystem scanning.

### Failure mode

If a font can't be found in cache, Google Fonts, or system fonts, `resolveFonts`
emits a warning and the font is added to the `failed` list. Text using that font
renders in Inter (resvg's `defaultFontFamily`) — wrong font, but no crash.

```
[openfig] Font "MyCustomFont" missing weights [400, 700] — not on Google Fonts,
not found in system fonts. Text will render in Inter as fallback.
Use registerFont() to supply this font manually.
```

## Registering Custom Fonts

For fonts that automatic resolution can't find (proprietary, not on Google Fonts,
not installed locally):

```javascript
import { registerFont, registerFontDir } from './deck-rasterizer.mjs';

// Single file
registerFont('/path/to/CustomFont.woff2');
registerFont(fontBuffer);  // Buffer or Uint8Array

// Entire directory (recursive, .ttf/.otf/.woff/.woff2)
registerFontDir('/path/to/fonts/');
```

Fonts can be registered at any time — they take effect on the next render call.
Manual registration takes precedence over automatic resolution.

### When fonts don't match

If resvg can't find a font for a `font-family` value, it falls back to the
`defaultFontFamily` (Inter). Text will render in the wrong font but won't crash.
Check the font's internal nameID 1 if matching fails:

```bash
# Inspect a font's name table
python3 -c "
from fontTools.ttLib import TTFont
font = TTFont('font.woff2')
for r in font['name'].names:
    if r.nameID in (1,2,4,5,6):
        print(f'nameID {r.nameID}: {r.toUnicode()}')
"
```
