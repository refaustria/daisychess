import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { DrawShape } from 'chessground/draw';
import type { Key } from 'chessground/types';
import { useEffect, useRef } from 'react';
import {
  currentFen,
  isCheck,
  lastMove,
  legalDests,
  turn,
  useGameStore,
} from '../../store/gameStore';
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.cburnett.css';
import styles from './Board.module.css';

export interface BoardProps {
  /** Arrows/shapes drawn by the app (chessground `autoShapes`). */
  shapes?: DrawShape[];
  /** When set, this position is shown read-only instead of the game position. */
  previewFen?: string | null;
}

const NO_SHAPES: DrawShape[] = [];

export function Board({ shapes = NO_SHAPES, previewFen = null }: BoardProps = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const state = useGameStore();
  const makeMove = useGameStore((s) => s.makeMove);

  useEffect(() => {
    if (!ref.current) return;
    api.current = Chessground(ref.current, {
      movable: { free: false },
      draggable: { showGhost: true },
      highlight: { lastMove: true, check: true },
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
          makeMove(from, to);
        },
      },
    });
  }, [makeMove]);

  const gameFen = currentFen(state);
  const previewing = previewFen !== null;
  const fen = previewFen ?? gameFen;
  const side = previewing ? ((previewFen.split(' ')[1] === 'b' ? 'black' : 'white') as 'white' | 'black') : turn(state);
  const last = lastMove(state);
  const check = !previewing && isCheck(state);
  const { orientation } = state;
  useEffect(() => {
    api.current?.set({
      fen,
      turnColor: side,
      orientation,
      check,
      lastMove: previewing ? undefined : (last as Key[] | undefined),
      movable: previewing
        ? { free: false, color: undefined, dests: new Map<Key, Key[]>() }
        : { free: false, color: side, dests: legalDests(state) as Map<Key, Key[]> },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state is derived from fen/ply
  }, [fen, side, orientation, check, previewing, state.ply, state.startFen, state.moves]);

  useEffect(() => {
    api.current?.set({ drawable: { autoShapes: shapes } });
  }, [shapes]);

  return <div className={styles.board} data-testid="board" data-preview={previewing || undefined} ref={ref} />;
}
