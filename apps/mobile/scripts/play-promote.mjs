#!/usr/bin/env node
// Promotes an already-uploaded versionCode to another Play track (e.g. internal → production)
// through the Android Publisher API v3: edits.insert → edits.tracks.update → edits.commit. No
// re-upload (Play rejects a versionCode twice). Auth and error helpers come from play-publish.mjs.
//
// Usage: node scripts/play-promote.mjs --package org.daisychess.app --version-code 9
//          [--track production] [--status completed] [--release-name "0.1.0 (9)"]
//          [--release-notes-en "First release."]
// Env: PLAY_SERVICE_ACCOUNT_JSON (the key file's JSON). Prints no credentials.
import { fileURLToPath } from 'node:url';
import {
  call,
  explainPlayError,
  fetchAccessToken,
  isDraftAppError,
  parseServiceAccount,
} from './play-publish.mjs';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

/**
 * Validates and normalises the inputs; throws a readable Error.
 * @param {{ packageName?: string, versionCode?: unknown, track?: string }} p
 * @returns {{ packageName: string, versionCode: number, track: string }}
 */
export function validatePromoteInput({ packageName, versionCode, track = 'production' }) {
  if (!packageName || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
    throw new Error('--package must be an Android package name like org.daisychess.app');
  }
  const s = String(versionCode ?? '');
  const vc = Number(s);
  if (!/^[0-9]+$/.test(s) || !Number.isSafeInteger(vc) || vc <= 0) {
    throw new Error('--version-code must be a positive integer');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(track)) {
    throw new Error('--track must be a track name such as production, beta, alpha or internal');
  }
  return { packageName, versionCode: vc, track };
}

/**
 * One edit: put the versionCode on the track, commit. The edit is deleted when a step fails.
 * @param {{ fetchImpl?: typeof fetch, accessToken: string, packageName: string, versionCode: number,
 *   track: string, status: string, releaseName?: string, releaseNotes?: string }} p
 * @returns {Promise<{ editId: string }>}
 */
export async function promoteVersion({
  fetchImpl = fetch,
  accessToken,
  packageName,
  versionCode,
  track,
  status,
  releaseName,
  releaseNotes,
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
            ...(releaseNotes ? { releaseNotes: [{ language: 'en-US', text: releaseNotes }] } : {}),
          },
        ],
      }),
    });
    await call(fetchImpl, `${API}/${app}/edits/${e}:commit`, { method: 'POST', headers: auth });
    return { editId };
  } catch (err) {
    await fetchImpl(`${API}/${app}/edits/${e}`, { method: 'DELETE', headers: auth }).catch(
      () => {},
    );
    throw err;
  }
}

/**
 * promoteVersion, retried once with status `draft` when Play says the app is still a draft.
 * @param {Parameters<typeof promoteVersion>[0]} p
 * @returns {Promise<{ editId: string, status: string, fellBackToDraft: boolean }>}
 */
export async function promoteWithDraftFallback(p) {
  try {
    return { ...(await promoteVersion(p)), status: p.status, fellBackToDraft: false };
  } catch (e) {
    if (p.status === 'draft' || !isDraftAppError(e)) throw e;
    const r = await promoteVersion({ ...p, status: 'draft' });
    return { ...r, status: 'draft', fellBackToDraft: true };
  }
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
  const { packageName, versionCode, track } = validatePromoteInput({
    packageName: args.package,
    versionCode: args['version-code'],
    track: args.track,
  });
  const json = process.env.PLAY_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not set');
  const accessToken = await fetchAccessToken({ sa: parseServiceAccount(json) });
  const r = await promoteWithDraftFallback({
    accessToken,
    packageName,
    versionCode,
    track,
    status: args.status ?? 'completed',
    releaseName: args['release-name'] || undefined,
    releaseNotes: args['release-notes-en'] || undefined,
  });
  if (r.fellBackToDraft) {
    console.log('note: Play says the app is still a draft; promoted as a draft release instead');
  }
  console.log(`promoted versionCode ${versionCode} to track ${track} (status ${r.status})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`play-promote: ${explainPlayError(e)}`);
    process.exit(1);
  });
}
