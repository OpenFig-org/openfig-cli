#!/usr/bin/env node
// Regenerate lib/slides/figma-available-fonts.mjs: the canonical set of
// font families Figma resolves at render time. Union of:
//   - the full Google Fonts catalog (via google-font-metadata)
//   - the system faces Figma's desktop/web app loads from the host OS
//     (Inter house font, plus Arial/Helvetica/Times/Courier/Georgia/Verdana
//     etc. on macOS/Windows).
// Requires `npm i -D google-font-metadata` in this package.

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { APIDirect } = await import('google-font-metadata');
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'lib', 'slides', 'figma-available-fonts.mjs');

const SYSTEM_CORE = [
  'inter',
  'arial', 'helvetica', 'helvetica neue',
  'times', 'times new roman',
  'courier', 'courier new',
  'georgia', 'verdana', 'tahoma', 'trebuchet ms',
  'sf pro', 'sf pro display', 'sf pro text',
  'menlo', 'monaco', 'consolas',
];

const names = [...new Set([
  ...APIDirect.map((f) => f.family.toLowerCase()),
  ...SYSTEM_CORE,
])].sort();
writeFileSync(out, [
  '// GENERATED — regenerate with scripts/refresh-figma-available-fonts.mjs',
  '//',
  '// The canonical set of font families Figma resolves at render time: the',
  '// Google Fonts catalog plus the system faces Figma loads from the host OS.',
  '// Lowercased. A module rather than JSON so the environment-agnostic',
  '// converter core can import it without a filesystem.',
  `export const FIGMA_AVAILABLE_FONT_NAMES = ${JSON.stringify(names)};`,
  '',
].join('\n'));
console.log(`wrote ${names.length} families → ${out}`);
