/**
 * Opening book built from the vendored lichess `chess-openings` table (ADR-011): every named
 * variation with its move line. Pure (no chess.js, no stores), so it is cheap to build and test.
 *
 * The lines form a trie of SAN moves from the start position; a node is "in book" when some named
 * line passes through it. Move-order based: a transposition into a book position by another move
 * order is not in book here (the position-based name lookup in `index.ts` still recognises it).
 */

/** One row of `data/openings.json`: ECO, name, EPD of the named position, SAN line ("e4 e5"). */
export type OpeningRow = readonly [eco: string, name: string, epd: string, moves: string];

export interface BookOpening {
  /** Index in the table (stable for one data version). */
  readonly id: number;
  readonly eco: string;
  readonly name: string;
  /** Position after the line, without move counters. */
  readonly epd: string;
  /** The line as SAN moves from the start position. */
  readonly moves: readonly string[];
}

export interface BookMove {
  san: string;
  /** The named variation reached exactly by this move, if any. */
  opening?: BookOpening;
  /** Names of the variations this move leads to (shallowest first, at most {@link MAX_NAMES}). */
  names: string[];
  /** Number of named variations in the subtree of this move (popularity / amount of theory). */
  lines: number;
}

/** Cap of {@link BookMove.names}. */
export const MAX_NAMES = 5;

interface Node {
  readonly children: Map<string, Node>;
  /** The named variation ending exactly here. */
  entry?: BookOpening;
  /** Named variations in this subtree (including `entry`). */
  size: number;
  /** Shallowest-first names in the subtree (filled lazily). */
  names?: string[];
}

const newNode = (): Node => ({ children: new Map(), size: 0 });

/** Identity of a variation across data versions (ECO + name), e.g. for the training schedule. */
export const openingKey = (o: Pick<BookOpening, 'eco' | 'name'>): string => `${o.eco} ${o.name}`;

/** Lowercase, no diacritics, punctuation as spaces. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface SearchIndex {
  name: string;
  words: string[];
  eco: string;
}

export class Book {
  readonly openings: readonly BookOpening[];
  private readonly root: Node = newNode();
  private readonly byKey = new Map<string, BookOpening>();
  private readonly index: SearchIndex[];

  constructor(rows: readonly OpeningRow[]) {
    const openings: BookOpening[] = [];
    for (const row of rows) {
      const [eco, name, epd, line] = row;
      const moves = line.split(' ').filter(Boolean);
      if (moves.length === 0) continue;
      const o: BookOpening = { id: openings.length, eco, name, epd, moves };
      openings.push(o);
      if (!this.byKey.has(openingKey(o))) this.byKey.set(openingKey(o), o);
      let node = this.root;
      node.size++;
      for (const san of moves) {
        let next = node.children.get(san);
        if (!next) node.children.set(san, (next = newNode()));
        next.size++;
        node = next;
      }
      // Two rows with the same line cannot happen (same line = same position); keep the first.
      node.entry ??= o;
    }
    this.openings = openings;
    this.index = openings.map((o) => {
      const name = normalizeText(o.name);
      return { name, words: name.split(' '), eco: o.eco.toLowerCase() };
    });
  }

  private node(prefix: readonly string[]): Node | undefined {
    let node: Node | undefined = this.root;
    for (const san of prefix) {
      node = node.children.get(san);
      if (!node) return undefined;
    }
    return node;
  }

  /** True when some named line starts with `prefix` (the empty prefix is in book). */
  inBook(prefix: readonly string[]): boolean {
    return this.node(prefix) !== undefined;
  }

  /**
   * The book continuations after `prefix` (SAN moves from the start position), most popular
   * first (number of named lines below), then by SAN. Empty when `prefix` left the book.
   */
  bookMoves(prefix: readonly string[]): BookMove[] {
    const node = this.node(prefix);
    if (!node) return [];
    const out: BookMove[] = [];
    for (const [san, child] of node.children) {
      out.push({
        san,
        ...(child.entry ? { opening: child.entry } : {}),
        names: this.names(child),
        lines: child.size,
      });
    }
    return out.sort((a, b) => b.lines - a.lines || a.san.localeCompare(b.san));
  }

  /** Shallowest-first distinct names in the subtree (breadth-first, capped). */
  private names(node: Node): string[] {
    if (node.names) return node.names;
    const names: string[] = [];
    let level: Node[] = [node];
    while (level.length && names.length < MAX_NAMES) {
      const next: Node[] = [];
      // Popular branches first within one depth.
      const sorted = [...level].sort((a, b) => b.size - a.size);
      for (const n of sorted) {
        if (n.entry && !names.includes(n.entry.name)) {
          names.push(n.entry.name);
          if (names.length >= MAX_NAMES) break;
        }
        next.push(...n.children.values());
      }
      level = next;
    }
    node.names = names;
    return names;
  }

  /** The deepest named variation along `prefix` (the opening "so far"), or undefined. */
  openingAt(prefix: readonly string[]): BookOpening | undefined {
    let node: Node | undefined = this.root;
    let found: BookOpening | undefined;
    for (const san of prefix) {
      node = node.children.get(san);
      if (!node) break;
      if (node.entry) found = node.entry;
    }
    return found;
  }

  /** The named variation ending exactly at `prefix`, if any. */
  openingExactly(prefix: readonly string[]): BookOpening | undefined {
    return this.node(prefix)?.entry;
  }

  /** The SAN line of an opening (a copy). */
  lineFor(o: Pick<BookOpening, 'moves'>): string[] {
    return [...o.moves];
  }

  /**
   * Named sub-variations of `o`: every variation whose line extends `o`'s line (not `o` itself),
   * shallowest first, then in table order (ECO, name).
   */
  variationsUnder(o: Pick<BookOpening, 'moves'>): BookOpening[] {
    const node = this.node(o.moves);
    if (!node) return [];
    const out: { o: BookOpening; depth: number }[] = [];
    const walk = (n: Node, depth: number) => {
      for (const child of n.children.values()) {
        if (child.entry) out.push({ o: child.entry, depth });
        walk(child, depth + 1);
      }
    };
    walk(node, 1);
    return out.sort((a, b) => a.depth - b.depth || a.o.id - b.o.id).map((x) => x.o);
  }

  /** Number of named sub-variations of `o` (same set as {@link variationsUnder}). */
  countUnder(o: Pick<BookOpening, 'moves'>): number {
    const node = this.node(o.moves);
    if (!node) return 0;
    return node.size - (node.entry ? 1 : 0);
  }

  /** Book continuations inside `o`'s subtree after `prefix` (see {@link inSubtree}). */
  subtreeMoves(o: Pick<BookOpening, 'moves'>, prefix: readonly string[]): BookMove[] {
    if (prefix.length < o.moves.length) {
      const san = o.moves[prefix.length]!;
      if (!o.moves.slice(0, prefix.length).every((m, i) => m === prefix[i])) return [];
      return this.bookMoves(prefix).filter((m) => m.san === san);
    }
    return inSubtree(o, prefix) ? this.bookMoves(prefix) : [];
  }

  /** The variation with this {@link openingKey}. */
  find(key: string): BookOpening | undefined {
    return this.byKey.get(key);
  }

  /**
   * Openings matching `query` by name or ECO, best first:
   * ECO code (exact > prefix) > name starts with the query > the opening family (before ":")
   * starts with it > every query word is the start of a word in the name (in order ranks higher)
   * > substring. Ties: shorter line, then table order. An empty query returns [].
   */
  search(query: string, limit = 50): BookOpening[] {
    const q = normalizeText(query);
    if (!q) return [];
    const qWords = q.split(' ');
    const ecoQuery = /^[a-e]\d{0,2}$/.test(q) ? q : null;
    const scored: { o: BookOpening; score: number }[] = [];
    for (let i = 0; i < this.openings.length; i++) {
      const o = this.openings[i]!;
      const ix = this.index[i]!;
      let score = 0;
      if (ecoQuery && ix.eco === ecoQuery) score = 1000;
      else if (ecoQuery && ecoQuery.length > 1 && ix.eco.startsWith(ecoQuery)) score = 900;
      else if (ix.name.startsWith(q)) score = ix.name.length === q.length ? 800 : 700;
      else {
        const words = matchWords(ix.words, qWords);
        if (words === 'ordered') score = 500;
        else if (words === 'unordered') score = 400;
        else if (ix.name.includes(q)) score = 100;
      }
      if (score > 0) scored.push({ o, score });
    }
    scored.sort(
      (a, b) => b.score - a.score || a.o.moves.length - b.o.moves.length || a.o.id - b.o.id,
    );
    return scored.slice(0, limit).map((s) => s.o);
  }
}

/** Every query word is a prefix of a distinct name word; 'ordered' if they appear in order. */
function matchWords(
  words: readonly string[],
  q: readonly string[],
): 'ordered' | 'unordered' | null {
  let ordered = true;
  let last = -1;
  const used = new Set<number>();
  for (const w of q) {
    let hit = -1;
    // Prefer a match after the previous one (keeps "queen gambit declined" ordered).
    for (let i = last + 1; i < words.length; i++) {
      if (!used.has(i) && words[i]!.startsWith(w)) {
        hit = i;
        break;
      }
    }
    if (hit < 0) {
      ordered = false;
      for (let i = 0; i < words.length; i++) {
        if (!used.has(i) && words[i]!.startsWith(w)) {
          hit = i;
          break;
        }
      }
    }
    if (hit < 0) return null;
    used.add(hit);
    last = hit;
  }
  return ordered ? 'ordered' : 'unordered';
}

/** True when `prefix` is `o`'s line or extends it. */
export function inSubtree(o: Pick<BookOpening, 'moves'>, prefix: readonly string[]): boolean {
  return prefix.length >= o.moves.length && o.moves.every((m, i) => prefix[i] === m);
}

/**
 * Picks one of `moves` at random, weighted by the number of named lines below each move (the main
 * line has the most theory), so side lines still come up now and then. `random` in [0, 1).
 */
export function pickWeighted(
  moves: readonly BookMove[],
  random: () => number,
): BookMove | undefined {
  if (moves.length === 0) return undefined;
  const total = moves.reduce((n, m) => n + m.lines, 0);
  let r = random() * total;
  for (const m of moves) {
    r -= m.lines;
    if (r < 0) return m;
  }
  return moves[moves.length - 1];
}
