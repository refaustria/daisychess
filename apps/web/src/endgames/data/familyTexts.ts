/**
 * Short descriptions of the endgame families for the endgame stop of the guided review
 * (M32-4, ADR-025 section 5).
 *
 * Written by us for DaisyChess (GPL-3.0-or-later, nothing copied; see SOURCE.md). Each text says
 * what matters in the endgame and the typical plan for the stronger and the weaker side. The keys
 * are the `EndgameFamily` values of `@daisychess/endgames`, one entry per family.
 */

export interface EndgameFamilyText {
  /** An `EndgameFamily` of `@daisychess/endgames`. */
  key: string;
  /** Sentence-case name; the card shows it as "Endgame: rook endgame". */
  title: string;
  /** Two or three sentences, 120 to 420 characters. */
  text: string;
}

export const ENDGAME_FAMILY_TEXTS: readonly EndgameFamilyText[] = [
  {
    key: 'basic_mate',
    title: 'Basic checkmate',
    text: 'One side has only a king and the other has enough force to mate. The technique is to drive the lone king to the edge, bring your own king up to help and avoid stalemate on the last moves. Two bishops or bishop and knight need a precise plan, and the defender should head for the corner of the right colour.',
  },
  {
    key: 'kp_v_k',
    title: 'King and pawn against king',
    text: 'The whole game is whether the pawn can promote. The attacker wants the king in front of the pawn and the opposition; the defender wants to block the pawn or to sit on a square in front of it. A rook pawn is the great exception, because a defending king in the corner draws.',
  },
  {
    key: 'pawn',
    title: 'Pawn endgame',
    text: 'Only kings and pawns remain, so the king is a fighting piece and every tempo counts. Put your king on the active squares, win the opposition, create an outside passed pawn to drag the enemy king away and then go after the weak pawns. A single misstep often decides the game, since pawns cannot go back.',
  },
  {
    key: 'rook',
    title: 'Rook endgame',
    text: 'Rook endgames are the most common and very drawish: the side with the weaker pawns can often hold by keeping the rook active. Put your rook behind passed pawns, cut off the enemy king along a file or rank and keep your own king close to the pawns. The defender should avoid passivity and look for checks from behind.',
  },
  {
    key: 'double_rook',
    title: 'Double rook endgame',
    text: 'Two rooks each can work together on an open file or the seventh rank, which makes mating threats against the king possible. The stronger side doubles on the key line and attacks the weak pawns, while the weaker side trades one pair of rooks when it can. Watch for back rank problems and for perpetual check.',
  },
  {
    key: 'rook_v_pawns',
    title: 'Rook against pawns',
    text: 'A rook is facing several pawns, so the question is whether the pawns can be pushed together and supported by the king. The rook side must stop the most advanced pawn in time and pick the others off, ideally with the king nearby. The pawn side wants connected passed pawns on the sixth or seventh rank.',
  },
  {
    key: 'rook_v_minor',
    title: 'Rook against a minor piece',
    text: 'A rook is worth about two pawns more than a bishop or knight, so with pawns on the board the rook side is usually better. With few pawns the minor piece can hold a draw, particularly with its king close to the corner. The rook side should create a passed pawn; the other side should aim to give up the piece for the last pawns.',
  },
  {
    key: 'rook_minor',
    title: 'Rook and minor piece each',
    text: 'Both sides have a rook and a bishop or knight, so the pieces can attack together and king safety matters more than in a pure rook endgame. Look for a passed pawn, a weak king or an open file for the rook. The bishop is usually stronger when pawns are on both wings, the knight when the position is closed.',
  },
  {
    key: 'rook_minor_v_rook',
    title: 'Rook and minor piece against a rook',
    text: 'The extra bishop or knight is often not enough to win without pawns, because the defender can reach a known fortress or sacrifice the rook for the minor piece at the right moment. With pawns the extra piece helps to create a second front and to shield the king from checks. The defender should keep the rook active and try to trade the remaining pawns.',
  },
  {
    key: 'queen',
    title: 'Queen endgame',
    text: 'The queen moves fast and checks often, so perpetual check is the defender’s main resource. The stronger side should place the queen centrally, bring the king to a square protected from checks and push the passed pawn with the queen supporting it. Look for forks that win a pawn or force a queen trade.',
  },
  {
    key: 'queen_v_rook',
    title: 'Queen against rook',
    text: 'Without pawns the queen wins by force, but the technique is long and the rook side can set stalemate traps. With pawns on the board the rook can build a fortress, and the queen side then tries for a pawn break or a fork. The weaker side keeps the king and rook close together to avoid skewers.',
  },
  {
    key: 'queen_v_pawns',
    title: 'Queen against pawns',
    text: 'The queen is trying to stop one or more far advanced pawns. A pawn on the seventh rank can draw against the queen if it is a rook or bishop pawn and the attacking king is far away. The queen side must bring the king up and use checks to gain the tempi it needs.',
  },
  {
    key: 'queen_v_minor',
    title: 'Queen against a minor piece',
    text: 'The queen is much stronger than a bishop or knight. The queen side wins by using the extra material to attack pawns and to create threats against the king, while avoiding forks. The only hope for the weaker side is a fortress or a stalemate trick, so it should keep its pieces together.',
  },
  {
    key: 'queen_rook',
    title: 'Queen and rook endgame',
    text: 'Heavy pieces on both sides give plenty of ways to attack the king, so checks and mating threats count more than pawns. The side with the safer king usually has the advantage. Use the rook to cover the back rank, avoid leaving it loose and look for ways to trade the queens when ahead.',
  },
  {
    key: 'queen_v_pieces',
    title: 'Queen against several pieces',
    text: 'One queen faces a rook and a minor piece, or two minors, which is roughly equal in material. The pieces work best together and fear forks by the queen, while the queen wants open lines and a king that has little cover. The side with the pieces should keep them protected and head for a position where the queen has no targets.',
  },
  {
    key: 'same_bishops',
    title: 'Bishops of the same colour',
    text: 'Each side has a bishop on the same colour squares, so the endgame is much like a pawn endgame in which the bishops fight over the weak squares. The side with more pawns can create a passed pawn and use the king to support it. Put your pawns on the opposite colour from your bishop so that it stays active.',
  },
  {
    key: 'opposite_bishops',
    title: 'Opposite-coloured bishops',
    text: 'With opposite-coloured bishops the defender often draws even a pawn or two down, because the bishops cannot challenge each other and the attacker cannot attack the squares the defender controls. The stronger side needs two connected passed pawns far apart or other pieces on the board to win. The defender should place pawns on the colour of its bishop and build a fortress.',
  },
  {
    key: 'knight',
    title: 'Knight endgame',
    text: 'Knights are slow and short-range, so pawns on both wings and the position of the king matter a lot. Keep the king active, place the knight on a strong central square and make a passed pawn, because a knight is poor at stopping a rook pawn from afar. A knight ending often plays like a pawn endgame with extra tactics.',
  },
  {
    key: 'bishop_v_knight',
    title: 'Bishop against knight',
    text: 'The bishop is stronger when there are pawns on both wings and the position is open, because it controls long diagonals and can attack from afar. The knight likes closed positions with pawns on one colour, where it can find an outpost. The bishop side should aim to open the position, the knight side to keep it closed.',
  },
  {
    key: 'minor_v_pawns',
    title: 'Minor piece against pawns',
    text: 'A bishop or knight is facing pawns, and a piece is normally worth about three pawns. Two or three connected passed pawns can beat a lone piece, one or two usually cannot. The piece side blockades the pawns with the king and the piece; the pawn side pushes them together and uses the king to shield them.',
  },
  {
    key: 'two_minors',
    title: 'Minor pieces endgame',
    text: 'Two minor pieces are on the board against one or two, so the plan depends on the pair: two bishops work well together on open boards, bishop and knight need care to cooperate, two knights are hard to use for a win. Create a passed pawn, keep the pieces protected and the king active. Be wary of forks, which win material quickly.',
  },
  {
    key: 'other',
    title: 'Endgame',
    text: 'Most of the pieces have been traded and the king is now an active piece, so bring it towards the centre. Count the pawns, find the passed and the weak ones and make a plan before you move. Piece activity is usually worth more than a small material difference, and tempo and zugzwang start to matter.',
  },
];

/** The entry of an endgame family (the `other` entry for an unknown key). */
export function endgameTextFor(family: string): EndgameFamilyText | undefined {
  return (
    ENDGAME_FAMILY_TEXTS.find((t) => t.key === family) ??
    ENDGAME_FAMILY_TEXTS.find((t) => t.key === 'other')
  );
}
