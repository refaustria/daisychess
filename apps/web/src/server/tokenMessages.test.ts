import { afterEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import {
  authMessage,
  BUDGET_EXHAUSTED_MESSAGE,
  deniedMessage,
  EXPIRED_MESSAGE,
  isDeniedText,
  NODE_OFFLINE_MESSAGE,
  NO_CAPACITY_MESSAGE,
  REVOKED_MESSAGE,
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

describe('analysisDenied messages (ADR-020)', () => {
  it('maps every reason to its wording', () => {
    expect(deniedMessage('expired')).toBe(
      'Your server access token has expired — ask the node operator for a new one',
    );
    expect(deniedMessage('revoked')).toBe('Your server access token was revoked');
    expect(deniedMessage('node_offline')).toBe('Your engine node is offline — try again later');
    expect(deniedMessage('no_capacity')).toBe('All engines are busy — try again in a moment');
    expect(deniedMessage('budget_exhausted')).toBe(
      "Today's community pool time is used up — it resets at midnight UTC",
    );
    expect(deniedMessage('no_token')).toBe(NO_TOKEN_MESSAGE);
    expect(deniedMessage('bad_token')).toBe(TOKEN_REJECTED_MESSAGE);
  });

  it('older servers (no reason) keep the stored-token wording', () => {
    expect(deniedMessage(undefined, false)).toBe(NO_TOKEN_MESSAGE);
    expect(deniedMessage(undefined, true)).toBe(TOKEN_REJECTED_MESSAGE);
  });

  it('classifies the texts', () => {
    for (const t of [
      EXPIRED_MESSAGE,
      REVOKED_MESSAGE,
      NODE_OFFLINE_MESSAGE,
      NO_CAPACITY_MESSAGE,
      BUDGET_EXHAUSTED_MESSAGE,
    ]) {
      expect(isDeniedText(t)).toBe(true);
    }
    expect(isDeniedText(NO_TOKEN_MESSAGE)).toBe(false);
    expect(isAuthText(EXPIRED_MESSAGE)).toBe(true);
    expect(isAuthText(NODE_OFFLINE_MESSAGE)).toBe(false);
  });
});
