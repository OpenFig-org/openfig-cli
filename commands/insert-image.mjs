/**
 * insert-image — Apply an image fill override to a slide instance.
 *
 * Usage: node cli.mjs insert-image <file.deck> -o <output.deck> --slide <id|name> --key <overrideKey> --image <path.png> [--thumb <thumb.png>]
 */
import { FigDeck } from '../lib/core/fig-deck.mjs';
import { nid, parseId } from '../lib/core/node-helpers.mjs';
import { imageOv } from '../lib/core/image-helpers.mjs';
import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';
import { getImageDimensions, generateThumbnail } from '../lib/core/image-utils.mjs';

function sha1Hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

export async function run(args, flags) {
  const file = args[0];
  const outPath = flags.o || flags.output;
  const slideRef = flags.slide;
  const keyStr = flags.key;
  const imagePath = flags.image;
  const thumbPath = flags.thumb || null;

  if (!file || !outPath || !slideRef || !keyStr || !imagePath) {
    console.error('Usage: insert-image <file.deck> -o <out.deck> --slide <id|name> --key <key> --image <path.png> [--thumb <thumb.png>]');
    process.exit(1);
  }

  const deck = await FigDeck.fromDeckFile(file);

  // Find slide
  const slide = findSlide(deck, slideRef);
  if (!slide) { console.error(`Slide not found: ${slideRef}`); process.exit(1); }

  const inst = deck.getSlideInstance(nid(slide));
  if (!inst) { console.error(`No instance on slide ${nid(slide)}`); process.exit(1); }

  const imgBuf = readFileSync(resolve(imagePath));
  const imgHash = sha1Hex(imgBuf);
  const { width, height } = await getImageDimensions(resolve(imagePath));

  let thumbHash;
  if (thumbPath) {
    const tBuf = readFileSync(resolve(thumbPath));
    thumbHash = sha1Hex(tBuf);
    copyToImages(deck, thumbHash, resolve(thumbPath));
  } else {
    const tmpThumb = `/tmp/openfig_thumb_${Date.now()}.png`;
    await generateThumbnail(resolve(imagePath), tmpThumb);
    thumbHash = sha1Hex(readFileSync(tmpThumb));
    copyToImages(deck, thumbHash, tmpThumb);
  }

  // Copy full image to images dir
  copyToImages(deck, imgHash, resolve(imagePath));

  // Build and apply override
  const key = parseId(keyStr);
  const override = imageOv(key, imgHash, thumbHash, width, height);

  if (!inst.symbolData) inst.symbolData = {};
  if (!inst.symbolData.symbolOverrides) inst.symbolData.symbolOverrides = [];
  inst.symbolData.symbolOverrides.push(override);

  console.log(`Image: ${imgHash} (${width}×${height})`);
  console.log(`Thumb: ${thumbHash}`);
  console.log(`Applied to slide "${slide.name || nid(slide)}" key ${keyStr}`);

  const bytes = await deck.saveDeck(outPath);
  console.log(`Saved: ${outPath} (${bytes} bytes)`);
}

function copyToImages(deck, hash, srcPath) {
  if (!deck.imagesDir) {
    deck.imagesDir = `/tmp/openfig_images_${Date.now()}`;
    mkdirSync(deck.imagesDir, { recursive: true });
  }
  const dest = join(deck.imagesDir, hash);
  if (!existsSync(dest)) {
    copyFileSync(srcPath, dest);
  }
}

function findSlide(deck, ref) {
  const byId = deck.getNode(ref);
  if (byId?.type === 'SLIDE') return byId;
  return deck.getActiveSlides().find(s => s.name === ref);
}
