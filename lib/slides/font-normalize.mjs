import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Canonical set of fonts Figma resolves at render time. Regenerated via
// scripts/refresh-figma-available-fonts.mjs (Google Fonts catalog + the
// system core Figma loads from the host OS). Lowercased family names.
export const FIGMA_AVAILABLE_FONTS = new Set(
  JSON.parse(readFileSync(join(__dirname, 'figma-available-fonts.json'), 'utf8')),
);

// Proprietary fonts → metric-compatible OFL clones Figma can load. Derived
// from FreeDesktop's 30-metric-aliases.conf, filtered to substitutes Figma
// actually serves. Regenerated via scripts/refresh-font-metric-aliases.mjs.
export const FONT_METRIC_ALIASES = new Map(
  Object.entries(
    JSON.parse(readFileSync(join(__dirname, 'font-metric-aliases.json'), 'utf8')),
  ),
);

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
