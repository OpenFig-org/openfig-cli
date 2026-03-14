/**
 * Cross-platform image utilities using sharp.
 * Replaces macOS-only sips calls.
 */
import sharp from 'sharp';
import { writeFileSync } from 'fs';

/**
 * Get pixel dimensions of an image.
 * @param {string|Buffer} input - file path or buffer
 * @returns {Promise<{width: number, height: number}>}
 */
export async function getImageDimensions(input) {
  const meta = await sharp(input).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

/**
 * Generate a thumbnail (~320px wide) and write to a temp file.
 * @param {string|Buffer} input - file path or buffer
 * @param {string} outPath - destination file path
 * @returns {Promise<void>}
 */
export async function generateThumbnail(input, outPath) {
  await sharp(input)
    .resize(320, null, { withoutEnlargement: true })
    .png()
    .toFile(outPath);
}
