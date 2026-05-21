#!/usr/bin/env node
// Regenerate lib/slides/font-metric-aliases.json from FreeDesktop's
// 30-metric-aliases.conf — the authoritative open-source list of
// metric-compatible font pairs maintained alongside fontconfig.
//
// We only keep aliases whose substitute is actually loadable by Figma
// (i.e. present in figma-available-fonts.json), and we skip sources Figma
// resolves natively (Arial, Times New Roman, etc.) since substituting
// those would replace a working face with a different visual design.
//
// Usage: node scripts/refresh-font-metric-aliases.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UPSTREAM =
  'https://gitlab.freedesktop.org/fontconfig/fontconfig/-/raw/main/conf.d/30-metric-aliases.conf';

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, '..', 'lib', 'slides');
const outPath = join(libDir, 'font-metric-aliases.json');

const available = new Set(
  JSON.parse(readFileSync(join(libDir, 'figma-available-fonts.json'), 'utf8')),
);

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
writeFileSync(outPath, JSON.stringify(sorted, null, 2) + '\n');
console.log(`wrote ${Object.keys(sorted).length} aliases → ${outPath}`);
for (const [from, to] of Object.entries(sorted)) console.log(`  ${from} → ${to}`);
