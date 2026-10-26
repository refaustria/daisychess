#!/usr/bin/env node
// App Store provisioning profile for the release pipeline (M26-8, ADR-022 §6): finds or creates an
// active IOS_APP_STORE profile for the bundle id that contains the distribution certificate the
// workflow imported from IOS_DIST_CERT_P12_B64, through the App Store Connect API (ES256 JWT from
// the team API key). An existing profile with the same name is reused while it is ACTIVE, contains
// that certificate and is valid for at least `minValidDays`; stale ones (expired, INVALID after a
// capability change, other certificate) are deleted and replaced.
//
// Usage: node scripts/asc-profile.mjs --bundle-id org.daisychess.app --cert <pem file>
//          --name "DaisyChess App Store CI" --out <file.mobileprovision>
// Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the .p8 file). Prints one JSON line
// {uuid, name, action, expirationDate, identitySha1}; no key material is ever printed.
import { X509Certificate, createHash, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ASC_BASE = 'https://api.appstoreconnect.apple.com';

/** @param {Buffer | string} data */
export function base64url(data) {
  return Buffer.from(data).toString('base64url');
}

/**
 * App Store Connect API token (ES256, 20 min maximum lifetime; we use 15).
 * @param {{ keyId: string, issuerId: string, privateKeyPem: string, now?: number }} p
 */
export function ascJwt({ keyId, issuerId, privateKeyPem, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iss: issuerId, iat, exp: iat + 15 * 60, aud: 'appstoreconnect-v1' }),
  );
  const input = `${header}.${payload}`;
  // JWS wants the raw r||s signature, not DER.
  const sig = sign('sha256', Buffer.from(input), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return `${input}.${base64url(sig)}`;
}

export class AscError extends Error {
  /** @param {string} message @param {number} status @param {string} body */
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * @typedef {{ id: string, type: string, attributes?: Record<string, unknown>,
 *   relationships?: Record<string, { data?: { id: string, type: string } | { id: string, type: string }[] }> }} AscResource
 * @typedef {(method: string, path: string, body?: unknown) => Promise<{ data?: AscResource | AscResource[] } | null>} AscRequest
 */

/**
 * @param {{ token: () => string, fetchImpl?: typeof fetch, base?: string }} p
 * @returns {AscRequest}
 */
export function createAscApi({ token, fetchImpl = fetch, base = ASC_BASE }) {
  return async (method, path, body) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new AscError(`${method} ${path.split('?')[0]}: HTTP ${res.status}`, res.status, text);
    }
    return text ? JSON.parse(text) : null;
  };
}

/** @param {{ data?: AscResource | AscResource[] } | null} r @returns {AscResource[]} */
function list(r) {
  const d = r?.data;
  return Array.isArray(d) ? d : d ? [d] : [];
}

/** @param {AscResource} r @param {string} k @returns {string} */
function attr(r, k) {
  const v = r.attributes?.[k];
  return typeof v === 'string' ? v : '';
}

/** @param {AscResource} r @param {string} rel @returns {string[]} */
function relIds(r, rel) {
  const d = r.relationships?.[rel]?.data;
  if (!d) return [];
  return (Array.isArray(d) ? d : [d]).map((x) => x.id);
}

/**
 * All certificates in a PEM bundle (the keychain export may contain more than the leaf).
 * @param {string} pem
 * @returns {X509Certificate[]}
 */
export function parsePemBundle(pem) {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((b) => new X509Certificate(b));
}

/** @param {Buffer} der */
const sha256 = (der) => createHash('sha256').update(der).digest('hex');

/**
 * @typedef {{ uuid: string, name: string, action: 'reused' | 'created', expirationDate: string,
 *   identitySha1: string, content: Buffer, deleted: string[] }} ProfileResult
 */

/**
 * @param {{ api: AscRequest, bundleIdentifier: string, certs: X509Certificate[],
 *   profileName: string, minValidDays?: number, now?: number }} p
 * @returns {Promise<ProfileResult>}
 */
export async function ensureAppStoreProfile({
  api,
  bundleIdentifier,
  certs,
  profileName,
  minValidDays = 7,
  now = Date.now(),
}) {
  if (certs.length === 0) throw new Error('no certificate given (empty PEM)');

  const q = (/** @type {Record<string, string>} */ o) => new URLSearchParams(o).toString();
  const bundles = list(
    await api(
      'GET',
      `/v1/bundleIds?${q({ 'filter[identifier]': bundleIdentifier, limit: '200' })}`,
    ),
  ).filter((b) => attr(b, 'identifier') === bundleIdentifier);
  const bundle = bundles[0];
  if (!bundle) {
    throw new Error(
      `bundle id ${bundleIdentifier} is not registered in the team (Certificates, Identifiers & Profiles → Identifiers)`,
    );
  }

  const ascCerts = list(
    await api(
      'GET',
      `/v1/certificates?${q({ 'filter[certificateType]': 'DISTRIBUTION,IOS_DISTRIBUTION', limit: '200' })}`,
    ),
  );
  const local = new Map(certs.map((c) => [sha256(c.raw), c]));
  let ascCert = null;
  let localCert = null;
  for (const c of ascCerts) {
    const content = attr(c, 'certificateContent');
    if (!content) continue;
    const hit = local.get(sha256(Buffer.from(content, 'base64')));
    if (hit) {
      ascCert = c;
      localCert = hit;
      break;
    }
  }
  if (!ascCert || !localCert) {
    throw new Error(
      'the distribution certificate from IOS_DIST_CERT_P12_B64 is not (or no longer) registered in the team ' +
        '(revoked or expired?): export a current Apple Distribution certificate and run scripts/mobile/set-ios-secrets.sh',
    );
  }
  const identitySha1 = localCert.fingerprint.replace(/:/g, '');

  const profiles = list(
    await api(
      'GET',
      `/v1/profiles?${q({
        'filter[name]': profileName,
        'filter[profileType]': 'IOS_APP_STORE',
        include: 'bundleId,certificates',
        'limit[certificates]': '50',
        limit: '200',
      })}`,
    ),
  ).filter((p) => attr(p, 'name') === profileName);

  const minExpiry = now + minValidDays * 86_400_000;
  const usable = profiles.find(
    (p) =>
      attr(p, 'profileState') === 'ACTIVE' &&
      Date.parse(attr(p, 'expirationDate')) > minExpiry &&
      relIds(p, 'bundleId').includes(bundle.id) &&
      relIds(p, 'certificates').includes(ascCert.id) &&
      attr(p, 'profileContent') !== '',
  );
  if (usable) {
    return {
      uuid: attr(usable, 'uuid'),
      name: profileName,
      action: 'reused',
      expirationDate: attr(usable, 'expirationDate'),
      identitySha1,
      content: Buffer.from(attr(usable, 'profileContent'), 'base64'),
      deleted: [],
    };
  }

  // Same-name stale profiles would make PROVISIONING_PROFILE_SPECIFIER ambiguous: remove them.
  /** @type {string[]} */
  const deleted = [];
  for (const p of profiles) {
    await api('DELETE', `/v1/profiles/${encodeURIComponent(p.id)}`);
    deleted.push(p.id);
  }
  const created = list(
    await api('POST', '/v1/profiles', {
      data: {
        type: 'profiles',
        attributes: { name: profileName, profileType: 'IOS_APP_STORE' },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: bundle.id } },
          certificates: { data: [{ type: 'certificates', id: ascCert.id }] },
        },
      },
    }),
  )[0];
  if (!created || !attr(created, 'profileContent')) {
    throw new Error('App Store Connect created no profile content');
  }
  return {
    uuid: attr(created, 'uuid'),
    name: profileName,
    action: 'created',
    expirationDate: attr(created, 'expirationDate'),
    identitySha1,
    content: Buffer.from(attr(created, 'profileContent'), 'base64'),
    deleted,
  };
}

/**
 * Human hint for an API failure (the workflow prints it as an ::error::).
 * @param {unknown} e
 */
export function explainAscError(e) {
  if (!(e instanceof AscError)) return e instanceof Error ? e.message : String(e);
  if (e.status === 401) {
    return `${e.message}: the API key was rejected (check ASC_KEY_ID, ASC_ISSUER_ID and ASC_API_KEY_P8_B64; revoked key?)`;
  }
  if (e.status === 403) {
    return (
      `${e.message}: the API key may not manage provisioning profiles (role too low). Either use a key ` +
      'with the Admin or App Manager role with access to Certificates, Identifiers & Profiles, or set the ' +
      'secret IOS_PROVISIONING_PROFILE_B64 to a manually created App Store profile (deploy/README.md).'
    );
  }
  return `${e.message} ${e.body.slice(0, 500)}`;
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
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH } = process.env;
  if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_PATH) {
    throw new Error('ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH must be set');
  }
  for (const k of ['bundle-id', 'cert', 'name', 'out']) {
    if (!args[k]) throw new Error(`--${k} is required`);
  }
  const privateKeyPem = readFileSync(ASC_KEY_PATH, 'utf8');
  const api = createAscApi({
    token: () => ascJwt({ keyId: ASC_KEY_ID, issuerId: ASC_ISSUER_ID, privateKeyPem }),
  });
  const r = await ensureAppStoreProfile({
    api,
    bundleIdentifier: String(args['bundle-id']),
    certs: parsePemBundle(readFileSync(String(args.cert), 'utf8')),
    profileName: String(args.name),
  });
  writeFileSync(String(args.out), r.content, { mode: 0o600 });
  console.log(
    JSON.stringify({
      uuid: r.uuid,
      name: r.name,
      action: r.action,
      expirationDate: r.expirationDate,
      identitySha1: r.identitySha1,
      deleted: r.deleted,
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`asc-profile: ${explainAscError(e)}`);
    process.exit(1);
  });
}
