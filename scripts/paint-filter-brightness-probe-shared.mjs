import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exposureForBrightness } from '../lib/slides/handoff/element-dispatch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SLIDE = { w: 1920, h: 1080 };
// Exact aspect ratio and vertical placement of the slide 7 photo band, moved
// away from the slide edge only so the human-readable probe label remains
// visible. The image crop itself is still 1920x300.
export const PHOTO = { x: 0, y: 450, w: 1920, h: 300 };
export const SOURCE_ASSET_ID = '9bce4ed7-8dcc-4d01-a784-224c268bc54d';
export const SOURCE_HTML = join(
  HERE,
  '..',
  'test',
  'fixtures',
  'standalone-html',
  'the-carbon-question',
  'The-Carbon-Question.html',
);

export const BRIGHTNESS_VALUES = [1, 1.18, 1.55];
export const PROBE_STEPS = BRIGHTNESS_VALUES.map((brightness) => ({
  brightness,
  exposure: brightness === 1 ? null : exposureForBrightness(brightness),
}));

/**
 * Read the real slide 7 wind-farm photograph from the standalone export.
 *
 * Keeping the source in the fixture avoids introducing a convenient synthetic
 * photo whose histogram happens to flatter either CSS brightness or exposure.
 */
export function readSourcePhoto() {
  const html = readFileSync(SOURCE_HTML, 'utf8');
  const marker = '<script type="__bundler/manifest">';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`asset manifest not found in ${SOURCE_HTML}`);
  const contentStart = start + marker.length;
  const end = html.indexOf('</script>', contentStart);
  if (end < 0) throw new Error(`asset manifest is not closed in ${SOURCE_HTML}`);
  const manifest = JSON.parse(html.slice(contentStart, end));
  const asset = manifest[SOURCE_ASSET_ID];
  if (!asset) throw new Error(`source asset ${SOURCE_ASSET_ID} is absent`);
  let bytes = Buffer.from(asset.data, 'base64');
  if (asset.compressed) bytes = gunzipSync(bytes);
  return { bytes, mime: asset.mime };
}

export function groundTruthFilename(index) {
  return `page-${String(index + 1).padStart(2, '0')}.png`;
}
