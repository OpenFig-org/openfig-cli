import { readFileSync, existsSync, statSync, mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname, basename } from 'path';
import { execFileSync } from 'child_process';

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function findManifestRoot(dir) {
  if (existsSync(join(dir, 'manifest.json'))) return dir;
  const nested = join(dir, 'claude_code_handoff');
  if (existsSync(join(nested, 'manifest.json'))) return nested;
  for (const entry of readdirSync(dir)) {
    const sub = join(dir, entry);
    if (!isDir(sub)) continue;
    const found = findManifestRoot(sub);
    if (found) return found;
  }
  return null;
}

function unzipToTemp(zipPath) {
  const dest = mkdtempSync(join(tmpdir(), 'openfig-handoff-'));
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', dest]);
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

  const root = findManifestRoot(workDir);
  if (!root) {
    throw new Error(`No manifest.json found under ${workDir}`);
  }

  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

  let html = null;
  const htmlFile = readdirSync(root).find(f => f.toLowerCase().endsWith('.html'));
  if (htmlFile) {
    html = readFileSync(join(root, htmlFile), 'utf8');
  }

  function resolveMedia(src) {
    if (!src || typeof src !== 'string') {
      throw new Error(`resolveMedia: invalid src ${JSON.stringify(src)}`);
    }
    const candidates = [
      join(root, src),
      join(root, 'media', basename(src)),
      join(dirname(root), src),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    throw new Error(`Media asset not found: ${src} (searched ${candidates.join(', ')})`);
  }

  return { rootDir: root, tempRoot, manifest, resolveMedia, html };
}
