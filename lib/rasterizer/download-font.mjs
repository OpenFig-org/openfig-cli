#!/usr/bin/env node
/**
 * font-helper — Install fonts from @fontsource and register with the rasterizer.
 *
 * resvg-wasm accepts WOFF2 directly — no conversion needed.
 *
 * Usage:
 *   node lib/rasterizer/download-font.mjs "Darker Grotesque" 500 600
 *   node lib/rasterizer/download-font.mjs "Inter" 400 700
 *
 * What it does:
 *   1. npm install @fontsource/<family> (if not already installed)
 *   2. Prints the registerFont() calls to add to deck-rasterizer.mjs
 */

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '../..');

const [,, familyArg, ...weightArgs] = process.argv;
if (!familyArg) {
  console.error('Usage: node download-font.mjs "Family Name" [weight...]\n');
  console.error('  node download-font.mjs "Darker Grotesque" 500 600');
  process.exit(1);
}

const weights   = weightArgs.length ? weightArgs.map(Number) : [400];
const family    = familyArg.trim();
const pkgSlug   = family.toLowerCase().replace(/\s+/g, '-');
const pkgName   = `@fontsource/${pkgSlug}`;
const pkgDir    = join(ROOT, 'node_modules', pkgName, 'files');

if (!existsSync(pkgDir)) {
  console.log(`Installing ${pkgName}…`);
  execSync(`npm install ${pkgName} --save-dev`, { cwd: ROOT, stdio: 'inherit' });
}

if (!existsSync(pkgDir)) {
  console.error(`${pkgName} not found after install.`);
  process.exit(1);
}

console.log(`\n✓ ${pkgName} ready. Add to deck-rasterizer.mjs fontBuffers:\n`);
for (const w of weights) {
  const file = `${pkgSlug}-latin-${w}-normal.woff2`;
  const full = join(pkgDir, file);
  if (existsSync(full)) {
    const rel = full.replace(ROOT + '/', '');
    console.log(`  readFileSync(join(ROOT, '${rel}')),  // ${family} ${w}`);
  } else {
    console.warn(`  ⚠ not found: ${file}`);
  }
}
