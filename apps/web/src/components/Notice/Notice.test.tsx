// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../../store/uiStore';
import { Notice, NOTICE_MS } from './Notice';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useUiStore.getState().dismissNotice();
});

describe('Notice', () => {
  it('shows the notice, dismisses on click and after a timeout', () => {
    vi.useFakeTimers();
    render(<Notice />);
    expect(screen.queryByTestId('app-notice')).toBeNull();
    act(() => useUiStore.getState().showNotice('Server access token saved on this device'));
    expect(screen.getByTestId('app-notice').textContent).toContain('saved on this device');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('app-notice')).toBeNull();
    act(() => useUiStore.getState().showNotice('again'));
    act(() => {
      vi.advanceTimersByTime(NOTICE_MS + 1);
    });
    expect(screen.queryByTestId('app-notice')).toBeNull();
  });
});
