import { describe, expect, it } from 'vitest';
import {
  AnalyzeMessageSchema,
  DEFAULT_LIMITS,
  ENGINE_STYLES,
  EngineDescriptorSchema,
  EngineInfoSchema,
  LimitsSchema,
  PROTOCOL_BOUNDS,
  PROTOCOL_VERSION,
  PolicyEntrySchema,
  checkAnalyzeLimits,
  parseClientMessage,
  parseServerMessage,
  resolveEngineNodes,
  type AnalyzeMessage,
  type EngineDescriptor,
  type Limits,
} from './protocol.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const analyze = (extra: Partial<AnalyzeMessage> = {}): AnalyzeMessage => ({
  type: 'analyze',
  sessionId: 's',
  searchId: 1,
  engine: 'maia-1500',
  fen: FEN,
  ...extra,
});

describe('human-like engines (ADR-019) — additive protocol', () => {
  it('keeps PROTOCOL_VERSION 1 and bounds nodes', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(PROTOCOL_BOUNDS.nodes).toEqual({ min: 1, max: 10_000 });
    expect(DEFAULT_LIMITS.maxNodes).toBe(10_000);
    expect(ENGINE_STYLES).toEqual(['strength', 'human']);
  });

  it('analyze accepts an optional nodes limit within the hard bounds', () => {
    expect(AnalyzeMessageSchema.safeParse(analyze({ nodes: 1 })).success).toBe(true);
    expect(AnalyzeMessageSchema.safeParse(analyze({ nodes: 10_000 })).success).toBe(true);
    expect(AnalyzeMessageSchema.safeParse(analyze({ nodes: 0 })).success).toBe(false);
    expect(AnalyzeMessageSchema.safeParse(analyze({ nodes: 10_001 })).success).toBe(false);
    expect(AnalyzeMessageSchema.safeParse(analyze({ nodes: 1.5 })).success).toBe(false);
    const parsed = parseClientMessage(JSON.stringify(analyze({ nodes: 7 })));
    expect(parsed.ok && parsed.message).toMatchObject({ type: 'analyze', nodes: 7 });
  });

  it('limits: maxNodes is optional (older servers) and bounded', () => {
    const { maxNodes: _omit, ...legacy } = DEFAULT_LIMITS;
    void _omit;
    expect(LimitsSchema.safeParse(legacy).success).toBe(true);
    expect(LimitsSchema.safeParse(DEFAULT_LIMITS).success).toBe(true);
    expect(LimitsSchema.safeParse({ ...DEFAULT_LIMITS, maxNodes: 0 }).success).toBe(false);
    expect(LimitsSchema.safeParse({ ...DEFAULT_LIMITS, maxNodes: 20_000 }).success).toBe(false);
  });

  it('checkAnalyzeLimits: nodes against maxNodes; unsupported on servers without it', () => {
    expect(checkAnalyzeLimits(analyze({ nodes: 10 }), DEFAULT_LIMITS)).toBeNull();
    expect(checkAnalyzeLimits(analyze(), DEFAULT_LIMITS)).toBeNull();
    expect(checkAnalyzeLimits(analyze({ nodes: 500 }), { ...DEFAULT_LIMITS, maxNodes: 100 })).toBe(
      'nodes 500 exceeds the server limit of 100',
    );
    const legacy: Limits = { ...DEFAULT_LIMITS };
    delete legacy.maxNodes;
    expect(checkAnalyzeLimits(analyze({ nodes: 1 }), legacy)).toBe(
      'nodes is not supported by this server',
    );
    expect(checkAnalyzeLimits(analyze(), legacy)).toBeNull();
  });

  it('resolveEngineNodes: a capped engine runs its cap by default and rejects more', () => {
    const maia: Pick<EngineDescriptor, 'id' | 'maxNodes'> = { id: 'maia-1500', maxNodes: 1 };
    expect(resolveEngineNodes({}, maia)).toEqual({ ok: true, nodes: 1 });
    expect(resolveEngineNodes({ nodes: 1 }, maia)).toEqual({ ok: true, nodes: 1 });
    expect(resolveEngineNodes({ nodes: 2 }, maia)).toEqual({
      ok: false,
      message: 'nodes 2 exceeds the limit of 1 for engine "maia-1500"',
    });
    const sf = { id: 'stockfish' };
    expect(resolveEngineNodes({}, sf)).toEqual({ ok: true, nodes: undefined });
    expect(resolveEngineNodes({ nodes: 5_000 }, sf)).toEqual({ ok: true, nodes: 5_000 });
  });

  it('engine descriptors carry optional style, rating and maxNodes', () => {
    const base = {
      id: 'maia-1500',
      name: 'Maia 1500',
      enabled: true,
      defaults: { threads: 1, hash: 16 },
    };
    expect(EngineDescriptorSchema.safeParse(base).success).toBe(true);
    const human = { ...base, style: 'human', rating: 1500, maxNodes: 1 };
    const parsed = EngineDescriptorSchema.safeParse(human);
    expect(parsed.success && parsed.data).toEqual(human);
    expect(EngineDescriptorSchema.safeParse({ ...base, style: 'cheeky' }).success).toBe(false);
    expect(EngineDescriptorSchema.safeParse({ ...base, rating: 50 }).success).toBe(false);
    expect(EngineDescriptorSchema.safeParse({ ...base, maxNodes: 0 }).success).toBe(false);
    const welcome = parseServerMessage({
      type: 'welcome',
      protocolVersion: 1,
      serverVersion: 'x',
      limits: DEFAULT_LIMITS,
      engines: [human],
    });
    expect(welcome.ok && welcome.message.type === 'welcome' && welcome.message.engines[0]).toEqual(
      human,
    );
  });

  it('info.policy: up to 10 entries of valid moves with p in 0…1', () => {
    const info = { depth: 1, multipv: 1, score: { cp: 99 }, pv: ['e2e4'] };
    expect(EngineInfoSchema.safeParse(info).success).toBe(true);
    const policy = [
      { uci: 'e2e4', p: 0.5022 },
      { uci: 'd2d4', p: 0.2334 },
    ];
    const ok = EngineInfoSchema.safeParse({ ...info, policy });
    expect(ok.success && ok.data.policy).toEqual(policy);
    expect(PolicyEntrySchema.safeParse({ uci: 'e2e4', p: 1 }).success).toBe(true);
    expect(PolicyEntrySchema.safeParse({ uci: 'e2e4', p: 1.01 }).success).toBe(false);
    expect(PolicyEntrySchema.safeParse({ uci: 'e2e4', p: -0.1 }).success).toBe(false);
    expect(PolicyEntrySchema.safeParse({ uci: 'node', p: 0.5 }).success).toBe(false);
    const tooMany = Array.from({ length: 11 }, (_, i) => ({ uci: 'e2e4', p: i / 11 }));
    expect(EngineInfoSchema.safeParse({ ...info, policy: tooMany }).success).toBe(false);
    const msg = parseServerMessage({
      type: 'info',
      sessionId: 's',
      searchId: 1,
      info: { ...info, policy },
    });
    expect(msg.ok && msg.message.type === 'info' && msg.message.info.policy).toEqual(policy);
  });
});
