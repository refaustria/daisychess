import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';

/**
 * User-facing wording for a missing or refused engine-server access token, in one place.
 * Tokens are stored per device, so "no token stored" (this device was never set up) is told apart
 * from "a token is stored but the server refused it".
 */

/** Internal marker of a refused/missing token in probe and engine errors (matched by {@link isAuthError}). */
export const UNAUTHORIZED_MESSAGE = 'Access token required or wrong';

export const NO_TOKEN_MESSAGE = 'No server access token on this device — enter it in Settings';
export const TOKEN_REJECTED_MESSAGE = 'Server access token was rejected — check it in Settings';

/** The shorter variants that end a sentence about what the token is needed for. */
export const NO_TOKEN_REVIEW_HINT = 'Enter the server access token in Settings to review on the server.';
export const TOKEN_REJECTED_REVIEW_HINT =
  'The server access token was rejected; check it in Settings to review on the server.';

export const NO_TOKEN_HINTS_NOTE = 'Human-like hints need the server access token — enter it in Settings';
export const TOKEN_REJECTED_HINTS_NOTE =
  'Human-like hints: the server access token was rejected — check it in Settings';

export const isAuthError = (message: string | undefined): boolean =>
  message !== undefined && message.includes(UNAUTHORIZED_MESSAGE);

/** True for the two user-facing messages (and the internal marker). */
export const isAuthText = (text: string): boolean =>
  text === NO_TOKEN_MESSAGE || text === TOKEN_REJECTED_MESSAGE || isAuthError(text);

/** Whether this device has a token stored (settings). */
export const hasStoredToken = (): boolean => useSettingsStore.getState().serverToken !== '';

/** The message for the current token state (reads the settings at call time). */
export const authMessage = (hasToken: boolean = hasStoredToken()): string =>
  hasToken ? TOKEN_REJECTED_MESSAGE : NO_TOKEN_MESSAGE;

export const authReviewHint = (hasToken: boolean = hasStoredToken()): string =>
  hasToken ? TOKEN_REJECTED_REVIEW_HINT : NO_TOKEN_REVIEW_HINT;

export const authHintsNote = (hasToken: boolean = hasStoredToken()): string =>
  hasToken ? TOKEN_REJECTED_HINTS_NOTE : NO_TOKEN_HINTS_NOTE;

/** Replaces the internal marker by the user-facing message; other texts pass through. */
export const displayError = (text: string): string => (isAuthError(text) ? authMessage() : text);

/** Switches to the Settings tab and focuses the server token field. */
export const openServerTokenSettings = (): void => useUiStore.getState().openServerTokenSettings();

/** Id of the token input in the Settings tab (focus target). */
export const SERVER_TOKEN_INPUT_ID = 'server-token-input';
