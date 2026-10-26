// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockMatchMedia } from '../../test/matchMedia';
import { PHONE_QUERY, usePhoneLayout } from './usePhoneLayout';

function Probe() {
  return <p data-testid="probe">{usePhoneLayout() ? 'phone' : 'regular'}</p>;
}

afterEach(cleanup);

describe('usePhoneLayout', () => {
  it('is false without matchMedia', () => {
    const original = window.matchMedia;
    // @ts-expect-error jsdom: no matchMedia
    delete window.matchMedia;
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('regular');
    window.matchMedia = original;
  });

  it('follows the portrait phone media query, including later changes', () => {
    expect(PHONE_QUERY).toBe('(max-width: 600px) and (orientation: portrait)');
    const mq = mockMatchMedia(PHONE_QUERY, true);
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('phone');
    act(() => mq.set(false));
    expect(screen.getByTestId('probe').textContent).toBe('regular');
    act(() => mq.set(true));
    expect(screen.getByTestId('probe').textContent).toBe('phone');
    unmount();
    expect(mq.listeners()).toBe(0);
    mq.restore();
  });
});
