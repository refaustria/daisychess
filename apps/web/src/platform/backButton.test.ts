// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../store/uiStore';
import {
  handleBack,
  registerBackHandler,
  resetBackButton,
  startBackButton,
  trackTabHistory,
} from './backButton';

let stop: () => void;
beforeEach(() => {
  useUiStore.setState({ activeTab: 'moves' });
  resetBackButton();
  stop = trackTabHistory();
});
afterEach(() => stop());

describe('back button', () => {
  it('closes the newest dialog first', () => {
    const order: string[] = [];
    const a = registerBackHandler(() => (order.push('a'), true));
    const b = registerBackHandler(() => (order.push('b'), true));
    expect(handleBack()).toBe('dialog');
    b();
    expect(handleBack()).toBe('dialog');
    a();
    expect(order).toEqual(['b', 'a']);
  });

  it('skips handlers that closed nothing', () => {
    const off = registerBackHandler(() => false);
    expect(handleBack()).toBe('exit');
    off();
  });

  it('walks back through the visited tabs, then exits on the first tab', () => {
    const ui = useUiStore.getState();
    ui.setActiveTab('play');
    ui.setActiveTab('settings');
    expect(handleBack()).toBe('tab');
    expect(useUiStore.getState().activeTab).toBe('play');
    expect(handleBack()).toBe('tab');
    expect(useUiStore.getState().activeTab).toBe('moves');
    expect(handleBack()).toBe('exit');
  });

  it('does not record its own navigation and goes home without history', () => {
    useUiStore.setState({ activeTab: 'review' }); // e.g. set before tracking saw a previous tab
    expect(handleBack()).toBe('tab');
    expect(useUiStore.getState().activeTab).toBe('moves');
  });

  it('exits the app through the plugin', async () => {
    let press: () => void = () => undefined;
    const port = {
      onStateChange: vi.fn(),
      onBackButton: vi.fn((fn: () => void) => {
        press = fn;
        return Promise.resolve();
      }),
      exitApp: vi.fn(() => Promise.resolve()),
    };
    await startBackButton(port);
    press();
    expect(port.exitApp).toHaveBeenCalledTimes(1);
    useUiStore.getState().setActiveTab('import');
    press();
    expect(port.exitApp).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().activeTab).toBe('moves');
  });
});
