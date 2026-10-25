import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { resetCallbackGuard } from '../auth/lichess';

afterEach(() => {
  cleanup();
  resetCallbackGuard();
  globalThis.sessionStorage.clear();
  globalThis.history.replaceState(null, '', '/portal/');
});
