#!/usr/bin/env node
// App Store Connect metadata for DaisyChess (iOS): fills the app record from the repo, idempotently,
// through the App Store Connect API (ES256 JWT, same key as asc-profile.mjs). Sources:
// store/listing.en.json (texts, URLs), store/app-store.json (categories, age rating, review
// contact, price, availability, screenshot sets), apps/site/STORE_CHECKLIST.md (custom EULA, App
// Review notes) and store/screenshots/<set>/*.png. What the API cannot do is printed as owner steps.
//
// Usage: node scripts/asc-metadata.mjs [--version x.y.z] [--dry-run] [--submit] [--no-screenshots]
//   --dry-run   read the record and print the planned changes; nothing is written
//   --submit    after filling the record, create a review submission and submit it for App Review
// Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the .p8 file); REVIEW_TOKEN (server analysis token
// quoted in the review notes; required with --submit); optional REVIEW_CONTACT_PHONE,
// REVIEW_CONTACT_FIRST_NAME, REVIEW_CONTACT_LAST_NAME, REVIEW_CONTACT_EMAIL. Secrets are never
// printed (the review token is masked in the plan output).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AscError, ascJwt, createAscApi } from './asc-profile.mjs';
import { readPngInfo } from './png.mjs';

const MOBILE_DIR = fileURLToPath(new URL('..', import.meta.url));
const STORE_DIR = join(MOBILE_DIR, 'store');
const CHECKLIST = fileURLToPath(new URL('../../site/STORE_CHECKLIST.md', import.meta.url));

/**
 * @typedef {{ id: string, type: string }} Ref
 * @typedef {{ id: string, type: string, attributes?: Record<string, unknown>,
 *   relationships?: Record<string, { data?: Ref | Ref[] | null }> }} Resource
 * @typedef {{ data?: Resource | Resource[] | null, included?: Resource[], links?: { next?: string } }} Doc
 * @typedef {(method: string, path: string, body?: unknown) => Promise<Doc | null>} Api
 * @typedef {(req: { method: string, url: string, headers: Record<string, string>, body: Buffer }) => Promise<void>} UploadFn
 * @typedef {{ status: 'changed' | 'planned' | 'unchanged' | 'warning', item: string, detail?: string }} Entry
 * @typedef {{ displayType: string, dir: string, sizes: string[] }} ScreenshotSetConfig
 * @typedef {{ displayType: string, files: { name: string, path: string, size: number, md5: string }[] }} ScreenshotSet
 * @typedef {{
 *   bundleId: string, locale: string, versionString: string, copyright: string,
 *   versionLocalization: Record<string, string>, appInfoLocalization: Record<string, string>,
 *   categories: Record<string, string>, contentRightsDeclaration: string,
 *   ageRating: Record<string, string | boolean>,
 *   review: { contactFirstName: string, contactLastName: string, contactEmail: string,
 *     contactPhone?: string, notes?: string, demoAccountRequired: boolean },
 *   reviewToken?: string, eula: string, price: 'free' | 'skip',
 *   availability: { availableInNewTerritories: boolean, excludeTerritories: string[] },
 *   screenshots: ScreenshotSet[] }} Desired
 * @typedef {{ api: Api, dryRun: boolean, upload: UploadFn, sleep: (ms: number) => Promise<void>,
 *   log: (line: string) => void, entries: Entry[], ownerSteps: string[], secrets: string[],
 *   territories?: string[], pollTimeoutMs: number, seq: number }} Ctx
 */

/** Version states in which the version's metadata can still be edited. */
export const EDITABLE_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);
/** Version states after a submission (nothing to do before App Review decides). */
export const SUBMITTED_STATES = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'READY_FOR_REVIEW']);

/** App Store Connect wants "+<country code> <number>". */
export const PHONE_RE = /^\+\d[\d ()./-]{5,}$/;

/** Age rating attributes that are not questionnaire answers (left as they are). */
const AGE_RATING_META = new Set([
  'kidsAgeBand',
  'ageRatingOverride',
  'ageRatingOverrideV2',
  'koreaAgeRatingOverride',
  'gracRatingClassificationNumber',
  'developerAgeRatingInfoUrl',
  'socialMediaAgeRestricted',
  'seventeenPlus',
]);

/**
 * What the App Store Connect API cannot set (checked against the OpenAPI spec 4.5.1): printed after
 * every run so the owner knows what is left in the web UI.
 */
export const STATIC_OWNER_STEPS = [
  'App Privacy (App Store Connect → App → App Privacy): not in the API. Answers from https://daisychess.org/app-privacy/: ' +
    'Tracking: No. Data types collected: User Content → Other User Content (game reviews in the shared review store) and ' +
    'Usage Data → Product Interaction (daily search counters per token); for both: not linked to the user, not used for ' +
    'tracking, purpose App Functionality only. Everything else: not collected. Then "Publish".',
  'Digital Services Act trader status (App Store Connect → Business, or the app\'s App Information → "Digital Services ' +
    'Act"): not in the API. Required to distribute in the EU; a free app without monetisation is usually "not a trader" ' +
    '(owner decision, see apps/site/STORE_CHECKLIST.md).',
  'Check App Information → Age Rating shows 4+ after this run (the questionnaire answers are set by the API; Apple ' +
    'computes the rating).',
  'Content rights (App Information): set to "contains, shows or accesses third-party content" with rights to use it ' +
    '(lichess puzzle database CC0, lichess/chess.com APIs). Confirm this is right.',
  'China mainland is excluded from availability (app-store.json availability.excludeTerritories): distribution there ' +
    'needs an ICP filing and, for the Games category, a game approval number. Remove "CHN" only once both exist.',
];

// ---------------------------------------------------------------------------------------------
// Pure helpers

/** @param {Resource} r @param {string} k */
function attr(r, k) {
  const v = r.attributes?.[k];
  return typeof v === 'string' ? v : '';
}

/** @param {Resource} r @param {string} rel @returns {string[]} */
function relIds(r, rel) {
  const d = r.relationships?.[rel]?.data;
  if (!d) return [];
  return (Array.isArray(d) ? d : [d]).map((x) => x.id);
}

/** @param {Doc | null} r @returns {Resource[]} */
function list(r) {
  const d = r?.data;
  return Array.isArray(d) ? d : d ? [d] : [];
}

/** @param {Record<string, string>} o */
const q = (o) => new URLSearchParams(o).toString();

/** @param {string} state */
export function isEditable(state) {
  return EDITABLE_STATES.has(state);
}

/** @param {Resource} v */
export function versionState(v) {
  return attr(v, 'appVersionState') || attr(v, 'appStoreState');
}

/**
 * Attributes of `desired` that differ from `current` (null, undefined and '' count as equal).
 * @param {Record<string, unknown> | undefined} current
 * @param {Record<string, unknown>} desired
 * @returns {Record<string, unknown>}
 */
export function diffAttributes(current, desired) {
  /** @param {unknown} v */
  const norm = (v) => (v === undefined || v === '' ? null : v);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(desired)) {
    if (v === undefined) continue;
    if (norm(current?.[k]) !== norm(v)) out[k] = v;
  }
  return out;
}

/**
 * The fenced block that follows the first heading starting with `heading` in a Markdown file.
 * @param {string} md
 * @param {string} heading
 */
export function markdownBlockAfter(md, heading) {
  const at = md
    .split('\n')
    .findIndex((l) => /^#{1,6} /.test(l) && l.replace(/^#+ /, '').startsWith(heading));
  if (at < 0) throw new Error(`heading "${heading}" not found`);
  const rest = md
    .split('\n')
    .slice(at + 1)
    .join('\n');
  const m = rest.match(/^```[^\n]*\n([\s\S]*?)\n```/m);
  if (!m || m[1] === undefined) throw new Error(`no code block after "${heading}"`);
  return m[1];
}

/**
 * Joins hard-wrapped lines into paragraphs (App Store Connect shows text as typed). Paragraphs are
 * separated by blank lines; lines indented by four spaces stay on their own line, unindented.
 * @param {string} text
 */
export function unwrapParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((para) => {
      const out = [];
      for (const line of para.split('\n')) {
        if (/^ {4}/.test(line)) out.push({ keep: true, s: line.trim() });
        else if (out.length && !out[out.length - 1]?.keep) {
          const last = /** @type {{ keep: boolean, s: string }} */ (out[out.length - 1]);
          last.s += ` ${line.trim()}`;
        } else out.push({ keep: false, s: line.trim() });
      }
      return out.map((x) => x.s).join('\n');
    })
    .join('\n\n')
    .trim();
}

/**
 * App Review notes from the checklist template.
 * @param {string} template
 * @param {{ token: string, version: string }} p
 */
export function renderReviewNotes(template, { token, version }) {
  if (!token) throw new Error('review token is empty');
  const text = unwrapParagraphs(
    template.replaceAll('<REVIEW_TOKEN>', token).replaceAll('<VERSION>', version),
  );
  if (text.length > 4000) throw new Error(`review notes are ${text.length} characters (max 4000)`);
  return text;
}

/** @param {Buffer} buf */
export function md5(buf) {
  return createHash('md5').update(buf).digest('hex');
}

/**
 * Local screenshot files of one set, sorted by name, with size checks.
 * @param {string} storeDir
 * @param {ScreenshotSetConfig} set
 * @returns {ScreenshotSet}
 */
export function loadScreenshotSet(storeDir, set) {
  const dir = join(storeDir, set.dir);
  const names = readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.png'))
    .sort();
  if (names.length === 0) throw new Error(`${set.dir}: no PNG screenshots`);
  if (names.length > 10) throw new Error(`${set.dir}: ${names.length} screenshots (max 10)`);
  const files = names.map((name) => {
    const path = join(dir, name);
    const buf = readFileSync(path);
    const { width, height } = readPngInfo(buf);
    const dims = `${width}x${height}`;
    if (!set.sizes.includes(dims) && !set.sizes.includes(`${height}x${width}`)) {
      throw new Error(
        `${set.dir}/${name}: ${dims} is not a valid ${set.displayType} size (${set.sizes.join(', ')})`,
      );
    }
    return { name, path, size: buf.length, md5: md5(buf) };
  });
  return { displayType: set.displayType, files };
}

/**
 * Everything the record should contain, from the repo files.
 * @param {{ version: string, env?: Record<string, string | undefined>, storeDir?: string,
 *   checklistPath?: string, withScreenshots?: boolean }} p
 * @returns {Desired}
 */
export function loadDesired({
  version,
  env = process.env,
  storeDir = STORE_DIR,
  checklistPath = CHECKLIST,
  withScreenshots = true,
}) {
  const listing = JSON.parse(readFileSync(join(storeDir, 'listing.en.json'), 'utf8'));
  const cfg = JSON.parse(readFileSync(join(storeDir, 'app-store.json'), 'utf8'));
  const md = readFileSync(checklistPath, 'utf8');
  const apple = listing.apple;
  const token = env.REVIEW_TOKEN?.trim() || undefined;
  const phone = env.REVIEW_CONTACT_PHONE?.trim() || undefined;
  if (phone && !PHONE_RE.test(phone)) {
    throw new Error(
      'REVIEW_CONTACT_PHONE must start with + and the country code (e.g. +43 1 2345678)',
    );
  }
  return {
    bundleId: cfg.bundleId,
    locale: cfg.locale,
    versionString: version,
    copyright: apple.copyright,
    versionLocalization: {
      description: apple.description,
      keywords: apple.keywords,
      promotionalText: apple.promotionalText,
      supportUrl: listing.supportUrl,
      marketingUrl: listing.website,
    },
    appInfoLocalization: {
      name: apple.name,
      subtitle: apple.subtitle,
      privacyPolicyUrl: listing.privacyPolicyUrl,
    },
    categories: cfg.categories,
    contentRightsDeclaration: cfg.contentRightsDeclaration,
    ageRating: cfg.ageRating,
    review: {
      contactFirstName: env.REVIEW_CONTACT_FIRST_NAME?.trim() || cfg.reviewContact.firstName,
      contactLastName: env.REVIEW_CONTACT_LAST_NAME?.trim() || cfg.reviewContact.lastName,
      contactEmail: env.REVIEW_CONTACT_EMAIL?.trim() || cfg.reviewContact.email,
      ...(phone ? { contactPhone: phone } : {}),
      ...(token
        ? {
            notes: renderReviewNotes(markdownBlockAfter(md, 'App Review notes'), {
              token,
              version,
            }),
          }
        : {}),
      demoAccountRequired: false,
    },
    ...(token ? { reviewToken: token } : {}),
    eula: unwrapParagraphs(markdownBlockAfter(md, 'App Store Connect: custom EULA')),
    price: cfg.price === 'free' ? 'free' : 'skip',
    availability: cfg.availability,
    screenshots: withScreenshots
      ? cfg.screenshots.map((/** @type {ScreenshotSetConfig} */ s) =>
          loadScreenshotSet(storeDir, s),
        )
      : [],
  };
}

// ---------------------------------------------------------------------------------------------
// API plumbing

/** @param {Ctx} ctx @param {string} text */
function mask(ctx, text) {
  let out = text;
  for (const s of ctx.secrets) if (s) out = out.replaceAll(s, '***');
  return out;
}

/**
 * @param {Ctx} ctx
 * @param {Entry['status']} status
 * @param {string} item
 * @param {string} [detail]
 */
function report(ctx, status, item, detail) {
  ctx.entries.push({ status, item, ...(detail ? { detail: mask(ctx, detail) } : {}) });
  ctx.log(`${status.padEnd(9)} ${item}${detail ? `: ${mask(ctx, detail)}` : ''}`);
}

/** @param {Ctx} ctx @param {string} item @param {Record<string, unknown>} changes */
function reportChange(ctx, item, changes) {
  const detail = Object.entries(changes)
    .map(([k, v]) => {
      const s =
        typeof v === 'string'
          ? JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}...` : v)
          : JSON.stringify(v);
      return `${k}=${s}`;
    })
    .join(', ');
  report(ctx, ctx.dryRun ? 'planned' : 'changed', item, detail);
}

/** GET; synthetic dry-run ids return nothing. @param {Ctx} ctx @param {string} path */
async function get(ctx, path) {
  if (path.includes('dry-run-')) return { data: [] };
  return ctx.api('GET', path);
}

/** GET of a to-one relationship that may not exist (HTTP 404 or data null). @param {Ctx} ctx @param {string} path */
async function getOptional(ctx, path) {
  try {
    return list(await get(ctx, path))[0] ?? null;
  } catch (e) {
    if (e instanceof AscError && e.status === 404) return null;
    throw e;
  }
}

/** Every page of a collection. @param {Ctx} ctx @param {string} path */
async function getAll(ctx, path) {
  /** @type {Resource[]} */
  const out = [];
  /** @type {Resource[]} */
  const included = [];
  /** @type {string | undefined} */
  let next = path;
  for (let page = 0; next && page < 50; page += 1) {
    const doc = await get(ctx, next);
    out.push(...list(doc));
    included.push(...(doc?.included ?? []));
    const link = doc?.links?.next;
    next = link ? link.replace(/^https:\/\/api\.appstoreconnect\.apple\.com/, '') : undefined;
  }
  return { data: out, included };
}

/**
 * POST/PATCH/DELETE; in a dry run nothing is sent and a synthetic resource is returned.
 * @param {Ctx} ctx @param {string} method @param {string} path @param {unknown} [body]
 * @returns {Promise<Resource | null>}
 */
async function write(ctx, method, path, body) {
  if (ctx.dryRun || path.includes('dry-run-')) {
    ctx.seq += 1;
    const data =
      /** @type {{ data?: { type?: string, attributes?: Record<string, unknown> } } | undefined} */ (
        body
      )?.data;
    return {
      id: `dry-run-${ctx.seq}`,
      type: data?.type ?? 'unknown',
      attributes: data?.attributes ?? {},
    };
  }
  return list(await ctx.api(method, path, body))[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Steps

/** @param {Ctx} ctx @param {string} bundleId */
export async function findApp(ctx, bundleId) {
  const apps = list(
    await get(ctx, `/v1/apps?${q({ 'filter[bundleId]': bundleId, limit: '10' })}`),
  ).filter((a) => attr(a, 'bundleId') === bundleId);
  const app = apps[0];
  if (!app) {
    throw new Error(
      `no App Store Connect app with bundle id ${bundleId} (create the app record first, deploy/README.md)`,
    );
  }
  return app;
}

/**
 * Finds or creates the App Store version `versionString`. An editable version with another number
 * (App Store Connect creates "1.0" with a new app) is renamed: only one can be in preparation.
 * @param {Ctx} ctx @param {string} appId @param {{ versionString: string, copyright: string }} d
 * @returns {Promise<{ id: string, state: string, action: 'created' | 'renamed' | 'existing' }>}
 */
export async function ensureVersion(ctx, appId, { versionString, copyright }) {
  const { data: versions } = await getAll(
    ctx,
    `/v1/apps/${appId}/appStoreVersions?${q({ 'filter[platform]': 'IOS', limit: '200' })}`,
  );
  const same = versions.find((v) => attr(v, 'versionString') === versionString);
  if (same) {
    const state = versionState(same);
    if (!isEditable(state)) {
      const why = SUBMITTED_STATES.has(state)
        ? 'it is already submitted for review'
        : 'it has passed review; bump apps/mobile/package.json "version" for a new one';
      throw new Error(`App Store version ${versionString} is in state ${state}: ${why}`);
    }
    const changes = diffAttributes(same.attributes, { copyright });
    if (Object.keys(changes).length) {
      reportChange(ctx, `version ${versionString}`, changes);
      await write(ctx, 'PATCH', `/v1/appStoreVersions/${same.id}`, {
        data: { type: 'appStoreVersions', id: same.id, attributes: changes },
      });
    } else report(ctx, 'unchanged', `version ${versionString}`, state);
    return { id: same.id, state, action: 'existing' };
  }
  const editable = versions.find((v) => isEditable(versionState(v)));
  if (editable) {
    const from = attr(editable, 'versionString');
    reportChange(ctx, `version ${from} → ${versionString}`, { versionString, copyright });
    await write(ctx, 'PATCH', `/v1/appStoreVersions/${editable.id}`, {
      data: { type: 'appStoreVersions', id: editable.id, attributes: { versionString, copyright } },
    });
    return { id: editable.id, state: versionState(editable), action: 'renamed' };
  }
  reportChange(ctx, `version ${versionString} (new)`, {
    platform: 'IOS',
    versionString,
    copyright,
  });
  const created = await write(ctx, 'POST', '/v1/appStoreVersions', {
    data: {
      type: 'appStoreVersions',
      attributes: { platform: 'IOS', versionString, copyright },
      relationships: { app: { data: { type: 'apps', id: appId } } },
    },
  });
  if (!created) throw new Error('App Store Connect created no version');
  return { id: created.id, state: 'PREPARE_FOR_SUBMISSION', action: 'created' };
}

/**
 * Patches or creates the localization for `locale` in a collection.
 * @param {Ctx} ctx
 * @param {{ label: string, listPath: string, type: string, parentRel: string, parentType: string,
 *   parentId: string, locale: string, fields: Record<string, unknown> }} p
 * @returns {Promise<string>} localization id
 */
async function upsertLocalization(
  ctx,
  { label, listPath, type, parentRel, parentType, parentId, locale, fields },
) {
  const { data } = await getAll(ctx, listPath);
  const loc = data.find((l) => attr(l, 'locale') === locale);
  if (loc) {
    const changes = diffAttributes(loc.attributes, fields);
    if (Object.keys(changes).length) {
      reportChange(ctx, label, changes);
      await write(ctx, 'PATCH', `/v1/${type}/${loc.id}`, {
        data: { type, id: loc.id, attributes: changes },
      });
    } else report(ctx, 'unchanged', label);
    return loc.id;
  }
  reportChange(ctx, `${label} (new)`, fields);
  const created = await write(ctx, 'POST', `/v1/${type}`, {
    data: {
      type,
      attributes: { locale, ...fields },
      relationships: { [parentRel]: { data: { type: parentType, id: parentId } } },
    },
  });
  if (!created) throw new Error(`App Store Connect created no ${type}`);
  return created.id;
}

/** @param {Ctx} ctx @param {string} versionId @param {Desired} d */
export function syncVersionLocalization(ctx, versionId, d) {
  return upsertLocalization(ctx, {
    label: `version localization ${d.locale}`,
    listPath: `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50`,
    type: 'appStoreVersionLocalizations',
    parentRel: 'appStoreVersion',
    parentType: 'appStoreVersions',
    parentId: versionId,
    locale: d.locale,
    fields: d.versionLocalization,
  });
}

/** @param {Ctx} ctx @param {Resource} app @param {Desired} d */
export async function syncAppAttributes(ctx, app, d) {
  const changes = diffAttributes(app.attributes, {
    contentRightsDeclaration: d.contentRightsDeclaration,
  });
  if (Object.keys(changes).length) {
    reportChange(ctx, 'app', changes);
    await write(ctx, 'PATCH', `/v1/apps/${app.id}`, {
      data: { type: 'apps', id: app.id, attributes: changes },
    });
  } else report(ctx, 'unchanged', 'app content rights declaration');
}

/**
 * The app info being prepared (the live one is READY_FOR_DISTRIBUTION and read-only).
 * @param {Ctx} ctx @param {string} appId
 */
export async function editableAppInfo(ctx, appId) {
  const { data } = await getAll(
    ctx,
    `/v1/apps/${appId}/appInfos?${q({ include: 'primaryCategory,primarySubcategoryOne,primarySubcategoryTwo,secondaryCategory,secondarySubcategoryOne,secondarySubcategoryTwo' })}`,
  );
  const st = (/** @type {Resource} */ i) => attr(i, 'state') || attr(i, 'appStoreState');
  const info =
    data.find((i) => st(i) === 'PREPARE_FOR_SUBMISSION') ??
    data.find(
      (i) =>
        !['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE', 'REPLACED_WITH_NEW_INFO'].includes(st(i)),
    );
  if (!info) throw new Error('no editable app info (is a version in preparation?)');
  return info;
}

/** @param {Ctx} ctx @param {Resource} info @param {Desired} d */
export async function syncAppInfo(ctx, info, d) {
  /** @type {Record<string, { data: Ref }>} */
  const rels = {};
  for (const [rel, id] of Object.entries(d.categories)) {
    if (relIds(info, rel)[0] !== id) rels[rel] = { data: { type: 'appCategories', id } };
  }
  if (Object.keys(rels).length) {
    reportChange(
      ctx,
      'categories',
      Object.fromEntries(Object.entries(rels).map(([k, v]) => [k, v.data.id])),
    );
    await write(ctx, 'PATCH', `/v1/appInfos/${info.id}`, {
      data: { type: 'appInfos', id: info.id, relationships: rels },
    });
  } else report(ctx, 'unchanged', 'categories');

  await upsertLocalization(ctx, {
    label: `app info localization ${d.locale}`,
    listPath: `/v1/appInfos/${info.id}/appInfoLocalizations?limit=50`,
    type: 'appInfoLocalizations',
    parentRel: 'appInfo',
    parentType: 'appInfos',
    parentId: info.id,
    locale: d.locale,
    fields: d.appInfoLocalization,
  });

  const decl = await getOptional(ctx, `/v1/appInfos/${info.id}/ageRatingDeclaration`);
  if (!decl) {
    report(ctx, 'warning', 'age rating', 'no age rating declaration on the app info');
    return;
  }
  const known = Object.keys(decl.attributes ?? {});
  /** @type {Record<string, unknown>} */
  const desired = {};
  for (const [k, v] of Object.entries(d.ageRating)) {
    // Attributes the API no longer has are skipped (the questionnaire changes over time).
    if (known.length === 0 || known.includes(k)) desired[k] = v;
  }
  const unanswered = known.filter((k) => !(k in d.ageRating) && !AGE_RATING_META.has(k));
  if (unanswered.length) {
    const msg = `age rating questions without an answer in app-store.json: ${unanswered.join(', ')}`;
    report(ctx, 'warning', 'age rating', msg);
    ctx.ownerSteps.push(
      `Answer the new age rating questions in App Store Connect (or add them to apps/mobile/store/app-store.json): ${unanswered.join(', ')}.`,
    );
  }
  const changes = diffAttributes(decl.attributes, desired);
  if (Object.keys(changes).length) {
    reportChange(ctx, 'age rating', changes);
    await write(ctx, 'PATCH', `/v1/ageRatingDeclarations/${decl.id}`, {
      data: { type: 'ageRatingDeclarations', id: decl.id, attributes: changes },
    });
  } else report(ctx, 'unchanged', 'age rating');
}

/**
 * @param {Ctx} ctx @param {string} versionId @param {Desired} d
 * @returns {Promise<{ hasPhone: boolean, hasNotes: boolean }>}
 */
export async function syncReviewDetail(ctx, versionId, d) {
  const current = await getOptional(ctx, `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`);
  /** @type {Record<string, unknown>} */
  const desired = { ...d.review };
  if (!d.review.notes) {
    report(ctx, 'warning', 'review notes', 'REVIEW_TOKEN is not set: notes left as they are');
  }
  if (!d.review.contactPhone && !attr(current ?? { id: '', type: '' }, 'contactPhone')) {
    report(
      ctx,
      'warning',
      'review contact',
      'no phone number (REVIEW_CONTACT_PHONE): App Review requires one',
    );
  }
  const hasPhone = Boolean(d.review.contactPhone || (current && attr(current, 'contactPhone')));
  const hasNotes = Boolean(d.review.notes || (current && attr(current, 'notes')));
  if (current) {
    const changes = diffAttributes(current.attributes, desired);
    if (Object.keys(changes).length) {
      reportChange(ctx, 'review details', changes);
      await write(ctx, 'PATCH', `/v1/appStoreReviewDetails/${current.id}`, {
        data: { type: 'appStoreReviewDetails', id: current.id, attributes: changes },
      });
    } else report(ctx, 'unchanged', 'review details');
  } else if (!hasPhone) {
    // App Store Connect refuses to create review details without a phone (HTTP 409).
    report(
      ctx,
      'warning',
      'review details',
      'not created: App Store Connect requires the contact phone',
    );
  } else {
    reportChange(ctx, 'review details (new)', desired);
    await write(ctx, 'POST', '/v1/appStoreReviewDetails', {
      data: {
        type: 'appStoreReviewDetails',
        attributes: desired,
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    });
  }
  return { hasPhone, hasNotes };
}

/** All territory ids (cached). @param {Ctx} ctx */
async function territories(ctx) {
  if (!ctx.territories) {
    const { data } = await getAll(ctx, '/v1/territories?limit=200');
    ctx.territories = data.map((t) => t.id).sort();
    if (ctx.territories.length === 0) throw new Error('App Store Connect returned no territories');
  }
  return ctx.territories;
}

/** @param {Ctx} ctx @param {string} appId @param {string} text */
export async function syncEula(ctx, appId, text) {
  const all = await territories(ctx);
  const terr = { data: all.map((id) => ({ type: 'territories', id })) };
  const current = await getOptional(ctx, `/v1/apps/${appId}/endUserLicenseAgreement`);
  if (!current) {
    reportChange(ctx, 'custom EULA (new)', { agreementText: text, territories: all.length });
    await write(ctx, 'POST', '/v1/endUserLicenseAgreements', {
      data: {
        type: 'endUserLicenseAgreements',
        attributes: { agreementText: text },
        relationships: { app: { data: { type: 'apps', id: appId } }, territories: terr },
      },
    });
    return;
  }
  const { data: have } = await getAll(
    ctx,
    `/v1/endUserLicenseAgreements/${current.id}/territories?limit=200`,
  );
  const haveIds = new Set(have.map((t) => t.id));
  const missing = all.filter((id) => !haveIds.has(id));
  /** @type {Record<string, unknown>} */
  const changes = diffAttributes(current.attributes, { agreementText: text });
  if (Object.keys(changes).length || missing.length) {
    reportChange(ctx, 'custom EULA', {
      ...changes,
      ...(missing.length ? { addTerritories: missing.length } : {}),
    });
    await write(ctx, 'PATCH', `/v1/endUserLicenseAgreements/${current.id}`, {
      data: {
        type: 'endUserLicenseAgreements',
        id: current.id,
        attributes: changes,
        ...(missing.length ? { relationships: { territories: terr } } : {}),
      },
    });
  } else report(ctx, 'unchanged', 'custom EULA');
}

/**
 * Runs a step whose HTTP 403 means "the key's role may not do this": a warning and an owner step
 * instead of a failed run.
 * @param {Ctx} ctx @param {string} item @param {string} ownerStep @param {() => Promise<void>} fn
 */
async function soft(ctx, item, ownerStep, fn) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AscError && e.status === 403) {
      report(ctx, 'warning', item, `HTTP 403 for this API key (${e.message})`);
      ctx.ownerSteps.push(ownerStep);
      return;
    }
    throw e;
  }
}

/** @param {Ctx} ctx @param {string} appId */
export async function syncPrice(ctx, appId) {
  const schedule = await getOptional(ctx, `/v1/apps/${appId}/appPriceSchedule`);
  if (schedule) {
    // An app without prices still returns a schedule resource (id = app id) whose manualPrices
    // answer 404: that is "no price yet".
    /** @type {{ data: Resource[], included: Resource[] }} */
    let doc = { data: [], included: [] };
    try {
      doc = await getAll(
        ctx,
        `/v1/appPriceSchedules/${schedule.id}/manualPrices?${q({ include: 'appPricePoint', 'fields[appPricePoints]': 'customerPrice', limit: '200' })}`,
      );
    } catch (e) {
      if (!(e instanceof AscError && e.status === 404)) throw e;
    }
    const points = new Map(doc.included.map((p) => [p.id, Number(attr(p, 'customerPrice'))]));
    const current = doc.data.filter((p) => !p.attributes?.endDate);
    const free =
      current.length > 0 &&
      current.every((p) => {
        const pp = relIds(p, 'appPricePoint')[0];
        return pp !== undefined && points.get(pp) === 0;
      });
    if (free) {
      report(ctx, 'unchanged', 'price', 'free');
      return;
    }
  }
  /** @type {Resource | undefined} */
  let freePoint;
  /** @type {string | undefined} */
  let next = `/v1/apps/${appId}/appPricePoints?${q({ 'filter[territory]': 'USA', limit: '200' })}`;
  for (let page = 0; next && !freePoint && page < 20; page += 1) {
    const doc = await get(ctx, next);
    freePoint = list(doc).find((p) => Number(attr(p, 'customerPrice')) === 0);
    const link = doc?.links?.next;
    next = link ? link.replace(/^https:\/\/api\.appstoreconnect\.apple\.com/, '') : undefined;
  }
  if (!freePoint) throw new Error('no free (0.00) USA price point found');
  reportChange(ctx, 'price', { baseTerritory: 'USA', customerPrice: '0.00' });
  await write(ctx, 'POST', '/v1/appPriceSchedules', {
    data: {
      type: 'appPriceSchedules',
      relationships: {
        app: { data: { type: 'apps', id: appId } },
        baseTerritory: { data: { type: 'territories', id: 'USA' } },
        manualPrices: { data: [{ type: 'appPrices', id: '${price0}' }] },
      },
    },
    included: [
      {
        type: 'appPrices',
        id: '${price0}',
        attributes: { startDate: null },
        relationships: { appPricePoint: { data: { type: 'appPricePoints', id: freePoint.id } } },
      },
    ],
  });
}

/** @param {Ctx} ctx @param {string} appId @param {Desired['availability']} want */
export async function syncAvailability(ctx, appId, want) {
  const all = await territories(ctx);
  const exclude = new Set(want.excludeTerritories);
  const current = await getOptional(ctx, `/v1/apps/${appId}/appAvailabilityV2`);
  if (!current) {
    reportChange(ctx, 'availability (new)', {
      availableInNewTerritories: want.availableInNewTerritories,
      territories: all.length - all.filter((t) => exclude.has(t)).length,
      excluded: [...exclude].join(','),
    });
    await write(ctx, 'POST', '/v2/appAvailabilities', {
      data: {
        type: 'appAvailabilities',
        attributes: { availableInNewTerritories: want.availableInNewTerritories },
        relationships: {
          app: { data: { type: 'apps', id: appId } },
          territoryAvailabilities: {
            data: all.map((t) => ({ type: 'territoryAvailabilities', id: `\${ta-${t}}` })),
          },
        },
      },
      included: all.map((t) => ({
        type: 'territoryAvailabilities',
        id: `\${ta-${t}}`,
        attributes: { available: !exclude.has(t) },
        relationships: { territory: { data: { type: 'territories', id: t } } },
      })),
    });
    return;
  }
  if (current.attributes?.availableInNewTerritories !== want.availableInNewTerritories) {
    report(
      ctx,
      'warning',
      'availability',
      'availableInNewTerritories differs and cannot be changed through the API',
    );
    ctx.ownerSteps.push(
      `Pricing and Availability → "Make available in new territories": set to ${want.availableInNewTerritories ? 'on' : 'off'}.`,
    );
  }
  const doc = await getAll(
    ctx,
    `/v2/appAvailabilities/${current.id}/territoryAvailabilities?${q({ include: 'territory', limit: '200' })}`,
  );
  let changed = 0;
  for (const ta of doc.data) {
    const terr = relIds(ta, 'territory')[0];
    if (!terr) continue;
    const available = !exclude.has(terr);
    if (ta.attributes?.available === available) continue;
    changed += 1;
    reportChange(ctx, `availability ${terr}`, { available });
    await write(ctx, 'PATCH', `/v1/territoryAvailabilities/${ta.id}`, {
      data: { type: 'territoryAvailabilities', id: ta.id, attributes: { available } },
    });
  }
  if (!changed) report(ctx, 'unchanged', 'availability', `${doc.data.length} territories`);
}

/** @param {Ctx} ctx @param {string} id */
async function waitForScreenshot(ctx, id) {
  const until = Date.now() + ctx.pollTimeoutMs;
  for (;;) {
    const s = list(await ctx.api('GET', `/v1/appScreenshots/${id}`))[0];
    const delivery =
      /** @type {{ state?: string, errors?: { code?: string, description?: string }[] } | undefined} */ (
        s?.attributes?.assetDeliveryState
      );
    if (delivery?.state === 'COMPLETE') return;
    if (delivery?.state === 'FAILED') {
      const why = (delivery.errors ?? [])
        .map((e) => `${e.code ?? ''} ${e.description ?? ''}`.trim())
        .join('; ');
      throw new Error(
        `screenshot ${s ? attr(s, 'fileName') : id} was rejected by App Store Connect: ${why || 'FAILED'}`,
      );
    }
    if (Date.now() > until)
      throw new Error(`screenshot ${id} still ${delivery?.state ?? 'unknown'} after polling`);
    await ctx.sleep(2000);
  }
}

/**
 * Makes each configured screenshot set equal to the local files (same names and MD5 in the same
 * order, all processed); otherwise the set's screenshots are deleted and uploaded again.
 * @param {Ctx} ctx @param {string} localizationId @param {ScreenshotSet[]} sets
 */
export async function syncScreenshots(ctx, localizationId, sets) {
  const { data: existing } = await getAll(
    ctx,
    `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=50`,
  );
  for (const set of sets) {
    const label = `screenshots ${set.displayType}`;
    let remote = existing.find((s) => attr(s, 'screenshotDisplayType') === set.displayType);
    /** @type {Resource[]} */
    let shots = [];
    if (remote) {
      shots = (await getAll(ctx, `/v1/appScreenshotSets/${remote.id}/appScreenshots?limit=50`))
        .data;
      const same =
        shots.length === set.files.length &&
        shots.every((s, i) => {
          const f = set.files[i];
          const state = /** @type {{ state?: string } | undefined} */ (
            s.attributes?.assetDeliveryState
          )?.state;
          return (
            f &&
            attr(s, 'fileName') === f.name &&
            attr(s, 'sourceFileChecksum') === f.md5 &&
            state === 'COMPLETE'
          );
        });
      if (same) {
        report(ctx, 'unchanged', label, `${shots.length} screenshots`);
        continue;
      }
    }
    reportChange(ctx, label, {
      delete: shots.length,
      upload: set.files.map((f) => f.name).join(' '),
    });
    if (ctx.dryRun) continue;
    if (!remote) {
      const created = await write(ctx, 'POST', '/v1/appScreenshotSets', {
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: set.displayType },
          relationships: {
            appStoreVersionLocalization: {
              data: { type: 'appStoreVersionLocalizations', id: localizationId },
            },
          },
        },
      });
      if (!created)
        throw new Error(`App Store Connect created no screenshot set ${set.displayType}`);
      remote = created;
    }
    for (const s of shots) await write(ctx, 'DELETE', `/v1/appScreenshots/${s.id}`);
    /** @type {string[]} */
    const ids = [];
    for (const f of set.files) {
      const buf = readFileSync(f.path);
      const created = await write(ctx, 'POST', '/v1/appScreenshots', {
        data: {
          type: 'appScreenshots',
          attributes: { fileName: f.name, fileSize: buf.length },
          relationships: {
            appScreenshotSet: { data: { type: 'appScreenshotSets', id: remote.id } },
          },
        },
      });
      if (!created) throw new Error(`App Store Connect created no screenshot for ${f.name}`);
      const ops =
        /** @type {{ method: string, url: string, offset: number, length: number, requestHeaders?: { name: string, value: string }[] }[] | undefined} */ (
          created.attributes?.uploadOperations
        ) ?? [];
      if (ops.length === 0) throw new Error(`no upload operations for ${f.name}`);
      for (const op of ops) {
        await ctx.upload({
          method: op.method,
          url: op.url,
          headers: Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value])),
          body: buf.subarray(op.offset, op.offset + op.length),
        });
      }
      await write(ctx, 'PATCH', `/v1/appScreenshots/${created.id}`, {
        data: {
          type: 'appScreenshots',
          id: created.id,
          attributes: { uploaded: true, sourceFileChecksum: f.md5 },
        },
      });
      ids.push(created.id);
    }
    for (const id of ids) await waitForScreenshot(ctx, id);
    ctx.log(`          ${label}: ${ids.length} uploaded and processed`);
  }
}

/**
 * Attaches the newest processed build of `versionString` to the version.
 * @param {Ctx} ctx @param {string} appId @param {string} versionId @param {string} versionString
 * @returns {Promise<string | null>} the build number, or null when no valid build exists
 */
export async function selectBuild(ctx, appId, versionId, versionString) {
  const builds = list(
    await get(
      ctx,
      `/v1/builds?${q({
        'filter[app]': appId,
        'filter[preReleaseVersion.version]': versionString,
        'filter[preReleaseVersion.platform]': 'IOS',
        'filter[processingState]': 'VALID',
        'filter[expired]': 'false',
        sort: '-uploadedDate',
        limit: '1',
      })}`,
    ),
  );
  const build = builds[0];
  if (!build) {
    report(
      ctx,
      'warning',
      'build',
      `no processed (VALID) build of ${versionString}: upload one with release-mobile.yml`,
    );
    return null;
  }
  const number = attr(build, 'version');
  if (build.attributes?.usesNonExemptEncryption == null) {
    // Info.plist declares ITSAppUsesNonExemptEncryption = false; mirror it if the build lacks it.
    reportChange(ctx, `build ${number}`, { usesNonExemptEncryption: false });
    await write(ctx, 'PATCH', `/v1/builds/${build.id}`, {
      data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } },
    });
  }
  const current = await getOptional(ctx, `/v1/appStoreVersions/${versionId}/relationships/build`);
  if (current?.id === build.id) {
    report(ctx, 'unchanged', 'build', `${versionString} (${number})`);
  } else {
    reportChange(ctx, 'build', { build: `${versionString} (${number})` });
    await write(ctx, 'PATCH', `/v1/appStoreVersions/${versionId}/relationships/build`, {
      data: { type: 'builds', id: build.id },
    });
  }
  return number;
}

/**
 * Creates (or reuses an open) review submission with the version and submits it.
 * @param {Ctx} ctx @param {string} appId @param {string} versionId
 */
export async function submitForReview(ctx, appId, versionId) {
  const { data: subs } = await getAll(
    ctx,
    `/v1/reviewSubmissions?${q({
      'filter[app]': appId,
      'filter[platform]': 'IOS',
      'filter[state]': 'READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES',
      limit: '50',
    })}`,
  );
  const busy = subs.find((s) => ['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(attr(s, 'state')));
  if (busy) {
    report(ctx, 'unchanged', 'review submission', `already ${attr(busy, 'state')} (${busy.id})`);
    return busy.id;
  }
  let sub = subs.find((s) => ['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES'].includes(attr(s, 'state')));
  if (!sub) {
    reportChange(ctx, 'review submission (new)', { platform: 'IOS' });
    const created = await write(ctx, 'POST', '/v1/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    });
    if (!created) throw new Error('App Store Connect created no review submission');
    sub = created;
  }
  const { data: items } = await getAll(ctx, `/v1/reviewSubmissions/${sub.id}/items?limit=50`);
  if (!items.some((i) => relIds(i, 'appStoreVersion').includes(versionId))) {
    reportChange(ctx, 'review submission item', { appStoreVersion: versionId });
    await write(ctx, 'POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    });
  }
  reportChange(ctx, 'review submission', { submitted: true });
  await write(ctx, 'PATCH', `/v1/reviewSubmissions/${sub.id}`, {
    data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } },
  });
  return sub.id;
}

/**
 * Fills the whole record. Returns the report entries and the owner steps.
 * @param {{ api: Api, desired: Desired, dryRun?: boolean, submit?: boolean, upload?: UploadFn,
 *   sleep?: (ms: number) => Promise<void>, log?: (line: string) => void, pollTimeoutMs?: number }} p
 */
export async function syncAppStore({
  api,
  desired: d,
  dryRun = false,
  submit = false,
  upload = defaultUpload,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (line) => console.log(line),
  pollTimeoutMs = 10 * 60_000,
}) {
  if (submit && !d.reviewToken) {
    throw new Error(
      '--submit needs the review token: set the secret REVIEW_TOKEN (a revocable portal token for App Review)',
    );
  }
  /** @type {Ctx} */
  const ctx = {
    api,
    dryRun,
    upload,
    sleep,
    log,
    entries: [],
    ownerSteps: [],
    secrets: d.reviewToken ? [d.reviewToken] : [],
    pollTimeoutMs,
    seq: 0,
  };
  if (dryRun) log('dry run: nothing is written');
  const app = await findApp(ctx, d.bundleId);
  log(`app ${attr(app, 'name') || d.bundleId} (${app.id})`);
  const version = await ensureVersion(ctx, app.id, d);
  const locId = await syncVersionLocalization(ctx, version.id, d);
  await syncAppAttributes(ctx, app, d);
  const info = await editableAppInfo(ctx, app.id);
  await syncAppInfo(ctx, info, d);
  const review = await syncReviewDetail(ctx, version.id, d);
  await syncEula(ctx, app.id, d.eula);
  if (d.price === 'free') {
    await soft(
      ctx,
      'price',
      'Pricing and Availability → Price: set "Free" (USD 0.00, base territory United States).',
      () => syncPrice(ctx, app.id),
    );
  }
  await soft(
    ctx,
    'availability',
    `Pricing and Availability → Availability: all countries and regions except ${d.availability.excludeTerritories.join(', ') || 'none'}.`,
    () => syncAvailability(ctx, app.id, d.availability),
  );
  if (d.screenshots.length) await syncScreenshots(ctx, locId, d.screenshots);
  const build = await selectBuild(ctx, app.id, version.id, d.versionString);

  if (!review.hasPhone) {
    ctx.ownerSteps.push(
      'App Review contact phone: set the repository variable REVIEW_CONTACT_PHONE (international format, e.g. +43…) ' +
        'and rerun store-metadata.yml, or enter it under the version → App Review Information.',
    );
  }
  if (!review.hasNotes) {
    ctx.ownerSteps.push(
      'App Review notes: create a revocable reviewer token in the portal, set the secret REVIEW_TOKEN and rerun ' +
        'store-metadata.yml (the notes quote it; apps/site/STORE_CHECKLIST.md).',
    );
  }
  if (!build)
    ctx.ownerSteps.push(`Upload a build of ${d.versionString} (release-mobile.yml) and rerun.`);

  let submission = null;
  if (submit) {
    const blockers = [
      ...(build ? [] : ['no processed build']),
      ...(review.hasPhone ? [] : ['no review contact phone']),
      ...(review.hasNotes ? [] : ['no review notes']),
    ];
    if (blockers.length) throw new Error(`not submitting: ${blockers.join(', ')}`);
    submission = await submitForReview(ctx, app.id, version.id);
  } else {
    ctx.ownerSteps.push(
      'Submit: rerun store-metadata.yml with submit=true, or App Store Connect → the version → "Add for Review" → "Submit to App Review".',
    );
  }
  return {
    appId: app.id,
    versionId: version.id,
    versionAction: version.action,
    build,
    submission,
    entries: ctx.entries,
    ownerSteps: [...STATIC_OWNER_STEPS, ...ctx.ownerSteps],
  };
}

/** @type {UploadFn} */
async function defaultUpload({ method, url, headers, body }) {
  const res = await fetch(url, {
    method,
    headers,
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok)
    throw new Error(`screenshot upload ${method} ${new URL(url).host}: HTTP ${res.status}`);
}

/**
 * Human-readable API failure including App Store Connect's error details.
 * @param {unknown} e
 */
export function explainMetadataError(e) {
  if (!(e instanceof AscError)) return e instanceof Error ? e.message : String(e);
  /** @type {string[]} */
  let details = [];
  try {
    const body =
      /** @type {{ errors?: { code?: string, title?: string, detail?: string, source?: { pointer?: string }, meta?: { associatedErrors?: Record<string, { code?: string, title?: string, detail?: string }[]> } }[] }} */ (
        JSON.parse(e.body)
      );
    details = (body.errors ?? []).flatMap((x) => [
      `${x.code ?? ''}: ${x.detail ?? x.title ?? ''}${x.source?.pointer ? ` (${x.source.pointer})` : ''}`,
      // A 409 on a review submission lists the actual reasons here, keyed by resource path.
      ...Object.entries(x.meta?.associatedErrors ?? {}).flatMap(([path, list]) =>
        list.map((a) => `  ${path}: ${a.code ?? ''}: ${a.detail ?? a.title ?? ''}`),
      ),
    ]);
  } catch {
    if (e.body) details = [e.body.slice(0, 500)];
  }
  const hint =
    e.status === 401
      ? ' (key rejected: check ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_P8_B64)'
      : e.status === 403
        ? ' (the API key role may not change this; App Manager or Admin is needed)'
        : '';
  return `${e.message}${hint}${details.length ? `\n  ${details.join('\n  ')}` : ''}`;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { dryRun: false, submit: false, screenshots: true, version: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--submit') out.submit = true;
    else if (a === '--no-screenshots') out.screenshots = false;
    else if (a === '--version' && argv[i + 1]) out.version = String(argv[++i]);
    else throw new Error(`bad argument ${a ?? ''}`);
  }
  if (out.dryRun && out.submit) throw new Error('--dry-run and --submit exclude each other');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version =
    args.version || JSON.parse(readFileSync(join(MOBILE_DIR, 'package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`bad version ${version}`);
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH } = process.env;
  if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_PATH) {
    throw new Error('ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH must be set');
  }
  const desired = loadDesired({ version, withScreenshots: args.screenshots });
  if (args.submit && !desired.reviewToken) {
    throw new Error(
      '--submit needs the review token: set the secret REVIEW_TOKEN (a revocable portal token for App Review)',
    );
  }
  const privateKeyPem = readFileSync(ASC_KEY_PATH, 'utf8');
  const api = /** @type {Api} */ (
    /** @type {unknown} */ (
      createAscApi({
        token: () => ascJwt({ keyId: ASC_KEY_ID, issuerId: ASC_ISSUER_ID, privateKeyPem }),
      })
    )
  );
  console.log(
    `asc-metadata: ${desired.bundleId} ${version}${args.dryRun ? ' (dry run)' : ''}${args.submit ? ' (submit)' : ''}; ` +
      `screenshots: ${desired.screenshots.map((s) => `${s.displayType}×${s.files.length} (${basename(s.files[0]?.path ?? '')}…)`).join(', ') || 'skipped'}`,
  );
  const r = await syncAppStore({ api, desired, dryRun: args.dryRun, submit: args.submit });
  const counts = r.entries.reduce(
    (/** @type {Record<string, number>} */ acc, e) => ({
      ...acc,
      [e.status]: (acc[e.status] ?? 0) + 1,
    }),
    {},
  );
  console.log(
    `\nsummary: ${JSON.stringify({ appId: r.appId, version: version, versionAction: r.versionAction, build: r.build, submission: r.submission, ...counts })}`,
  );
  console.log('\nRemaining owner steps in App Store Connect (not possible through the API):');
  r.ownerSteps.forEach((s, i) => console.log(`${i + 1}. ${s}`));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      summary,
      [
        `### App Store metadata ${version}${args.dryRun ? ' (dry run)' : ''}`,
        '',
        '| Status | Item | Detail |',
        '| --- | --- | --- |',
        ...r.entries.map(
          (e) => `| ${e.status} | ${e.item} | ${(e.detail ?? '').replaceAll('|', '\\|')} |`,
        ),
        '',
        '#### Owner steps',
        '',
        ...r.ownerSteps.map((s, i) => `${i + 1}. ${s}`),
        '',
      ].join('\n'),
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`asc-metadata: ${explainMetadataError(e)}`);
    process.exit(1);
  });
}
