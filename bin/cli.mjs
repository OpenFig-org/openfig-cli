#!/usr/bin/env node
/**
 * OpenFig — Open-source tools for Figma file parsing and rendering.
 *
 * Usage: openfig <command> <file.deck | file.fig> [args...]
 *
 * Commands:
 *   inspect        Show document structure (node hierarchy tree)
 *   list-text      List all text content in the deck
 *   list-overrides List all editable override keys per symbol
 *   update-text    Apply text overrides to a slide instance
 *   insert-image   Apply an image fill override to a slide instance
 *   clone-slide    Duplicate a template slide with new content
 *   remove-slide   Mark slides as REMOVED
 *   roundtrip      Decode and re-encode (pipeline validation)
 *
 * Disclaimer:
 *   Figma is a trademark of Figma, Inc.
 *   OpenFig is an independent open-source project and is not affiliated with,
 *   endorsed by, or sponsored by Figma, Inc.
 */

const COMMANDS = {
  'inspect':        './commands/inspect.mjs',
  'list-text':      './commands/list-text.mjs',
  'list-overrides': './commands/list-overrides.mjs',
  'update-text':    './commands/update-text.mjs',
  'insert-image':   './commands/insert-image.mjs',
  'clone-slide':    './commands/clone-slide.mjs',
  'remove-slide':   './commands/remove-slide.mjs',
  'roundtrip':      './commands/roundtrip.mjs',
  'export':         './commands/export.mjs',
  'pdf':            './commands/pdf.mjs',
};

const arg2 = process.argv[2];
let command, rawArgs;

if (!arg2 || arg2 === '--help' || arg2 === '-h') {
  console.log(`OpenFig — Open-source tools for Figma file parsing and rendering\n`);
  console.log('Usage: openfig <command> <file.deck | file.fig> [args...]\n');
  console.log('Commands:');
  console.log('  export         Export slides as images (PNG/JPG/WEBP)');
  console.log('  pdf            Export slides as a multi-page PDF');
  console.log('  inspect        Show document structure (node hierarchy tree)');
  console.log('  list-text      List all text content in the deck');
  console.log('  list-overrides List editable override keys per symbol');
  console.log('  update-text    Apply text overrides to a slide instance');
  console.log('  insert-image   Apply image fill override to a slide instance');
  console.log('  clone-slide    Duplicate a template slide with new content');
  console.log('  remove-slide   Mark slides as REMOVED');
  console.log('  roundtrip      Decode and re-encode (pipeline validation)');
  process.exit(0);
}

if (COMMANDS[arg2]) {
  command = arg2;
  rawArgs = process.argv.slice(3);
} else {
  console.error(`Unknown command: ${arg2}\nRun with --help for available commands.`);
  process.exit(1);
}

// Parse args: positional args + flags (--flag value, --flag=value)
const positional = [];
const flags = {};

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg.startsWith('--')) {
    const eqIdx = arg.indexOf('=');
    let key, value;
    if (eqIdx >= 0) {
      key = arg.substring(2, eqIdx);
      value = arg.substring(eqIdx + 1);
    } else {
      key = arg.substring(2);
      // Peek ahead for value (unless next arg is also a flag)
      if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) {
        value = rawArgs[++i];
      } else {
        value = true;
      }
    }
    // Support repeating flags (e.g. --set k=v --set k2=v2)
    if (flags[key] !== undefined) {
      if (!Array.isArray(flags[key])) flags[key] = [flags[key]];
      flags[key].push(value);
    } else {
      flags[key] = value;
    }
  } else if (arg.startsWith('-') && arg.length === 2) {
    // Short flag like -o
    const key = arg.substring(1);
    if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
      flags[key] = rawArgs[++i];
    } else {
      flags[key] = true;
    }
  } else {
    positional.push(arg);
  }
}

// Run command
const mod = await import(COMMANDS[command]);
try {
  await mod.run(positional, flags);
} catch (err) {
  console.error(`Error: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
