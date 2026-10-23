import { DEFAULT_BOARD_THEME, findBoardTheme } from '@chesslab/ui-theme/boardThemes';
import { DEFAULT_PIECE_SET, isPieceSet } from '@chesslab/ui-theme/pieceSets';
import { create } from 'zustand';

export type HighlightStyle = 'classic' | 'subtle' | 'none';
export const HIGHLIGHT_STYLES: readonly HighlightStyle[] = ['classic', 'subtle', 'none'];

export interface Settings {
  /** Preset id from ui-theme, or 'custom' when `customBoard` is used. */
  boardTheme: string;
  customBoard?: { light: string; dark: string };
  pieceSet: string;
  coordinates: boolean;
  highlightStyle: HighlightStyle;
  sound: boolean;
  /**
   * Access token of the engine server (ADR-010), sent in `hello.token`. Empty = none. Stored in
   * localStorage like the other settings: it is a shared gate against casual use, not a secret
   * that needs protection from this browser's user.
   */
  serverToken: string;
}

/** Same bound as the protocol's `hello.token`. */
export const MAX_SERVER_TOKEN_LENGTH = 256;

/** Trims surrounding whitespace (pasted tokens) and caps the length. */
export function normalizeToken(raw: string): string {
  return raw.trim().slice(0, MAX_SERVER_TOKEN_LENGTH);
}

export const SETTINGS_KEY = 'chesslab.settings';

export const DEFAULT_SETTINGS: Settings = {
  boardTheme: DEFAULT_BOARD_THEME,
  pieceSet: DEFAULT_PIECE_SET,
  coordinates: true,
  highlightStyle: 'classic',
  sound: true,
  serverToken: '',
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Parses stored JSON defensively; unknown or invalid fields fall back to defaults. */
export function parseSettings(raw: string | null): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (!raw) return out;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof v !== 'object' || v === null) return out;
  const o = v as Record<string, unknown>;
  const cb = o.customBoard as Record<string, unknown> | undefined;
  if (
    cb &&
    typeof cb.light === 'string' &&
    typeof cb.dark === 'string' &&
    HEX.test(cb.light) &&
    HEX.test(cb.dark)
  ) {
    out.customBoard = { light: cb.light, dark: cb.dark };
  }
  if (typeof o.boardTheme === 'string') {
    if (findBoardTheme(o.boardTheme)) out.boardTheme = o.boardTheme;
    else if (o.boardTheme === 'custom' && out.customBoard) out.boardTheme = 'custom';
  }
  if (typeof o.pieceSet === 'string' && isPieceSet(o.pieceSet)) out.pieceSet = o.pieceSet;
  if (typeof o.coordinates === 'boolean') out.coordinates = o.coordinates;
  if (
    typeof o.highlightStyle === 'string' &&
    (HIGHLIGHT_STYLES as readonly string[]).includes(o.highlightStyle)
  ) {
    out.highlightStyle = o.highlightStyle as HighlightStyle;
  }
  if (typeof o.sound === 'boolean') out.sound = o.sound;
  if (typeof o.serverToken === 'string') out.serverToken = normalizeToken(o.serverToken);
  return out;
}

function load(): Settings {
  try {
    return parseSettings(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persist(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable; settings apply for this session only */
  }
}

interface SettingsActions {
  set: (patch: Partial<Settings>) => void;
  /** Selects a custom board colour pair (also switches boardTheme to 'custom'). */
  setCustomBoard: (c: { light: string; dark: string }) => void;
  /** Stores the engine server access token (trimmed; empty removes it). */
  setServerToken: (token: string) => void;
  /** Resets the appearance settings; the server access token is kept. */
  reset: () => void;
}

export type SettingsStore = Settings & SettingsActions;

function pick(s: Settings): Settings {
  const out: Settings = {
    boardTheme: s.boardTheme,
    pieceSet: s.pieceSet,
    coordinates: s.coordinates,
    highlightStyle: s.highlightStyle,
    sound: s.sound,
    serverToken: s.serverToken,
  };
  if (s.customBoard) out.customBoard = s.customBoard;
  return out;
}

export const useSettingsStore = create<SettingsStore>()((set, get) => ({
  ...load(),
  set: (patch) => {
    set(patch);
    persist(pick(get()));
  },
  setCustomBoard: (customBoard) => {
    set({ customBoard, boardTheme: 'custom' });
    persist(pick(get()));
  },
  setServerToken: (token) => {
    const serverToken = normalizeToken(token);
    if (serverToken === get().serverToken) return;
    set({ serverToken });
    persist(pick(get()));
  },
  reset: () => {
    set({ ...DEFAULT_SETTINGS, serverToken: get().serverToken, customBoard: undefined });
    persist(pick(get()));
  },
}));

/** Effective board colours, or null for the default theme (keeps the light/dark theme tokens). */
export function boardColours(s: Settings): { light: string; dark: string } | null {
  if (s.boardTheme === 'custom' && s.customBoard) return s.customBoard;
  if (s.boardTheme === DEFAULT_BOARD_THEME) return null;
  const t = findBoardTheme(s.boardTheme);
  return t ? { light: t.light, dark: t.dark } : null;
}

export function applyBoardColours(s: Settings, root: HTMLElement = document.documentElement): void {
  const c = boardColours(s);
  if (c) {
    root.style.setProperty('--board-light', c.light);
    root.style.setProperty('--board-dark', c.dark);
  } else {
    root.style.removeProperty('--board-light');
    root.style.removeProperty('--board-dark');
  }
}

/** Applies the settings as CSS variables now and on every change. Returns an unsubscribe function. */
export function applySettings(): () => void {
  applyBoardColours(useSettingsStore.getState());
  return useSettingsStore.subscribe((s) => applyBoardColours(s));
}
