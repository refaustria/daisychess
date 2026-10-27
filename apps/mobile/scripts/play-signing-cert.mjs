#!/usr/bin/env node
// Prints the Play App Signing certificate SHA-256 of a package through the Android Publisher API
// (generatedApks.list), for the repository variable PLAY_SIGNING_SHA256 that deploy/deploy-web.sh
// renders into /.well-known/assetlinks.json (Android App Links need the *app signing* key that
// Google re-signs with, not the upload key). Auth helpers come from play-publish.mjs.
//
// Usage: node scripts/play-signing-cert.mjs --package org.daisychess.app --version-code 9
// Env: PLAY_SERVICE_ACCOUNT_JSON (the key file's JSON). Prints no credentials.
import { fileURLToPath } from 'node:url';
import {
  PlayError,
  explainPlayError,
  fetchAccessToken,
  parseServiceAccount,
} from './play-publish.mjs';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

/**
 * Normalises a certificate hash (64 hex chars, or base64/base64url of 32 bytes) to the
 * colon-separated uppercase form of keytool and PLAY_SIGNING_SHA256.
 * @param {string} value
 * @returns {string}
 */
export function formatFingerprint(value) {
  const v = value.trim().replace(/[:\s]/g, '');
  /** @type {Buffer} */
  let bytes;
  if (/^[0-9a-fA-F]{64}$/.test(v)) bytes = Buffer.from(v, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) bytes = Buffer.from(v, 'base64');
  else throw new Error(`unrecognised certificate hash format (length ${v.length})`);
  if (bytes.length !== 32)
    throw new Error(`certificate hash is ${bytes.length} bytes, expected 32`);
  return bytes.toString('hex').toUpperCase().replace(/../g, '$&:').slice(0, -1);
}

/**
 * @param {{ fetchImpl?: typeof fetch, accessToken: string, packageName: string, versionCode: number }} p
 * @returns {Promise<string[]>} distinct fingerprints, colon-separated uppercase
 */
export async function fetchSigningCerts({
  fetchImpl = fetch,
  accessToken,
  packageName,
  versionCode,
}) {
  const url = `${API}/${encodeURIComponent(packageName)}/generatedApks/${versionCode}`;
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new PlayError(`GET generatedApks/${versionCode}: HTTP ${res.status}`, res.status, text);
  }
  const body = /** @type {{ generatedApks?: { certificateSha256Hash?: unknown }[] }} */ (
    text ? JSON.parse(text) : {}
  );
  const out = new Set();
  for (const apk of body.generatedApks ?? []) {
    if (typeof apk.certificateSha256Hash === 'string') {
      out.add(formatFingerprint(apk.certificateSha256Hash));
    }
  }
  if (out.size === 0) {
    throw new Error(
      `no generated APKs with a certificate for versionCode ${versionCode} (not processed by Play yet?)`,
    );
  }
  return [...out];
}

/** @param {unknown} e */
export function explainSigningCertError(e) {
  if (e instanceof PlayError && (e.status === 403 || e.status === 404)) {
    return (
      `${e.message}: ${e.body.slice(0, 500)}\nHint: check that versionCode exists in Play Console, ` +
      'that Play App Signing is enabled, and that the service account has app access ' +
      '(view app information / release permissions) in Users and permissions.'
    );
  }
  return explainPlayError(e);
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
  const versionCode = Number(args['version-code']);
  if (!args.package || !Number.isInteger(versionCode) || versionCode <= 0) {
    throw new Error('--package and a positive integer --version-code are required');
  }
  const json = process.env.PLAY_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not set');
  const accessToken = await fetchAccessToken({ sa: parseServiceAccount(json) });
  const certs = await fetchSigningCerts({ accessToken, packageName: args.package, versionCode });
  for (const c of certs) console.log(`app signing SHA-256: ${c}`);
  console.log(`PLAY_SIGNING_SHA256=${certs.join(',')}`);
  console.log(`(lowercase hex: ${certs.map((c) => c.replace(/:/g, '').toLowerCase()).join(',')})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`play-signing-cert: ${explainSigningCertError(e)}`);
    process.exit(1);
  });
}
