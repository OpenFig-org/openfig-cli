#!/usr/bin/env node
/**
 * OpenFig Claude plugin release script
 * Usage: node scripts/release-claudeplugin.mjs [patch|minor|major]
 * Bumps .claude-plugin/ versions independently from npm, tags as claudeplugin-v*.
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

function bumpVersion(version, bump) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// 1. Read current plugin version and bump it
const plugin = read('.claude-plugin/plugin.json');
const version = bumpVersion(plugin.version, bump);
console.log(`\nReleasing Claude plugin v${version}...\n`);

// 2. Update plugin.json
plugin.version = version;
write('.claude-plugin/plugin.json', plugin);

// 3. Update marketplace.json
const market = read('.claude-plugin/marketplace.json');
market.plugins[0].version = version;
write('.claude-plugin/marketplace.json', market);

// 4. Update SKILL.md version metadata
const skillFiles = [
  '.claude-plugin/skills/figma-slides-creator/SKILL.md',
  '.claude-plugin/skills/figma-template-builder/SKILL.md',
];
for (const rel of skillFiles) {
  const path = join(root, rel);
  try {
    const content = readFileSync(path, 'utf8');
    writeFileSync(path, content.replace(/version: "[\d.]+"/, `version: "${version}"`));
  } catch { /* skill may not have version field */ }
}

// 5. Commit, tag, push
run(`git add .claude-plugin/`);
run(`git commit -m "claudeplugin v${version}"`);
run(`git tag claudeplugin-v${version}`);
run(`git push && git push --tags`);

console.log(`\n✅ Released Claude plugin v${version}\n`);
