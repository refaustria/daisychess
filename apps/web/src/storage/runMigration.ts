// Side-effect module: imported first in main.tsx so the storage rename (ADR-018) runs before
// any store module reads localStorage at import time.
import { migrateStorage } from './migrate';

migrateStorage();

// The inline theme bootstrap in index.html ran before the migration and only knows the new key;
// apply a just-migrated theme so the first start after the rename keeps the user's choice.
try {
  const t = localStorage.getItem('daisychess.theme');
  if ((t === 'light' || t === 'dark') && !document.documentElement.hasAttribute('data-theme')) {
    document.documentElement.setAttribute('data-theme', t);
  }
} catch {
  // Storage blocked: the system theme applies, as in the inline bootstrap.
}
