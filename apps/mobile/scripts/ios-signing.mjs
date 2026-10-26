#!/usr/bin/env node
// Manual App Store signing for the release workflow (M26-8). The committed project keeps automatic
// signing (developers' Xcode); the workflow switches only the App target's Release configuration to
// manual signing in its throw-away checkout. Command-line build settings would apply to every
// target, including the Swift package targets, which reject a provisioning profile.
//
// Usage:
//   node scripts/ios-signing.mjs patch <project.pbxproj> --team <id> --profile <name> --identity <sha1>
//   node scripts/ios-signing.mjs export-options <out.plist> --team <id> --bundle-id <id>
//        --profile <name> --identity <sha1>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{ teamId: string, bundleId: string, profileName: string, identity: string }} SigningParams
 */

/** @param {string} v */
function quote(v) {
  if (/["\\\n]/.test(v)) throw new Error(`unsupported character in ${JSON.stringify(v)}`);
  return `"${v}"`;
}

/** @param {SigningParams} p */
function validate(p) {
  if (!/^[A-Z0-9]{10}$/.test(p.teamId)) throw new Error(`bad team id ${p.teamId}`);
  if (!/^[A-Za-z0-9.-]+$/.test(p.bundleId)) throw new Error(`bad bundle id ${p.bundleId}`);
  if (!p.profileName) throw new Error('profile name is empty');
  if (!p.identity) throw new Error('signing identity is empty');
}

/**
 * Switches the Release XCBuildConfiguration whose PRODUCT_BUNDLE_IDENTIFIER is `bundleId` to
 * manual signing. Throws unless exactly one such configuration exists.
 * @param {string} pbxproj
 * @param {SigningParams} p
 */
export function patchManualSigning(pbxproj, p) {
  validate(p);
  const block =
    /(\t\t[0-9A-F]{24} \/\* Release \*\/ = \{\n\t\t\tisa = XCBuildConfiguration;\n[\s\S]*?\n\t\t\};\n)/g;
  let hits = 0;
  const out = pbxproj.replace(block, (cfg) => {
    if (!cfg.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${p.bundleId};`)) return cfg;
    hits++;
    const drop =
      /^\t\t\t\t("?CODE_SIGN_IDENTITY(\[sdk=iphoneos\*\])?"?|CODE_SIGN_STYLE|DEVELOPMENT_TEAM|PROVISIONING_PROFILE_SPECIFIER|PROVISIONING_PROFILE) = .*;\n/gm;
    const settings = [
      `\t\t\t\tCODE_SIGN_IDENTITY = ${quote(p.identity)};`,
      `\t\t\t\t"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = ${quote(p.identity)};`,
      '\t\t\t\tCODE_SIGN_STYLE = Manual;',
      `\t\t\t\tDEVELOPMENT_TEAM = ${p.teamId};`,
      `\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = ${quote(p.profileName)};`,
    ].join('\n');
    return cfg.replace(drop, '').replace(/(\t\t\tbuildSettings = \{\n)/, `$1${settings}\n`);
  });
  if (hits !== 1) {
    throw new Error(`expected one Release configuration for ${p.bundleId}, found ${hits}`);
  }
  return out;
}

/** @param {string} s */
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * ExportOptions.plist for `xcodebuild -exportArchive` (App Store Connect distribution, manual).
 * @param {SigningParams} p
 */
export function exportOptionsPlist(p) {
  validate(p);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>export</string>
	<key>teamID</key>
	<string>${xml(p.teamId)}</string>
	<key>signingStyle</key>
	<string>manual</string>
	<key>signingCertificate</key>
	<string>${xml(p.identity)}</string>
	<key>provisioningProfiles</key>
	<dict>
		<key>${xml(p.bundleId)}</key>
		<string>${xml(p.profileName)}</string>
	</dict>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>uploadSymbols</key>
	<true/>
	<key>stripSwiftSymbols</key>
	<true/>
</dict>
</plist>
`;
}

/** @param {string[]} argv */
function parseFlags(argv) {
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

function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!file)
    throw new Error(
      'usage: ios-signing.mjs <patch|export-options> <file> --team … --profile … --identity …',
    );
  const f = parseFlags(rest);
  const p = {
    teamId: f.team ?? '',
    bundleId: f['bundle-id'] ?? 'org.daisychess.app',
    profileName: f.profile ?? '',
    identity: f.identity ?? '',
  };
  if (cmd === 'patch') {
    writeFileSync(file, patchManualSigning(readFileSync(file, 'utf8'), p));
  } else if (cmd === 'export-options') {
    writeFileSync(file, exportOptionsPlist(p));
  } else {
    throw new Error(`unknown command ${cmd ?? ''}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`ios-signing: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
