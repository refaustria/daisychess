/** Lazy loaders for piece-set CSS. Each set is fetched once, on first use. */
const loaders: Record<string, () => Promise<unknown>> = {
  cburnett: () => import('chessground/assets/chessground.cburnett.css'),
  letters: () => import('@daisychess/ui-theme/pieces/letters.css'),
};

const loaded = new Map<string, Promise<void>>();

export function loadPieceSet(id: string): Promise<void> {
  const load = loaders[id];
  if (!load) return Promise.resolve();
  let p = loaded.get(id);
  if (!p) {
    p = load().then(
      () => undefined,
      () => {
        loaded.delete(id); // allow a retry
      },
    );
    loaded.set(id, p);
  }
  return p;
}
