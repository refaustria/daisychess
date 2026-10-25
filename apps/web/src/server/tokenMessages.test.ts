import { afterEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import {
  authMessage,
  displayError,
  isAuthText,
  NO_TOKEN_MESSAGE,
  openServerTokenSettings,
  TOKEN_REJECTED_MESSAGE,
  UNAUTHORIZED_MESSAGE,
} from './tokenMessages';

afterEach(() => useSettingsStore.getState().setServerToken(''));

describe('token messages', () => {
  it('tells "no token stored" from "token rejected"', () => {
    expect(authMessage()).toBe(NO_TOKEN_MESSAGE);
    useSettingsStore.getState().setServerToken('abc');
    expect(authMessage()).toBe(TOKEN_REJECTED_MESSAGE);
    expect(displayError(UNAUTHORIZED_MESSAGE)).toBe(TOKEN_REJECTED_MESSAGE);
    expect(displayError('Server unreachable')).toBe('Server unreachable');
    expect(isAuthText(NO_TOKEN_MESSAGE)).toBe(true);
    expect(isAuthText('Server unreachable')).toBe(false);
  });

  it('openServerTokenSettings opens the Settings tab and requests focus', () => {
    openServerTokenSettings();
    expect(useUiStore.getState().activeTab).toBe('settings');
    expect(useUiStore.getState().focusServerToken).toBe(true);
    useUiStore.getState().clearFocusServerToken();
  });
});
