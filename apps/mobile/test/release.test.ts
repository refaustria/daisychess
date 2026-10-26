import { generateKeyPairSync, verify, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AscError,
  ascJwt,
  ensureAppStoreProfile,
  explainAscError,
  parsePemBundle,
  createAscApi,
} from '../scripts/asc-profile.mjs';
import type { AscRequest } from '../scripts/asc-profile.mjs';
import { exportOptionsPlist, patchManualSigning } from '../scripts/ios-signing.mjs';
import {
  PlayError,
  explainPlayError,
  fetchAccessToken,
  googleAssertion,
  parseServiceAccount,
  publishWithDraftFallback,
} from '../scripts/play-publish.mjs';
import { resolveReleaseVersion } from '../scripts/release-version.mjs';

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

function selfSigned(): { pem: string; cert: X509Certificate } {
  // Node cannot mint certificates: a throw-away self-signed EC certificate (public fixture).
  const pem = readFileSync(new URL('./fixtures/dist-cert.pem', import.meta.url), 'utf8');
  return { pem, cert: new X509Certificate(pem) };
}

describe('ascJwt', () => {
  it('produces an ES256 token App Store Connect accepts (header, claims, raw signature)', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const now = Date.UTC(2026, 9, 26, 12);
    const jwt = ascJwt({ keyId: '67943UW56Q', issuerId: 'iss-uuid', privateKeyPem: pem, now });
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(decode(h)).toEqual({ alg: 'ES256', kid: '67943UW56Q', typ: 'JWT' });
    const claims = decode(p);
    expect(claims).toMatchObject({ iss: 'iss-uuid', aud: 'appstoreconnect-v1' });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(20 * 60);
    const sig = Buffer.from(s, 'base64url');
    expect(sig.length).toBe(64); // r||s, not DER
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        sig,
      ),
    ).toBe(true);
  });
});

type Call = { method: string; path: string; body?: unknown };

function fakeAsc(opts: {
  certDerB64: string;
  profiles?: Array<Record<string, unknown>>;
  bundles?: Array<Record<string, unknown>>;
}) {
  const calls: Call[] = [];
  const api = (async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path.startsWith('/v1/bundleIds')) {
      return {
        data: opts.bundles ?? [
          { id: 'B2', type: 'bundleIds', attributes: { identifier: 'org.daisychess.app.widget' } },
          { id: 'B1', type: 'bundleIds', attributes: { identifier: 'org.daisychess.app' } },
        ],
      };
    }
    if (method === 'GET' && path.startsWith('/v1/certificates')) {
      return {
        data: [
          { id: 'C0', type: 'certificates', attributes: { certificateContent: 'AAAA' } },
          { id: 'C1', type: 'certificates', attributes: { certificateContent: opts.certDerB64 } },
        ],
      };
    }
    if (method === 'GET' && path.startsWith('/v1/profiles')) return { data: opts.profiles ?? [] };
    if (method === 'DELETE') return null;
    if (method === 'POST' && path === '/v1/profiles') {
      return {
        data: {
          id: 'PNEW',
          type: 'profiles',
          attributes: {
            name: 'DaisyChess App Store CI',
            uuid: 'uuid-new',
            expirationDate: '2027-10-26T00:00:00.000+00:00',
            profileContent: Buffer.from('new-profile').toString('base64'),
          },
        },
      };
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as unknown as AscRequest;
  return { api, calls };
}

const NOW = Date.UTC(2026, 9, 26);
const profile = (
  over: Record<string, unknown> = {},
  rel: { cert?: string; bundle?: string } = {},
) => ({
  id: 'P1',
  type: 'profiles',
  attributes: {
    name: 'DaisyChess App Store CI',
    uuid: 'uuid-old',
    profileState: 'ACTIVE',
    expirationDate: '2027-06-01T00:00:00.000+00:00',
    profileContent: Buffer.from('old-profile').toString('base64'),
    ...over,
  },
  relationships: {
    bundleId: { data: { type: 'bundleIds', id: rel.bundle ?? 'B1' } },
    certificates: { data: [{ type: 'certificates', id: rel.cert ?? 'C1' }] },
  },
});

describe('ensureAppStoreProfile', () => {
  const { pem, cert } = selfSigned();
  const certDerB64 = cert.raw.toString('base64');
  const base = {
    bundleIdentifier: 'org.daisychess.app',
    certs: parsePemBundle(pem),
    profileName: 'DaisyChess App Store CI',
    now: NOW,
  };

  it('reuses an active profile with the bundle id and the certificate', async () => {
    const { api, calls } = fakeAsc({ certDerB64, profiles: [profile()] });
    const r = await ensureAppStoreProfile({ api, ...base });
    expect(r.action).toBe('reused');
    expect(r.uuid).toBe('uuid-old');
    expect(r.content.toString()).toBe('old-profile');
    expect(r.identitySha1).toBe(cert.fingerprint.replace(/:/g, ''));
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it.each([
    ['expired soon', profile({ expirationDate: '2026-10-30T00:00:00.000+00:00' })],
    ['invalid after a capability change', profile({ profileState: 'INVALID' })],
    ['another certificate', profile({}, { cert: 'C0' })],
    ['another bundle id', profile({}, { bundle: 'B2' })],
  ])(
    'replaces a stale profile (%s): delete, then create with bundle id + certificate',
    async (_n, p) => {
      const { api, calls } = fakeAsc({ certDerB64, profiles: [p] });
      const r = await ensureAppStoreProfile({ api, ...base });
      expect(r.action).toBe('created');
      expect(r.deleted).toEqual(['P1']);
      expect(r.uuid).toBe('uuid-new');
      const order = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
      expect(order).toEqual(['DELETE /v1/profiles/P1', 'POST /v1/profiles']);
      const post = calls.find((c) => c.method === 'POST')?.body as {
        data: { attributes: unknown; relationships: unknown };
      };
      expect(post.data.attributes).toEqual({
        name: base.profileName,
        profileType: 'IOS_APP_STORE',
      });
      expect(post.data.relationships).toEqual({
        bundleId: { data: { type: 'bundleIds', id: 'B1' } },
        certificates: { data: [{ type: 'certificates', id: 'C1' }] },
      });
    },
  );

  it('creates a profile when none exists', async () => {
    const { api } = fakeAsc({ certDerB64 });
    const r = await ensureAppStoreProfile({ api, ...base });
    expect(r).toMatchObject({ action: 'created', deleted: [], uuid: 'uuid-new' });
  });

  it('ignores a same-prefix profile name', async () => {
    const { api } = fakeAsc({
      certDerB64,
      profiles: [profile({ name: 'DaisyChess App Store CI old' })],
    });
    const r = await ensureAppStoreProfile({ api, ...base });
    expect(r).toMatchObject({ action: 'created', deleted: [] });
  });

  it('fails clearly when the certificate is not registered (revoked)', async () => {
    const { api } = fakeAsc({ certDerB64: 'AAAA' });
    await expect(ensureAppStoreProfile({ api, ...base })).rejects.toThrow(
      /not \(or no longer\) registered/,
    );
  });

  it('fails clearly when the bundle id is not registered (exact match only)', async () => {
    const { api } = fakeAsc({
      certDerB64,
      bundles: [
        { id: 'B2', type: 'bundleIds', attributes: { identifier: 'org.daisychess.app.x' } },
      ],
    });
    await expect(ensureAppStoreProfile({ api, ...base })).rejects.toThrow(
      /not registered in the team/,
    );
  });

  it('rejects an empty PEM', async () => {
    const { api } = fakeAsc({ certDerB64 });
    await expect(ensureAppStoreProfile({ api, ...base, certs: [] })).rejects.toThrow(
      /no certificate/,
    );
  });
});

describe('createAscApi / explainAscError', () => {
  it('sends the bearer token and turns HTTP errors into AscError', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).authorization });
      return new Response('{"errors":[{"status":"403"}]}', { status: 403 });
    }) as unknown as typeof fetch;
    const api = createAscApi({ token: () => 'tok', fetchImpl, base: 'https://x' });
    const err = await api('GET', '/v1/profiles?filter[name]=a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AscError);
    expect(seen).toEqual([{ url: 'https://x/v1/profiles?filter[name]=a', auth: 'Bearer tok' }]);
    expect(explainAscError(err)).toMatch(/IOS_PROVISIONING_PROFILE_B64/);
    expect((err as Error).message).not.toContain('filter'); // no query strings in logs
  });

  it('explains 401 as a key problem', () => {
    expect(explainAscError(new AscError('GET /v1/x: HTTP 401', 401, ''))).toMatch(/ASC_KEY_ID/);
  });
});

describe('patchManualSigning / exportOptionsPlist', () => {
  const pbx = readFileSync(
    new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url),
    'utf8',
  );
  const p = {
    teamId: 'PM7LTV7M72',
    bundleId: 'org.daisychess.app',
    profileName: 'DaisyChess App Store CI',
    identity: '0123456789ABCDEF0123456789ABCDEF01234567',
  };

  it('switches only the App target Release configuration to manual signing', () => {
    const out = patchManualSigning(pbx, p);
    const blocks = out.split(/\n(?=\t\t[0-9A-F]{24} \/\*)/);
    const release = blocks.filter(
      (b) => b.includes('/* Release */ = {') && b.includes('PRODUCT_BUNDLE_IDENTIFIER'),
    );
    expect(release).toHaveLength(1);
    const r = release[0] ?? '';
    expect(r).toContain('CODE_SIGN_STYLE = Manual;');
    expect(r).toContain('DEVELOPMENT_TEAM = PM7LTV7M72;');
    expect(r).toContain('PROVISIONING_PROFILE_SPECIFIER = "DaisyChess App Store CI";');
    expect(r).toContain(`"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "${p.identity}";`);
    expect(r.match(/CODE_SIGN_STYLE/g)).toHaveLength(1);
    // Debug of the target and the project-level configurations are untouched.
    expect(out.match(/CODE_SIGN_STYLE = Automatic;/g)).toHaveLength(1);
    expect(out.match(/CODE_SIGN_IDENTITY = "iPhone Developer";/g)).toHaveLength(2);
    // Idempotent: a second patch yields the same text.
    expect(patchManualSigning(out, p)).toBe(out);
  });

  it('throws when the configuration is missing or ambiguous', () => {
    expect(() => patchManualSigning(pbx, { ...p, bundleId: 'org.other.app' })).toThrow(/found 0/);
    expect(() => patchManualSigning(pbx, { ...p, teamId: 'x' })).toThrow(/team id/);
    expect(() => patchManualSigning(pbx, { ...p, profileName: 'a"b' })).toThrow(/unsupported/);
  });

  it('writes app-store-connect export options with the profile mapping', () => {
    const plist = exportOptionsPlist(p);
    expect(plist).toContain('<string>app-store-connect</string>');
    expect(plist).toContain(
      '<key>org.daisychess.app</key>\n\t\t<string>DaisyChess App Store CI</string>',
    );
    expect(plist).toContain('<string>manual</string>');
    expect(plist).toMatch(/manageAppVersionAndBuildNumber<\/key>\n\t<false\/>/);
  });
});

describe('Google Play publishing', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = parseServiceAccount(
    JSON.stringify({
      type: 'service_account',
      client_email: 'ci@example.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
  );

  it('parses only service account keys', () => {
    expect(() => parseServiceAccount('nope')).toThrow(/not valid JSON/);
    expect(() => parseServiceAccount('{"type":"authorized_user"}')).toThrow(/client_email/);
  });

  it('signs an RS256 assertion for the publisher scope', () => {
    const jwt = googleAssertion({ sa, now: NOW });
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(p)).toMatchObject({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
    });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(
      true,
    );
  });

  it('exchanges the assertion for an access token', async () => {
    let body = '';
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return Response.json({ access_token: 'at', expires_in: 3599 });
    }) as unknown as typeof fetch;
    expect(await fetchAccessToken({ sa, fetchImpl })).toBe('at');
    expect(new URLSearchParams(body).get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
  });

  type Step = { match: RegExp; status?: number; json?: unknown; text?: string };
  function fakePlay(steps: Step[]) {
    const calls: string[] = [];
    const bodies: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const line = `${init.method} ${url.replace(/^https:\/\/androidpublisher\.googleapis\.com/, '')}`;
      calls.push(line);
      bodies.push(typeof init.body === 'string' ? init.body : '');
      const step = steps.shift();
      if (!step || !step.match.test(line)) throw new Error(`unexpected ${line}`);
      return new Response(step.text ?? JSON.stringify(step.json ?? {}), {
        status: step.status ?? 200,
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls, bodies };
  }
  const aab = Buffer.from('fake-aab');
  const req = {
    accessToken: 'at',
    packageName: 'org.daisychess.app',
    aab,
    track: 'internal',
    status: 'completed',
    releaseName: '0.1.0 (42)',
  };
  const happy = (): Step[] => [
    {
      match: /^POST \/androidpublisher\/v3\/applications\/org\.daisychess\.app\/edits$/,
      json: { id: 'E1' },
    },
    {
      match: /^POST \/upload\/.*\/edits\/E1\/bundles\?uploadType=media$/,
      json: { versionCode: 42 },
    },
    { match: /^PUT .*\/edits\/E1\/tracks\/internal$/ },
    { match: /^POST .*\/edits\/E1:commit$/ },
  ];

  it('uploads, assigns the internal track and commits', async () => {
    const { fetchImpl, calls, bodies } = fakePlay(happy());
    const r = await publishWithDraftFallback({ ...req, fetchImpl });
    expect(r).toEqual({ versionCode: 42, editId: 'E1', status: 'completed' });
    expect(calls).toHaveLength(4);
    expect(JSON.parse(bodies[2] ?? '')).toEqual({
      track: 'internal',
      releases: [{ name: '0.1.0 (42)', versionCodes: ['42'], status: 'completed' }],
    });
  });

  it('retries as a draft release while the app is a draft, deleting the failed edit', async () => {
    const steps: Step[] = [
      { match: /edits$/, json: { id: 'E1' } },
      { match: /bundles/, json: { versionCode: 42 } },
      {
        match: /tracks\/internal$/,
        status: 400,
        text: '{"error":{"message":"Only releases with status draft may be created on draft app."}}',
      },
      { match: /^DELETE .*\/edits\/E1$/ },
      ...happy().map((s, i) =>
        i === 0
          ? { ...s, json: { id: 'E2' } }
          : { ...s, match: new RegExp(s.match.source.replace('E1', 'E2')) },
      ),
    ];
    const { fetchImpl, bodies } = fakePlay(steps);
    const r = await publishWithDraftFallback({ ...req, fetchImpl });
    expect(r.status).toBe('draft');
    expect(JSON.parse(bodies[6] ?? '').releases[0].status).toBe('draft');
  });

  it('rejects a bundle whose server-side sha256 differs, and deletes the edit', async () => {
    const { fetchImpl, calls } = fakePlay([
      { match: /edits$/, json: { id: 'E1' } },
      { match: /bundles/, json: { versionCode: 42, sha256: 'ff' } },
      { match: /^DELETE/ },
    ]);
    await expect(publishWithDraftFallback({ ...req, fetchImpl })).rejects.toThrow(/sha256/);
    expect(calls.at(-1)).toMatch(/^DELETE/);
  });

  it('explains the 403 of a package without a first manual upload', async () => {
    const { fetchImpl } = fakePlay([
      { match: /edits$/, status: 403, text: '{"error":{"code":403}}' },
    ]);
    const err = await publishWithDraftFallback({ ...req, fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlayError);
    expect(explainPlayError(err)).toMatch(/manual AAB upload/);
  });
});

describe('resolveReleaseVersion', () => {
  it('accepts a matching tag and uses the run number as build number', () => {
    expect(
      resolveReleaseVersion({ packageVersion: '1.2.3', refName: 'mobile-v1.2.3', runNumber: '57' }),
    ).toEqual({
      version: '1.2.3',
      buildNumber: 57,
    });
    expect(
      resolveReleaseVersion({ packageVersion: '0.1.0', refName: null, runNumber: '1' }).buildNumber,
    ).toBe(1);
  });

  it.each([
    ['1.2.4', 'mobile-v1.2.3', '1', /does not match/],
    ['1.2.3', 'node-v1.2.3', '1', /not a mobile-v/],
    ['1.2.3-rc.1', 'mobile-v1.2.3-rc.1', '1', /not a store version/],
    ['01.2.3', null, '1', /not a store version/],
    ['1.2.3', null, '0', /run number/],
    ['1.2.3', null, 'x', /run number/],
  ])('rejects %s / %s / run %s', (packageVersion, refName, runNumber, re) => {
    expect(() => resolveReleaseVersion({ packageVersion, refName, runNumber })).toThrow(re);
  });
});
