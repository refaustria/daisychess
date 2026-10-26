/**
 * Puzzle themes: lichess theme keys (CC0 data) with our own labels and descriptions (the lila
 * translation files are AGPL and are not used). Grouped for the theme select.
 */

export type ThemeGroup = 'mates' | 'tactics' | 'phase' | 'length' | 'special';

export interface ThemeInfo {
  key: string;
  group: ThemeGroup;
  label: string;
  description: string;
}

/** Groups in display order. */
export const THEME_GROUPS: readonly { key: ThemeGroup; label: string }[] = [
  { key: 'mates', label: 'Mates' },
  { key: 'tactics', label: 'Tactics' },
  { key: 'phase', label: 'Phase' },
  { key: 'length', label: 'Length' },
  { key: 'special', label: 'Special' },
];

const t = (key: string, group: ThemeGroup, label: string, description: string): ThemeInfo => ({
  key,
  group,
  label,
  description,
});

/** Every theme of the lichess puzzle database, in display order within each group. */
export const THEMES: readonly ThemeInfo[] = [
  // Mates
  t('mate', 'mates', 'Checkmate', 'Finish the game with checkmate.'),
  t('mateIn1', 'mates', 'Mate in 1', 'One move to checkmate.'),
  t('mateIn2', 'mates', 'Mate in 2', 'Checkmate in two of your moves.'),
  t('mateIn3', 'mates', 'Mate in 3', 'Checkmate in three of your moves.'),
  t('mateIn4', 'mates', 'Mate in 4', 'Checkmate in four of your moves.'),
  t('mateIn5', 'mates', 'Mate in 5 or more', 'A long forced sequence that ends in checkmate.'),
  t(
    'backRankMate',
    'mates',
    'Back-rank mate',
    'The king is trapped on its first rank by its own pawns.',
  ),
  t(
    'smotheredMate',
    'mates',
    'Smothered mate',
    'A knight mates a king hemmed in by its own pieces.',
  ),
  t(
    'anastasiaMate',
    'mates',
    'Anastasia’s mate',
    'Knight and rook (or queen) trap the king on the edge.',
  ),
  t('arabianMate', 'mates', 'Arabian mate', 'Rook and knight mate the king in the corner.'),
  t(
    'balestraMate',
    'mates',
    'Balestra mate',
    'A bishop gives mate while the queen covers the escape squares.',
  ),
  t('blindSwineMate', 'mates', 'Blind swine mate', 'Two rooks on the seventh rank mate the king.'),
  t('bodenMate', 'mates', 'Boden’s mate', 'Two bishops on crossing diagonals mate the king.'),
  t(
    'cornerMate',
    'mates',
    'Corner mate',
    'The king is mated in the corner, usually by rook and knight.',
  ),
  t(
    'doubleBishopMate',
    'mates',
    'Double bishop mate',
    'Two bishops on neighbouring diagonals mate the king.',
  ),
  t(
    'dovetailMate',
    'mates',
    'Dovetail mate',
    'The queen mates diagonally next to the king, its retreat blocked by its own pieces.',
  ),
  t(
    'epauletteMate',
    'mates',
    'Epaulette mate',
    'The king’s own pieces on both sides block its escape.',
  ),
  t('hookMate', 'mates', 'Hook mate', 'Rook, knight and pawn combine to mate the king.'),
  t('killBoxMate', 'mates', 'Kill box mate', 'Rook and queen box the king in and mate it.'),
  t(
    'morphysMate',
    'mates',
    'Morphy’s mate',
    'A bishop mates a cornered king while a rook cuts it off.',
  ),
  t('operaMate', 'mates', 'Opera mate', 'Rook mates on the back rank, protected by a bishop.'),
  t('pillsburysMate', 'mates', 'Pillsbury’s mate', 'Rook and bishop mate a king on the edge.'),
  t(
    'swallowstailMate',
    'mates',
    'Swallow’s tail mate',
    'The queen mates in front of the king; its own pieces block both flanks.',
  ),
  t(
    'triangleMate',
    'mates',
    'Triangle mate',
    'Queen and rook form a triangle around the king and mate it.',
  ),
  t(
    'vukovicMate',
    'mates',
    'Vuković mate',
    'Rook and knight mate the king on the edge, often with a third piece helping.',
  ),
  // Tactics
  t('fork', 'tactics', 'Fork', 'One piece attacks two or more targets at once.'),
  t(
    'pin',
    'tactics',
    'Pin',
    'A piece cannot move without exposing a more valuable piece behind it.',
  ),
  t(
    'skewer',
    'tactics',
    'Skewer',
    'A valuable piece is attacked and must move, exposing the piece behind it.',
  ),
  t(
    'discoveredAttack',
    'tactics',
    'Discovered attack',
    'Moving one piece opens a line of attack for another.',
  ),
  t(
    'discoveredCheck',
    'tactics',
    'Discovered check',
    'Moving one piece uncovers a check by another.',
  ),
  t(
    'doubleCheck',
    'tactics',
    'Double check',
    'Check from two pieces at once: the king has to move.',
  ),
  t('hangingPiece', 'tactics', 'Hanging piece', 'A piece is left undefended and can be taken.'),
  t('trappedPiece', 'tactics', 'Trapped piece', 'A piece has no safe square and will be lost.'),
  t('sacrifice', 'tactics', 'Sacrifice', 'Give up material for a bigger gain a few moves later.'),
  t(
    'deflection',
    'tactics',
    'Deflection',
    'Lure a defender away from the square or piece it guards.',
  ),
  t(
    'attraction',
    'tactics',
    'Attraction',
    'Force a piece, often the king, onto a square where a tactic works.',
  ),
  t(
    'capturingDefender',
    'tactics',
    'Remove the defender',
    'Take the piece that guards another, then win what it guarded.',
  ),
  t(
    'clearance',
    'tactics',
    'Clearance',
    'Move a piece out of the way to open a square, file or diagonal.',
  ),
  t(
    'interference',
    'tactics',
    'Interference',
    'Put a piece between two enemy pieces to cut their connection.',
  ),
  t(
    'intermezzo',
    'tactics',
    'In-between move',
    'Insert a forcing move before the expected recapture.',
  ),
  t('xRayAttack', 'tactics', 'X-ray attack', 'A piece attacks or defends through another piece.'),
  t(
    'quietMove',
    'tactics',
    'Quiet move',
    'A move without check or capture that prepares an unstoppable threat.',
  ),
  t(
    'defensiveMove',
    'tactics',
    'Defensive move',
    'The only move that keeps the position together.',
  ),
  t(
    'zugzwang',
    'tactics',
    'Zugzwang',
    'The opponent has to move and every move makes things worse.',
  ),
  t('exposedKing', 'tactics', 'Exposed king', 'Attack a king with few defenders around it.'),
  t('kingsideAttack', 'tactics', 'Kingside attack', 'Attack the king after it castled short.'),
  t('queensideAttack', 'tactics', 'Queenside attack', 'Attack the king after it castled long.'),
  t(
    'attackingF2F7',
    'tactics',
    'Attack on f2/f7',
    'Strike at the weak pawn next to the uncastled king.',
  ),
  t('advancedPawn', 'tactics', 'Advanced pawn', 'A pawn deep in enemy territory decides the game.'),
  t(
    'collinearMove',
    'tactics',
    'Collinear move',
    'The key move travels along the same line as another piece.',
  ),
  // Phase
  t('opening', 'phase', 'Opening', 'A tactic in the first moves of the game.'),
  t('middlegame', 'phase', 'Middlegame', 'A tactic in the middle of the game.'),
  t('endgame', 'phase', 'Endgame', 'A tactic with few pieces left.'),
  t('pawnEndgame', 'phase', 'Pawn endgame', 'Only kings and pawns are left.'),
  t('knightEndgame', 'phase', 'Knight endgame', 'Knights and pawns only.'),
  t('bishopEndgame', 'phase', 'Bishop endgame', 'Bishops and pawns only.'),
  t('rookEndgame', 'phase', 'Rook endgame', 'Rooks and pawns only.'),
  t('queenEndgame', 'phase', 'Queen endgame', 'Queens and pawns only.'),
  t('queenRookEndgame', 'phase', 'Queen and rook endgame', 'Queens, rooks and pawns only.'),
  // Length
  t('oneMove', 'length', 'One move', 'Solved with a single move.'),
  t('short', 'length', 'Short', 'Two of your moves.'),
  t('long', 'length', 'Long', 'Three of your moves.'),
  t('veryLong', 'length', 'Very long', 'Four or more of your moves.'),
  // Special
  t('advantage', 'special', 'Win an advantage', 'Reach a clearly better position.'),
  t('crushing', 'special', 'Crushing', 'Win decisive material or reach a winning position.'),
  t('equality', 'special', 'Equalise', 'Save a worse position and reach equality.'),
  t('promotion', 'special', 'Promotion', 'Promote a pawn or threaten to.'),
  t('underPromotion', 'special', 'Underpromotion', 'Promote to a knight, bishop or rook.'),
  t('castling', 'special', 'Castling', 'The key move is castling.'),
  t('enPassant', 'special', 'En passant', 'The key move captures en passant.'),
  t('master', 'special', 'Master games', 'From games of titled players.'),
  t('masterVsMaster', 'special', 'Master vs master', 'From games between two titled players.'),
  t('superGM', 'special', 'Super GM games', 'From games of the world’s best players.'),
];

const byKey = new Map(THEMES.map((th) => [th.key, th]));

/** Theme info of a key, or undefined for a key we do not know (a newer dump). */
export function themeInfo(key: string): ThemeInfo | undefined {
  return byKey.get(key);
}

/** Label of a theme; unknown keys are split at capitals (`newTheme` → `New theme`). */
export function themeLabel(key: string): string {
  const known = byKey.get(key);
  if (known) return known.label;
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Themes grouped for a select, in display order. With `available`, only those keys (e.g. the
 * index's themes) are listed; available keys we do not know go to `special`.
 */
export function themesByGroup(
  available?: Iterable<string>,
): { group: ThemeGroup; label: string; themes: ThemeInfo[] }[] {
  const keys = available ? new Set(available) : undefined;
  const list: ThemeInfo[] = keys ? THEMES.filter((th) => keys.has(th.key)) : [...THEMES];
  if (keys) {
    for (const k of [...keys].sort()) {
      if (k && !byKey.has(k))
        list.push({ key: k, group: 'special', label: themeLabel(k), description: '' });
    }
  }
  return THEME_GROUPS.map((g) => ({
    group: g.key,
    label: g.label,
    themes: list.filter((th) => th.group === g.key),
  })).filter((g) => g.themes.length > 0);
}
