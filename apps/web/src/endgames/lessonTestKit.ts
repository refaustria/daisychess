/**
 * Test helpers of the endgame trainer (not shipped: only imported by tests): a local tablebase
 * over the real bundled Syzygy files (`public/endgames/v1/`), a scripted lichess client and the
 * wiring of both into `tablebaseStore` and `lessonStore`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialKey, SyzygyTables, type Lesson, type TbPosition } from '@daisychess/endgames';
import { vi } from 'vitest';
import type { HumanGameLock } from '../live/lock';
import { useSettingsStore, type TablebaseSetting } from '../store/settingsStore';
import { useGameStore } from '../store/gameStore';
import { abortError, type LichessTablebaseClient } from './lichessTablebase';
import type { LocalTablebase } from './localTablebase';
import { configureLessonStore, resetLessonStore, useLessonStore } from './lessonStore';
import { configureTablebase, resetTablebaseStore } from './tablebaseStore';

/** `public/endgames/v1/` (jsdom gives `import.meta.url` a non-file scheme: fall back to cwd). */
const dir = ((): string => {
  const here = import.meta.url.startsWith('file:')
    ? join(dirname(fileURLToPath(import.meta.url)), '../../public/endgames/v1')
    : '';
  return here && existsSync(here) ? here : join(process.cwd(), 'public/endgames/v1');
})();

/** Every bundled core table, loaded once per test file. */
export function coreTables(): SyzygyTables {
  const t = new SyzygyTables();
  for (const name of readdirSync(dir)) {
    if (/\.rtb[wz]$/.test(name)) t.addTable(name, new Uint8Array(readFileSync(join(dir, name))));
  }
  return t;
}

export interface Kit {
  tables: SyzygyTables;
  lock: { value: HumanGameLock };
  lichess: LichessTablebaseClient & { probe: ReturnType<typeof vi.fn> };
  /** Answers of the scripted lichess client (default: nothing). */
  setLichess(fn: (fen: string) => Promise<TbPosition | null>): void;
  local: LocalTablebase;
}

export function makeKit(tables: SyzygyTables): Kit {
  const lock = { value: null as HumanGameLock };
  let answer: (fen: string) => Promise<TbPosition | null> = async () => null;
  const lichess = {
    probe: vi.fn((fen: string, o?: { signal?: AbortSignal }) => {
      if (o?.signal?.aborted) return Promise.reject(abortError());
      return answer(fen);
    }),
    available: () => true,
    blockedUntil: () => 0,
    blockedReason: () => null,
    requestCount: () => 0,
    abortAll: () => undefined,
  };
  const local: LocalTablebase = {
    probe: async (fen) => tables.probePosition(fen),
    coverage: async (fen) => {
      const key = materialKey(fen);
      const missing = tables.missing(key, 'wdl');
      return { wdl: missing.length === 0, dtz: tables.missing(key, 'dtz').length === 0, missing };
    },
    reset: () => undefined,
    running: () => false,
  };
  return {
    tables,
    lock,
    lichess,
    local,
    setLichess: (fn) => {
      answer = fn;
    },
  };
}

/** Installs the kit (no cache, no delay) and resets both stores and the board. */
export function installKit(kit: Kit, setting: TablebaseSetting = 'online', lessons?: Lesson[]) {
  useSettingsStore.getState().set({ tablebase: setting });
  configureTablebase({
    lichess: kit.lichess,
    local: kit.local,
    cache: { get: async () => undefined, put: async () => undefined },
    lock: () => kit.lock.value,
  });
  resetTablebaseStore();
  configureLessonStore(null);
  configureLessonStore({
    replyDelayMs: 0,
    lock: () => kit.lock.value,
    ...(lessons ? { lessons } : {}),
  });
  resetLessonStore();
  useGameStore.getState().reset();
}

/** Waits until the lesson waits for the user (or is over / ended). */
export async function settled(): Promise<void> {
  await vi.waitFor(
    () => {
      const s = useLessonStore.getState();
      const ready =
        s.status === 'idle' ||
        s.status === 'done' ||
        (s.status === 'running' && s.game?.phase === 'user' && !s.thinking);
      if (!ready) throw new Error(`lesson busy: ${s.status} ${s.game?.phase} ${s.thinking}`);
    },
    { timeout: 3000, interval: 2 },
  );
}

/** A move on the board, like a drag (UCI). */
export const boardMove = (uci: string): boolean =>
  useGameStore.getState().makeMove(uci.slice(0, 2), uci.slice(2, 4), uci[4]);
