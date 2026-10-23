export interface PieceSetInfo {
  id: string;
  name: string;
  /** Licence / provenance, shown in docs and the UI credits. */
  license: string;
}

export const DEFAULT_PIECE_SET = 'cburnett';

/**
 * The CSS for each set is loaded lazily by the app. `cburnett` comes from the
 * chessground package; `letters` is an original set generated for ChessLab.
 */
export const pieceSets: readonly PieceSetInfo[] = [
  { id: 'cburnett', name: 'Classic (Cburnett)', license: 'Colin M.L. Burnett, GPLv2+ (via chessground)' },
  { id: 'letters', name: 'Letters', license: 'ChessLab original, MIT' },
];

export function isPieceSet(id: string): boolean {
  return pieceSets.some((p) => p.id === id);
}
