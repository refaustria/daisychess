// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LICENSE_NAME, SOURCE_REPO_URL, sourceLinkFor } from '../../appInfo';
import { AboutField } from './AboutField';
import { SettingsPanel } from './SettingsPanel';

afterEach(cleanup);

describe('AboutField', () => {
  it('links to the source repository and names the licence', () => {
    render(<AboutField />);
    const link = screen.getByRole('link', { name: 'Repository' });
    expect(link.getAttribute('href')).toBe(SOURCE_REPO_URL);
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('link', { name: LICENSE_NAME })).toBeTruthy();
  });

  it('shows version and commit', () => {
    render(<AboutField />);
    expect(screen.getByTestId('about-version').textContent).toMatch(/DaisyChess \S+ .*commit \S+/);
  });

  it('loads the bundled GPL text and notices on demand', async () => {
    render(<AboutField />);
    expect(screen.queryByText(/GNU General Public License, version 3/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Licences' }));
    expect(await screen.findByText('GNU General Public License, version 3')).toBeTruthy();
    expect(screen.getByLabelText('GNU General Public License').textContent).toContain(
      'TERMS AND CONDITIONS',
    );
    expect(screen.getByLabelText('Third-party notices').textContent).toContain('Stockfish');
    expect(screen.getByLabelText('Attributions').textContent).toMatch(/Lc0.*Maia.*chessground/s);
  });

  it('is part of the Settings panel', () => {
    render(<SettingsPanel />);
    expect(screen.getByRole('link', { name: 'Repository' })).toBeTruthy();
  });
});

describe('sourceLinkFor', () => {
  it('points the app at the mobile-v tag and the web at the commit', () => {
    expect(sourceLinkFor({ mobile: true, version: '0.1.0', commit: 'abc' })).toBe(
      `${SOURCE_REPO_URL}/tree/mobile-v0.1.0`,
    );
    expect(sourceLinkFor({ mobile: false, version: '0.0.0', commit: 'abc' })).toBe(
      `${SOURCE_REPO_URL}/tree/abc`,
    );
    expect(sourceLinkFor({ mobile: false, version: '0.0.0', commit: '' })).toBe(SOURCE_REPO_URL);
  });
});

const here = (f: string) => join(process.cwd(), 'src/components/Settings', f);

describe('licence chunk', () => {
  it('is only reachable through a dynamic import (not in the main entry)', () => {
    const about = readFileSync(here('AboutField.tsx'), 'utf8');
    expect(about).not.toMatch(/^import .*LicencesView/m);
    expect(about).toMatch(/import\('\.\/LicencesView'\)/);
    const view = readFileSync(here('LicencesView.tsx'), 'utf8');
    expect(view).toContain('LICENSE?raw');
    expect(readFileSync(here('SettingsPanel.tsx'), 'utf8')).not.toContain('LicencesView');
  });
});
