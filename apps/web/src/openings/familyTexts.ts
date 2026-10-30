import { normalizeText } from './book';
import type { FamilyText } from './data/familyTexts';

export type { FamilyText } from './data/familyTexts';

/**
 * Family texts for the opening stop of the guided review (M31-4, ADR-024 section 3). The data
 * module is a separate chunk, imported on demand together with the openings table.
 */

let texts: readonly FamilyText[] | null = null;
let loading: Promise<readonly FamilyText[]> | null = null;

/** Lazy-loads the family texts. Safe to call repeatedly. */
export function loadFamilyTexts(): Promise<readonly FamilyText[]> {
  loading ??= import('./data/familyTexts').then((m) => {
    texts = m.FAMILY_TEXTS;
    return texts;
  });
  return loading;
}

/** The loaded texts, or null until {@link loadFamilyTexts} resolved. */
export const getFamilyTexts = (): readonly FamilyText[] | null => texts;

/** The family of an opening name: the part before the first `:` (the whole name without one). */
export function familyOf(name: string): string {
  const i = name.indexOf(':');
  return (i < 0 ? name : name.slice(0, i)).trim();
}

function inRange(eco: string, from: string, to: string): boolean {
  const e = eco.toUpperCase();
  return e >= from && e <= to;
}

/**
 * The text for an opening: an entry whose `variations` prefix matches the full name first, then
 * the first entry whose `names` contain the family, then the first whose ECO ranges contain the
 * code. Undefined when nothing matches (or the texts are not loaded and none are passed).
 */
export function familyTextFor(
  opening: { name?: string; eco?: string },
  entries: readonly FamilyText[] | null = texts,
): FamilyText | undefined {
  if (!entries) return undefined;
  if (opening.name) {
    const name = normalizeText(opening.name);
    for (const e of entries) {
      for (const v of e.variations ?? []) {
        const p = normalizeText(v);
        if (name === p || name.startsWith(`${p} `)) return e;
      }
    }
    const family = normalizeText(familyOf(opening.name));
    for (const e of entries) {
      if (e.names.some((n) => normalizeText(n) === family)) return e;
    }
  }
  const eco = opening.eco;
  if (eco && /^[A-E]\d\d$/i.test(eco)) {
    for (const e of entries) {
      if (e.eco?.some(([from, to]) => inRange(eco, from, to))) return e;
    }
  }
  return undefined;
}
