/** Public source repository (GPL-3.0 source offer). Change here if the repository moves. */
export const SOURCE_REPO_URL = 'https://github.com/refaustria/daisychess';
export const LICENSE_NAME = 'GPL-3.0-or-later';
export const LICENSE_URL = `${SOURCE_REPO_URL}/blob/main/LICENSE`;
export const NOTICES_URL = `${SOURCE_REPO_URL}/blob/main/THIRD_PARTY_NOTICES.md`;

/** Build identity (Vite `define`; the mobile build takes the version of apps/mobile). */
export const APP_VERSION: string = __APP_VERSION__;
export const APP_COMMIT: string = __APP_COMMIT__;
export const APP_BUILD: string = __APP_BUILD__;
export const IS_MOBILE_BUILD: boolean = __APP_MOBILE__;

/** Link to the exact source of this build: the `mobile-v<version>` tag in the app, the commit on the web. */
export function sourceLinkFor(
  info: { mobile: boolean; version: string; commit: string } = {
    mobile: IS_MOBILE_BUILD,
    version: APP_VERSION,
    commit: APP_COMMIT,
  },
): string {
  if (info.mobile) return `${SOURCE_REPO_URL}/tree/mobile-v${info.version}`;
  return info.commit ? `${SOURCE_REPO_URL}/tree/${info.commit}` : SOURCE_REPO_URL;
}
