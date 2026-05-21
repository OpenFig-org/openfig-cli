import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Full Google Fonts catalog (vendored, regenerated via
// scripts/refresh-figma-available-fonts.mjs) plus system faces Figma's
// desktop/web app loads from the OS. Lowercased family names.
export const FIGMA_AVAILABLE_FONTS = new Set([
  ...JSON.parse(readFileSync(join(__dirname, 'figma-available-fonts.json'), 'utf8')),
  'inter',
  'arial', 'helvetica', 'helvetica neue',
  'times', 'times new roman',
  'courier', 'courier new',
  'georgia', 'verdana', 'tahoma', 'trebuchet ms',
  'sf pro', 'sf pro display', 'sf pro text',
  'menlo', 'monaco', 'consolas',
]);

// Proprietary system fonts → metric-compatible OFL clones Figma can load.
// Only true metric-compatible pairs (same widths, layout preserved) live here.
export const FONT_METRIC_ALIASES = new Map([
  ['calibri', 'Carlito'],
  ['cambria', 'Caladea'],
]);

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
