// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canShare, shareContent } from './share';

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'share');
});

describe('share', () => {
  it('uses the native port when given', async () => {
    const port = { share: vi.fn(() => Promise.resolve()) };
    expect(await shareContent({ text: '1. e4', title: 'T' }, port)).toBe('shared');
    expect(port.share).toHaveBeenCalledWith({ text: '1. e4', title: 'T' });
  });

  it('falls back to navigator.share on the web, else reports unavailable', async () => {
    expect(canShare()).toBe(false);
    expect(await shareContent({ url: 'https://x' }, null)).toBe('unavailable');
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    expect(canShare()).toBe(true);
    expect(await shareContent({ url: 'https://x' }, null)).toBe('shared');
    expect(share).toHaveBeenCalledWith({ url: 'https://x' });
  });

  it('maps a dismissed sheet to cancelled and other errors to failed', async () => {
    const abort = Object.assign(new Error('x'), { name: 'AbortError' });
    expect(await shareContent({}, { share: () => Promise.reject(abort) })).toBe('cancelled');
    expect(
      await shareContent({}, { share: () => Promise.reject(new Error('Share canceled')) }),
    ).toBe('cancelled');
    expect(await shareContent({}, { share: () => Promise.reject(new Error('boom')) })).toBe(
      'failed',
    );
  });
});
