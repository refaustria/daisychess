import { useGameStore, type GameState } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';

export type MoveSoundKind = 'move' | 'capture' | 'check';

type AudioCtor = typeof AudioContext;
let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const w = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
    const C = w.AudioContext ?? w.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    return ctx;
  } catch {
    return null;
  }
}

function tone(
  ac: AudioContext,
  freq: number,
  start: number,
  dur: number,
  gain: number,
  type: OscillatorType,
) {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/** Plays a short synthesised sound. Never throws; silent when audio is unavailable or disabled. */
export function playMoveSound(kind: MoveSoundKind): void {
  if (!useSettingsStore.getState().sound) return;
  try {
    const ac = context();
    if (!ac) return;
    if (ac.state === 'suspended') void ac.resume().catch(() => undefined);
    const t = ac.currentTime;
    if (kind === 'move') {
      tone(ac, 520, t, 0.07, 0.18, 'triangle');
    } else {
      tone(ac, 330, t, 0.09, 0.25, 'square');
      tone(ac, kind === 'check' ? 660 : 440, t + 0.08, 0.12, 0.2, 'square');
    }
  } catch {
    /* audio failure must never affect play */
  }
}

/** Classifies the move that was just played, or null if `next` is not a freshly played move. */
export function newMoveKind(prev: GameState, next: GameState): MoveSoundKind | null {
  if (next.ply !== prev.ply + 1) return null;
  const m = next.moves[next.ply - 1];
  if (!m || m === prev.moves[prev.ply]) return null; // forward navigation reuses the record
  if (/[+#]$/.test(m.san)) return 'check';
  return m.san.includes('x') ? 'capture' : 'move';
}

/** Plays a sound for each newly played move (not for navigation or undo). */
export function startMoveSounds(): () => void {
  return useGameStore.subscribe((next, prev) => {
    const kind = newMoveKind(prev, next);
    if (kind) playMoveSound(kind);
  });
}
