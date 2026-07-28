/**
 * Load a handoff bundle — a directory, or a .zip of one — into the shape the
 * element dispatcher consumes: a manifest, the serialized template HTML, and a
 * media resolver.
 *
 * A bundle is untrusted input: it is a file people receive from others, and
 * both its entry names and its `manifest.json` `src` values are attacker-
 * controlled. Everything this module resolves is therefore confined to the
 * bundle root, compared on `realpath` rather than on the joined string — a
 * symlinked directory otherwise passes any prefix test while resolving
 * somewhere else entirely.
 */
import { readFileSync, existsSync, statSync, lstatSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname, basename, sep } from 'path';
import crypto from 'crypto';
import { unpackArchive } from '../../core/archive.mjs';

// A bundle nests a handful of levels at most (`claude_code_handoff/media/…`).
// The cap stops a symlink cycle or a deliberately deep tree from turning the
// scan into an unbounded filesystem walk.
const MAX_SCAN_DEPTH = 8;

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// Deliberately lstat: a symlink to a directory must not be descended into,
// or `findManifestRoot` walks straight out of the bundle and `rootDir` becomes
// a contained-looking string that resolves anywhere.
function isRealDir(p) {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

// Resolve `p` through any symlinks on the part of it that exists, so the
// containment test below compares real locations. A path whose tail does not
// exist yet (the `data:` media file we are about to write) has its existing
// ancestor resolved and the remainder appended.
function realpathDeep(p) {
  let head = resolve(p);
  const tail = [];
  for (;;) {
    try { return join(realpathSync(head), ...tail); } catch {}
    const parent = dirname(head);
    if (parent === head) return resolve(p);
    tail.unshift(basename(head));
    head = parent;
  }
}

// True when `candidate` is `boundary` itself or sits underneath it, judged
// after symlink resolution on both sides.
function isContained(boundaryReal, candidate) {
  const real = realpathDeep(candidate);
  return real === boundaryReal || real.startsWith(boundaryReal + sep);
}

function findManifestRoot(dir, depth = 0) {
  if (existsSync(join(dir, 'manifest.json'))) return dir;
  const nested = join(dir, 'claude_code_handoff');
  if (existsSync(join(nested, 'manifest.json'))) return nested;
  if (depth >= MAX_SCAN_DEPTH) return null;
  for (const entry of readdirSync(dir)) {
    const sub = join(dir, entry);
    if (!isRealDir(sub)) continue;
    const found = findManifestRoot(sub, depth + 1);
    if (found) return found;
  }
  return null;
}

// Extract in-process rather than shelling out to `unzip`, which does not ship
// on Windows. `unzip` sanitised entry names for us (it strips leading slashes
// and refuses `..` components) and refused nothing else — so replacing it means
// enforcing containment here, exactly as `core/fig-deck.mjs` does on the deck
// read path. fflate has no concept of a symlink entry, which also closes the
// hole where a `media -> /elsewhere` link let `resolveMedia` write outside the
// temp directory.
function unzipToTemp(zipPath) {
  const dest = mkdtempSync(join(tmpdir(), 'openfig-handoff-'));
  const destReal = realpathSync(dest);
  for (const [name, data] of unpackArchive(readFileSync(zipPath))) {
    const out = join(dest, name);
    if (!isContained(destReal, out)) {
      throw new Error(`Unsafe bundle entry escapes the extraction directory: ${name}`);
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data);
  }
  return dest;
}

export function loadBundle(bundlePath) {
  const abs = resolve(bundlePath);
  if (!existsSync(abs)) throw new Error(`Bundle not found: ${abs}`);

  let workDir = abs;
  let tempRoot = null;
  if (!isDir(abs)) {
    if (!abs.endsWith('.zip')) {
      throw new Error(`Bundle must be a directory or .zip: ${abs}`);
    }
    tempRoot = unzipToTemp(abs);
    workDir = tempRoot;
  }

  // Every path this loader hands out has to stay inside the bundle. The
  // boundary is the bundle root rather than the manifest root, so a manifest
  // nested in `claude_code_handoff/` can still reach media beside it.
  const boundaryReal = realpathSync(workDir);

  const root = findManifestRoot(workDir);
  if (!root) {
    throw new Error(`No manifest.json found under ${workDir}`);
  }

  // The two reads at the bundle root need the same containment as the media
  // resolution below: in a directory bundle either entry can be a symlink
  // pointing outside, and `template.html` in particular feeds SVG extraction,
  // so its contents can reach the produced .deck.
  const readContained = (name, what) => {
    const path = join(root, name);
    if (!isContained(boundaryReal, path)) {
      throw new Error(`Unsafe ${what} escapes the bundle: ${name}`);
    }
    return readFileSync(path, 'utf8');
  };

  const manifest = JSON.parse(readContained('manifest.json', 'manifest'));

  let html = null;
  const htmlFile = readdirSync(root).find(f => f.toLowerCase().endsWith('.html'));
  if (htmlFile) {
    html = readContained(htmlFile, 'bundle HTML');
  }

  function resolveMedia(src) {
    if (!src || typeof src !== 'string') {
      throw new Error(`resolveMedia: invalid src ${JSON.stringify(src)}`);
    }
    if (src.startsWith('data:')) {
      const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(src);
      if (!m) throw new Error(`resolveMedia: malformed data URL`);
      const [, mime, b64, payload] = m;
      const ext = ({
        'image/svg+xml': 'svg',
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/gif': 'gif',
        'image/webp': 'webp',
      })[mime.toLowerCase()] ?? 'bin';
      const buf = b64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
      const mediaDir = join(root, 'media');
      if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });
      // Content-addressed filename so repeated references reuse the same file.
      const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
      const outPath = join(mediaDir, `data-${hash}.${ext}`);
      // `media` may itself be a symlink pointing out of the bundle, so this
      // write is checked like any other.
      if (!isContained(boundaryReal, outPath)) {
        throw new Error(`resolveMedia: refusing to write outside the bundle: ${outPath}`);
      }
      if (!existsSync(outPath)) writeFileSync(outPath, buf);
      return outPath;
    }
    const candidates = [
      join(root, src),
      join(root, 'media', basename(src)),
      join(dirname(root), src),
    ];
    for (const c of candidates) {
      // Without this, a manifest `src` of `../../../../etc/passwd` resolves
      // and its bytes are embedded into the produced .deck — an arbitrary
      // local file read, exfiltrated into an artifact the user then shares.
      if (!isContained(boundaryReal, c)) continue;
      if (existsSync(c)) return c;
    }
    throw new Error(`Media asset not found: ${src} (searched ${candidates.join(', ')})`);
  }

  return { rootDir: root, tempRoot, manifest, resolveMedia, html };
}
