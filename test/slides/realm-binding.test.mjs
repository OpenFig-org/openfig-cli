/**
 * Every measurement payload must take its realm as an argument.
 *
 * `Surface.evaluate` runs a function against the export's document. Playwright
 * satisfies that by serialising the function and re-parsing it *inside* the
 * page, which binds a free `document` to the page's own. The iframe host
 * cannot: it calls the function object from the host page's realm, so a free
 * `document` resolves to the host's DOM and measures the wrong document —
 * without throwing, and with entirely plausible numbers. Re-parsing inside the
 * iframe is not an option; it needs `unsafe-eval`, which task 1.8 removed the
 * need for.
 *
 * So the payloads take `{ realm, arg }` and destructure their globals out of
 * `realm`, and both hosts supply one. `test/slides/browser-host.test.mjs`
 * proves the binding is right at runtime, in a real browser, against a host
 * page carrying a decoy `<section>`. This is the cheap static half: it catches
 * a *new* payload written the old way, which the runtime test would only catch
 * if that payload happened to be on the fixture's path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

// The three modules that ship payloads to `Surface.evaluate`. Everything else
// in `lib/slides/browser/` runs in the host realm and reaches for the host's
// globals on purpose.
const PAYLOAD_MODULES = [
  'lib/slides/browser-extract.mjs',
  'lib/slides/core/measurement-surface.mjs',
  'lib/slides/core/convert-standalone.mjs',
];

// A payload's first token has to be its realm. This cannot be answered by
// looking for bare `document` — once a payload has destructured `document` out
// of `realm`, the correct spelling and the broken one are the same token — so
// the check is on the signature, which is where the two genuinely differ.
const EVALUATE_CALL = /\.evaluate\(\s*(async\s*)?\(/g;
const TAKES_REALM = /^\s*\.evaluate\(\s*(?:async\s*)?\(\s*\{\s*realm\b/;

// Only what both hosts actually put on the realm object. A payload
// destructuring anything else gets `undefined` in one host and works in the
// other.
const REALM_MEMBERS = new Set(['document', 'window', 'getComputedStyle']);

// Comments and plain string literals only. Template literals are deliberately
// left alone: nesting `${…}` makes them impossible to match with a regex, and
// a naive attempt swallows the rest of the file from the first backtick — the
// same mistake would have made every assertion below pass vacuously.
function strip(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/(['"])(?:\\.|(?!\1)[^\n])*\1/g, '""');
}

function evaluateCallsIn(source) {
  const out = [];
  for (const m of source.matchAll(EVALUATE_CALL)) {
    out.push({
      line: source.slice(0, m.index).split('\n').length,
      takesRealm: TAKES_REALM.test(source.slice(m.index)),
    });
  }
  return out;
}

describe('measurement payloads bind to the realm they are measuring', () => {
  for (const rel of PAYLOAD_MODULES) {
    it(`${rel} hands every payload its realm`, () => {
      const raw = readFileSync(join(REPO, rel), 'utf8');
      const source = strip(raw);
      const calls = evaluateCallsIn(source);
      // A module with no `evaluate` call would pass the filter below
      // vacuously, and stripping is exactly the step that can silently produce
      // one, so the count has to survive it.
      expect(calls.length).toBe((raw.match(/\.evaluate\(/g) ?? []).length);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter((c) => !c.takesRealm).map((c) => `${rel}:${c.line}`)).toEqual([]);
    });

    it(`${rel} destructures only what both hosts supply`, () => {
      const source = strip(readFileSync(join(REPO, rel), 'utf8'));
      const offenders = [];
      for (const m of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*realm\s*;/g)) {
        for (const name of m[1].split(',').map((t) => t.trim()).filter(Boolean)) {
          if (!REALM_MEMBERS.has(name)) offenders.push(`${rel} → ${name}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('would notice a payload written the old way', () => {
    // Without this, the assertions above pass just as happily against a regex
    // that matches nothing.
    const injected = strip(`
      await surface.evaluate(() => {
        return getComputedStyle(document.querySelector('section')).width;
      });
      await surface.evaluate(({ realm }) => realm.document.title);
    `);
    expect(evaluateCallsIn(injected).map((c) => c.takesRealm)).toEqual([false, true]);
  });

  it('both hosts hand the payload a realm object', () => {
    const node = readFileSync(join(REPO, 'lib/slides/playwright-layout.mjs'), 'utf8');
    const browser = readFileSync(join(REPO, 'lib/slides/browser/iframe-surface.mjs'), 'utf8');
    // Node resolves a JSHandle nested in the argument back to the live in-page
    // object, so the payload is still serialised *and* gets its globals given
    // to it; the iframe passes the frame's own.
    expect(node).toMatch(/page\.evaluate\(fn,\s*\{\s*realm,\s*arg\s*\}\)/);
    expect(node).toMatch(/evaluateHandle\(/);
    expect(browser).toMatch(/realm:\s*realmOf\(\)/);
  });
});
