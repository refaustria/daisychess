import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_DENIED_REASONS,
  DEFAULT_LIMITS,
  PROTOCOL_VERSION,
  WelcomeMessageSchema,
  WelcomeNodeSchema,
  parseServerMessage,
  type WelcomeMessage,
} from './index.js';

/** Today's `welcome` of a standalone server (ADR-006/013/017): must keep parsing unchanged. */
const TODAY: WelcomeMessage = {
  type: 'welcome',
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: '0.0.0',
  limits: { ...DEFAULT_LIMITS },
  engines: [
    { id: 'stockfish', name: 'Stockfish 19', enabled: true, defaults: { threads: 4, hash: 256 } },
  ],
  capabilities: { analysis: true, rooms: true, reviewStore: true },
};

describe('welcome (ADR-020 additive fields)', () => {
  it('still accepts today’s welcome, with node and analysisDenied absent', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    const r = parseServerMessage(JSON.stringify(TODAY));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.message).toEqual(TODAY);
    expect((r.message as WelcomeMessage).node).toBeUndefined();
    expect((r.message as WelcomeMessage).analysisDenied).toBeUndefined();
  });

  it('carries welcome.node for a routed connection', () => {
    const msg = { ...TODAY, node: { name: 'fast-box', operator: 'bojan', shared: true } };
    const r = parseServerMessage(JSON.stringify(msg));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.message).toEqual(msg);
    // The built-in node has no operator.
    expect(WelcomeNodeSchema.safeParse({ name: 'local', shared: false }).success).toBe(true);
  });

  it('rejects malformed welcome.node', () => {
    expect(WelcomeNodeSchema.safeParse({ name: '', shared: false }).success).toBe(false);
    expect(WelcomeNodeSchema.safeParse({ name: 'x'.repeat(33), shared: false }).success).toBe(
      false,
    );
    expect(WelcomeNodeSchema.safeParse({ name: 'fast-box' }).success).toBe(false);
    expect(
      WelcomeNodeSchema.safeParse({ name: 'fast-box', operator: '', shared: true }).success,
    ).toBe(false);
  });

  it('carries analysisDenied with every reason of the catalogue', () => {
    expect(ANALYSIS_DENIED_REASONS).toEqual([
      'no_token',
      'bad_token',
      'expired',
      'revoked',
      'node_offline',
      'no_capacity',
      'budget_exhausted',
    ]);
    for (const reason of ANALYSIS_DENIED_REASONS) {
      const msg = {
        ...TODAY,
        engines: [],
        capabilities: { analysis: false, rooms: true, reviewStore: true },
        analysisDenied: reason,
      };
      const r = parseServerMessage(msg);
      expect(r.ok, reason).toBe(true);
      if (r.ok) expect((r.message as WelcomeMessage).analysisDenied).toBe(reason);
    }
    const bad = WelcomeMessageSchema.safeParse({ ...TODAY, analysisDenied: 'maintenance' });
    expect(bad.success).toBe(false);
  });
});
