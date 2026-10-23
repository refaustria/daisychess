import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { DrawShape } from 'chessground/draw';
import type { Key } from 'chessground/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { startMoveSounds } from '../../sound/sounds';
import { useSettingsStore } from '../../store/settingsStore';
import { loadPieceSet } from './pieceCss';
import {
  currentFen,
  isCheck,
  isPromotionMove,
  lastMove,
  legalDests,
  turn,
  useGameStore,
  type Orientation,
} from '../../store/gameStore';
import { PromotionDialog, type PromotionPiece } from './PromotionDialog';
import 'chessground/assets/chessground.base.css';
import styles from './Board.module.css';

export interface BoardProps {
  /** Arrows/shapes drawn by the app (chessground `autoShapes`). */
  shapes?: DrawShape[];
  /** When set, this position is shown read-only instead of the game position. */
  previewFen?: string | null;
  /**
   * Restricts who may move: `undefined` = the side to move (analysis board), a colour = only that
   * colour and only on its turn (play mode), `null` = nobody.
   */
  movableColor?: Orientation | null;
}

interface PendingPromotion {
  from: string;
  to: string;
  color: Orientation;
}

const NO_SHAPES: DrawShape[] = [];

export function Board({ shapes = NO_SHAPES, previewFen = null, movableColor }: BoardProps = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const state = useGameStore();
  const makeMove = useGameStore((s) => s.makeMove);
  const coordinates = useSettingsStore((s) => s.coordinates);
  const highlightStyle = useSettingsStore((s) => s.highlightStyle);
  const pieceSet = useSettingsStore((s) => s.pieceSet);
  const [readySet, setReadySet] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<PendingPromotion | null>(null);
  /** Bumped to push the game position to chessground again (after a cancelled promotion). */
  const [resync, setResync] = useState(0);

  useEffect(() => startMoveSounds(), []);

  // Dynamic classes go through classList: chessground owns the root's className (cg-wrap).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const classes = [`piece-set-${pieceSet}`];
    const hl =
      highlightStyle === 'subtle'
        ? styles.hlSubtle
        : highlightStyle === 'none'
          ? styles.hlNone
          : undefined;
    if (hl) classes.push(hl);
    el.classList.add(...classes);
    return () => el.classList.remove(...classes);
  }, [pieceSet, highlightStyle]);

  useEffect(() => {
    let live = true;
    void loadPieceSet(pieceSet).then(() => live && setReadySet(pieceSet));
    return () => {
      live = false;
    };
  }, [pieceSet]);

  useEffect(() => {
    if (!ref.current) return;
    api.current = Chessground(ref.current, {
      movable: { free: false },
      premovable: { enabled: false },
      draggable: { showGhost: true },
      highlight: { lastMove: true, check: true },
      coordinates: useSettingsStore.getState().coordinates,
      animation: { enabled: true, duration: 150 },
    });
    return () => {
      api.current?.destroy();
      api.current = null;
    };
  }, []);

  useEffect(() => {
    api.current?.set({
      events: {
        move: (from, to) => {
          const game = useGameStore.getState();
          // Pawn to the last rank: ask for the piece; chessground already shows the pawn there.
          if (isPromotionMove(game, from, to)) setPromotion({ from, to, color: turn(game) });
          else makeMove(from, to);
        },
      },
    });
  }, [makeMove]);

  const gameFen = currentFen(state);
  const previewing = previewFen !== null;
  const fen = previewFen ?? gameFen;
  const side = previewing
    ? ((previewFen.split(' ')[1] === 'b' ? 'black' : 'white') as 'white' | 'black')
    : turn(state);
  const last = lastMove(state);
  const check = !previewing && isCheck(state);
  const { orientation } = state;
  const canMove = !previewing && (movableColor === undefined || movableColor === side);

  // A pending promotion belongs to the position it was started in.
  useEffect(() => {
    setPromotion(null);
  }, [gameFen, previewing]);

  const promotionRef = useRef<PendingPromotion | null>(null);
  promotionRef.current = promotion;
  const choosePromotion = useCallback(
    (piece: PromotionPiece) => {
      const p = promotionRef.current;
      promotionRef.current = null;
      setPromotion(null);
      if (p) makeMove(p.from, p.to, piece);
    },
    [makeMove],
  );
  const cancelPromotion = useCallback(() => {
    setPromotion(null);
    setResync((n) => n + 1);
  }, []);

  useEffect(() => {
    api.current?.set({
      fen,
      turnColor: side,
      orientation,
      check,
      lastMove: previewing ? undefined : (last as Key[] | undefined),
      movable: canMove
        ? { free: false, color: side, dests: legalDests(state) as Map<Key, Key[]> }
        : { free: false, color: undefined, dests: new Map<Key, Key[]>() },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state is derived from fen/ply
  }, [fen, side, orientation, check, canMove, resync, state.ply, state.startFen, state.moves]);

  useEffect(() => {
    // Coordinates are part of the wrap markup, so a redraw is needed after changing the option.
    api.current?.set({ coordinates });
    api.current?.redrawAll();
  }, [coordinates]);

  useEffect(() => {
    api.current?.set({ drawable: { autoShapes: shapes } });
  }, [shapes]);

  return (
    <div className={styles.root}>
      <div
        className={styles.board}
        data-testid="board"
        role="group"
        aria-label="Chess board"
        aria-describedby="board-note"
        data-preview={previewing || undefined}
        data-pieces-ready={readySet === pieceSet || undefined}
        ref={ref}
      />
      {promotion && (
        <PromotionDialog
          to={promotion.to}
          color={promotion.color}
          orientation={orientation}
          pieceSet={pieceSet}
          onSelect={choosePromotion}
          onCancel={cancelPromotion}
        />
      )}
    </div>
  );
}
