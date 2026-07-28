/**
 * A handoff bundle is untrusted input, and its resolved paths end up as bytes
 * inside a .deck the user then shares. These cover the three escapes that
 * exist in the shape of the bundle loader:
 *
 *   - a zip entry named `../…`, which `unzip` used to sanitise for us and
 *     `fflate` does not (the same regression the deck read path had);
 *   - a symlink that makes a contained-looking path resolve elsewhere, on
 *     both the write side (`resolveMedia`'s data: branch) and the discovery
 *     side (`findManifestRoot`);
 *   - a `manifest.json` `src` of `../../…`, an arbitrary local file read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { loadBundle } from '../../lib/slides/handoff/bundle-loader.mjs';

const enc = (s) => new TextEncoder().encode(s);
const MANIFEST = JSON.stringify({ title: 'T', dimensions: { width: 1920, height: 1080 }, slides: [] });

let work;
beforeAll(() => { work = mkdtempSync(join(tmpdir(), 'bundle-loader-safety-')); });
afterAll(() => { rmSync(work, { recursive: true, force: true }); });

function writeZip(name, files) {
  const path = join(work, name);
  writeFileSync(path, zipSync(files));
  return path;
}

function dirBundle(name, extra = {}) {
  const root = join(work, name);
  mkdirSync(join(root, 'media'), { recursive: true });
  writeFileSync(join(root, 'manifest.json'), MANIFEST);
  writeFileSync(join(root, 'template.html'), '<html></html>');
  for (const [rel, body] of Object.entries(extra)) writeFileSync(join(root, rel), body);
  return root;
}

describe('bundle loader: zip extraction', () => {
  it('loads a well-formed zip bundle', () => {
    const zip = writeZip('ok.zip', {
      'manifest.json': enc(MANIFEST),
      'template.html': enc('<html></html>'),
      'media/logo.png': enc('not-really-a-png'),
    });
    const bundle = loadBundle(zip);
    expect(bundle.manifest.title).toBe('T');
    expect(bundle.html).toBe('<html></html>');
    expect(existsSync(bundle.resolveMedia('media/logo.png'))).toBe(true);
  });

  it('refuses an entry that escapes the extraction directory', () => {
    const zip = writeZip('escape.zip', {
      'manifest.json': enc(MANIFEST),
      '../../PWNED-relative.txt': enc('pwned'),
    });
    expect(() => loadBundle(zip)).toThrow(/escapes the extraction directory/);
    expect(existsSync(join(tmpdir(), 'PWNED-relative.txt'))).toBe(false);
  });

  it('re-roots an absolute entry name inside the extraction directory', () => {
    const zip = writeZip('abs.zip', {
      'manifest.json': enc(MANIFEST),
      '/etc/PWNED-absolute.txt': enc('pwned'),
    });
    const bundle = loadBundle(zip);
    expect(readdirSync(bundle.tempRoot)).toContain('etc');
  });

  it('materialises a symlink entry as an ordinary file', () => {
    // fflate has no concept of a symlink entry, so the link target arrives as
    // file content. `media` being a regular file is what stops resolveMedia's
    // data: branch from writing through it to an attacker-chosen directory.
    const outside = join(work, 'outside');
    mkdirSync(outside, { recursive: true });
    const zip = writeZip('symlink.zip', {
      'manifest.json': enc(MANIFEST),
      'media': enc(outside),
    });
    const bundle = loadBundle(zip);
    expect(() => bundle.resolveMedia('data:image/png;base64,aGk=')).toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('bundle loader: resolveMedia containment', () => {
  it('refuses a manifest src that climbs out of the bundle', () => {
    const secretDir = mkdtempSync(join(tmpdir(), 'bundle-secret-'));
    writeFileSync(join(secretDir, 'SECRET.txt'), 'top secret');
    const root = dirBundle('read-escape');
    const bundle = loadBundle(root);
    const climb = '../'.repeat(12) + secretDir.replace(/^\//, '') + '/SECRET.txt';
    expect(() => bundle.resolveMedia(climb)).toThrow(/Media asset not found/);
    rmSync(secretDir, { recursive: true, force: true });
  });

  it('refuses to write a data: asset through a symlinked media dir', () => {
    const outside = join(work, 'outside-media');
    mkdirSync(outside, { recursive: true });
    const root = join(work, 'symlinked-media');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'manifest.json'), MANIFEST);
    symlinkSync(outside, join(root, 'media'));
    const bundle = loadBundle(root);
    expect(() => bundle.resolveMedia('data:image/png;base64,aGk=')).toThrow(/outside the bundle/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('still resolves ordinary media inside the bundle', () => {
    const root = dirBundle('ordinary');
    writeFileSync(join(root, 'media', 'logo.png'), 'x');
    const bundle = loadBundle(root);
    expect(bundle.resolveMedia('media/logo.png')).toBe(join(root, 'media', 'logo.png'));
    const written = bundle.resolveMedia('data:image/png;base64,aGk=');
    expect(written.startsWith(join(root, 'media'))).toBe(true);
    expect(existsSync(written)).toBe(true);
  });
});

describe('bundle loader: manifest discovery', () => {
  it('does not descend a symlinked directory', () => {
    const victim = join(work, 'victim');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'manifest.json'), JSON.stringify({ marker: 'OUTSIDE' }));
    const root = join(work, 'symlink-discovery');
    mkdirSync(root, { recursive: true });
    symlinkSync(victim, join(root, 'sub'));
    expect(() => loadBundle(root)).toThrow(/No manifest.json found/);
  });

  it('finds a manifest nested one level down', () => {
    const root = join(work, 'nested');
    mkdirSync(join(root, 'claude_code_handoff'), { recursive: true });
    writeFileSync(join(root, 'claude_code_handoff', 'manifest.json'), MANIFEST);
    const bundle = loadBundle(root);
    expect(bundle.rootDir).toBe(join(root, 'claude_code_handoff'));
  });
});
