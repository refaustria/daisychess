// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Clock } from './Clock';
import { formatClock, isLowTime } from './format';

afterEach(cleanup);

describe('formatClock', () => {
  it.each([
    [600_000, '10:00'],
    [598_000, '9:58'],
    [61_999, '1:01'],
    [10_000, '0:10'],
    [9_999, '0:09.9'],
    [9_870, '0:09.8'],
    [50, '0:00.0'],
    [-5, '0:00.0'],
    [3_599_999, '59:59'],
    [3_600_000, '1:00:00'],
    [3_725_000, '1:02:05'],
    [10_800_000, '3:00:00'],
  ])('%i → %s', (ms, text) => expect(formatClock(ms)).toBe(text));
});

describe('isLowTime', () => {
  it('under 20 s, capped at 10 % of the initial time for short games', () => {
    expect(isLowTime(19_999)).toBe(true);
    expect(isLowTime(20_000)).toBe(false);
    expect(isLowTime(19_999, 600_000)).toBe(true);
    expect(isLowTime(25_000, 600_000)).toBe(false);
    expect(isLowTime(7_000, 60_000)).toBe(false); // 1+0: low below 6 s
    expect(isLowTime(5_900, 60_000)).toBe(true);
    expect(isLowTime(14_000, 15_000)).toBe(false);
    expect(isLowTime(1_400, 15_000)).toBe(true);
  });
});

describe('Clock', () => {
  it('renders time, label and timer semantics', () => {
    render(<Clock ms={598_000} side="white" testId="c" />);
    const el = screen.getByTestId('c');
    expect(el.textContent).toBe('9:58');
    expect(el.getAttribute('role')).toBe('timer');
    expect(el.getAttribute('aria-live')).toBe('off');
    expect(el.getAttribute('aria-label')).toBe('White clock 9:58');
    expect(el.getAttribute('data-state')).toBe('idle');
    expect(el.getAttribute('data-active')).toBeNull();
    expect(el.className).not.toMatch(/clockLow|clockRunning|clockActive/);
  });

  it('running: active + pulse; low time coloured', () => {
    render(<Clock ms={8_400} side="black" state="running" initialMs={600_000} testId="c" />);
    const el = screen.getByTestId('c');
    expect(el.textContent).toBe('0:08.4');
    expect(el.getAttribute('aria-label')).toBe('Black clock 0:08.4');
    expect(el.getAttribute('data-active')).toBe('true');
    expect(el.className).toMatch(/clockActive/);
    expect(el.className).toMatch(/clockRunning/);
    expect(el.className).toMatch(/clockLow/);
  });

  it('active without ticking has no pulse; flagged', () => {
    const { rerender } = render(<Clock ms={60_000} side="white" state="active" testId="c" />);
    expect(screen.getByTestId('c').className).toMatch(/clockActive/);
    expect(screen.getByTestId('c').className).not.toMatch(/clockRunning/);
    rerender(<Clock ms={0} side="white" state="flagged" testId="c" />);
    const el = screen.getByTestId('c');
    expect(el.textContent).toBe('0:00.0');
    expect(el.className).toMatch(/clockFlagged/);
    expect(el.getAttribute('data-state')).toBe('flagged');
    expect(el.getAttribute('aria-label')).toBe('White clock 0:00.0 (flagged)');
  });
});
