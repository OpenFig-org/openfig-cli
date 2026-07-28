/**
 * The converter core, and the deck writer beside it, must be loadable in a
 * browser. That is a property of a whole import graph, not of an entry file,
 * so each is checked two ways:
 *
 *   1. a static scan of every module reachable from the entry, rejecting Node
 *      builtins and the host globals (`process`, `Buffer`, `__dirname`,
 *      `require`) that would throw at call time rather than at import time —
 *      the shape that hid in `browser-extract.mjs` for as long as it did;
 *   2. a real bundle for the browser, which additionally proves that any
 *      third-party dependency resolves under browser conditions.
 *
 * The scan is the guard; the bundle is corroboration.
 *
 * Two graphs, deliberately, with different rules:
 *
 *   - `core/convert-standalone.mjs` — measurement. Allowed *no* third-party
 *     import at all, which is a stricter bar than portability needs and is
 *     held on purpose (see below).
 *   - `browser/index.mjs` — the whole browser adapter including the deck
 *     writer, which cannot be third-party-free: encoding `canvas.fig` needs
 *     kiwi, pako, zstd and fflate. Builtins and Node globals are still banned,
 *     and that is the assertion group 4b exists to make true.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleForBrowser, repoWarnings } from '../slides/browser-bundle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CORE_ENTRY = join(REPO, 'lib', 'slides', 'core', 'convert-standalone.mjs');
// The whole browser adapter, deck writer included. Until group 4b this entry
// reached only the measurement half — `api.mjs` and `core/fig-deck.mjs` were
// Node-bound, so a browser could measure an export and hand back nothing.
const BROWSER_ENTRY = join(REPO, 'lib', 'slides', 'browser', 'index.mjs');

const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

// `import x from '…'`, `export … from '…'`, and dynamic `import('…')`.
const SPECIFIER_RE = /(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|[^.\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;

function specifiersOf(source) {
  const out = [];
  for (const m of source.matchAll(SPECIFIER_RE)) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/** Walk an import graph over repo-local files. */
function walkGraph(entry) {
  const seen = new Set();
  const bare = new Map(); // specifier → importing files
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const spec of specifiersOf(source)) {
      if (spec.startsWith('.')) {
        queue.push(resolve(dirname(file), spec));
      } else {
        // Every importer, not just the last one: two files reaching for the
        // same builtin is two findings, and the browser graph is big enough
        // for that to matter.
        if (!bare.has(spec)) bare.set(spec, []);
        bare.get(spec).push(file);
      }
    }
  }
  return { files: [...seen], bare };
}

const rel = (f) => f.slice(REPO.length + 1);

function importOffenders(bare, predicate) {
  const out = [];
  for (const [spec, importers] of bare) {
    if (!predicate(spec)) continue;
    for (const file of importers) out.push(`${rel(file)} -> ${spec}`);
  }
  return out.sort();
}

// `process.env` reads are the failure mode that survives an import scan: the
// module loads cleanly in a browser and throws only when the line finally
// runs. Comments and strings are stripped first so prose about `process.env`
// does not fail the test.
// Two spellings, because the obvious regex misses the sneaky one:
//   `process.env.X`            — bare global, any member access
//   `globalThis.process.env.X` — reached through globalThis
// The lookbehind that stops `foo.process` matching also stopped
// `globalThis.process`, so that spelling needs its own pattern.
const GLOBAL_PATTERNS = [
  /(?<![.\w$])(process|Buffer|__dirname|__filename|require)\s*[.(\[]/,
  /globalThis\s*[.\[]\s*['"`]?(process|Buffer|require)\b/,
];

function globalOffenders(files) {
  const out = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');
    for (const pattern of GLOBAL_PATTERNS) {
      const m = source.match(pattern);
      if (m) out.push(`${rel(file)} -> ${m[1]}`);
    }
  }
  return out.sort();
}

describe('converter core portability', () => {
  const { files, bare } = walkGraph(CORE_ENTRY);

  it('reaches the modules it is supposed to', () => {
    // A scan that silently walked nothing would pass every assertion below.
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files.some((f) => f.endsWith('browser-extract.mjs'))).toBe(true);
    expect(files.some((f) => f.endsWith('font-normalize.mjs'))).toBe(true);
    expect(files.some((f) => f.endsWith('measurement-surface.mjs'))).toBe(true);
  });

  it('imports no Node builtin anywhere in its graph', () => {
    expect(importOffenders(bare, (spec) => BUILTINS.has(spec))).toEqual([]);
  });

  it('imports no third-party package at all', () => {
    // Not a rule for all time — a browser-safe dependency would be fine — but
    // today the core needs none, and every one added is a resolution condition
    // someone has to check. Loosen deliberately, not by accident.
    expect(importOffenders(bare, () => true)).toEqual([]);
  });

  it('reaches for no Node global', () => {
    expect(globalOffenders(files)).toEqual([]);
  });

  it('bundles for the browser', async () => {
    // Fail rather than skip. This is the strongest of the assertions here —
    // a static scan cannot see a transitively imported builtin — so silently
    // passing when the bundler is missing would turn it into a green no-op.
    // `rolldown` is declared in devDependencies precisely so this cannot
    // happen; before that it resolved only via a hoisted transitive copy.
    const { rolldown } = await import('rolldown');
    const build = await rolldown({
      input: CORE_ENTRY,
      platform: 'browser',
      // Default onwarn would let an unresolved import through as a warning.
      onwarn: (warning) => {
        throw new Error(`bundling the core warned: ${warning.message}`);
      },
    });
    const { output } = await build.generate({ format: 'esm' });
    await build.close();
    const code = output.map((c) => c.code ?? '').join('\n');
    expect(code).toContain('convertStandaloneCore');
    expect(code).not.toMatch(/require\(["']node:/);
  });
});

describe('deck writer portability', () => {
  // Same scan, over the entry that actually produces a `.deck`. Everything the
  // browser needs to go from an export to bytes is reachable from here:
  // `convertStandaloneToDeckBytes` → the measurement core → the memory bundle
  // → the element dispatcher → `api-core.mjs` → `fig-deck-core.mjs`.
  const { files, bare } = walkGraph(BROWSER_ENTRY);

  it('reaches the writer, not just the measurement half', () => {
    // Named files rather than a count: a barrel that stopped re-exporting the
    // writer would shrink the graph and quietly pass everything below.
    const names = files.map((f) => rel(f));
    expect(names).toContain('lib/slides/api-core.mjs');
    expect(names).toContain('lib/core/fig-deck-core.mjs');
    expect(names).toContain('lib/core/archive.mjs');
    expect(names).toContain('lib/slides/core/convert-bundle.mjs');
    expect(names).toContain('lib/slides/handoff/element-dispatch.mjs');
    expect(names).toContain('lib/slides/browser/convert-to-deck.mjs');
    // And the Node halves must NOT be reachable. These are the four files the
    // survey counted Node imports in; every one of them still has them.
    expect(names).not.toContain('lib/slides/api.mjs');
    expect(names).not.toContain('lib/core/fig-deck.mjs');
    expect(names).not.toContain('lib/slides/handoff-converter.mjs');
    expect(names).not.toContain('lib/slides/handoff/bundle-loader.mjs');
    expect(names).not.toContain('lib/core/image-utils.mjs');
  });

  it('imports no Node builtin anywhere in its graph', () => {
    expect(importOffenders(bare, (spec) => BUILTINS.has(spec))).toEqual([]);
  });

  it('reaches for no Node global', () => {
    // The one that would have caught `Buffer.alloc` in `api.mjs`'s blob
    // encoders, which no import scan can see: `Buffer` is a global there, not
    // an import, and both encoders are on the path of every line, ellipse and
    // SVG path the dispatcher emits.
    expect(globalOffenders(files)).toEqual([]);
  });

  it('imports only browser-safe third-party packages', () => {
    // Unlike the measurement core, the writer needs libraries — it has to
    // encode kiwi, deflate, zstd and zip. Pinned as a list so adding one is a
    // decision: each is a resolution condition and a bundle-size line item.
    const seen = [...bare.keys()].sort();
    expect(seen).toEqual([
      // The wasm module, not the package's `main`: its JS wrapper copies
      // results out of the heap with `Buffer` and throws in a browser. See
      // `lib/core/zstd.mjs`.
      '@foxglove/wasm-zstd/dist/wasm-zstd.js',
      'fflate',
      'kiwi-schema',
      'openfig-core',
      'pako',
    ]);
  });

  it('bundles for the browser, deck writer and all', async () => {
    const { code, warnings, vendorStubs } = await bundleForBrowser({ format: 'esm' });

    // Any unresolved import traced back to our own code is a failure. The
    // encoder's dead `ENVIRONMENT_IS_NODE` branch is not ours and is stubbed;
    // see `test/slides/browser-bundle.mjs`.
    expect(repoWarnings(warnings).map((w) => w.message)).toEqual([]);
    for (const hit of vendorStubs) expect(hit.importer).toContain('node_modules');

    expect(code).toContain('convertStandaloneToDeckBytes');
    expect(code).not.toMatch(/require\(["']node:/);
    // `sharp` is the dependency most likely to creep back in: it was a default
    // parameter in two places, which pulls it in whether or not the branch runs.
    expect(code).not.toMatch(/["']sharp["']/);
  }, 120_000);
});
