import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const readRepo = (rel: string): string =>
  readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

describe('deep link configuration (ADR-022 §4)', () => {
  it('apple-app-site-association claims setup and room fragments for the app id', () => {
    const aasa = JSON.parse(readRepo('apps/web/public/.well-known/apple-app-site-association'));
    const [detail] = aasa.applinks.details;
    expect(detail.appIDs).toEqual(['PM7LTV7M72.org.daisychess.app']);
    expect(detail.components.map((c: Record<string, string>) => [c['/'], c['#']])).toEqual([
      ['/', 'setup-token=*'],
      ['/', '/room/*'],
    ]);
  });

  it('assetlinks template carries the package and exactly one placeholder', () => {
    const raw = readRepo('deploy/assetlinks.json.template');
    const [entry] = JSON.parse(raw);
    expect(entry.target.package_name).toBe('org.daisychess.app');
    expect(entry.target.sha256_cert_fingerprints).toEqual(['<PLAY_SIGNING_SHA256>']);
    // The placeholder is never served from the web build.
    expect(() => readRepo('apps/web/public/.well-known/assetlinks.json')).toThrow();
  });

  it('iOS: associated domain entitlement in both build configurations, scheme registered', () => {
    expect(read('ios/App/App/App.entitlements')).toContain(
      '<string>applinks:play.daisychess.org</string>',
    );
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
    expect(pbx.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g)).toHaveLength(2);
    const plist = read('ios/App/App/Info.plist');
    expect(plist).toMatch(
      /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>daisychess<\/string>/,
    );
  });

  it('Android: verified App Link on exact path / and the scheme hosts', () => {
    const m = read('android/app/src/main/AndroidManifest.xml');
    expect(m).toContain('android:autoVerify="true"');
    expect(m).toContain(
      'android:scheme="https" android:host="play.daisychess.org" android:path="/"',
    );
    // Only the https App Link must stay path-exact; the PGN filters (M26-5) use content/file URIs.
    expect(m).not.toMatch(/<data[^>]*android:scheme="https"[^>]*(pathPrefix|pathPattern)/);
    expect(m).toContain('android:scheme="daisychess" android:host="setup"');
    expect(m).toContain('android:scheme="org.daisychess.app" android:host="lichess-callback"');
  });
});
