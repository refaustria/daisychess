// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LICENSE_NAME, SOURCE_REPO_URL } from '../../appInfo';
import { AboutField } from './AboutField';
import { SettingsPanel } from './SettingsPanel';

afterEach(cleanup);

describe('AboutField', () => {
  it('links to the source repository and names the licence', () => {
    render(<AboutField />);
    const link = screen.getByRole('link', { name: 'Source code' });
    expect(link.getAttribute('href')).toBe(SOURCE_REPO_URL);
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('link', { name: LICENSE_NAME })).toBeTruthy();
  });

  it('is part of the Settings panel', () => {
    render(<SettingsPanel />);
    expect(screen.getByRole('link', { name: 'Source code' })).toBeTruthy();
  });
});
