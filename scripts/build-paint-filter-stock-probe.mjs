#!/usr/bin/env node
/**
 * Build a public-domain photo generalization probe for editable paint filters.
 *
 * Every slide places the CSS pixel target beside the original photograph with
 * OpenFig's editable native paintFilter mapping. A no-filter control verifies
 * that export/layout noise is negligible before the filtered pairs are scored.
 *
 * The five source photographs are CC0 1.0 files from Wikimedia Commons. Their
 * file pages are printed on the slides and recorded below so a derived visual
 * can be published with an auditable source trail.
 *
 * Usage:
 *   node scripts/build-paint-filter-stock-probe.mjs \
 *     [-o out.deck] [--assets directory]
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { basename, join, resolve } from 'path';
import sharp from 'sharp';
import { sharpImageOps } from '../lib/core/image-utils.mjs';
import {
  contrastForCss,
  exposureForBrightness,
  toneAdjustmentsForBrightness,
} from '../lib/slides/handoff/element-dispatch.mjs';
import { Deck } from '../lib/slides/api.mjs';

export const SLIDE = { width: 1920, height: 1080 };
export const TARGET_REGION = { x: 110, y: 280, width: 820, height: 680 };
export const NATIVE_REGION = { x: 990, y: 280, width: 820, height: 680 };

export const STOCK_SOURCES = [
  {
    id: 'portrait',
    label: 'Low-key monochrome portrait',
    filename: 'portrait.jpg',
    downloadUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/4/49/Bearded_man_smoking_pipe-3013924.jpg/1920px-Bearded_man_smoking_pipe-3013924.jpg',
    sourcePage:
      'https://commons.wikimedia.org/wiki/File:Bearded_man_smoking_pipe-3013924.jpg',
  },
  {
    id: 'landscape',
    label: 'Daylight landscape',
    filename: 'landscape.jpg',
    downloadUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Landscape_north_Euboea_Greece.jpg/1920px-Landscape_north_Euboea_Greece.jpg',
    sourcePage:
      'https://commons.wikimedia.org/wiki/File:Landscape_north_Euboea_Greece.jpg',
  },
  {
    id: 'night',
    label: 'Night industrial scene',
    filename: 'night.jpg',
    downloadUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/Snowfall_at_night_over_Brofjorden_and_Preemraff_oil_refinery.jpg/1920px-Snowfall_at_night_over_Brofjorden_and_Preemraff_oil_refinery.jpg',
    sourcePage:
      'https://commons.wikimedia.org/wiki/File:Snowfall_at_night_over_Brofjorden_and_Preemraff_oil_refinery.jpg',
  },
  {
    id: 'interior',
    label: 'High-dynamic-range interior',
    filename: 'interior.jpg',
    downloadUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bb/Interior_of_the_Basilica_of_Sainte-Anne-de-Beaupr%C3%A9.jpg/1920px-Interior_of_the_Basilica_of_Sainte-Anne-de-Beaupr%C3%A9.jpg',
    sourcePage:
      'https://commons.wikimedia.org/wiki/File:Interior_of_the_Basilica_of_Sainte-Anne-de-Beaupr%C3%A9.jpg',
  },
  {
    id: 'flowers',
    label: 'Highly saturated flowers',
    filename: 'flowers.jpg',
    downloadUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Gazania_krebsiana%2C_Quebec_city%2C_Quebec%2C_Canada_131.jpg/1920px-Gazania_krebsiana%2C_Quebec_city%2C_Quebec%2C_Canada_131.jpg',
    sourcePage:
      'https://commons.wikimedia.org/wiki/File:Gazania_krebsiana,_Quebec_city,_Quebec,_Canada_131.jpg',
  },
].map((source) => ({
  ...source,
  license: 'CC0 1.0',
  attributionRequired: false,
}));

const MILD_BRIGHTNESS = 1.18;
const STRONG_CONTRAST = 1.15;
const STRONG_BRIGHTNESS = 1.55;

export const PROFILES = [
  {
    id: 'control',
    label: 'Control - no filter',
    ops: [],
    paintFilter: null,
  },
  {
    id: 'mild',
    label: 'Mild - brightness(1.18)',
    ops: [{ fn: 'brightness', amount: MILD_BRIGHTNESS }],
    paintFilter: toneAdjustmentsForBrightness(MILD_BRIGHTNESS),
  },
  {
    id: 'strong',
    label: 'Strong - grayscale(1) contrast(1.15) brightness(1.55)',
    ops: [
      { fn: 'grayscale', amount: 1 },
      { fn: 'contrast', amount: STRONG_CONTRAST },
      { fn: 'brightness', amount: STRONG_BRIGHTNESS },
    ],
    paintFilter: {
      vibrance: -1,
      contrast: contrastForCss(STRONG_CONTRAST),
      ...toneAdjustmentsForBrightness(STRONG_BRIGHTNESS),
    },
  },
];

export const PROBE_PLAN = PROFILES.flatMap((profile) =>
  STOCK_SOURCES.map((source) => ({ profile, source })));

export const COLOR_SAFE_PROFILES = [
  {
    id: 'current-color',
    label: 'Current color mapping - brightness(1.18)',
    ops: [{ fn: 'brightness', amount: MILD_BRIGHTNESS }],
    paintFilter: toneAdjustmentsForBrightness(MILD_BRIGHTNESS),
  },
  {
    id: 'color-safe',
    label: 'Color-safe candidate - brightness(1.18)',
    ops: [{ fn: 'brightness', amount: MILD_BRIGHTNESS }],
    paintFilter: {
      exposure: exposureForBrightness(MILD_BRIGHTNESS),
    },
  },
  {
    id: 'grayscale-refined',
    label: 'Grayscale refinement - grayscale(1) brightness(1.18)',
    ops: [
      { fn: 'grayscale', amount: 1 },
      { fn: 'brightness', amount: MILD_BRIGHTNESS },
    ],
    paintFilter: {
      vibrance: -1,
      ...toneAdjustmentsForBrightness(MILD_BRIGHTNESS),
    },
  },
];

export function profilesForMode(mode) {
  if (mode === 'generalization') return PROFILES;
  if (mode === 'color-safe') return COLOR_SAFE_PROFILES;
  throw new Error(`unknown probe mode ${mode}`);
}

export function probePlanForMode(mode) {
  return profilesForMode(mode).flatMap((profile) =>
    STOCK_SOURCES.map((source) => ({ profile, source })));
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

async function download(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'OpenFig paint-filter research probe' },
  });
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function sourceBytes(source, assetsDirectory) {
  if (assetsDirectory) {
    const path = join(assetsDirectory, source.filename);
    if (existsSync(path)) return readFileSync(path);
  }
  const bytes = await download(source.downloadUrl);
  if (assetsDirectory) {
    mkdirSync(assetsDirectory, { recursive: true });
    writeFileSync(join(assetsDirectory, source.filename), bytes);
  }
  return bytes;
}

async function normalizedPhoto(bytes) {
  return sharp(bytes)
    .resize(TARGET_REGION.width, TARGET_REGION.height, {
      fit: 'cover',
      position: 'centre',
    })
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

async function cssTarget(bytes, profile) {
  if (!profile.ops.length) return bytes;
  return sharpImageOps.bakeFilter(bytes, { ops: profile.ops });
}

function imagePaint(node) {
  const paint = node.fillPaints?.find((candidate) => candidate.type === 'IMAGE');
  if (!paint) throw new Error(`probe: ${node.name ?? 'image'} has no IMAGE paint`);
  return paint;
}

async function addPair(slide, normalized, target, profile) {
  await slide.addImage(
    { bytes: target, mime: profile.ops.length ? 'image/png' : 'image/jpeg' },
    {
      ...TARGET_REGION,
      name: 'CSS pixel target',
      scaleMode: 'STRETCH',
    },
  );
  const native = await slide.addImage(
    { bytes: normalized, mime: 'image/jpeg' },
    {
      ...NATIVE_REGION,
      name: 'Editable native mapping',
      scaleMode: 'STRETCH',
    },
  );
  if (profile.paintFilter) {
    imagePaint(native).paintFilter = { ...profile.paintFilter };
  }
}

async function main() {
  const outPath = resolve(option('-o', 'paint-filter-stock-probe.deck'));
  const assetsArg = option('--assets', '');
  const assetsDirectory = assetsArg ? resolve(assetsArg) : '';
  const mode = option('--mode', 'generalization');
  const profiles = profilesForMode(mode);
  const plan = probePlanForMode(mode);
  const normalized = new Map();

  for (const source of STOCK_SOURCES) {
    normalized.set(
      source.id,
      await normalizedPhoto(await sourceBytes(source, assetsDirectory)),
    );
  }

  const deck = await Deck.create({
    name: mode === 'generalization'
      ? 'OpenFig editable paint-filter stock-photo probe'
      : 'OpenFig color-safe paint-filter refinement probe',
  });
  for (const [index, { profile, source }] of plan.entries()) {
    const slide = deck.addBlankSlide();
    const photo = normalized.get(source.id);
    const target = await cssTarget(photo, profile);

    slide.addText(
      `${String(index + 1).padStart(2, '0')}  ${source.label}`,
      {
        x: 110,
        y: 58,
        width: 1700,
        font: 'Inter',
        fontSize: 46,
        fontWeight: 600,
        color: { r: 0.05, g: 0.05, b: 0.05 },
      },
    );
    slide.addText(
      profile.label,
      {
        x: 110,
        y: 132,
        width: 1700,
        font: 'Inter',
        fontSize: 28,
        color: { r: 0.25, g: 0.25, b: 0.25 },
      },
    );
    slide.addText(
      'CSS pixel target',
      {
        x: TARGET_REGION.x,
        y: 225,
        width: TARGET_REGION.width,
        font: 'Inter',
        fontSize: 24,
        color: { r: 0.2, g: 0.2, b: 0.2 },
      },
    );
    slide.addText(
      'OpenFig editable native mapping',
      {
        x: NATIVE_REGION.x,
        y: 225,
        width: NATIVE_REGION.width,
        font: 'Inter',
        fontSize: 24,
        color: { r: 0.2, g: 0.2, b: 0.2 },
      },
    );
    await addPair(slide, photo, target, profile);
    slide.addText(
      `Source: ${basename(new URL(source.sourcePage).pathname)} · ${source.license} · Wikimedia Commons`,
      {
        x: 110,
        y: 994,
        width: 1700,
        font: 'Inter',
        fontSize: 17,
        color: { r: 0.4, g: 0.4, b: 0.4 },
      },
    );
  }

  await deck.save(outPath);
  console.log(`wrote ${outPath}`);
  console.log(`  ${plan.length} slides: ${STOCK_SOURCES.length} CC0 photos × ${profiles.length} profiles`);
  for (const profile of profiles) {
    console.log(`  ${profile.id}: ${profile.label}`);
    console.log(`    ${JSON.stringify(profile.paintFilter ?? {})}`);
  }
}

if (process.argv[1]?.endsWith('build-paint-filter-stock-probe.mjs')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
