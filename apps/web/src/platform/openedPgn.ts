/**
 * Open-with / import of `.pgn` files handed to the app by other apps (M26-5, ADR-022 §4).
 * `file://` (iOS, copied into the app's Inbox because `LSSupportsOpeningDocumentsInPlace` is
 * false) and `content://` (Android) URLs arrive through the app URL dispatcher; the text is read
 * with `@capacitor/filesystem` and queued in {@link useOpenedPgn}, which the Import panel turns
 * into its normal flow (single game: load; several: the game picker).
 */
import { create } from 'zustand';
import { splitPgnGames } from '../store/pgn';
import { useUiStore } from '../store/uiStore';
import { registerAppUrlHandler } from './appUrl';
import { loadFiles, type FilesPort } from './native';

/** Largest file we read (a lichess monthly export of one player is a few MB). */
export const MAX_PGN_FILE_BYTES = 10 * 1024 * 1024;

export class PgnFileError extends Error {}

interface OpenedPgn {
  /** Increments with every file; the Import panel consumes a seq once. */
  seq: number;
  text: string;
  name: string;
}

interface OpenedPgnStore extends OpenedPgn {
  offer(text: string, name: string): void;
  clear(): void;
}

export const useOpenedPgn = create<OpenedPgnStore>()((set, get) => ({
  seq: 0,
  text: '',
  name: '',
  offer: (text, name) => set({ seq: get().seq + 1, text, name }),
  clear: () => set({ text: '', name: '' }),
}));

/** URLs that carry a file: iOS `file://`, Android `content://`. */
export const isFileUrl = (url: string): boolean => /^(file|content):\/\//i.test(url);

/** Decodes PGN bytes: UTF-16 by BOM, UTF-8 (BOM stripped), else Windows-1252 (old Latin-1 exports). */
export function decodePgnBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** A display name for the file from its URL (the decoded `*.pgn` last path segment), '' when unknown. */
export function fileNameOf(url: string): string {
  try {
    const path = url.replace(/[?#].*$/, '');
    const last = path.split('/').pop() ?? '';
    const name = decodeURIComponent(last);
    // Content URIs often end in an opaque id; only a real file name is worth showing.
    return /\.pgn$/i.test(name) ? name : '';
  } catch {
    return '';
  }
}

/** Reads and decodes the file; throws {@link PgnFileError} with a user-facing message. */
export async function readPgnFile(files: FilesPort, url: string): Promise<string> {
  const tooBig = new PgnFileError('This file is too large to import (limit 10 MB)');
  const size = await files.size(url);
  if (size !== null && size > MAX_PGN_FILE_BYTES) throw tooBig;
  let bytes: Uint8Array;
  try {
    bytes = await files.read(url);
  } catch {
    throw new PgnFileError('Could not read the file');
  }
  if (bytes.length > MAX_PGN_FILE_BYTES) throw tooBig;
  const text = decodePgnBytes(bytes);
  if (splitPgnGames(text).length === 0) throw new PgnFileError('No chess games found in this file');
  return text;
}

/** Opens a file URL: read, queue for the Import tab, switch to it. Errors become notices. */
export async function openPgnUrl(
  url: string,
  files: FilesPort | null | Promise<FilesPort | null> = loadFiles(),
): Promise<boolean> {
  const ui = useUiStore.getState();
  try {
    const port = await files;
    if (!port) return false;
    const text = await readPgnFile(port, url);
    const name = fileNameOf(url);
    const n = splitPgnGames(text).length;
    useOpenedPgn.getState().offer(text, name);
    ui.setActiveTab('import');
    ui.showNotice(
      n > 1 ? `${name || 'File'}: ${n} games, choose one to open` : `Opened ${name || 'PGN file'}`,
    );
    if (/\/Inbox\//.test(url)) void port.remove(url).catch(() => undefined);
    return true;
  } catch (e) {
    ui.showNotice(e instanceof PgnFileError ? e.message : 'Could not open the file');
    return false;
  }
}

/** Routes file URLs to {@link openPgnUrl}; returns the unregister function. */
export function registerPgnFileHandler(
  open: (url: string) => unknown = (u) => openPgnUrl(u),
): () => void {
  return registerAppUrlHandler(isFileUrl, (u) => void open(u));
}
