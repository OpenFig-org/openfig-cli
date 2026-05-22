#!/usr/bin/env node
/**
 * OpenFig npm release script
 * Usage: node scripts/release-npm.mjs [patch|minor|major]
 * Bumps package.json, publishes to npm, tags as npm-v*.
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
const previousVersion = read('package.json').version;
run(`npm version ${bump} --no-git-tag-version`);
const { version } = read('package.json');
console.log(`\nReleasing npm package v${version}...\n`);

// 2. CHANGELOG.md must already contain a `## [<version>]` heading so the
// GitHub release workflow can extract the body. Without this check we ship
// silently-empty releases (happened on 0.4.4 — the tag pushes before the
// changelog entry exists, the workflow finds nothing, and the release body
// is empty forever). Revert the bump if the section is missing.
const changelogPath = join(root, 'CHANGELOG.md');
let changelog = readFileSync(changelogPath, 'utf8');
if (!new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(changelog)) {
  write('package.json', { ...read('package.json'), version: previousVersion });
  run(`npm install --package-lock-only --silent`);
  console.error(`\n✗ CHANGELOG.md is missing a "## [${version}]" section.`);
  console.error(`  Add the entry before running release. Reverted package.json to ${previousVersion}.\n`);
  process.exit(1);
}

// Append the Keep-a-Changelog reference-link line so the heading renders
// as a clickable release link on GitHub. Idempotent: skip if already present.
const linkRef = `[${version}]: https://github.com/OpenFig-org/openfig-cli/releases/tag/npm-v${version}`;
if (!changelog.includes(linkRef)) {
  // Insert above the first existing `[X.Y.Z]: …` reference so the list
  // stays in descending-version order.
  const refMatch = changelog.match(/^\[\d+\.\d+\.\d+\]:.*$/m);
  changelog = refMatch
    ? changelog.replace(refMatch[0], `${linkRef}\n${refMatch[0]}`)
    : changelog.trimEnd() + `\n\n${linkRef}\n`;
  writeFileSync(changelogPath, changelog);
}

// 3. Publish first — only commit/tag/push if it succeeds
run(`npm publish --access public`);
run(`git add package.json package-lock.json CHANGELOG.md`);
run(`git commit -m "npm v${version}"`);
run(`git tag npm-v${version}`);
run(`git push && git push --tags`);

console.log(`\n✅ Published openfig-cli@${version} to npm\n`);
