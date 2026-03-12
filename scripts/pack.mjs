#!/usr/bin/env node
/**
 * figmatk pack script
 * Creates a local plugin ZIP that can be uploaded via Claude Desktop → Browse plugins → Upload local plugin.
 * Usage: node scripts/pack.mjs
 * Output: dist/figmatk-plugin.zip
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';
import { createWriteStream } from 'fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = join(root, '.pack-tmp');
const distDir = join(root, 'dist');
const outZip = join(distDir, 'figmatk-plugin.zip');

// Cleanup + prepare
if (existsSync(tmp)) rmSync(tmp, { recursive: true });
mkdirSync(tmp, { recursive: true });
mkdirSync(distDir, { recursive: true });

console.log('Copying plugin files...');

// Files and directories to include
const include = [
  'package.json',
  'package-lock.json',
  'mcp-server.mjs',
  'cli.mjs',
  'lib',
  'commands',
  'skills',
  '.claude-plugin',
  '.mcp.json',
  'LICENSE',
  'README.md',
];

for (const item of include) {
  const src = join(root, item);
  if (existsSync(src)) {
    cpSync(src, join(tmp, item), { recursive: true });
  }
}

// Install production deps into the tmp dir
console.log('Installing production dependencies...');
execSync('npm install --omit=dev --ignore-scripts', { cwd: tmp, stdio: 'inherit' });

// Create ZIP
console.log(`Creating ${outZip}...`);
await new Promise((resolve, reject) => {
  const output = createWriteStream(outZip);
  const archive = archiver('zip', { zlib: { level: 6 } });
  output.on('close', resolve);
  archive.on('error', reject);
  archive.pipe(output);
  archive.directory(tmp, false);
  archive.finalize();
});

// Cleanup
rmSync(tmp, { recursive: true });

const size = Math.round(existsSync(outZip) ? (await import('fs')).statSync(outZip).size / 1024 : 0);
console.log(`\n✅ dist/figmatk-plugin.zip (${size} KB)`);
console.log('   Upload via: Claude Desktop → Browse plugins → Upload local plugin\n');
