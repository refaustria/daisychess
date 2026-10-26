// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../store/uiStore';
import { MULTI_GAME_PGN } from './openedPgn.fixture';
import { dispatchAppUrl, handleOpenedUrl, resetAppUrl } from './appUrl';
import type { FilesPort } from './native';
import {
  MAX_PGN_FILE_BYTES,
  decodePgnBytes,
  fileNameOf,
  isFileUrl,
  openPgnUrl,
  readPgnFile,
  registerPgnFileHandler,
  useOpenedPgn,
} from './openedPgn';

const enc = (s: string) => new TextEncoder().encode(s);

const fakeFiles = (bytes: Uint8Array | Error, size: number | null = null): FilesPort => ({
  size: vi.fn(() => Promise.resolve(size)),
  read: vi.fn(() => (bytes instanceof Error ? Promise.reject(bytes) : Promise.resolve(bytes))),
  remove: vi.fn(() => Promise.resolve()),
});

beforeEach(() => {
  useOpenedPgn.setState({ seq: 0, text: '', name: '' });
  useUiStore.setState({ notice: null, activeTab: 'moves' });
});
afterEach(resetAppUrl);

describe('file url helpers', () => {
  it('recognises file and content URLs only', () => {
    expect(isFileUrl('content://media/external/file/42')).toBe(true);
    expect(isFileUrl('file:///var/mobile/Inbox/x.pgn')).toBe(true);
    expect(isFileUrl('daisychess://setup?token=x')).toBe(false);
    expect(isFileUrl('https://play.daisychess.org/')).toBe(false);
  });

  it('derives a decoded display name', () => {
    expect(fileNameOf('file:///a/Inbox/My%20game.pgn')).toBe('My game.pgn');
    expect(fileNameOf('content://x/y/z.pgn?foo=1')).toBe('z.pgn');
    expect(fileNameOf('content://x/%E0%A4')).toBe('');
  });
});

describe('decodePgnBytes', () => {
  it('decodes UTF-8 and strips a BOM', () => {
    expect(decodePgnBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('Müller')]))).toBe('Müller');
  });
  it('falls back to Windows-1252 for Latin-1 files', () => {
    expect(decodePgnBytes(new Uint8Array([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]))).toBe('Müller');
  });
  it('decodes UTF-16 by BOM', () => {
    const le = new Uint8Array([0xff, 0xfe, 0x4d, 0x00, 0xfc, 0x00]);
    expect(decodePgnBytes(le)).toBe('Mü');
    expect(decodePgnBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x4d, 0x00, 0xfc]))).toBe('Mü');
  });
});

describe('readPgnFile', () => {
  it('rejects files over the size limit before and after reading', async () => {
    const big = fakeFiles(enc('x'), MAX_PGN_FILE_BYTES + 1);
    await expect(readPgnFile(big, 'file:///a.pgn')).rejects.toThrow(/too large/);
    expect(big.read).not.toHaveBeenCalled();
    const unknownSize = fakeFiles(new Uint8Array(MAX_PGN_FILE_BYTES + 1));
    await expect(readPgnFile(unknownSize, 'content://a')).rejects.toThrow(/too large/);
  });
  it('reports unreadable files and files without games', async () => {
    await expect(readPgnFile(fakeFiles(new Error('EACCES')), 'content://a')).rejects.toThrow(
      'Could not read the file',
    );
    await expect(readPgnFile(fakeFiles(enc('  \n ')), 'content://a')).rejects.toThrow(
      'No chess games found in this file',
    );
  });
});

describe('open-with path (multi-game PGN)', () => {
  it('routes a file URL from the dispatcher to the Import tab and queues the text', async () => {
    const files = fakeFiles(new Uint8Array([0xef, 0xbb, 0xbf, ...enc(MULTI_GAME_PGN)]));
    const done = vi.fn();
    registerPgnFileHandler((u) => openPgnUrl(u, files).then(done));
    expect(handleOpenedUrl('file:///private/var/Inbox/rounds%201-3.pgn')).toBe(1);
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(true));
    const q = useOpenedPgn.getState();
    expect(q.seq).toBe(1);
    expect(q.name).toBe('rounds 1-3.pgn');
    expect(q.text).toContain('[White "Müller"]');
    expect(useUiStore.getState().activeTab).toBe('import');
    expect(useUiStore.getState().notice).toBe('rounds 1-3.pgn: 3 games, choose one to open');
    expect(files.remove).toHaveBeenCalledWith('file:///private/var/Inbox/rounds%201-3.pgn');
  });

  it('keeps content URIs and does not delete them', async () => {
    const files = fakeFiles(enc(MULTI_GAME_PGN.split('\r\n\r\n[Event "Round 2"]')[0] as string));
    expect(await openPgnUrl('content://com.android.providers/doc/7', files)).toBe(true);
    expect(files.remove).not.toHaveBeenCalled();
    expect(useUiStore.getState().notice).toBe('Opened PGN file');
  });

  it('shows errors as notices and queues nothing', async () => {
    expect(await openPgnUrl('content://a', fakeFiles(enc('   ')))).toBe(false);
    expect(useUiStore.getState().notice).toBe('No chess games found in this file');
    expect(useOpenedPgn.getState().seq).toBe(0);
    expect(useUiStore.getState().activeTab).toBe('moves');
  });

  it('does nothing without the plugin (web)', async () => {
    expect(await openPgnUrl('file:///a.pgn', null)).toBe(false);
    expect(dispatchAppUrl('file:///a.pgn')).toBe(0);
  });
});
