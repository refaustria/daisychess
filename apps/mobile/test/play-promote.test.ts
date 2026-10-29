import { describe, expect, it } from 'vitest';
import { PlayError, explainPlayError } from '../scripts/play-publish.mjs';
import {
  promoteVersion,
  promoteWithDraftFallback,
  validatePromoteInput,
} from '../scripts/play-promote.mjs';

type Call = { method: string; url: string; body: unknown; auth: string | undefined };

/** Fake Play API; `trackReplies` are consumed per tracks.update call (default 200). */
function fakePlay(trackReplies: { status: number; body: string }[] = [], commitStatus = 200) {
  const calls: Call[] = [];
  let edits = 0;
  const impl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const headers = init.headers as Record<string, string> | undefined;
    calls.push({
      method,
      url,
      body: typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined,
      auth: headers?.authorization,
    });
    if (method === 'POST' && url.endsWith('/edits')) {
      return new Response(JSON.stringify({ id: `e${++edits}` }), { status: 200 });
    }
    if (url.includes('/tracks/')) {
      const r = trackReplies.shift() ?? { status: 200, body: '{}' };
      return new Response(r.body, { status: r.status });
    }
    if (url.endsWith(':commit')) {
      return new Response(commitStatus === 200 ? '{}' : 'commit refused', { status: commitStatus });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const base = {
  accessToken: 'tok',
  packageName: 'org.daisychess.app',
  versionCode: 9,
  track: 'production',
  status: 'completed',
};
const A =
  'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/org.daisychess.app';

describe('validatePromoteInput', () => {
  it('accepts numeric strings and defaults the track to production', () => {
    expect(validatePromoteInput({ packageName: 'org.daisychess.app', versionCode: '9' })).toEqual({
      packageName: 'org.daisychess.app',
      versionCode: 9,
      track: 'production',
    });
  });
  it('rejects bad version codes, packages and tracks', () => {
    for (const vc of ['', '0', '-1', '1.5', '9a', 'abc', undefined]) {
      expect(() =>
        validatePromoteInput({ packageName: 'org.daisychess.app', versionCode: vc }),
      ).toThrow(/version-code/);
    }
    expect(() => validatePromoteInput({ versionCode: '9' })).toThrow(/package/);
    expect(() => validatePromoteInput({ packageName: 'x y', versionCode: '9' })).toThrow(/package/);
    expect(() =>
      validatePromoteInput({ packageName: 'org.daisychess.app', versionCode: '9', track: '../x' }),
    ).toThrow(/track/);
  });
});

describe('promoteVersion', () => {
  it('inserts an edit, updates the track, commits (in order, with auth)', async () => {
    const { impl, calls } = fakePlay();
    const r = await promoteVersion({
      ...base,
      fetchImpl: impl,
      releaseName: '0.1.0 (9)',
      releaseNotes: 'First release.',
    });
    expect(r.editId).toBe('e1');
    expect(calls.map((c) => `${c.method} ${c.url.replace(A, '')}`)).toEqual([
      'POST /edits',
      'PUT /edits/e1/tracks/production',
      'POST /edits/e1:commit',
    ]);
    expect(calls.every((c) => c.auth === 'Bearer tok')).toBe(true);
    expect(calls[1]?.body).toEqual({
      track: 'production',
      releases: [
        {
          name: '0.1.0 (9)',
          versionCodes: ['9'],
          status: 'completed',
          releaseNotes: [{ language: 'en-US', text: 'First release.' }],
        },
      ],
    });
  });
  it('omits name and notes when not given', async () => {
    const { impl, calls } = fakePlay();
    await promoteVersion({ ...base, fetchImpl: impl });
    expect(calls[1]?.body).toEqual({
      track: 'production',
      releases: [{ versionCodes: ['9'], status: 'completed' }],
    });
  });
  it("deletes the edit when the track update fails and keeps Play's body", async () => {
    const { impl, calls } = fakePlay([{ status: 403, body: 'declare your data safety form' }]);
    const err = await promoteVersion({ ...base, fetchImpl: impl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlayError);
    expect(explainPlayError(err)).toContain('declare your data safety form');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(calls.at(-1)?.url).toBe(`${A}/edits/e1`);
  });
  it('deletes the edit when the commit fails', async () => {
    const { impl, calls } = fakePlay([], 400);
    await expect(promoteVersion({ ...base, fetchImpl: impl })).rejects.toBeInstanceOf(PlayError);
    expect(calls.at(-1)?.method).toBe('DELETE');
  });
});

describe('promoteWithDraftFallback', () => {
  const draft = {
    status: 400,
    body: 'Only releases with status draft may be created on draft app.',
  };
  it('retries once as draft in a fresh edit and reports it', async () => {
    const { impl, calls } = fakePlay([draft]);
    const r = await promoteWithDraftFallback({ ...base, fetchImpl: impl });
    expect(r).toMatchObject({ status: 'draft', fellBackToDraft: true, editId: 'e2' });
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[1]?.body).toMatchObject({ releases: [{ status: 'draft' }] });
  });
  it('does not fall back on other errors', async () => {
    const { impl, calls } = fakePlay([{ status: 400, body: 'something else' }]);
    await expect(promoteWithDraftFallback({ ...base, fetchImpl: impl })).rejects.toBeInstanceOf(
      PlayError,
    );
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
  it('does not retry when already draft', async () => {
    const { impl } = fakePlay([draft]);
    await expect(
      promoteWithDraftFallback({ ...base, status: 'draft', fetchImpl: impl }),
    ).rejects.toBeInstanceOf(PlayError);
  });
  it('reports completed without fallback on success', async () => {
    const { impl } = fakePlay();
    expect(await promoteWithDraftFallback({ ...base, fetchImpl: impl })).toMatchObject({
      status: 'completed',
      fellBackToDraft: false,
    });
  });
});
