import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('GET /health', () => {
  it('returns ok and version', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: '0.0.0' });
    await app.close();
  });
});
