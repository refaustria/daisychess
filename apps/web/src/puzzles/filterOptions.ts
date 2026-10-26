/**
 * Options of the puzzle filters (ADR-023 §8): themes and opening families/variations with the
 * number of puzzles, from the stored index when there is one (the whole dataset), else from the
 * bundled starter. Also the size hint of "Keep puzzles for offline use".
 */
import { openingFamily, openingTagsForName } from '@daisychess/puzzles';

export interface CountedTag {
  tag: string;
  count: number;
}

export interface FamilyOption extends CountedTag {
  variations: CountedTag[];
}

export interface FilterOptions {
  themes: CountedTag[];
  families: FamilyOption[];
  /** The counts come from the index (all shards), not just the bundled starter. */
  fromIndex: boolean;
}

/** Groups a flat list of opening tags into families with their variations. */
export function groupOpenings(
  tags: readonly CountedTag[],
  families: readonly string[],
): FamilyOption[] {
  const out = new Map<string, FamilyOption>(
    families.map((f) => [f, { tag: f, count: 0, variations: [] }]),
  );
  for (const t of tags) {
    const fam = openingFamily(t.tag, families);
    if (!fam) continue;
    const entry = out.get(fam)!;
    if (t.tag === fam) entry.count = t.count;
    else entry.variations.push(t);
  }
  const list = [...out.values()].filter((f) => f.count > 0 || f.variations.length > 0);
  for (const f of list) {
    if (f.count === 0) f.count = f.variations.reduce((n, v) => n + v.count, 0);
    f.variations.sort((a, b) => a.tag.localeCompare(b.tag));
  }
  return list.sort((a, b) => a.tag.localeCompare(b.tag));
}

/** Loads the options (never throws; empty lists when nothing is reachable). */
export async function loadFilterOptions(): Promise<FilterOptions> {
  try {
    const { loadIndex } = await import('./source');
    const index = await loadIndex();
    if (index) {
      const themes = index.themes
        .map((tag, i) => ({ tag, count: index.counts.themes[i] ?? 0 }))
        .filter((t) => t.count > 0);
      const tags = index.openings
        .map((tag, i) => ({ tag, count: index.counts.openings[i] ?? 0 }))
        .filter((t) => t.count > 0);
      const families = index.families.map((i) => index.openings[i]!);
      return { themes, families: groupOpenings(tags, families), fromIndex: true };
    }
  } catch {
    // Fall through to the starter.
  }
  try {
    const { starterCounts } = await import('./starter');
    const c = await starterCounts();
    const themes = Object.entries(c.themes).map(([tag, count]) => ({ tag, count }));
    const tags = Object.entries(c.openings).map(([tag, count]) => ({ tag, count }));
    // The starter has no family list: a tag is a family when no shorter tag is its prefix.
    const sorted = tags.map((t) => t.tag).sort((a, b) => a.length - b.length);
    const families: string[] = [];
    for (const t of sorted) if (!openingFamily(t, families)) families.push(t);
    return { themes, families: groupOpenings(tags, families), fromIndex: false };
  } catch {
    return { themes: [], families: [], fromIndex: false };
  }
}

/**
 * The tag to filter by for an opening name of the book: its variation when puzzles exist for it,
 * else its family, else undefined (no puzzles for this opening).
 */
export function pickOpeningTag(name: string, options: FilterOptions): string | undefined {
  const { family, variation } = openingTagsForName(name);
  const fam = options.families.find((f) => f.tag === family);
  if (!fam) return undefined;
  if (variation && fam.variations.some((v) => v.tag === variation)) return variation;
  return fam.count > 0 ? family : undefined;
}

export interface OfflineInfo {
  shards: number;
  bytes: number;
}

/** What "Keep puzzles for offline use" would fetch for `rating` (null without an index). */
export async function offlineInfo(rating: number): Promise<OfflineInfo | null> {
  try {
    const { loadIndex, offlinePlan } = await import('./source');
    const index = await loadIndex();
    if (!index) return null;
    const plan = offlinePlan(index, rating);
    return { shards: plan.length, bytes: plan.reduce((n, s) => n + s.bytes, 0) };
  } catch {
    return null;
  }
}

/** "12.4 MB" / "340 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}
