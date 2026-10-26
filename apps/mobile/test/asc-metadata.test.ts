import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AscError } from '../scripts/asc-profile.mjs';
import {
  STATIC_OWNER_STEPS,
  diffAttributes,
  ensureVersion,
  explainMetadataError,
  loadDesired,
  loadScreenshotSet,
  markdownBlockAfter,
  md5,
  parseArgs,
  renderReviewNotes,
  syncAppStore,
  unwrapParagraphs,
} from '../scripts/asc-metadata.mjs';
import { encodePng } from '../scripts/png.mjs';

type Ref = { id: string; type: string };
type Res = {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: Ref | Ref[] | null }>;
};
type Call = { method: string; path: string; body?: unknown };
type Body = {
  data: {
    type: string;
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, { data: Ref | Ref[] }>;
  };
  included?: Res[];
};

const tmp = mkdtempSync(path.join(tmpdir(), 'asc-metadata-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function pngFile(dir: string, name: string, width: number, height: number, shade: number) {
  mkdirSync(dir, { recursive: true });
  const data = Buffer.alloc(width * height * 3, shade);
  writeFileSync(path.join(dir, name), encodePng({ width, height, channels: 3, data }));
}

// Two tiny screenshot sets (sizes are configurable, so 4x8 stands in for 1320x2868).
pngFile(path.join(tmp, 'shots/phone'), '01-a.png', 4, 8, 10);
pngFile(path.join(tmp, 'shots/phone'), '02-b.png', 4, 8, 20);
pngFile(path.join(tmp, 'shots/pad'), '01-a.png', 6, 8, 30);
const phoneSet = loadScreenshotSet(tmp, {
  displayType: 'APP_IPHONE_67',
  dir: 'shots/phone',
  sizes: ['4x8'],
});
const padSet = loadScreenshotSet(tmp, {
  displayType: 'APP_IPAD_PRO_3GEN_129',
  dir: 'shots/pad',
  sizes: ['6x8'],
});

function desired(
  env: Record<string, string> = { REVIEW_TOKEN: 'tok-secret-1', REVIEW_CONTACT_PHONE: '+43 1 234' },
) {
  return {
    ...loadDesired({ version: '0.1.1', env, withScreenshots: false }),
    screenshots: [phoneSet, padSet],
  };
}

const AGE_KEYS = [
  'alcoholTobaccoOrDrugUseOrReferences',
  'contests',
  'gamblingSimulated',
  'gunsOrOtherWeapons',
  'medicalOrTreatmentInformation',
  'profanityOrCrudeHumor',
  'sexualContentGraphicAndNudity',
  'sexualContentOrNudity',
  'horrorOrFearThemes',
  'matureOrSuggestiveThemes',
  'violenceCartoonOrFantasy',
  'violenceRealisticProlongedGraphicOrSadistic',
  'violenceRealistic',
  'advertising',
  'ageAssurance',
  'gambling',
  'healthOrWellnessTopics',
  'lootBox',
  'messagingAndChat',
  'parentalControls',
  'socialMedia',
  'unrestrictedWebAccess',
  'userGeneratedContent',
  'kidsAgeBand',
  'ageRatingOverrideV2',
];

/** In-memory App Store Connect with just enough behaviour for the metadata flow. */
function fakeAsc(
  opts: { versions?: Res[]; forbid?: RegExp; failDelivery?: boolean; extraAgeKey?: string } = {},
) {
  const calls: Call[] = [];
  const uploads: { method: string; url: string; headers: Record<string, string>; bytes: number }[] =
    [];
  let seq = 0;
  const nid = (p: string) => `${p}${++seq}`;
  const st = {
    app: {
      id: 'A1',
      type: 'apps',
      attributes: {
        bundleId: 'org.daisychess.app',
        name: 'DaisyChess',
        contentRightsDeclaration: null,
      },
    } as Res,
    versions: opts.versions ?? [
      {
        id: 'V1',
        type: 'appStoreVersions',
        attributes: {
          versionString: '1.0',
          appVersionState: 'PREPARE_FOR_SUBMISSION',
          copyright: null,
        },
      },
    ],
    versionLocs: [] as Res[],
    appInfos: [
      {
        id: 'I0',
        type: 'appInfos',
        attributes: { state: 'READY_FOR_DISTRIBUTION' },
        relationships: {},
      },
      {
        id: 'I1',
        type: 'appInfos',
        attributes: { state: 'PREPARE_FOR_SUBMISSION' },
        relationships: { primaryCategory: { data: null } },
      },
    ] as Res[],
    infoLocs: [
      {
        id: 'IL1',
        type: 'appInfoLocalizations',
        attributes: { locale: 'en-US', name: 'DaisyChess', subtitle: null, privacyPolicyUrl: null },
      },
    ] as Res[],
    age: {
      id: 'AR1',
      type: 'ageRatingDeclarations',
      attributes: Object.fromEntries(
        [...AGE_KEYS, ...(opts.extraAgeKey ? [opts.extraAgeKey] : [])].map((k) => [k, null]),
      ),
    } as Res,
    review: null as Res | null,
    eula: null as Res | null,
    eulaTerritories: [] as string[],
    priceSchedule: null as Res | null,
    prices: [] as Res[],
    availability: null as Res | null,
    territoryAvail: [] as Res[],
    sets: [] as Res[],
    shots: new Map<string, Res[]>(),
    builds: [
      {
        id: 'B7',
        type: 'builds',
        attributes: { version: '7', usesNonExemptEncryption: null, processingState: 'VALID' },
      },
    ] as Res[],
    buildRel: null as string | null,
    submissions: [] as Res[],
    items: [] as Res[],
  };
  const territories = ['AUT', 'CHN', 'DEU', 'USA'];
  const one = (r: Res | null | undefined) => {
    if (!r) throw new AscError('GET: HTTP 404', 404, '{"errors":[{"code":"NOT_FOUND"}]}');
    return { data: r };
  };

  const api = async (method: string, p: string, raw?: unknown) => {
    calls.push({ method, path: p, body: raw });
    const body = raw as Body | undefined;
    if (opts.forbid?.test(`${method} ${p}`))
      throw new AscError(`${method} ${p}: HTTP 403`, 403, '{}');
    const u = new URL(`https://x${p}`);
    const pp = u.pathname;
    let m: RegExpMatchArray | null;
    if (method === 'GET') {
      if (pp === '/v1/apps') return { data: [st.app] };
      if (pp === '/v1/apps/A1/appStoreVersions') return { data: st.versions };
      if ((m = pp.match(/^\/v1\/appStoreVersions\/(\w+)\/appStoreVersionLocalizations$/)))
        return { data: st.versionLocs };
      if (pp === '/v1/apps/A1/appInfos') return { data: st.appInfos };
      if (pp === '/v1/appInfos/I1/appInfoLocalizations') return { data: st.infoLocs };
      if (pp === '/v1/appInfos/I1/ageRatingDeclaration') return { data: st.age };
      if ((m = pp.match(/^\/v1\/appStoreVersions\/\w+\/appStoreReviewDetail$/)))
        return { data: st.review };
      if (pp === '/v1/territories') {
        // Two pages, to exercise links.next.
        if (u.searchParams.get('cursor'))
          return { data: territories.slice(2).map((id) => ({ id, type: 'territories' })) };
        return {
          data: territories.slice(0, 2).map((id) => ({ id, type: 'territories' })),
          links: {
            next: 'https://api.appstoreconnect.apple.com/v1/territories?limit=200&cursor=2',
          },
        };
      }
      if (pp === '/v1/apps/A1/endUserLicenseAgreement') return one(st.eula);
      if ((m = pp.match(/^\/v1\/endUserLicenseAgreements\/\w+\/territories$/))) {
        return { data: st.eulaTerritories.map((id) => ({ id, type: 'territories' })) };
      }
      // Like the real API: a placeholder schedule (id = app id) whose prices answer 404.
      if (pp === '/v1/apps/A1/appPriceSchedule')
        return { data: st.priceSchedule ?? { id: 'A1', type: 'appPriceSchedules' } };
      if (pp === '/v1/appPriceSchedules/A1/manualPrices') return one(null);
      if ((m = pp.match(/^\/v1\/appPriceSchedules\/\w+\/manualPrices$/))) {
        return {
          data: st.prices,
          included: [{ id: 'PP0', type: 'appPricePoints', attributes: { customerPrice: '0.0' } }],
        };
      }
      if (pp === '/v1/apps/A1/appPricePoints') {
        return {
          data: [
            { id: 'PP1', type: 'appPricePoints', attributes: { customerPrice: '0.99' } },
            { id: 'PP0', type: 'appPricePoints', attributes: { customerPrice: '0.0' } },
          ],
        };
      }
      if (pp === '/v1/apps/A1/appAvailabilityV2') return one(st.availability);
      if ((m = pp.match(/^\/v2\/appAvailabilities\/\w+\/territoryAvailabilities$/)))
        return { data: st.territoryAvail };
      if ((m = pp.match(/^\/v1\/appStoreVersionLocalizations\/\w+\/appScreenshotSets$/)))
        return { data: st.sets };
      if ((m = pp.match(/^\/v1\/appScreenshotSets\/(\w+)\/appScreenshots$/)))
        return { data: st.shots.get(m[1] ?? '') ?? [] };
      if ((m = pp.match(/^\/v1\/appScreenshots\/(\w+)$/))) {
        const shot = [...st.shots.values()].flat().find((s) => s.id === m?.[1]);
        return one(shot);
      }
      if (pp === '/v1/builds') {
        expect(u.searchParams.get('filter[preReleaseVersion.version]')).toBe('0.1.1');
        expect(u.searchParams.get('filter[processingState]')).toBe('VALID');
        return { data: st.builds };
      }
      if ((m = pp.match(/^\/v1\/appStoreVersions\/\w+\/relationships\/build$/))) {
        return { data: st.buildRel ? { id: st.buildRel, type: 'builds' } : null };
      }
      if (pp === '/v1/reviewSubmissions') return { data: st.submissions };
      if ((m = pp.match(/^\/v1\/reviewSubmissions\/\w+\/items$/))) return { data: st.items };
    }
    const attrs = body?.data.attributes ?? {};
    const patch = (r: Res) => {
      r.attributes = { ...r.attributes, ...attrs };
      return { data: r };
    };
    if (method === 'PATCH') {
      if ((m = pp.match(/^\/v1\/appStoreVersions\/(\w+)$/)))
        return patch(st.versions.find((v) => v.id === m?.[1]) as Res);
      if ((m = pp.match(/^\/v1\/appStoreVersionLocalizations\/(\w+)$/)))
        return patch(st.versionLocs.find((v) => v.id === m?.[1]) as Res);
      if ((m = pp.match(/^\/v1\/appInfoLocalizations\/(\w+)$/)))
        return patch(st.infoLocs.find((v) => v.id === m?.[1]) as Res);
      if (pp === '/v1/apps/A1') return patch(st.app);
      if (pp === '/v1/appInfos/I1') {
        const info = st.appInfos[1] as Res;
        for (const [k, v] of Object.entries(body?.data.relationships ?? {})) {
          info.relationships = { ...info.relationships, [k]: { data: v.data } };
        }
        return { data: info };
      }
      if (pp === '/v1/ageRatingDeclarations/AR1') return patch(st.age);
      if ((m = pp.match(/^\/v1\/appStoreReviewDetails\/\w+$/))) return patch(st.review as Res);
      if ((m = pp.match(/^\/v1\/endUserLicenseAgreements\/\w+$/))) return patch(st.eula as Res);
      if ((m = pp.match(/^\/v1\/territoryAvailabilities\/(\w+)$/)))
        return patch(st.territoryAvail.find((t) => t.id === m?.[1]) as Res);
      if ((m = pp.match(/^\/v1\/appScreenshots\/(\w+)$/))) {
        const shot = [...st.shots.values()].flat().find((s) => s.id === m?.[1]) as Res;
        patch(shot);
        shot.attributes = {
          ...shot.attributes,
          assetDeliveryState: opts.failDelivery
            ? {
                state: 'FAILED',
                errors: [{ code: 'IMAGE_INCORRECT_DIMENSIONS', description: 'bad size' }],
              }
            : { state: 'COMPLETE' },
        };
        return { data: shot };
      }
      if ((m = pp.match(/^\/v1\/builds\/(\w+)$/))) return patch(st.builds[0] as Res);
      if ((m = pp.match(/^\/v1\/appStoreVersions\/\w+\/relationships\/build$/))) {
        st.buildRel = (body?.data as Ref).id;
        return null;
      }
      if ((m = pp.match(/^\/v1\/reviewSubmissions\/(\w+)$/))) {
        const s = st.submissions.find((x) => x.id === m?.[1]) as Res;
        s.attributes = { ...s.attributes, state: 'WAITING_FOR_REVIEW' };
        return { data: s };
      }
    }
    if (method === 'POST') {
      const created: Res = { id: '', type: body?.data.type ?? '', attributes: { ...attrs } };
      if (pp === '/v1/appStoreVersions') {
        created.id = nid('V');
        created.attributes = { ...attrs, appVersionState: 'PREPARE_FOR_SUBMISSION' };
        st.versions.push(created);
      } else if (pp === '/v1/appStoreVersionLocalizations') {
        created.id = nid('VL');
        st.versionLocs.push(created);
      } else if (pp === '/v1/appInfoLocalizations') {
        created.id = nid('IL');
        st.infoLocs.push(created);
      } else if (pp === '/v1/appStoreReviewDetails') {
        if (!attrs.contactPhone)
          throw new AscError(
            'POST: HTTP 409',
            409,
            '{"errors":[{"code":"ENTITY_ERROR.ATTRIBUTE.REQUIRED"}]}',
          );
        created.id = nid('RD');
        st.review = created;
      } else if (pp === '/v1/endUserLicenseAgreements') {
        created.id = nid('E');
        st.eula = created;
        st.eulaTerritories = ((body?.data.relationships?.territories?.data ?? []) as Ref[]).map(
          (t) => t.id,
        );
      } else if (pp === '/v1/appPriceSchedules') {
        created.id = nid('PS');
        st.priceSchedule = created;
        st.prices = [
          {
            id: 'P1',
            type: 'appPrices',
            attributes: {},
            relationships: { appPricePoint: { data: { id: 'PP0', type: 'appPricePoints' } } },
          },
        ];
      } else if (pp === '/v2/appAvailabilities') {
        created.id = nid('AV');
        st.availability = created;
        st.territoryAvail = (body?.included ?? []).map((t, i) => ({
          id: `TA${i}`,
          type: 'territoryAvailabilities',
          attributes: t.attributes,
          relationships: t.relationships,
        }));
      } else if (pp === '/v1/appScreenshotSets') {
        created.id = nid('SS');
        st.sets.push(created);
        st.shots.set(created.id, []);
      } else if (pp === '/v1/appScreenshots') {
        created.id = nid('SH');
        const setId = (body?.data.relationships?.appScreenshotSet?.data as Ref).id;
        created.attributes = {
          ...attrs,
          assetDeliveryState: { state: 'AWAITING_UPLOAD' },
          uploadOperations: [
            {
              method: 'PUT',
              url: `https://upload.example/${created.id}/0`,
              offset: 0,
              length: 10,
              requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
            },
            {
              method: 'PUT',
              url: `https://upload.example/${created.id}/1`,
              offset: 10,
              length: Number(attrs.fileSize) - 10,
              requestHeaders: [],
            },
          ],
        };
        st.shots.get(setId)?.push(created);
      } else if (pp === '/v1/reviewSubmissions') {
        created.id = nid('RS');
        created.attributes = { state: 'READY_FOR_REVIEW' };
        st.submissions.push(created);
      } else if (pp === '/v1/reviewSubmissionItems') {
        created.id = nid('RI');
        created.relationships = {
          appStoreVersion: { data: body?.data.relationships?.appStoreVersion?.data as Ref },
        };
        st.items.push(created);
      } else throw new Error(`unexpected POST ${pp}`);
      return { data: created };
    }
    if (method === 'DELETE') {
      if ((m = pp.match(/^\/v1\/appScreenshots\/(\w+)$/))) {
        for (const [k, v] of st.shots)
          st.shots.set(
            k,
            v.filter((s) => s.id !== m?.[1]),
          );
        return null;
      }
    }
    throw new Error(`unexpected ${method} ${p}`);
  };
  const upload = async (r: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: Buffer;
  }) => {
    uploads.push({ method: r.method, url: r.url, headers: r.headers, bytes: r.body.length });
  };
  return { api, calls, uploads, st, upload };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');
const quiet = { log: () => {}, sleep: async () => {} };

describe('asc-metadata pure helpers', () => {
  it('diffAttributes treats null, undefined and empty strings as equal', () => {
    expect(
      diffAttributes({ a: null, b: 'x', c: 1 }, { a: '', b: 'x', c: 2, d: undefined }),
    ).toEqual({ c: 2 });
    expect(diffAttributes(undefined, { a: false })).toEqual({ a: false });
    expect(diffAttributes({ a: null }, { a: false })).toEqual({ a: false });
  });

  it('markdownBlockAfter takes the fenced block after a heading prefix', () => {
    const md =
      '# T\n\n## Notes (paste)\n\nintro\n\n```\nline 1\nline 2\n```\n\n## Other\n```\nno\n```\n';
    expect(markdownBlockAfter(md, 'Notes')).toBe('line 1\nline 2');
    expect(() => markdownBlockAfter(md, 'Missing')).toThrow(/not found/);
  });

  it('unwrapParagraphs joins hard-wrapped lines and keeps indented lines', () => {
    expect(unwrapParagraphs('one\ntwo\n\n    TOKEN\n\nthree\n  four')).toBe(
      'one two\n\nTOKEN\n\nthree four',
    );
  });

  it('renderReviewNotes fills token and version and enforces the 4000-character limit', () => {
    const t =
      'Token:\n\n    <REVIEW_TOKEN>\n\nLink https://x/#t=<REVIEW_TOKEN> tag\nmobile-v<VERSION>.';
    expect(renderReviewNotes(t, { token: 'abc', version: '1.2.3' })).toBe(
      'Token:\n\nabc\n\nLink https://x/#t=abc tag mobile-v1.2.3.',
    );
    expect(() => renderReviewNotes(t, { token: '', version: '1' })).toThrow(/empty/);
    expect(() => renderReviewNotes('x'.repeat(4001), { token: 'a', version: '1' })).toThrow(/4000/);
  });

  it('loadScreenshotSet sorts files, hashes them and rejects wrong sizes', () => {
    expect(phoneSet.files.map((f) => f.name)).toEqual(['01-a.png', '02-b.png']);
    expect(phoneSet.files[0]?.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(md5(Buffer.from('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(() =>
      loadScreenshotSet(tmp, { displayType: 'APP_IPHONE_67', dir: 'shots/pad', sizes: ['4x8'] }),
    ).toThrow(/6x8 is not a valid APP_IPHONE_67 size/);
    mkdirSync(path.join(tmp, 'empty'));
    expect(() => loadScreenshotSet(tmp, { displayType: 'X', dir: 'empty', sizes: [] })).toThrow(
      /no PNG/,
    );
  });

  it('loadDesired reads the repo listing, checklist and screenshots', () => {
    const d = loadDesired({
      version: '0.1.1',
      env: { REVIEW_TOKEN: 'tok', REVIEW_CONTACT_PHONE: '+43 1 234' },
    });
    expect(d.bundleId).toBe('org.daisychess.app');
    expect(d.appInfoLocalization).toMatchObject({
      name: 'DaisyChess',
      privacyPolicyUrl: 'https://daisychess.org/privacy/',
    });
    expect(d.versionLocalization.supportUrl).toBe('https://daisychess.org/support/');
    expect(d.versionLocalization.keywords?.length).toBeLessThanOrEqual(100);
    expect(d.review.notes).toContain('\ntok\n');
    expect(d.review.notes).toContain('mobile-v0.1.1');
    expect(d.review.notes).not.toMatch(/<REVIEW_TOKEN>|<VERSION>/);
    expect(d.review).toMatchObject({
      contactPhone: '+43 1 234',
      contactEmail: 'hello@daisychess.org',
      demoAccountRequired: false,
    });
    expect(d.eula).toMatch(/^DaisyChess is free software\. It is licensed/);
    expect(d.eula).not.toContain('```');
    expect(d.categories.primaryCategory).toBe('GAMES');
    expect(d.screenshots.map((s) => [s.displayType, s.files.length])).toEqual([
      ['APP_IPHONE_67', 6],
      ['APP_IPAD_PRO_3GEN_129', 6],
    ]);
    expect(() =>
      loadDesired({ version: '0.1.1', env: { REVIEW_CONTACT_PHONE: '0664 123' } }),
    ).toThrow(/country code/);
    const bare = loadDesired({ version: '0.1.1', env: {}, withScreenshots: false });
    expect(bare.review.notes).toBeUndefined();
    expect(bare.review.contactPhone).toBeUndefined();
    expect(bare.reviewToken).toBeUndefined();
    expect(bare.screenshots).toEqual([]);
  });

  it('parseArgs and explainMetadataError', () => {
    expect(parseArgs(['--dry-run', '--version', '1.2.3'])).toEqual({
      dryRun: true,
      submit: false,
      screenshots: true,
      version: '1.2.3',
    });
    expect(() => parseArgs(['--dry-run', '--submit'])).toThrow(/exclude/);
    expect(() => parseArgs(['--bogus'])).toThrow(/bad argument/);
    const e = new AscError(
      'PATCH /v1/x: HTTP 409',
      409,
      JSON.stringify({
        errors: [
          {
            code: 'ENTITY_ERROR.ATTRIBUTE.INVALID',
            detail: 'bad',
            source: { pointer: '/data/attributes/x' },
          },
        ],
      }),
    );
    expect(explainMetadataError(e)).toBe(
      'PATCH /v1/x: HTTP 409\n  ENTITY_ERROR.ATTRIBUTE.INVALID: bad (/data/attributes/x)',
    );
    expect(explainMetadataError(new AscError('GET /v1/y: HTTP 403', 403, 'nope'))).toMatch(
      /role.*\n {2}nope/,
    );
  });
});

describe('ensureVersion', () => {
  // The fake implements only the routes the steps use; its signature matches the script's Api.
  const ctxFor = (api: ReturnType<typeof fakeAsc>['api']) => ({
    api,
    dryRun: false,
    upload: async () => {},
    sleep: async () => {},
    log: () => {},
    entries: [],
    ownerSteps: [],
    secrets: [],
    pollTimeoutMs: 1000,
    seq: 0,
  });
  const v = (id: string, versionString: string, appVersionState: string) => ({
    id,
    type: 'appStoreVersions',
    attributes: { versionString, appVersionState, copyright: 'c' },
  });

  it('renames the editable placeholder version instead of creating a second one', async () => {
    const f = fakeAsc({ versions: [v('V1', '1.0', 'PREPARE_FOR_SUBMISSION')] });
    const r = await ensureVersion(ctxFor(f.api), 'A1', { versionString: '0.1.1', copyright: 'c' });
    expect(r).toMatchObject({ id: 'V1', action: 'renamed' });
    expect(f.st.versions[0]?.attributes?.versionString).toBe('0.1.1');
  });

  it('creates a version when the only other one is live, reuses an existing one', async () => {
    const f = fakeAsc({ versions: [v('V0', '0.1.0', 'READY_FOR_DISTRIBUTION')] });
    const r = await ensureVersion(ctxFor(f.api), 'A1', { versionString: '0.1.1', copyright: 'c' });
    expect(r.action).toBe('created');
    expect(f.st.versions).toHaveLength(2);
    const again = await ensureVersion(ctxFor(f.api), 'A1', {
      versionString: '0.1.1',
      copyright: 'c',
    });
    expect(again).toMatchObject({ id: r.id, action: 'existing' });
  });

  it('refuses a version that is already submitted or live', async () => {
    const f = fakeAsc({ versions: [v('V1', '0.1.1', 'WAITING_FOR_REVIEW')] });
    await expect(
      ensureVersion(ctxFor(f.api), 'A1', { versionString: '0.1.1', copyright: 'c' }),
    ).rejects.toThrow(/already submitted/);
    const g = fakeAsc({ versions: [v('V1', '0.1.1', 'READY_FOR_DISTRIBUTION')] });
    await expect(
      ensureVersion(ctxFor(g.api), 'A1', { versionString: '0.1.1', copyright: 'c' }),
    ).rejects.toThrow(/bump/);
  });
});

describe('syncAppStore', () => {
  it('fills a fresh record, uploads screenshots and attaches the build; a second run writes nothing', async () => {
    const f = fakeAsc();
    const lines: string[] = [];
    const r = await syncAppStore({
      api: f.api,
      desired: desired(),
      upload: f.upload,
      sleep: async () => {},
      log: (l: string) => lines.push(l),
    });
    expect(r).toMatchObject({
      appId: 'A1',
      versionId: 'V1',
      versionAction: 'renamed',
      build: '7',
      submission: null,
    });
    const { st } = f;
    expect(st.versions[0]?.attributes).toMatchObject({
      versionString: '0.1.1',
      copyright: '© 2026 INCEPTUM e.U.',
    });
    expect(st.versionLocs[0]?.attributes).toMatchObject({
      locale: 'en-US',
      marketingUrl: 'https://daisychess.org',
    });
    expect(st.infoLocs[0]?.attributes).toMatchObject({ subtitle: 'Chess analysis, no ads' });
    expect(st.app.attributes?.contentRightsDeclaration).toBe('USES_THIRD_PARTY_CONTENT');
    expect(st.appInfos[1]?.relationships?.primarySubcategoryOne?.data).toEqual({
      type: 'appCategories',
      id: 'GAMES_BOARD',
    });
    expect(st.age.attributes).toMatchObject({
      unrestrictedWebAccess: false,
      violenceRealistic: 'NONE',
      kidsAgeBand: null,
    });
    expect(st.review?.attributes).toMatchObject({
      contactPhone: '+43 1 234',
      demoAccountRequired: false,
    });
    expect(st.review?.attributes?.notes).toContain('tok-secret-1');
    expect(st.eulaTerritories).toEqual(['AUT', 'CHN', 'DEU', 'USA']);
    expect(st.prices).toHaveLength(1);
    const avail = Object.fromEntries(
      st.territoryAvail.map((t) => [
        (t.relationships?.territory?.data as Ref).id,
        t.attributes?.available,
      ]),
    );
    expect(avail).toEqual({ AUT: true, CHN: false, DEU: true, USA: true });
    const priceCall = f.calls.find((c) => c.path === '/v1/appPriceSchedules')?.body as Body;
    expect(priceCall.included?.[0]?.relationships?.appPricePoint?.data).toEqual({
      type: 'appPricePoints',
      id: 'PP0',
    });
    // 3 screenshots, two upload operations each, with the headers App Store Connect asked for.
    expect(f.uploads).toHaveLength(6);
    expect(f.uploads[0]).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      bytes: 10,
    });
    const sizes = new Map<string, number>();
    for (const u of f.uploads) {
      const id = u.url.split('/')[3] ?? '';
      sizes.set(id, (sizes.get(id) ?? 0) + u.bytes);
    }
    expect([...sizes.values()]).toEqual([...phoneSet.files, ...padSet.files].map((x) => x.size));
    const committed = f.calls.filter(
      (c) => c.method === 'PATCH' && c.path.startsWith('/v1/appScreenshots/'),
    );
    expect(committed.map((c) => (c.body as Body).data.attributes?.sourceFileChecksum)).toEqual(
      [...phoneSet.files, ...padSet.files].map((x) => x.md5),
    );
    expect(st.builds[0]?.attributes?.usesNonExemptEncryption).toBe(false);
    expect(st.buildRel).toBe('B7');
    // The token never reaches the log.
    expect(lines.join('\n')).not.toContain('tok-secret-1');
    expect(r.ownerSteps.slice(0, STATIC_OWNER_STEPS.length)).toEqual(STATIC_OWNER_STEPS);
    expect(r.ownerSteps.at(-1)).toMatch(/submit=true/);

    f.calls.length = 0;
    f.uploads.length = 0;
    const again = await syncAppStore({
      api: f.api,
      desired: desired(),
      upload: f.upload,
      ...quiet,
    });
    expect(writes(f.calls)).toEqual([]);
    expect(f.uploads).toEqual([]);
    expect(again.entries.every((e) => e.status === 'unchanged')).toBe(true);
  });

  it('replaces a screenshot set whose files changed and re-enables an excluded-by-mistake territory', async () => {
    const f = fakeAsc();
    await syncAppStore({ api: f.api, desired: desired(), upload: f.upload, ...quiet });
    const firstPhone = [...(f.st.shots.get(f.st.sets[0]?.id ?? '') ?? [])].map((s) => s.id);
    (f.st.territoryAvail[0] as Res).attributes = { available: false }; // AUT
    f.calls.length = 0;
    const changed = { ...phoneSet, files: [...phoneSet.files].reverse() };
    const d = { ...desired(), screenshots: [changed, padSet] };
    await syncAppStore({ api: f.api, desired: d, upload: f.upload, ...quiet });
    const deletes = f.calls
      .filter((c) => c.method === 'DELETE')
      .map((c) => c.path.split('/').pop());
    expect(deletes).toEqual(firstPhone);
    const names = (f.st.shots.get(f.st.sets[0]?.id ?? '') ?? []).map((s) => s.attributes?.fileName);
    expect(names).toEqual(['02-b.png', '01-a.png']);
    expect(f.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/v1/appScreenshots',
      '/v1/appScreenshots',
    ]);
    expect(
      f.calls.some((c) => c.method === 'PATCH' && c.path === '/v1/territoryAvailabilities/TA0'),
    ).toBe(true);
  });

  it('dry run reads everything and writes nothing', async () => {
    const f = fakeAsc({ versions: [] });
    const lines: string[] = [];
    const r = await syncAppStore({
      api: f.api,
      desired: desired(),
      dryRun: true,
      upload: f.upload,
      sleep: async () => {},
      log: (l: string) => lines.push(l),
    });
    expect(writes(f.calls)).toEqual([]);
    expect(f.uploads).toEqual([]);
    expect(r.versionAction).toBe('created');
    expect(lines[0]).toMatch(/dry run/);
    expect(lines.some((l) => /^planned\s+screenshots APP_IPHONE_67/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toContain('tok-secret-1');
  });

  it('without REVIEW_TOKEN and phone: notes untouched, owner steps say what is missing; --submit refuses', async () => {
    const f = fakeAsc();
    const d = desired({});
    const r = await syncAppStore({ api: f.api, desired: d, upload: f.upload, ...quiet });
    // App Store Connect requires the phone to create review details: none are created.
    expect(f.st.review).toBeNull();
    expect(f.calls.some((c) => c.path === '/v1/appStoreReviewDetails')).toBe(false);
    expect(r.ownerSteps.join('\n')).toMatch(/REVIEW_CONTACT_PHONE[\s\S]*REVIEW_TOKEN/);
    const p = fakeAsc();
    await syncAppStore({
      api: p.api,
      desired: desired({ REVIEW_CONTACT_PHONE: '+43 1 234' }),
      upload: p.upload,
      ...quiet,
    });
    expect(p.st.review?.attributes).toMatchObject({
      contactPhone: '+43 1 234',
      contactLastName: 'Savicevic',
    });
    expect(p.st.review?.attributes?.notes).toBeUndefined();
    const g = fakeAsc();
    await expect(
      syncAppStore({ api: g.api, desired: d, submit: true, upload: g.upload, ...quiet }),
    ).rejects.toThrow(/REVIEW_TOKEN/);
    expect(g.calls).toEqual([]);
  });

  it('a 403 on price or availability becomes a warning and an owner step', async () => {
    const f = fakeAsc({ forbid: /^GET \/v1\/apps\/A1\/(appPriceSchedule|appAvailabilityV2)/ });
    const r = await syncAppStore({ api: f.api, desired: desired(), upload: f.upload, ...quiet });
    expect(r.entries.filter((e) => e.status === 'warning').map((e) => e.item)).toEqual([
      'price',
      'availability',
    ]);
    expect(r.ownerSteps.join('\n')).toMatch(/Price: set "Free"[\s\S]*except CHN/);
  });

  it('warns about age rating questions it has no answer for', async () => {
    const f = fakeAsc({ extraAgeKey: 'brandNewQuestion' });
    const r = await syncAppStore({ api: f.api, desired: desired(), upload: f.upload, ...quiet });
    expect(r.ownerSteps.join('\n')).toContain('brandNewQuestion');
    expect(f.st.age.attributes?.brandNewQuestion).toBeNull();
  });

  it('fails clearly when App Store Connect rejects a screenshot', async () => {
    const f = fakeAsc({ failDelivery: true });
    await expect(
      syncAppStore({ api: f.api, desired: desired(), upload: f.upload, ...quiet }),
    ).rejects.toThrow(/01-a\.png was rejected.*IMAGE_INCORRECT_DIMENSIONS bad size/);
  });

  it('without a processed build: warning, owner step, and --submit refuses', async () => {
    const f = fakeAsc();
    f.st.builds = [];
    const r = await syncAppStore({ api: f.api, desired: desired(), upload: f.upload, ...quiet });
    expect(r.build).toBeNull();
    expect(r.ownerSteps.join('\n')).toMatch(/Upload a build of 0\.1\.1/);
    await expect(
      syncAppStore({ api: f.api, desired: desired(), submit: true, upload: f.upload, ...quiet }),
    ).rejects.toThrow(/not submitting: no processed build/);
    expect(f.st.submissions).toEqual([]);
  });

  it('--submit creates a review submission with the version and submits it, once', async () => {
    const f = fakeAsc();
    const r = await syncAppStore({
      api: f.api,
      desired: desired(),
      submit: true,
      upload: f.upload,
      ...quiet,
    });
    expect(r.submission).toBe(f.st.submissions[0]?.id);
    expect(f.st.items[0]?.relationships?.appStoreVersion?.data).toEqual({
      type: 'appStoreVersions',
      id: 'V1',
    });
    expect(f.st.submissions[0]?.attributes?.state).toBe('WAITING_FOR_REVIEW');
    expect(r.ownerSteps.join('\n')).not.toMatch(/submit=true/);
    // The version is now WAITING_FOR_REVIEW in App Store Connect: the next run stops early.
    (f.st.versions[0] as Res).attributes = {
      ...f.st.versions[0]?.attributes,
      appVersionState: 'WAITING_FOR_REVIEW',
    };
    await expect(
      syncAppStore({ api: f.api, desired: desired(), submit: true, upload: f.upload, ...quiet }),
    ).rejects.toThrow(/already submitted/);
    expect(f.st.submissions).toHaveLength(1);
  });
});
