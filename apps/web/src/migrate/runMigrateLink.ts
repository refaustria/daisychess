// Side-effect module: imported in main.tsx right after the ChessLab rename migration and before
// any store module, so imported keys are in localStorage before the stores read it at import time.
// Deliberately imports no store: the notice is handed to main.tsx via takeMigrationNotice().
import { consumeMigrateLink } from './migrateLink';

let pendingNotice: string | null = null;

/** The one-time "moved from c.referee.at" notice of this start (null after the first call). */
export function takeMigrationNotice(): string | null {
  const n = pendingNotice;
  pendingNotice = null;
  return n;
}

function localStorageOrUndefined(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

try {
  const outcome = consumeMigrateLink({
    location: globalThis.location,
    history: globalThis.history,
    referrer: globalThis.document?.referrer ?? '',
    storage: localStorageOrUndefined(),
  });
  pendingNotice = outcome?.notice ?? null;
  // The inline theme bootstrap in index.html ran before the import: apply a moved theme now.
  const theme = outcome?.result?.imported.includes('daisychess.theme')
    ? globalThis.localStorage.getItem('daisychess.theme')
    : null;
  if (theme === 'light' || theme === 'dark')
    document.documentElement.setAttribute('data-theme', theme);
} catch {
  /* no location/history (non-browser): nothing to do */
}
