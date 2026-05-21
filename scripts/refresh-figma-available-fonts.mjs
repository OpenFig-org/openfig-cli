#!/usr/bin/env node
// Regenerate lib/slides/figma-available-fonts.json from google-font-metadata.
// Run when Google Fonts adds families we want recognised as Figma-available.
// Requires `npm i -D google-font-metadata` in this package.

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { APIDirect } = await import('google-font-metadata');
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'lib', 'slides', 'figma-available-fonts.json');

const names = APIDirect.map((f) => f.family.toLowerCase()).sort();
writeFileSync(out, JSON.stringify(names));
console.log(`wrote ${names.length} families → ${out}`);
