#!/usr/bin/env node
/**
 * OpenFig release script
 * Usage: node scripts/release.mjs [patch|minor|major]
 * Bumps npm + MCPB versions in sync, publishes to npm, pushes to GitHub.
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

// 1. Bump package.json via npm
run(`npm version ${bump} --no-git-tag-version`);
const { version } = read('package.json');
console.log(`\nBumping all files to ${version}...\n`);

// 2. Sync MCPB manifest
const manifest = read('manifest.json');
manifest.version = version;
write('manifest.json', manifest);

// 3. Sync Claude plugin metadata used by repo-backed installs/update checks
const plugin = read('.claude-plugin/plugin.json');
plugin.version = version;
write('.claude-plugin/plugin.json', plugin);

const market = read('.claude-plugin/marketplace.json');
market.plugins[0].version = version;
write('.claude-plugin/marketplace.json', market);

// 4. Sync SKILL.md
const skillPath = join(root, 'skills/figma-slides-creator/SKILL.md');
const skill = readFileSync(skillPath, 'utf8');
writeFileSync(skillPath, skill.replace(/version: "[\d.]+"/, `version: "${version}"`));

// 5. Commit, tag, publish, push
run(`git add package.json package-lock.json manifest.json .claude-plugin/ skills/`);
run(`git commit -m "Release v${version}"`);
run(`npm publish --access public`);
run(`git tag v${version}`);
run(`git push && git push --tags`);

// 6. Update local global install
run(`npm install -g openfig`);

console.log(`\n✅ Released openfig v${version}\n`);
