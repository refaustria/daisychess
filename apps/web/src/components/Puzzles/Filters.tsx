import { openingFamily, themesByGroup, themeLabel } from '@daisychess/puzzles';
import { useEffect, useId, useState } from 'react';
import { loadFilterOptions, type FilterOptions } from '../../puzzles/filterOptions';
import { usePuzzleStore } from '../../puzzles/puzzleStore';
import { OfflineKeep } from './OfflineKeep';
import styles from './PuzzlesPanel.module.css';

const label = (tag: string, count: number): string =>
  `${tag.replace(/_/g, ' ')} (${count.toLocaleString('en')})`;

/** Puzzles tab: theme, opening family and variation selects plus "Keep puzzles for offline use". */
export function Filters() {
  const filter = usePuzzleStore((s) => s.filter);
  const [options, setOptions] = useState<FilterOptions | null>(null);
  const themeId = useId();
  const familyId = useId();
  const variationId = useId();

  useEffect(() => {
    let alive = true;
    void loadFilterOptions().then((o) => alive && setOptions(o));
    return () => {
      alive = false;
    };
  }, []);

  const set = (next: { theme?: string; opening?: string }) => {
    const f: { theme?: string; opening?: string } = {};
    if (next.theme) f.theme = next.theme;
    if (next.opening) f.opening = next.opening;
    usePuzzleStore.getState().setFilter(f);
  };

  const families = options?.families ?? [];
  const tag = filter.opening ?? '';
  const familyTag = tag
    ? (openingFamily(
        tag,
        families.map((f) => f.tag),
      ) ?? tag)
    : '';
  const family = families.find((f) => f.tag === familyTag);
  const counts = new Map(options?.themes.map((t) => [t.tag, t.count]));
  const groups = themesByGroup(options ? options.themes.map((t) => t.tag) : undefined);

  return (
    <details className={styles.filters} open={Boolean(filter.theme || filter.opening)}>
      <summary>
        Filters
        {(filter.theme || filter.opening) && (
          <span className={styles.active} data-testid="puzzle-filter-active">
            {' '}
            ·{' '}
            {[filter.theme && themeLabel(filter.theme), filter.opening?.replace(/_/g, ' ')]
              .filter(Boolean)
              .join(', ')}
          </span>
        )}
      </summary>
      <div className={styles.filterGrid}>
        <label htmlFor={themeId} className={styles.label}>
          Theme
        </label>
        <select
          id={themeId}
          className={styles.select}
          value={filter.theme ?? ''}
          onChange={(e) => set({ ...filter, theme: e.target.value })}
        >
          <option value="">Any theme</option>
          {filter.theme && !counts.has(filter.theme) && (
            <option value={filter.theme}>{themeLabel(filter.theme)}</option>
          )}
          {groups.map((g) => (
            <optgroup key={g.group} label={g.label}>
              {g.themes.map((t) => (
                <option key={t.key} value={t.key}>
                  {counts.has(t.key)
                    ? `${t.label} (${counts.get(t.key)!.toLocaleString('en')})`
                    : t.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        <label htmlFor={familyId} className={styles.label}>
          Opening
        </label>
        <select
          id={familyId}
          className={styles.select}
          value={familyTag}
          onChange={(e) => set({ ...filter, opening: e.target.value })}
        >
          <option value="">Any opening</option>
          {familyTag && !family && (
            <option value={familyTag}>{familyTag.replace(/_/g, ' ')}</option>
          )}
          {families.map((f) => (
            <option key={f.tag} value={f.tag}>
              {label(f.tag, f.count)}
            </option>
          ))}
        </select>

        <label htmlFor={variationId} className={styles.label}>
          Variation
        </label>
        <select
          id={variationId}
          className={styles.select}
          value={tag === familyTag ? '' : tag}
          disabled={!family || family.variations.length === 0}
          onChange={(e) => set({ ...filter, opening: e.target.value || familyTag })}
        >
          <option value="">All variations</option>
          {family?.variations.map((v) => (
            <option key={v.tag} value={v.tag}>
              {label(v.tag.slice(family.tag.length + 1), v.count)}
            </option>
          ))}
        </select>
      </div>
      {(filter.theme || filter.opening) && (
        <button type="button" onClick={() => usePuzzleStore.getState().setFilter({})}>
          Clear filters
        </button>
      )}
      <p className={styles.note}>
        Filters apply to the next puzzle.
        {options && !options.fromIndex && ' Counts are for the puzzles bundled with the app.'}
      </p>
      <OfflineKeep />
    </details>
  );
}
