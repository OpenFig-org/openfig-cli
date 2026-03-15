#!/usr/bin/env node
/**
 * OpenFig npm release script
 * Usage: node scripts/release-npm.mjs [patch|minor|major]
 * Bumps package.json + manifest.json, publishes to npm, tags as npm-v*.
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bump = process.argv[2] ?? 'patch';

function read(rel) { return JSON.parse(readFileSync(join(root, rel), 'utf8')); }
function write(rel, obj) { writeFileSync(join(root, rel), JSON.stringify(obj, null, 2) + '\n'); }
function run(cmd) { execSync(cmd, { cwd: root, stdio: 'inherit' }); }

// 1. Bump package.json
run(`npm version ${bump} --no-git-tag-version`);
const { version } = read('package.json');
console.log(`\nReleasing npm package v${version}...\n`);

// 2. Sync MCPB manifest
const manifest = read('manifest.json');
manifest.version = version;
write('manifest.json', manifest);

// 3. Publish first — only commit/tag/push if it succeeds
run(`npm publish --access public`);
run(`git add package.json package-lock.json manifest.json`);
run(`git commit -m "npm v${version}"`);
run(`git tag npm-v${version}`);
run(`git push && git push --tags`);

console.log(`\n✅ Published openfig-cli@${version} to npm\n`);
