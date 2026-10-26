import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

describe('PGN open-with / share configuration (M26-5)', () => {
  it('Android: VIEW for the PGN MIME types and .pgn paths, SEND only for the PGN MIME types', () => {
    const m = read('android/app/src/main/AndroidManifest.xml');
    expect(m).toContain('android:mimeType="application/x-chess-pgn"');
    expect(m).toContain('android:mimeType="application/vnd.chess-pgn"');
    expect(m).toContain('android:scheme="content"');
    expect(m).toContain('android:pathPattern=".*\\\\.pgn"');
    const send =
      /<action android:name="android.intent.action.SEND" \/>[\s\S]*?<\/intent-filter>/.exec(m);
    expect(send?.[0]).toBeDefined();
    // Not a handler for every text share.
    expect(send?.[0]).not.toContain('text/plain');
    expect(send?.[0]).not.toContain('*/*');
  });

  it('Android: MainActivity turns a shared PGN (SEND + EXTRA_STREAM) into a VIEW intent', () => {
    const j = read('android/app/src/main/java/org/daisychess/app/MainActivity.java');
    expect(j).toContain('Intent.ACTION_SEND');
    expect(j).toContain('Intent.EXTRA_STREAM');
    expect(j).toContain('Intent.ACTION_VIEW');
  });

  it('iOS: exported type org.daisychess.pgn, document type, copy-in (no in-place opening)', () => {
    const p = read('ios/App/App/Info.plist');
    expect(p).toMatch(/<key>UTTypeIdentifier<\/key>\s*<string>org\.daisychess\.pgn<\/string>/);
    expect(p).toMatch(
      /<key>UTTypeConformsTo<\/key>\s*<array>\s*<string>public\.plain-text<\/string>/,
    );
    expect(p).toContain('<string>application/x-chess-pgn</string>');
    expect(p).toMatch(/public\.filename-extension<\/key>\s*<array>\s*<string>pgn<\/string>/);
    expect(p).toMatch(/<key>CFBundleDocumentTypes<\/key>/);
    expect(p).toMatch(/<key>LSSupportsOpeningDocumentsInPlace<\/key>\s*<false\/>/);
  });
});
