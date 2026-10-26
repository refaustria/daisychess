#!/usr/bin/env node
// Version gate of the mobile release workflow (M26-8, ADR-022 §6). Marketing version =
// apps/mobile/package.json `version` (checked against a `mobile-v<semver>` tag); build number
// (Android versionCode, iOS CFBundleVersion) = the workflow run number.
// Usage: node scripts/release-version.mjs <ref name or ''> <run number>
// Prints `version=…` and `build_number=…` lines (for $GITHUB_OUTPUT); exits 1 with a message.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Store versions are plain x.y.z (App Store: up to three integers; pre-release tags are rejected).
const STORE_SEMVER = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
/** Play's versionCode ceiling. */
export const MAX_VERSION_CODE = 2_100_000_000;

/**
 * @param {{ packageVersion: string, refName: string | null, runNumber: string }} p
 * @returns {{ version: string, buildNumber: number }}
 */
export function resolveReleaseVersion({ packageVersion, refName, runNumber }) {
  if (!STORE_SEMVER.test(packageVersion)) {
    throw new Error(
      `apps/mobile/package.json version ${packageVersion} is not a store version x.y.z`,
    );
  }
  if (refName !== null) {
    const m = /^mobile-v(.+)$/.exec(refName);
    if (!m) throw new Error(`ref ${refName} is not a mobile-v<x.y.z> tag`);
    if (m[1] !== packageVersion) {
      throw new Error(
        `tag ${refName} does not match apps/mobile/package.json version ${packageVersion}`,
      );
    }
  }
  const buildNumber = Number(runNumber);
  if (!Number.isInteger(buildNumber) || buildNumber < 1 || buildNumber > MAX_VERSION_CODE) {
    throw new Error(`bad run number ${runNumber}`);
  }
  return { version: packageVersion, buildNumber };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [ref = '', run = ''] = process.argv.slice(2);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const r = resolveReleaseVersion({
      packageVersion: String(pkg.version),
      refName: ref === '' ? null : ref,
      runNumber: run,
    });
    console.log(`version=${r.version}\nbuild_number=${r.buildNumber}`);
  } catch (e) {
    console.error(`release-version: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
