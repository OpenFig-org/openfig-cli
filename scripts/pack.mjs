#!/usr/bin/env node
/**
 * figmatk pack script
 * Creates a local MCPB extension bundle for Claude Desktop/Cowork.
 * Usage: node scripts/pack.mjs
 * Output: dist/figmatk.mcpb
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, cpSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = join(root, '.pack-tmp');
const distDir = join(root, 'dist');
const outBundle = join(distDir, 'figmatk.mcpb');

function bin(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function run(cmd, args, cwd = root) {
  execFileSync(bin(cmd), args, { cwd, stdio: 'inherit' });
}

// Cleanup + prepare
if (existsSync(tmp)) rmSync(tmp, { recursive: true });
mkdirSync(tmp, { recursive: true });
mkdirSync(distDir, { recursive: true });
if (existsSync(outBundle)) rmSync(outBundle);

console.log('Copying extension files...');

// Files and directories to include
const include = [
  'manifest.json',
  'package.json',
  'package-lock.json',
  'mcp-server.mjs',
  'cli.mjs',
  'lib',
  'commands',
  'skills',
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
run('npm', ['install', '--omit=dev', '--ignore-scripts'], tmp);
console.log('Validating staged manifest...');
run('npx', ['--no-install', 'mcpb', 'validate', 'manifest.json'], tmp);

// Create MCPB bundle
console.log(`Creating ${outBundle}...`);
run('npx', ['--no-install', 'mcpb', 'pack', tmp, outBundle]);

// Cleanup
rmSync(tmp, { recursive: true });

const size = Math.round(existsSync(outBundle) ? statSync(outBundle).size / 1024 : 0);
console.log(`\n✅ dist/figmatk.mcpb (${size} KB)`);
console.log('   Install via: Claude Desktop/Cowork → Settings → Extensions\n');
