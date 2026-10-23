import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { DrawShape } from 'chessground/draw';
import type { Key } from 'chessground/types';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { premoveShapes } from '../../live/premoves';
import { useHumanBoard } from '../../live/useHumanBoard';
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
   * colour and only on its turn (play mode), `null` = nobody. A running game against an opponent
   * (live lichess game, local engine game) overrides it: the user's colour at the tip, premoves on
   * the opponent's turn (see `useHumanBoard`).
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
  const human = useHumanBoard();
  const humanRef = useRef(human);
  humanRef.current = human;

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
      premovable: {
        enabled: false,
        events: {
          set: (from, to) => {
            const h = humanRef.current;
            if (!h) return;
            h.onPremove(from, to);
            // Queue mode: the queue is drawn as arrows, chessground keeps no premove of its own.
            if (h.premoveMode === 'queue') api.current?.cancelPremove();
          },
          // A click elsewhere or a right-click cancels chessground's single premove.
          unset: () => {
            const h = humanRef.current;
            if (h?.premoveMode === 'single') h.onPremoveCancel();
          },
        },
      },
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
  const movable = human ? human.movableColor : movableColor;
  const canMove = !previewing && (movable === undefined || movable === side);
  // On the opponent's turn the user's pieces can be premoved (unless premoves are off).
  const premoveColor =
    !previewing && human && human.premoveMode !== 'none' && !canMove ? human.movableColor : null;

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
        : { free: false, color: premoveColor ?? undefined, dests: new Map<Key, Key[]>() },
      premovable: { enabled: premoveColor !== null },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state is derived from fen/ply
  }, [fen, side, orientation, check, canMove, premoveColor, resync, state.ply, state.startFen, state.moves]);

  // The premove was played or dropped by the game: clear chessground's premove highlight.
  const hasPremove = (human?.premoves.length ?? 0) > 0;
  const hadPremove = useRef(false);
  useEffect(() => {
    if (hadPremove.current && !hasPremove) api.current?.cancelPremove();
    hadPremove.current = hasPremove;
  }, [hasPremove]);

  // Escape or a right-click on the board clears all premoves.
  useEffect(() => {
    if (!hasPremove) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') humanRef.current?.onPremoveCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasPremove]);
  const onMouseDown = useCallback((e: MouseEvent) => {
    if (e.button === 2) humanRef.current?.onPremoveCancel();
  }, []);

  useEffect(() => {
    // Coordinates are part of the wrap markup, so a redraw is needed after changing the option.
    api.current?.set({ coordinates });
    api.current?.redrawAll();
  }, [coordinates]);

  // Queued premoves are drawn (numbered) on top of the app's arrows.
  const queued = human?.premoveMode === 'queue' ? human.premoves : undefined;
  const allShapes = useMemo(
    () => (queued && queued.length ? [...shapes, ...(premoveShapes(queued) as DrawShape[])] : shapes),
    [shapes, queued],
  );
  useEffect(() => {
    api.current?.set({ drawable: { autoShapes: allShapes } });
  }, [allShapes]);

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
        data-premoves={human?.premoves.length ? human.premoves.join(' ') : undefined}
        onMouseDownCapture={onMouseDown}
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
