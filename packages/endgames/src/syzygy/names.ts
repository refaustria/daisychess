/*
 * Syzygy tablebase reader for DaisyChess — table names and dependencies.
 *
 * Derived from python-chess (`chess/syzygy.py`: `normalize_tablename`, `recalc_key`,
 * `_dependencies`, `all_dependencies`, `is_tablename`), Copyright (C) 2012-2024 Niklas Fiekas,
 * GPL-3.0-or-later (see `table.ts` for the full notice). Changes: TypeScript port (2026, the
 * DaisyChess authors).
 */

const PCHR = ['K', 'Q', 'R', 'B', 'N', 'P'];
const TABLENAME = /^[KQRBNP]+v[KQRBNP]+$/;

const order = (c: string): number => PCHR.indexOf(c);
const sortSide = (s: string): string => [...s].sort((a, b) => order(a) - order(b)).join('');

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return a.length < b.length;
}

/**
 * Canonical Syzygy name of a material key (`KPvKR` → `KRvKP`); with `mirror` the other side
 * order (python-chess `normalize_tablename`).
 */
export function normalizeTableName(name: string, mirror = false): string {
  const v = name.indexOf('v');
  const w = sortSide(name.slice(0, v));
  const b = sortSide(name.slice(v + 1));
  // (len(w), [order of b]) < (len(b), [order of w])
  const wb = [...b].map(order);
  const bw = [...w].map(order);
  const less = w.length !== b.length ? w.length < b.length : lexLess(wb, bw);
  return mirror !== less ? `${b}v${w}` : `${w}v${b}`;
}

/** Whether `name` is a canonical one-king table name with at most 7 pieces (`KQvK`, not `KvK`). */
export function isTableName(name: string): boolean {
  return (
    name.length <= 8 &&
    TABLENAME.test(name) &&
    normalizeTableName(name) === name &&
    name !== 'KvK' &&
    name.startsWith('K') &&
    name.includes('vK') &&
    name.split('K').length === 3
  );
}

/** Material key from the table's piece codes (python-chess `recalc_key`). */
export function recalcKey(pieces: number[], mirror = false): string {
  const w = mirror ? 8 : 0;
  const b = mirror ? 0 : 8;
  const count = (code: number): number => pieces.filter((p) => p === code).length;
  const side = (c: number): string =>
    'K'.repeat(count(6 ^ c)) +
    'Q'.repeat(count(5 ^ c)) +
    'R'.repeat(count(4 ^ c)) +
    'B'.repeat(count(3 ^ c)) +
    'N'.repeat(count(2 ^ c)) +
    'P'.repeat(count(1 ^ c));
  return `${side(w)}v${side(b)}`;
}

function directDependencies(target: string): string[] {
  const v = target.indexOf('v');
  const w = target.slice(0, v);
  const b = target.slice(v + 1);
  const out: string[] = [];
  for (const p of PCHR) {
    if (p === 'K') continue;
    // Promotions.
    if (p !== 'P' && w.includes('P')) out.push(normalizeTableName(`${w.replace('P', p)}v${b}`));
    if (p !== 'P' && b.includes('P')) out.push(normalizeTableName(`${w}v${b.replace('P', p)}`));
    // Captures.
    if (w.includes(p) && w.length > 1) out.push(normalizeTableName(`${w.replace(p, '')}v${b}`));
    if (b.includes(p) && b.length > 1) out.push(normalizeTableName(`${w}v${b.replace(p, '')}`));
  }
  return out;
}

/**
 * Material keys whose tables can be reached by captures and promotions (transitively), the
 * material itself first; `KvK` excluded. This is what probing a position of `materialKey`
 * and its legal children may touch (python-chess `all_dependencies`). `KBvK` and `KNvK` are
 * included here; `SyzygyTables` resolves them without a table (always drawn).
 */
export function tableClosure(materialKey: string): string[] {
  const closed = new Set<string>(['KvK']);
  const out: string[] = [];
  const open = [normalizeTableName(materialKey)];
  while (open.length > 0) {
    const name = open.shift()!;
    if (closed.has(name)) continue;
    closed.add(name);
    out.push(name);
    open.push(...directDependencies(name));
  }
  return out;
}

/** Materials that are drawn by insufficient material and need no table (`KBvK`, `KNvK`). */
export const DRAWN_WITHOUT_TABLE: ReadonlySet<string> = new Set(['KBvK', 'KNvK']);

/** `tableClosure` without the materials resolved without a table: the files probing needs. */
export function requiredTables(materialKey: string): string[] {
  return tableClosure(materialKey).filter((n) => !DRAWN_WITHOUT_TABLE.has(n));
}
