#!/usr/bin/env node
/**
 * Build the combined native tone-control refinement probe.
 *
 * The first tone-fit probe established that negative `shadows` and positive
 * `highlights` can restore more spread than slide 7 is missing. This probe
 * measures their interaction while slightly lowering exposure to compensate
 * for the highlights control's mean-luminance lift.
 *
 * Page 1 embeds the actual Chromium-rendered slide 7 band from the fixture as
 * a measurement target. It is a probe reference only; product output remains
 * the original image plus editable native paintFilter values.
 *
 * Usage:
 *   node scripts/build-paint-filter-tone-refinement-probe.mjs [-o out.deck]
 */
import { execFileSync } from 'child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { Deck } from '../lib/slides/api.mjs';
import {
  PHOTO,
  RAMP,
} from './build-paint-filter-tone-fit-probe.mjs';
import { readSourcePhoto } from './paint-filter-brightness-probe-shared.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GROUND_TRUTH_PDF = join(
  HERE,
  '..',
  'test',
  'fixtures',
  'standalone-html',
  'the-carbon-question',
  'The-Carbon-Question.claude-design.pdf',
);
const CORAL = '#FF5B45';

export const SHADOW_VALUES = [-1, -0.75, -0.5];
export const HIGHLIGHT_VALUES = [0.5, 0.75, 1];
export const EXPOSURE_VALUES = [0.2692, 0.2892, 0.3092, 0.3292];

const BASELINE = {
  vibrance: -1,
  contrast: 0.5,
  exposure: 0.3292,
};

export const REFINEMENT_PLAN = [
  {
    label: 'TARGET — Chromium CSS',
    kind: 'target',
    paintFilter: null,
  },
  {
    label: 'BASELINE — current native mapping',
    kind: 'native',
    paintFilter: { ...BASELINE },
  },
  ...EXPOSURE_VALUES.flatMap((exposure) =>
    HIGHLIGHT_VALUES.flatMap((highlights) =>
      SHADOW_VALUES.map((shadows) => ({
        label: `E ${exposure} · H ${highlights} · S ${shadows}`,
        kind: 'native',
        paintFilter: {
          vibrance: -1,
          contrast: 0.5,
          exposure,
          highlights,
          shadows,
        },
      })))),
];

async function rampPng({ cssTarget = false } = {}) {
  const bands = 32;
  const bandWidth = Math.round(RAMP.width / bands);
  const pixels = Buffer.alloc(RAMP.width * RAMP.height * 3);
  for (let x = 0; x < RAMP.width; x++) {
    const band = Math.min(bands - 1, Math.floor(x / bandWidth));
    let level = Math.round(8 + (band / (bands - 1)) * 239);
    if (cssTarget) {
      // grayscale(1) is a no-op on this neutral ramp. CSS applies the remaining
      // functions left to right, clipping after each primitive.
      level = Math.max(0, Math.min(255, ((level - 127.5) * 1.15) + 127.5));
      level = Math.max(0, Math.min(255, level * 1.55));
      level = Math.round(level);
    }
    for (let y = 0; y < RAMP.height; y++) {
      const index = (y * RAMP.width + x) * 3;
      pixels[index] = level;
      pixels[index + 1] = level;
      pixels[index + 2] = level;
    }
  }
  return sharp(pixels, {
    raw: { width: RAMP.width, height: RAMP.height, channels: 3 },
  }).png().toBuffer();
}

async function chromiumTargetBand(scratch) {
  const prefix = join(scratch, 'chromium-slide-7');
  execFileSync('pdftoppm', [
    '-png',
    '-r',
    '192',
    '-f',
    '7',
    '-l',
    '7',
    '-singlefile',
    GROUND_TRUTH_PDF,
    prefix,
  ], { stdio: 'pipe' });
  const page = readFileSync(`${prefix}.png`);
  const meta = await sharp(page).metadata();
  if (!meta.width || !meta.height) throw new Error('could not size Chromium target page');
  const bandHeight = Math.round(meta.width * (300 / 1920));
  return sharp(page)
    .extract({
      left: 0,
      top: meta.height - bandHeight,
      width: meta.width,
      height: bandHeight,
    })
    .resize(PHOTO.width, PHOTO.height, { fit: 'fill' })
    .png()
    .toBuffer();
}

function imagePaint(node) {
  const paint = node.fillPaints?.find((candidate) => candidate.type === 'IMAGE');
  if (!paint) throw new Error(`probe: ${node.name ?? 'image'} has no IMAGE paint`);
  return paint;
}

async function addNativeSamples(slide, rampPath, photo, paintFilter) {
  const ramp = await slide.addImage(rampPath, {
    ...RAMP,
    name: 'Measured native grey ramp',
    scaleMode: 'FILL',
  });
  imagePaint(ramp).paintFilter = { ...paintFilter };

  slide.addRectangle(PHOTO.x, PHOTO.y, PHOTO.width, PHOTO.height, {
    name: 'Slide 7 coral background',
    fill: CORAL,
  });
  const image = await slide.addImage(photo, {
    ...PHOTO,
    name: 'Measured native slide 7 photograph',
    scaleMode: 'FILL',
  });
  const paint = imagePaint(image);
  paint.paintFilter = { ...paintFilter };
  paint.blendMode = 'MULTIPLY';
}

async function addTargetSamples(slide, targetRampPath, targetBand) {
  await slide.addImage(targetRampPath, {
    ...RAMP,
    name: 'CSS target grey ramp',
    scaleMode: 'FILL',
  });
  await slide.addImage(
    { bytes: targetBand, mime: 'image/png' },
    {
      ...PHOTO,
      name: 'Chromium target slide 7 band',
      scaleMode: 'FILL',
    },
  );
}

async function main() {
  const outIndex = process.argv.indexOf('-o');
  const outPath = outIndex > -1
    ? process.argv[outIndex + 1]
    : 'paint-filter-tone-refinement-probe.deck';
  if (!outPath) throw new Error('-o requires an output path');

  const scratch = mkdtempSync(join(tmpdir(), 'tone-refinement-probe-'));
  try {
    const rampPath = join(scratch, 'ramp.png');
    const targetRampPath = join(scratch, 'target-ramp.png');
    writeFileSync(rampPath, await rampPng());
    writeFileSync(targetRampPath, await rampPng({ cssTarget: true }));
    const targetBand = await chromiumTargetBand(scratch);
    const photo = readSourcePhoto();

    const deck = await Deck.create({ name: 'OpenFig native tone refinement probe' });
    for (const [index, step] of REFINEMENT_PLAN.entries()) {
      const slide = deck.addBlankSlide();
      slide.addText(
        `${String(index + 1).padStart(2, '0')}  ${step.label}`,
        {
          x: 160,
          y: 72,
          width: 1600,
          font: 'Inter',
          fontSize: 48,
          color: { r: 0, g: 0, b: 0 },
        },
      );
      slide.addText(
        step.kind === 'target'
          ? 'Rendered by Chromium from the fixture · measurement reference only'
          : JSON.stringify(step.paintFilter),
        {
          x: 160,
          y: 155,
          width: 1600,
          font: 'Inter',
          fontSize: 22,
          color: { r: 0.25, g: 0.25, b: 0.25 },
        },
      );

      if (step.kind === 'target') {
        await addTargetSamples(slide, targetRampPath, targetBand);
      } else {
        await addNativeSamples(slide, rampPath, photo, step.paintFilter);
      }
    }

    await deck.save(outPath);
    console.log(`wrote ${outPath}`);
    console.log(`  ${REFINEMENT_PLAN.length} slides: 1 target, 1 baseline, 36 candidates`);
    console.log(`  shadows: ${SHADOW_VALUES.join(', ')}`);
    console.log(`  highlights: ${HIGHLIGHT_VALUES.join(', ')}`);
    console.log(`  exposure: ${EXPOSURE_VALUES.join(', ')}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('build-paint-filter-tone-refinement-probe.mjs')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
