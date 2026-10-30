import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Runs the Python unittest for deploy/stats/visitors.py (traffic-stats visitor classifier); skipped
// when python3 is not installed. Manual: python3 deploy/stats/test_visitors.py
const script = resolve(__dirname, '../../../../deploy/stats/test_visitors.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;

describe('deploy/stats visitor classifier', () => {
  it.skipIf(!hasPython)('python unittest passes', () => {
    const r = spawnSync('python3', ['-I', script], { encoding: 'utf8' });
    expect(r.stderr + r.stdout).toContain('OK');
    expect(r.status).toBe(0);
  });
});
