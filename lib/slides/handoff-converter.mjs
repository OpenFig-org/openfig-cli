import { mkdirSync } from 'fs';
import { Deck } from './api.mjs';
import { loadBundle } from './handoff/bundle-loader.mjs';
import { applyElement } from './handoff/element-dispatch.mjs';

function scopeScratchDir(outPath) {
  const scratch = outPath.replace(/\.deck$/, '') + '-build';
  mkdirSync(scratch, { recursive: true });
  process.env.TMPDIR = scratch;
  return scratch;
}

export async function convertHandoffBundle(bundlePath, outDeckPath, opts = {}) {
  const bundle = loadBundle(bundlePath);
  const manifest = bundle.manifest;
  const scratch = opts.scratchDir ?? scopeScratchDir(outDeckPath);

  const deck = await Deck.create({ name: opts.title ?? manifest.title ?? 'Untitled' });

  for (let i = 0; i < manifest.slides.length; i++) {
    const def = manifest.slides[i];
    const slide = deck.addBlankSlide();
    if (def.background) slide.setBackground(def.background);
    const ctx = { ...bundle, slideIndex: i + 1, slideDef: def };
    for (const el of def.elements ?? []) {
      await applyElement(slide, el, ctx);
    }
    if (def.speakerNotes) slide.setSpeakerNotes(def.speakerNotes);
  }

  await deck.save(outDeckPath);
  return { deck, scratchDir: scratch, bundle };
}
