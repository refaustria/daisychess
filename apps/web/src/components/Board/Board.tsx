import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
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

export function Board() {
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

  const fen = currentFen(state);
  const side = turn(state);
  const last = lastMove(state);
  const check = isCheck(state);
  const { orientation } = state;
  useEffect(() => {
    api.current?.set({
      fen,
      turnColor: side,
      orientation,
      check,
      lastMove: last as Key[] | undefined,
      movable: { free: false, color: side, dests: legalDests(state) as Map<Key, Key[]> },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state is derived from fen/ply
  }, [fen, side, orientation, check, state.ply, state.startFen, state.moves]);

  return <div className={styles.board} data-testid="board" ref={ref} />;
}
