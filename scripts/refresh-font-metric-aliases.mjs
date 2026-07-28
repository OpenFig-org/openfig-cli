#!/usr/bin/env node
// Regenerate lib/slides/font-metric-aliases.mjs from FreeDesktop's
// 30-metric-aliases.conf — the authoritative open-source list of
// metric-compatible font pairs maintained alongside fontconfig.
//
// We only keep aliases whose substitute is actually loadable by Figma
// (i.e. present in figma-available-fonts.mjs), and we skip sources Figma
// resolves natively (Arial, Times New Roman, etc.) since substituting
// those would replace a working face with a different visual design.
//
// Usage: node scripts/refresh-font-metric-aliases.mjs

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIGMA_AVAILABLE_FONT_NAMES } from '../lib/slides/figma-available-fonts.mjs';

const UPSTREAM =
  'https://gitlab.freedesktop.org/fontconfig/fontconfig/-/raw/main/conf.d/30-metric-aliases.conf';

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, '..', 'lib', 'slides');
const outPath = join(libDir, 'font-metric-aliases.mjs');

const available = new Set(FIGMA_AVAILABLE_FONT_NAMES);

const res = await fetch(UPSTREAM);
if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
const xml = await res.text();

// Slice to the "Map generics to specifics" section — these are the alias
// directives that map a requested (often proprietary) family to its
// metric-compatible substitutes in preference order.
const start = xml.indexOf('Map generics to specifics');
if (start < 0) throw new Error('section marker not found in upstream file');
const section = xml.slice(start);

// Match every <alias>…</alias> block in that section. Inside each block,
// the first <family> is the requested family; subsequent <family> children
// of <accept>…</accept> are the substitutes (in preference order).
const aliasBlocks = [...section.matchAll(/<alias[^>]*>([\s\S]*?)<\/alias>/g)];
const aliases = {};

for (const [, body] of aliasBlocks) {
  const families = [...body.matchAll(/<family>([^<]+)<\/family>/g)].map((m) => m[1].trim());
  if (families.length < 2) continue;
  const [from, ...candidates] = families;
  const fromLower = from.toLowerCase();
  // Skip families Figma already resolves natively — aliasing them would
  // swap a working visual face for a different design, defeating the point.
  if (available.has(fromLower)) continue;
  // Pick the first substitute Figma can actually load.
  const pick = candidates.find((c) => available.has(c.toLowerCase()));
  if (!pick) continue;
  aliases[fromLower] = pick;
}

const sorted = Object.fromEntries(
  Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)),
);
writeFileSync(outPath, [
  '// GENERATED — regenerate with scripts/refresh-font-metric-aliases.mjs',
  '//',
  '// Proprietary fonts → metric-compatible OFL clones Figma can load, derived',
  "// from FreeDesktop's 30-metric-aliases.conf and filtered to substitutes",
  '// Figma actually serves. A module rather than JSON so the',
  '// environment-agnostic converter core can import it without a filesystem.',
  `export const FONT_METRIC_ALIASES_BY_FAMILY = ${JSON.stringify(sorted, null, 2)};`,
  '',
].join('\n'));
console.log(`wrote ${Object.keys(sorted).length} aliases → ${outPath}`);
for (const [from, to] of Object.entries(sorted)) console.log(`  ${from} → ${to}`);
