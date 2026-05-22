#!/usr/bin/env node
// Extract the body of `## [<version>]` from CHANGELOG.md, with paragraphs
// reflowed so GitHub's release-body renderer (which treats every newline
// as <br>) doesn't preserve our 75-char editor wrap as visible breaks.
//
// Preserved newlines: blank lines (paragraph separators), list markers
// (`- `, `* `, `\d+. ` at any indent), and headings (`#`-prefixed).
//
// Usage: node scripts/extract-changelog-section.mjs <version>
// Prints the reflowed body to stdout. Exit 1 if the version is missing.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('usage: extract-changelog-section.mjs <version>');
  process.exit(2);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

const escaped = version.replace(/\./g, '\\.');
const sectionRe = new RegExp(
  `^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|^\\[\\d|\\Z)`,
  'm',
);
const match = changelog.match(sectionRe);
if (!match) {
  console.error(`✗ CHANGELOG.md has no "## [${version}]" section`);
  process.exit(1);
}

// Process paragraph-by-paragraph (split on blank lines). Within each
// paragraph, collapse newlines into spaces unless the next line starts a
// list item or heading — those stay on their own line so the renderer
// keeps the list structure.
const reflowed = match[1]
  .split(/\n\s*\n/)
  .map((para) =>
    para
      .replace(/\n(?!\s*[-*]\s|\s*\d+\.\s|#)/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ +\n/g, '\n')
      .trim(),
  )
  .filter(Boolean)
  .join('\n\n');

process.stdout.write(reflowed + '\n');
