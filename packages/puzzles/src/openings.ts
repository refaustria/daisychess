/**
 * Mapping between our openings-table names (`Queen's Pawn Game: Accelerated London System`) and
 * lichess OpeningTags (`Queens_Pawn_Game_Accelerated_London_System`). lichess tags a puzzle with
 * the family (`Sicilian_Defense`) and the first-level variation (`Sicilian_Defense_Najdorf_Variation`);
 * deeper names (after a comma) have no tag of their own.
 */

/**
 * lichess tag of an opening name (ADR-023 §8): `'` removed, `:` and `,` removed, whitespace →
 * `_`, hyphens kept.
 */
export function openingTag(name: string): string {
  return name.replace(/['’]/g, '').replace(/[:,]/g, '').trim().replace(/\s+/g, '_');
}

/**
 * Family of a tag: the longest of `families` that equals `tag` or is a `_`-separated prefix of
 * it (`Sicilian_Defense_Open` → `Sicilian_Defense`), or undefined.
 */
export function openingFamily(tag: string, families: Iterable<string>): string | undefined {
  let best: string | undefined;
  for (const f of families) {
    if ((tag === f || tag.startsWith(`${f}_`)) && (best === undefined || f.length > best.length))
      best = f;
  }
  return best;
}

/**
 * Filter tags of an opening name: the family (part before `:`) and, when the name has a
 * variation, the first-level variation tag (part before the first `,`) — the two levels lichess
 * tags puzzles with.
 */
export function openingTagsForName(name: string): { family: string; variation?: string } {
  const colon = name.indexOf(':');
  if (colon < 0) return { family: openingTag(name) };
  const family = openingTag(name.slice(0, colon));
  const comma = name.indexOf(',', colon);
  const variation = openingTag(comma < 0 ? name : name.slice(0, comma));
  return variation && variation !== family ? { family, variation } : { family };
}
