import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');
const pack = (o: unknown) =>
  `1.${Buffer.from(deflateRawSync(Buffer.from(JSON.stringify(o)))).toString('base64url')}`;

function setReferrer(value: string) {
  Object.defineProperty(document, 'referrer', { value, configurable: true });
}

afterEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  document.documentElement.removeAttribute('data-theme');
  setReferrer('');
});

describe('runMigrateLink (side effect on app start)', () => {
  it('imports before the stores load, strips the fragment, applies the theme and hands over the notice once', async () => {
    history.replaceState(
      null,
      '',
      `/#migrate=${pack({ v: 1, items: { 'daisychess.theme': 'dark', 'daisychess.nick': 'Bojan' } })}`,
    );
    setReferrer('https://c.referee.at/');
    vi.resetModules();
    const mod = await import('./runMigrateLink');
    expect(localStorage.getItem('daisychess.nick')).toBe('Bojan');
    expect(location.hash).toBe('');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(mod.takeMigrationNotice()).toBe('Your settings were moved from c.referee.at');
    expect(mod.takeMigrationNotice()).toBeNull();
  });

  it('does nothing without a fragment', async () => {
    vi.resetModules();
    const mod = await import('./runMigrateLink');
    expect(mod.takeMigrationNotice()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('imports no store module (stores read localStorage at import time)', () => {
    const src = read('./runMigrateLink.ts') + read('./migrateLink.ts') + read('./inflate.ts');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.every((p) => p === './migrateLink' || p === './inflate')).toBe(true);
  });

  it('runs before the setup link and every store in main.tsx', () => {
    const main = read('../main.tsx');
    const lines = main.split('\n').filter((l) => l.startsWith('import'));
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(at('./storage/runMigration')).toBeLessThan(at('./migrate/runMigrateLink'));
    expect(at('./migrate/runMigrateLink')).toBeLessThan(at('./setup/runSetupLink'));
    expect(at('./migrate/runMigrateLink')).toBeLessThan(at('./store/'));
  });
});
