// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_STORAGE_KEY, resetLichessAuth, setLichessNavigate, useLichessAuth } from '../../lichess/auth';
import { useUiStore } from '../../store/uiStore';
import { AccountChip } from './AccountChip';
import { LichessAccountSection } from './LichessAccountSection';

function loginAs(username: string) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'lio_x', username, scopes: ['board:play', 'challenge:read'] }));
  resetLichessAuth();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetLichessAuth();
  useUiStore.setState({ activeTab: 'moves' });
});

afterEach(() => {
  cleanup();
  setLichessNavigate(undefined);
  vi.unstubAllGlobals();
});

describe('AccountChip', () => {
  it('shows "Log in" when anonymous and opens Settings', () => {
    render(<AccountChip />);
    const chip = screen.getByTestId('account-chip');
    expect(chip.textContent).toBe('Log in');
    fireEvent.click(chip);
    expect(useUiStore.getState().activeTab).toBe('settings');
  });

  it('shows the username when logged in', () => {
    loginAs('Alice');
    render(<AccountChip />);
    expect(screen.getByTestId('account-chip').textContent).toBe('Alice');
    expect(screen.getByRole('button', { name: 'lichess account Alice, open settings' })).toBeTruthy();
  });
});

describe('LichessAccountSection', () => {
  it('offers the login with the scopes in the tooltip and starts it', async () => {
    const nav = vi.fn<(url: string) => void>();
    setLichessNavigate(nav);
    render(<LichessAccountSection />);
    const btn = screen.getByRole('button', { name: 'Log in with lichess' });
    expect(btn.getAttribute('title')).toContain('board:play, challenge:read, challenge:write');
    fireEvent.click(btn);
    await vi.waitFor(() => expect(nav).toHaveBeenCalledTimes(1));
    expect(nav.mock.calls[0]![0]).toMatch(/^https:\/\/lichess\.org\/oauth\?/);
  });

  it('shows "Logged in as", the scopes and logs out', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    loginAs('Alice');
    render(<LichessAccountSection />);
    expect(screen.getByText(/Logged in as/).textContent).toBe('Logged in as Alice');
    const scopes = screen.getByRole('list', { name: 'Granted permissions' });
    expect(scopes.textContent).toContain('board:play');
    expect(scopes.textContent).toContain('challenge:read');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    });
    expect(useLichessAuth.getState().status).toBe('anonymous');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Log in with lichess' })).toBeTruthy();
  });

  it('shows a login error', () => {
    useLichessAuth.setState({ status: 'error', error: 'Login cancelled on lichess' });
    render(<LichessAccountSection />);
    expect(screen.getByRole('alert').textContent).toBe('Login cancelled on lichess');
  });

  it('marks granted and missing permissions and hints at a new token', () => {
    loginAs('Alice');
    render(<LichessAccountSection />);
    const items = screen.getByRole('list', { name: 'Granted permissions' }).querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain('✓');
    expect(items[2]!.textContent).toContain('✗');
    expect(screen.getByText(/Create a new token with the missing permissions: challenge:write/)).toBeTruthy();
    expect(screen.getByText('via lichess login')).toBeTruthy();
  });

  describe('personal access token', () => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    const stub = (valid: boolean) => {
      const f = vi.fn(async (input: string, init?: RequestInit) => {
        if (input.endsWith('/api/token/test')) {
          return json(valid ? { [String(init?.body)]: { userId: 'bob', scopes: 'board:play,challenge:read,challenge:write', expires: null } } : { [String(init?.body)]: null });
        }
        if (input.endsWith('/api/account')) return json({ id: 'bob', username: 'Bob' });
        return new Response(null, { status: 204 });
      });
      vi.stubGlobal('fetch', f);
      return f;
    };

    it('links to the token page, hides the input by default and toggles it', () => {
      render(<LichessAccountSection />);
      const link = screen.getByRole('link', { name: 'Create a token on lichess' });
      expect(link.getAttribute('href')).toContain('/account/oauth/token/create?scopes[]=board:play&scopes[]=challenge:read&scopes[]=challenge:write');
      const input = screen.getByLabelText('Personal access token') as HTMLInputElement;
      expect(input.type).toBe('password');
      fireEvent.click(screen.getByRole('button', { name: 'Show lichess token' }));
      expect(input.type).toBe('text');
      expect((screen.getByRole('button', { name: 'Save lichess token' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('saves a valid token, then logs out without revoking', async () => {
      const f = stub(true);
      render(<LichessAccountSection />);
      fireEvent.change(screen.getByLabelText('Personal access token'), { target: { value: 'lip_abc' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save lichess token' }));
      await screen.findByText('via token');
      expect(screen.getByText(/Logged in as/).textContent).toBe('Logged in as Bob');
      expect(screen.queryByText(/Create a new token/)).toBeNull();
      expect(document.body.innerHTML).not.toContain('lip_abc');
      f.mockClear();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
      });
      expect(f).not.toHaveBeenCalled();
      expect(useLichessAuth.getState().status).toBe('anonymous');
    });

    it('shows an error for an invalid token', async () => {
      stub(false);
      render(<LichessAccountSection />);
      fireEvent.change(screen.getByLabelText('Personal access token'), { target: { value: 'lip_bad' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save lichess token' }));
      expect((await screen.findByRole('alert')).textContent).toBe('Token invalid or expired');
      expect(document.body.innerHTML).not.toContain('lip_bad</');
    });
  });
});
