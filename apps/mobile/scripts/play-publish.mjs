#!/usr/bin/env node
// Uploads a signed AAB to a Google Play track through the Android Publisher API v3 (M26-8,
// ADR-022 §6): edits.insert → edits.bundles.upload → edits.tracks.update → edits.commit, with a
// service-account JWT (RS256). Replaces the Gradle Play Publisher plugin of the ADR (no Gradle
// plugin in the committed project, no extra dependency; the four calls are all we need).
//
// Play App Signing stays on: the AAB is signed with the *upload* key, Google re-signs it.
// The API answers 403/404 for a package that has never had an AAB uploaded in Play Console, so the
// first upload is manual (deploy/README.md "Mobile release"); the workflow calls this script only
// when the repository variable PLAY_PUBLISH_ENABLED is 'true'.
//
// Usage: node scripts/play-publish.mjs --aab <file> --package org.daisychess.app
//          [--track internal] [--status completed] [--release-name "0.1.0 (42)"]
// Env: PLAY_SERVICE_ACCOUNT_JSON (the key file's JSON). Prints no credentials.
import { createHash, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';

/**
 * @typedef {{ client_email: string, private_key: string, token_uri?: string }} ServiceAccount
 */

/**
 * @param {string} json
 * @returns {ServiceAccount}
 */
export function parseServiceAccount(json) {
  /** @type {unknown} */
  let v;
  try {
    v = JSON.parse(json);
  } catch {
    throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  const o = /** @type {Record<string, unknown>} */ (v && typeof v === 'object' ? v : {});
  if (typeof o.client_email !== 'string' || typeof o.private_key !== 'string') {
    throw new Error(
      'PLAY_SERVICE_ACCOUNT_JSON lacks client_email/private_key (not a service account key?)',
    );
  }
  return {
    client_email: o.client_email,
    private_key: o.private_key,
    token_uri: typeof o.token_uri === 'string' ? o.token_uri : undefined,
  };
}

/**
 * OAuth2 JWT-bearer assertion for a service account (RFC 7523).
 * @param {{ sa: ServiceAccount, scope?: string, now?: number }} p
 */
export function googleAssertion({ sa, scope = PUBLISHER_SCOPE, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const b64 = (/** @type {unknown} */ o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope,
    aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  })}`;
  const sig = sign('sha256', Buffer.from(input), sa.private_key);
  return `${input}.${sig.toString('base64url')}`;
}

export class PlayError extends Error {
  /** @param {string} message @param {number} status @param {string} body */
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Record<string, unknown>>}
 */
async function call(fetchImpl, url, init) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(10 * 60_000), ...init });
  const text = await res.text();
  if (!res.ok) {
    const path = new URL(url).pathname.replace(/^.*\/applications\//, '');
    throw new PlayError(`${init.method ?? 'GET'} ${path}: HTTP ${res.status}`, res.status, text);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * @param {{ sa: ServiceAccount, fetchImpl?: typeof fetch, now?: number }} p
 * @returns {Promise<string>}
 */
export async function fetchAccessToken({ sa, fetchImpl = fetch, now }) {
  const r = await call(fetchImpl, sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: googleAssertion({ sa, now }),
    }).toString(),
  });
  if (typeof r.access_token !== 'string')
    throw new Error('token endpoint returned no access_token');
  return r.access_token;
}

/**
 * One edit: upload the bundle, put it on the track, commit. The edit is deleted when a step fails
 * (an uncommitted edit would otherwise block nothing but clutters the console).
 * @param {{ fetchImpl?: typeof fetch, accessToken: string, packageName: string, aab: Buffer,
 *   track: string, status: string, releaseName?: string }} p
 * @returns {Promise<{ versionCode: number, editId: string }>}
 */
export async function publishBundle({
  fetchImpl = fetch,
  accessToken,
  packageName,
  aab,
  track,
  status,
  releaseName,
}) {
  const auth = { authorization: `Bearer ${accessToken}` };
  const app = encodeURIComponent(packageName);
  const edit = await call(fetchImpl, `${API}/${app}/edits`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: '{}',
  });
  const editId = String(edit.id ?? '');
  if (!editId) throw new Error('edits.insert returned no id');
  const e = encodeURIComponent(editId);
  try {
    const bundle = await call(fetchImpl, `${UPLOAD}/${app}/edits/${e}/bundles?uploadType=media`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(aab),
    });
    const versionCode = Number(bundle.versionCode);
    if (!Number.isInteger(versionCode)) throw new Error('bundles.upload returned no versionCode');
    const local = createHash('sha256').update(aab).digest('hex');
    if (typeof bundle.sha256 === 'string' && bundle.sha256.toLowerCase() !== local) {
      throw new Error(`uploaded bundle sha256 ${bundle.sha256} != local ${local}`);
    }
    await call(fetchImpl, `${API}/${app}/edits/${e}/tracks/${encodeURIComponent(track)}`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        track,
        releases: [
          {
            ...(releaseName ? { name: releaseName } : {}),
            versionCodes: [String(versionCode)],
            status,
          },
        ],
      }),
    });
    await call(fetchImpl, `${API}/${app}/edits/${e}:commit`, { method: 'POST', headers: auth });
    return { versionCode, editId };
  } catch (err) {
    await fetchImpl(`${API}/${app}/edits/${e}`, { method: 'DELETE', headers: auth }).catch(
      () => {},
    );
    throw err;
  }
}

/** A draft app (never reviewed) accepts only draft releases. */
export function isDraftAppError(/** @type {unknown} */ e) {
  return e instanceof PlayError && e.status === 400 && /draft app/i.test(e.body);
}

/**
 * publishBundle, retried once with status `draft` when Play says the app is still a draft.
 * @param {Parameters<typeof publishBundle>[0]} p
 * @returns {Promise<{ versionCode: number, editId: string, status: string }>}
 */
export async function publishWithDraftFallback(p) {
  try {
    return { ...(await publishBundle(p)), status: p.status };
  } catch (e) {
    if (p.status === 'draft' || !isDraftAppError(e)) throw e;
    return { ...(await publishBundle({ ...p, status: 'draft' })), status: 'draft' };
  }
}

/** @param {unknown} e */
export function explainPlayError(e) {
  if (!(e instanceof PlayError)) return e instanceof Error ? e.message : String(e);
  const body = e.body.slice(0, 500);
  if (e.status === 401 || e.status === 403 || e.status === 404) {
    return (
      `${e.message}: ${body}\nHint: the package needs one manual AAB upload in Play Console before the API ` +
      'knows it, and the service account needs release permissions for the app (Users and permissions). ' +
      'Until then keep PLAY_PUBLISH_ENABLED unset and upload the workflow artifact by hand.'
    );
  }
  if (/versionCode/i.test(body) && /already/i.test(body)) {
    return `${e.message}: ${body}\nHint: this versionCode was used before (the run number must exceed the manual upload's).`;
  }
  return `${e.message}: ${body}`;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith('--') || v === undefined) throw new Error(`bad argument ${k ?? ''}`);
    out[k.slice(2)] = v;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.aab || !args.package) throw new Error('--aab and --package are required');
  const json = process.env.PLAY_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not set');
  const sa = parseServiceAccount(json);
  const accessToken = await fetchAccessToken({ sa });
  const r = await publishWithDraftFallback({
    accessToken,
    packageName: args.package,
    aab: readFileSync(args.aab),
    track: args.track ?? 'internal',
    status: args.status ?? 'completed',
    releaseName: args['release-name'],
  });
  console.log(
    `published versionCode ${r.versionCode} of ${args.package} to track ${args.track ?? 'internal'} (status ${r.status})`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`play-publish: ${explainPlayError(e)}`);
    process.exit(1);
  });
}
