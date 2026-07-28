/**
 * openfig programmatic API — the Node face of `./api-core.mjs`.
 *
 * Everything the Deck/Slide/Symbol model does lives in the core, which is
 * portable. This adds the three capabilities that need a filesystem, as a
 * `DeckIo` the core threads down to every object that can be handed a path:
 *
 *   - `Deck.open(path)` and `deck.save(outPath)`
 *   - a path argument to `addImage` / `setImage` / `setImageFill`
 *   - a path argument to `addSVG`
 *
 * plus `sharpImageOps` as the default raster implementation, which is the one
 * every recorded `.deck` baseline was produced with.
 *
 * The naming is inverted the same way `core/fig-deck.mjs` is: this file keeps
 * its path and its exported names, so `bin/*`, `mcp-server.mjs` and the
 * `openfig-cli` package export are untouched.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { FigDeck } from '../core/fig-deck.mjs';
import { sharpImageOps } from '../core/image-utils.mjs';
import { Deck as DeckCore } from './api-core.mjs';

export {
  Slide,
  Symbol,
  TextNode,
  ImageNode,
  Shape,
  PORTABLE_DECK_IO,
} from './api-core.mjs';

/** @type {import('./api-core.mjs').DeckIo} */
export const NODE_DECK_IO = Object.freeze({
  imageOps: sharpImageOps,
  readFileBytes: (path) => readFileSync(resolve(path)),
  // No `resolve`, matching the pre-split `addSVG`, which read the argument as
  // given.
  readFileText: (path) => readFileSync(path, 'utf8'),
});

export class Deck extends DeckCore {
  /**
   * @param {import('../core/fig-deck.mjs').FigDeck} figDeck
   * @param {string|null} [sourcePath]
   * @param {import('./api-core.mjs').DeckIo} [io]
   */
  constructor(figDeck, sourcePath = null, io = NODE_DECK_IO) {
    super(figDeck, sourcePath, io);
  }

  static get FigDeckClass() { return FigDeck; }

  static get defaultIo() { return NODE_DECK_IO; }

  /**
   * Open a .deck file.
   * @param {string} path
   * @returns {Promise<Deck>}
   */
  static async open(path) {
    const fd = await FigDeck.fromDeckFile(resolve(path));
    return new this(fd, resolve(path));
  }

  /**
   * Save to a file. Defaults to overwriting the source path.
   * @param {string} [outPath]
   */
  async save(outPath) {
    const target = outPath ? resolve(outPath) : this._sourcePath;
    if (!target) throw new Error('No output path specified and no source path known');
    // `FigDeck.saveDeck`, not `toBytes()` + a write: only `saveDeck` overlays
    // the images a deck opened from a file has on disk.
    await this._fd.saveDeck(target);
  }
}
