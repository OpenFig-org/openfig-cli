/**
 * list-overrides — List all editable override keys per symbol.
 *
 * Usage: node cli.mjs list-overrides <file.deck> [--symbol NAME|ID]
 */
import { FigDeck } from '../lib/core/fig-deck.mjs';
import { nid } from '../lib/core/node-helpers.mjs';

export async function run(args, flags) {
  const file = args[0];
  if (!file) { console.error('Usage: list-overrides <file.deck>'); process.exit(1); }

  const filterSym = flags.symbol || null;

  const deck = file.endsWith('.fig')
    ? FigDeck.fromFigFile(file)
    : await FigDeck.fromDeckFile(file);

  const symbols = deck.getSymbols();

  for (const sym of symbols) {
    const symId = nid(sym);
    const symName = sym.name || '(unnamed)';

    // Filter
    if (filterSym && symName !== filterSym && symId !== filterSym) continue;

    console.log(`\nSYMBOL "${symName}" (${symId})`);
    console.log('─'.repeat(60));

    // Walk children and find nodes with overrideKey
    walkForOverrides(deck, symId, 1);
  }
}

function walkForOverrides(deck, parentId, depth) {
  const children = deck.getChildren(parentId);
  for (const child of children) {
    const id = nid(child);
    const ok = child.overrideKey;

    if (ok) {
      const indent = '  '.repeat(depth);
      const keyStr = `${ok.sessionID}:${ok.localID}`;
      const type = child.type || '?';
      const name = child.name || '';

      let detail = '';
      if (type === 'TEXT' && child.textData?.characters) {
        const text = child.textData.characters;
        const preview = text.length > 50 ? text.substring(0, 47) + '...' : text;
        detail = ` → ${JSON.stringify(preview)}`;
      } else if (type === 'ROUNDED_RECTANGLE' || type === 'RECTANGLE') {
        const hasFill = child.fillPaints?.some(p => p.type === 'IMAGE');
        detail = hasFill ? ' [IMAGE PLACEHOLDER]' : '';
      } else if (type === 'INSTANCE') {
        const sid = child.symbolData?.symbolID;
        detail = sid ? ` sym=${sid.sessionID}:${sid.localID}` : '';
      }

      console.log(`${indent}${keyStr}  ${type} "${name}"${detail}`);
    }

    walkForOverrides(deck, id, depth + 1);
  }
}
