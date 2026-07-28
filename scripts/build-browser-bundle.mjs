#!/usr/bin/env node
/**
 * Build the self-contained browser converter bundle.
 *
 * Usage: node scripts/build-browser-bundle.mjs [outfile]
 *
 * Emits two files: the JavaScript, and the zstd `.wasm` beside it.
 *
 * An earlier version inlined the wasm as base64 so the bundle was a single
 * self-contained file, because a Claude artifact's CSP blocks `fetch` of a
 * `data:` URL. That target turned out to be unreachable for a different and
 * more fundamental reason: a Claude Design export rehydrates *itself* from
 * `blob:` scripts and `data:` fonts, and an artifact's policy allows neither.
 * Measured — the export produces 0 sections there against 27 under a policy we
 * control. Since the artifact cannot work at all, the constraint that justified
 * inlining is gone, and a separate file is better: a third smaller over the
 * wire, cached by the browser, and compiled by `instantiateStreaming`.
 *
 * The page still hands the bytes to the encoder via `setZstdWasmBinary`; it
 * just fetches them from a real file first.
 */
import { rolldown } from 'rolldown';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(REPO, 'lib/slides/browser/index.mjs');
const WASM = join(REPO, 'node_modules/@foxglove/wasm-zstd/dist/wasm-zstd.wasm');
const outFile = resolve(process.argv[2] ?? join(REPO, 'dist/openfig-converter.js'));

// Emscripten's loader reaches for the binary through several routes, none of
// which exist here: `fetch`, `require('fs')`, `__dirname`. Neutralise them so
// the bundle carries no Node shims and no network path, and let
// `setZstdWasmBinary` be the only way bytes arrive.
const stubNodeBuiltins = {
  name: 'stub-node-builtins',
  resolveId(id) {
    // The `.wasm` itself: Emscripten's glue references the file so it can fetch
    // it. We supply the bytes through `setZstdWasmBinary`, so the reference
    // resolves to nothing rather than being inlined a second time.
    if (id.endsWith('.wasm')) return `\0stub:wasm`;
    return ['fs', 'path', 'crypto', 'node:fs', 'node:path', 'node:crypto'].includes(id)
      ? `\0stub:${id}`
      : null;
  },
  load(id) {
    if (!id.startsWith('\0stub:')) return null;
    if (id === '\0stub:wasm') return 'export default "";';
    // Emscripten only touches these on the paths we do not take; throwing
    // makes a wrong turn loud instead of silently returning undefined.
    const nope = (name) =>
      `export function ${name}() { throw new Error('${id.slice(6)}.${name} is not available in the browser'); }`;
    return [
      'export default {};',
      ...['readFileSync', 'existsSync', 'openSync', 'readSync', 'closeSync'].map(nope),
      'export function join(...p) { return p.filter(Boolean).join("/"); }',
      'export function dirname(p) { return String(p).replace(/\\/[^/]*$/, ""); }',
      'export function normalize(p) { return p; }',
    ].join('\n');
  },
};

const build = await rolldown({
  input: ENTRY,
  platform: 'browser',
  plugins: [stubNodeBuiltins],
  onwarn: (w) => {
    // An unresolved import must not become a runtime failure on someone's
    // machine; fail the build instead.
    if (w.code === 'UNRESOLVED_IMPORT') throw new Error(`unresolved import: ${w.message}`);
  },
});
const { output } = await build.generate({ format: 'iife', name: 'OpenFigConverter' });
await build.close();

const wasmBytes = readFileSync(WASM);
const code = output.map((c) => c.code ?? '').join('\n');

const banner = `/* OpenFig converter — built ${new Date().toISOString().slice(0, 10)}.
   Loads openfig-zstd.wasm from the same directory. */\n`;

// Fetched once, then handed to the encoder as bytes. Deliberately not
// `instantiateStreaming` inside the library: the encoder takes bytes, and
// keeping the fetch here means the page controls caching and error reporting.
const bootstrap = `
;OpenFigConverter.loadWasm = function (url) {
  return fetch(url || new URL('openfig-zstd.wasm', document.currentScript ? document.currentScript.src : location.href))
    .then(function (r) {
      if (!r.ok) throw new Error('openfig: could not load the compressor (' + r.status + ')');
      return r.arrayBuffer();
    })
    .then(function (buf) { OpenFigConverter.setZstdWasmBinary(new Uint8Array(buf)); });
};
`;

const wasmOut = join(dirname(outFile), 'openfig-zstd.wasm');
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, banner + code + bootstrap);
writeFileSync(wasmOut, wasmBytes);

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`bundle : ${outFile}  ${kb(banner.length + code.length + bootstrap.length)}`);
console.log(`wasm   : ${wasmOut}  ${kb(wasmBytes.length)}`);
console.log(`total over the wire: ${kb(code.length + wasmBytes.length)} (was ${kb(code.length + wasmBytes.length * 4 / 3)} inlined)`);
