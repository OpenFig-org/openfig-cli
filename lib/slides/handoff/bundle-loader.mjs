import { readFileSync, existsSync, statSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname, basename } from 'path';
import { execFileSync } from 'child_process';
import crypto from 'crypto';

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
      if (!existsSync(outPath)) writeFileSync(outPath, buf);
      return outPath;
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
