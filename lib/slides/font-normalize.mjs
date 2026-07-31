// No filesystem here: this module is on the environment-agnostic core's import
// path, so the two data tables are .mjs data modules rather than JSON read at
// startup. Both are generated — see the scripts named in their headers.
import { FIGMA_AVAILABLE_FONT_NAMES } from './figma-available-fonts.mjs';
import { FONT_METRIC_ALIASES_BY_FAMILY } from './font-metric-aliases.mjs';

// Canonical set of fonts Figma resolves at render time (Google Fonts catalog +
// the system core Figma loads from the host OS). Lowercased family names.
export const FIGMA_AVAILABLE_FONTS = new Set(FIGMA_AVAILABLE_FONT_NAMES);

// Proprietary fonts → metric-compatible OFL clones Figma can load. Derived
// from FreeDesktop's 30-metric-aliases.conf, filtered to substitutes Figma
// actually serves.
export const FONT_METRIC_ALIASES = new Map(Object.entries(FONT_METRIC_ALIASES_BY_FAMILY));

const NON_PORTABLE_FONT_TOKENS = new Set([
  'blinkmacsystemfont',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'emoji',
  'math',
  'fangsong',
]);

export function stripFontToken(raw) {
  return String(raw).trim().replace(/^['"]|['"]$/g, '');
}

export function isPortableFontToken(token) {
  if (!token) return false;
  if (token.startsWith('-')) return false; // -apple-system and vendor prefixes
  return !NON_PORTABLE_FONT_TOKENS.has(token.toLowerCase());
}

// The weights a deck's style vocabulary can express — the distinct outputs of
// `mapFontStyle` in `handoff/element-dispatch.mjs`. The measurement clamp
// (`core/measurement-surface.mjs`) restricts itself to these so it never sizes
// text for a face the handoff cannot name. Widening `mapFontStyle` without
// widening this list is the drift that caused the clamp to resolve a bold
// request onto a weight the handoff then wrote as "Bold" — naming a face the
// family does not have.
export const NAMEABLE_WEIGHTS = [400, 700];

// Walk a CSS font-family stack and return the best Figma-resolvable family:
//   1. first token with a metric-compatible alias (Calibri → Carlito);
//   2. first token Figma is known to have;
//   3. fall back to the first portable token (Figma will show a font-picker
//      dialog on import — better than silently substituting an unrelated face).
export function normalizeFont(family) {
  if (!family) return undefined;
  const entries = String(family).split(',').map(stripFontToken).filter(Boolean);
  if (entries.length === 0) return undefined;
  for (const token of entries) {
    const lower = token.toLowerCase();
    const alias = FONT_METRIC_ALIASES.get(lower);
    if (alias) return alias;
    if (FIGMA_AVAILABLE_FONTS.has(lower)) return token;
  }
  return entries.find(isPortableFontToken) ?? entries[0];
}
