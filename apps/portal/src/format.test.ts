import { describe, expect, it } from 'vitest';
import { composeSnippet, formatAgo, formatDuration, lastDays, npxSnippet } from './format';

describe('format', () => {
  const now = Date.UTC(2026, 9, 25, 12);
  it('formats relative times', () => {
    expect(formatAgo(null, now)).toBe('never');
    expect(formatAgo(now - 1000, now)).toBe('just now');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(formatAgo(now - 2 * 86_400_000, now)).toBe('2 d ago');
  });
  it('formats durations', () => {
    expect(formatDuration(5000)).toBe('5 s');
    expect(formatDuration(90_000)).toBe('1 min 30 s');
    expect(formatDuration(3_900_000)).toBe('1 h 5 min');
  });
  it('lists the last UTC days oldest first', () => {
    const d = lastDays(3, now);
    expect(d).toEqual(['2026-10-23', '2026-10-24', '2026-10-25']);
  });
  it('fills the token into the snippets', () => {
    expect(composeSnippet('wss://h/link', 'dcn_a_b', true)).toContain('NODE_POOL: "on"');
    expect(npxSnippet('wss://h/link', 'dcn_a_b', false)).toBe('HUB_URL=wss://h/link NODE_TOKEN=dcn_a_b POOL=off npx -y @daisychess/node');
  });
});
