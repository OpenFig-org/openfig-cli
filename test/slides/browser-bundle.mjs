/**
 * Bundling the browser adapter for a real browser, shared by every test that
 * needs it.
 *
 * Two things here are not incidental:
 *
 *   - `.wasm` is inlined as a data URL. The zstd encoder is an Emscripten
 *     build that asks for its `.wasm` as a module, and the deck writer cannot
 *     encode `canvas.fig` without it. Group 5 owns how the shipped page
 *     delivers the binary — the artifact sandbox blocks `fetch` of a `data:`
 *     URL, which this host does not — so this is a test-local choice, not a
 *     build contract.
 *   - `fs` and `path` are stubbed *only* for `node_modules`. The encoder's
 *     glue carries a dead `ENVIRONMENT_IS_NODE` branch that `require`s both;
 *     it never runs in a browser (`typeof process === 'undefined'`), but a
 *     bundler still has to resolve it. The stub is scoped so the same request
 *     from anything under `lib/` still fails the build, which is the whole
 *     point of bundling as a portability check.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..');
export const BROWSER_ENTRY = resolve(REPO, 'lib', 'slides', 'browser', 'index.mjs');

const STUB = '\0openfig-node-builtin-stub';

/** Third-party dead-branch builtins, and nothing else. */
const VENDOR_BUILTINS = new Set(['fs', 'path', 'node:fs', 'node:path']);

function vendorBuiltinStub(onVendorStub) {
  return {
    name: 'openfig-vendor-builtin-stub',
    resolveId(id, importer) {
      if (!VENDOR_BUILTINS.has(id)) return null;
      // Anything under `lib/` asking for a builtin is a real failure and must
      // reach `onwarn`. Only vendored code gets the stub.
      if (!importer || !importer.includes('node_modules')) return null;
      onVendorStub?.({ id, importer });
      return STUB;
    },
    load(id) {
      if (id === STUB) return 'export default {};';
      return null;
    },
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.input] - Defaults to the browser adapter barrel.
 * @param {string} [opts.format] - 'iife' (default) or 'esm'.
 * @param {string} [opts.name] - IIFE global name.
 * @returns {Promise<{code: string, warnings: object[], vendorStubs: object[]}>}
 */
export async function bundleForBrowser(opts = {}) {
  const { rolldown } = await import('rolldown');
  const warnings = [];
  const vendorStubs = [];
  const build = await rolldown({
    input: opts.input ?? BROWSER_ENTRY,
    platform: 'browser',
    moduleTypes: { '.wasm': 'dataurl' },
    plugins: [vendorBuiltinStub((hit) => vendorStubs.push(hit))],
    // Collected rather than thrown: the caller decides, because "unresolved
    // import from node_modules" and "unresolved import from lib/" are very
    // different findings and only the second is a bug in this change.
    onwarn: (warning) => { warnings.push(warning); },
  });
  const { output } = await build.generate(
    opts.format === 'esm' ? { format: 'esm' } : { format: 'iife', name: opts.name ?? 'OpenFigBrowser' },
  );
  await build.close();
  return { code: output.map((c) => c.code ?? '').join('\n'), warnings, vendorStubs };
}

/** Warnings whose importer is repo code rather than a dependency. */
export function repoWarnings(warnings) {
  return warnings.filter((w) => {
    const text = `${w.id ?? ''} ${w.message ?? ''}`;
    return text.includes(`${REPO}/lib`) || /\blib\/(slides|core)\//.test(text);
  });
}
