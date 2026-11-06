// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import type { TablesManifest } from '@daisychess/endgames';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureTablePacks } from '../../endgames/tablePacks';
import {
  configureTablebase,
  resetTablebaseStore,
  useTablebaseStore,
} from '../../endgames/tablebaseStore';
import { configureTbCache, storedTableNames } from '../../endgames/tbCache';
import { useSettingsStore } from '../../store/settingsStore';
import { SettingsPanel } from './SettingsPanel';
import { ROOK_PACK_SIZE, TABLEBASE_LABEL, TablebaseField } from './TablebaseField';
import { ENDGAMES_KEY } from '../../endgames/endgamesProgress';

const bytes = new Uint8Array(4000).fill(5);
const MANIFEST: TablesManifest = {
  format: 1,
  source: 'test',
  tables: [
    {
      name: 'KRPvKR',
      kind: 'wdl',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      pack: 'rook',
    },
  ],
};

const local = { probe: vi.fn(), coverage: vi.fn(), reset: vi.fn(), running: () => false };

beforeEach(() => {
  configureTbCache(null);
  configureTablebase({ local });
  resetTablebaseStore();
  useSettingsStore.getState().set({ tablebase: 'online' });
});
afterEach(() => {
  cleanup();
  configureTablePacks({});
  configureTbCache(undefined);
  configureTablebase(null);
  useSettingsStore.getState().set({ tablebase: 'online' });
});

describe('TablebaseField', () => {
  it('offers the three settings with the privacy sentence; is part of the Settings panel', () => {
    render(<SettingsPanel />);
    const online = screen.getByLabelText(TABLEBASE_LABEL.online) as HTMLInputElement;
    expect(TABLEBASE_LABEL.online).toBe(
      'lichess (positions with up to 7 pieces are sent to tablebase.lichess.ovh)',
    );
    expect(online.checked).toBe(true);
    expect(screen.getByLabelText('On this device only')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Tablebase lookups' })).toBeTruthy();
    expect(screen.getByText(/lichess sees the position and your IP address/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Off'));
    expect(useSettingsStore.getState().tablebase).toBe('off');
    fireEvent.click(screen.getByLabelText('On this device only'));
    expect(useSettingsStore.getState().tablebase).toBe('local');
    expect(JSON.parse(localStorage.getItem('daisychess.settings')!)).toMatchObject({
      tablebase: 'local',
    });
    // "Reset to defaults" keeps the privacy choice.
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(useSettingsStore.getState().tablebase).toBe('local');
  });

  it('states the rook pack size from the manifest before the download', async () => {
    render(<TablebaseField />);
    expect(ROOK_PACK_SIZE).toBe('20.9 MB');
    expect(screen.getByText('Rook endgames offline: 20.9 MB')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download (20.9 MB)' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('tb-pack-status').textContent).toMatch(/Not downloaded/),
    );
    expect(screen.queryByTestId('tb-pack-delete')).toBeNull();
  });

  it('downloads with progress, then offers Delete; delete resets the local tables', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    configureTablePacks({
      manifest: MANIFEST,
      base: 'https://cdn.test/endgames/v1/',
      fetch: async () => {
        await gate;
        return new Response(bytes);
      },
    });
    render(<TablebaseField />);
    fireEvent.click(screen.getByTestId('tb-pack-download'));
    await waitFor(() => expect(screen.getByTestId('tb-pack-progress')).toBeTruthy());
    expect(screen.getByTestId('tb-pack-status').textContent).toMatch(/^Downloading… /);
    expect(screen.getByRole('button', { name: 'Cancel download' })).toBeTruthy();
    await act(async () => release());
    await waitFor(() =>
      expect(screen.getByTestId('tb-pack-status').textContent).toMatch(/^Downloaded/),
    );
    expect(local.reset).toHaveBeenCalled();
    expect(await storedTableNames()).toEqual(['KRPvKR.rtbw']);
    expect(screen.queryByTestId('tb-pack-download')).toBeNull();
    local.reset.mockClear();
    fireEvent.click(screen.getByTestId('tb-pack-delete'));
    await waitFor(() =>
      expect(screen.getByTestId('tb-pack-status').textContent).toMatch(/Not downloaded/),
    );
    expect(local.reset).toHaveBeenCalledWith({ terminate: true });
    expect(await storedTableNames()).toEqual([]);
  });

  it('a file that fails verification shows an error and stores nothing', async () => {
    configureTablePacks({
      manifest: MANIFEST,
      base: 'https://cdn.test/endgames/v1/',
      fetch: async () => new Response(new Uint8Array(4000).fill(6)),
    });
    render(<TablebaseField />);
    fireEvent.click(screen.getByTestId('tb-pack-download'));
    await waitFor(() =>
      expect(screen.getByTestId('tb-pack-error').textContent).toMatch(/checksum/),
    );
    expect(await storedTableNames()).toEqual([]);
    expect(useTablebaseStore.getState().packs.rook.busy).toBeNull();
  });

  it('cancel stops the download without an error', async () => {
    configureTablePacks({
      manifest: MANIFEST,
      base: 'https://cdn.test/endgames/v1/',
      fetch: (_url, init) =>
        new Promise((_res, rej) =>
          init?.signal?.addEventListener('abort', () =>
            rej(new DOMException('Aborted', 'AbortError')),
          ),
        ),
    });
    render(<TablebaseField />);
    fireEvent.click(screen.getByTestId('tb-pack-download'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel download' }));
    await waitFor(() => expect(screen.getByTestId('tb-pack-download')).toBeTruthy());
    expect(screen.queryByTestId('tb-pack-error')).toBeNull();
  });

  it('"Reset endgame progress" asks first, then calls the handler', () => {
    const reset = vi.fn();
    render(<TablebaseField onResetProgress={reset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset endgame progress' }));
    expect(reset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset endgame progress' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset' }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Endgame progress was reset.')).toBeTruthy();
  });

  it('by default the reset clears the stored endgame progress', () => {
    localStorage.setItem(ENDGAMES_KEY, '{"v":1,"lessons":{}}');
    render(<TablebaseField />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset endgame progress' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset' }));
    expect(localStorage.getItem(ENDGAMES_KEY)).toBeNull();
  });
});
