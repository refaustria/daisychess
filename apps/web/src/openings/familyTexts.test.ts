import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeText } from './book';
import rows from './data/openings.json';
import { FAMILY_TEXTS } from './data/familyTexts';
import { familyOf, familyTextFor, getFamilyTexts, loadFamilyTexts } from './familyTexts';

const families = new Set((rows as string[][]).map((r) => normalizeText(familyOf(r[1]!))));
const key = (name?: string, eco?: string) => familyTextFor({ name, eco }, FAMILY_TEXTS)?.key;

describe('FAMILY_TEXTS data', () => {
  it('has at least 55 entries with unique keys', () => {
    expect(FAMILY_TEXTS.length).toBeGreaterThanOrEqual(55);
    expect(new Set(FAMILY_TEXTS.map((e) => e.key)).size).toBe(FAMILY_TEXTS.length);
  });

  it.each(FAMILY_TEXTS.map((e) => [e.key, e] as const))('%s is well formed', (_k, e) => {
    expect(e.text.length).toBeGreaterThanOrEqual(120);
    expect(e.text.length).toBeLessThanOrEqual(420);
    expect(e.text.endsWith('.')).toBe(true);
    expect(e.text).toBe(e.text.trim());
    expect(e.title.length).toBeGreaterThan(0);
    expect(e.text.split(/(?<=[.!?])\s+(?=[A-Z])/).length).toBeLessThanOrEqual(4);
    expect(e.names.length > 0 || (e.variations?.length ?? 0) > 0).toBe(true);
    for (const n of e.names) expect(families.has(normalizeText(n)), `${n} is a family`).toBe(true);
    for (const [from, to] of e.eco ?? []) {
      expect(from).toMatch(/^[A-E]\d\d$/);
      expect(to).toMatch(/^[A-E]\d\d$/);
      expect(from <= to).toBe(true);
    }
  });

  it('keeps the ECO ranges of one entry ordered', () => {
    for (const e of FAMILY_TEXTS) {
      const r = e.eco ?? [];
      for (let i = 1; i < r.length; i++) expect(r[i - 1]![1] < r[i]![0]).toBe(true);
    }
  });

  it('variations are names of the table', () => {
    const names = new Set((rows as string[][]).map((r) => r[1] ?? ''));
    for (const e of FAMILY_TEXTS) {
      for (const v of e.variations ?? []) {
        expect(
          [...names].some((n) => n === v || n.startsWith(`${v} `) || n.startsWith(`${v}:`)),
        ).toBe(true);
      }
    }
  });
});

describe('familyTextFor', () => {
  it('matches by family name, ignoring the variation', () => {
    expect(key('Sicilian Defense: Najdorf Variation', 'B90')).toBe('sicilian');
    expect(key('Grünfeld Defense: Exchange Variation')).toBe('grunfeld');
    expect(key("King's Gambit Accepted: Kieseritzky Gambit")).toBe('kings-gambit');
    expect(key('Italian Game: Giuoco Piano')).toBe('italian-game');
  });

  it("prefers the London entry over the generic Queen's Pawn Game", () => {
    expect(key("Queen's Pawn Game: London System")).toBe('london');
    expect(key("Queen's Pawn Game: Chigorin Variation")).toBe('queens-pawn-game');
    expect(key('London System')).toBe('london');
  });

  it('matches the Evans Gambit by variation prefix before the Italian Game', () => {
    expect(key('Italian Game: Evans Gambit, Main Line')).toBe('evans-gambit');
    expect(key('Italian Game: Evans Gambit')).toBe('evans-gambit');
    expect(key('Italian Game: Two Knights Defense')).toBe('italian-game');
  });

  it('falls back to the ECO range for an unknown name', () => {
    expect(key('Something Unheard Of', 'B23')).toBe('sicilian');
    expect(key(undefined, 'C65')).toBe('ruy-lopez');
  });

  it('returns undefined for unknown openings', () => {
    expect(key('Amar Opening', 'A00')).toBeUndefined();
    expect(key(undefined, undefined)).toBeUndefined();
    expect(key('Nothing', 'zz')).toBeUndefined();
  });

  it('covers the common families of the table', () => {
    const rowsList = rows as string[][];
    const famCount = new Map<string, number>();
    for (const r of rowsList)
      famCount.set(familyOf(r[1]!), (famCount.get(familyOf(r[1]!)) ?? 0) + 1);
    let covered = 0;
    let total = 0;
    for (const [fam, n] of famCount) {
      if (n < 20) continue;
      total++;
      if (key(fam)) covered++;
    }
    expect(covered / total).toBeGreaterThan(0.9);
  });

  it('returns undefined before the texts are loaded and finds them afterwards', async () => {
    expect(getFamilyTexts()).toBeNull();
    expect(familyTextFor({ name: 'Sicilian Defense' })).toBeUndefined();
    await loadFamilyTexts();
    expect(familyTextFor({ name: 'Sicilian Defense' })?.key).toBe('sicilian');
    expect(getFamilyTexts()).toBe(FAMILY_TEXTS);
  });
});

describe('bundle', () => {
  it('only imports the data module lazily (own chunk)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
      });
    const src = join(__dirname, '..');
    for (const file of walk(src)) {
      if (/\.test\.tsx?$/.test(file) || file.endsWith(join('data', 'familyTexts.ts'))) continue;
      const code = readFileSync(file, 'utf8');
      for (const line of code.split('\n')) {
        if (!line.includes('data/familyTexts')) continue;
        expect(line, `${file}: ${line}`).toMatch(/import\s+type|export\s+type|import\(/);
      }
    }
  });
});
