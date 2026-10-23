// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders title and a formatted score from engine-core', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'ChessLab' })).toBeTruthy();
    expect(screen.getByTestId('score').textContent).toBe('+0.35');
  });
});
