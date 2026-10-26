import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pngHasAlphaChannel, readPngInfo } from '../scripts/png.mjs';
import { SCENES, SIZES } from '../scripts/store-screenshots.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = path.join(root, 'store');
const png = (...p: string[]) => readFileSync(path.join(root, ...p));
const res = 'android/app/src/main/res';

describe('store listing texts', () => {
  const l = JSON.parse(readFileSync(path.join(store, 'listing.en.json'), 'utf8')) as {
    developer: string;
    google: Record<'title' | 'shortDescription' | 'fullDescription', string>;
    apple: Record<'name' | 'subtitle' | 'promotionalText' | 'description' | 'keywords', string>;
  };
  const len = (s: string) => [...s].length;

  it('Google limits: title 30, short 80, full 4000', () => {
    expect(len(l.google.title)).toBeLessThanOrEqual(30);
    expect(len(l.google.shortDescription)).toBeLessThanOrEqual(80);
    expect(len(l.google.fullDescription)).toBeLessThanOrEqual(4000);
  });

  it('Apple limits: name 30, subtitle 30, promo 170, description 4000, keywords 100', () => {
    expect(len(l.apple.name)).toBeLessThanOrEqual(30);
    expect(len(l.apple.subtitle)).toBeLessThanOrEqual(30);
    expect(len(l.apple.promotionalText)).toBeLessThanOrEqual(170);
    expect(len(l.apple.description)).toBeLessThanOrEqual(4000);
    expect(len(l.apple.keywords)).toBeLessThanOrEqual(100);
    expect(l.apple.keywords).not.toMatch(/\s|,,|^,|,$/);
    // No third-party names and no features we do not have (puzzles exist since M30).
    expect(l.apple.keywords).not.toMatch(/tactic|lichess|chess\.com/i);
    expect(l.apple.keywords).toMatch(/(^|,)puzzles?(,|$)/);
  });

  it('names the publisher and makes no false claims', () => {
    expect(l.developer).toBe('INCEPTUM e.U.');
    for (const text of [l.google.fullDescription, l.apple.description]) {
      expect(text).toMatch(/No ads/);
      expect(text).toMatch(/GPL-3\.0-or-later/);
      expect(text).toMatch(/INCEPTUM e\.U\./);
    }
  });
});

describe('icons and graphics meet the store specs', () => {
  it('iOS app icon: 1024x1024, no alpha', () => {
    const b = png('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
    expect(readPngInfo(b)).toMatchObject({ width: 1024, height: 1024, bitDepth: 8 });
    expect(pngHasAlphaChannel(b)).toBe(false);
    const m = png('store/app-store-icon-1024.png');
    expect(readPngInfo(m)).toMatchObject({ width: 1024, height: 1024 });
    expect(pngHasAlphaChannel(m)).toBe(false);
  });

  it('Play icon: 512x512, 32-bit PNG, at most 1 MB', () => {
    const b = png('store/play-icon-512.png');
    expect(readPngInfo(b)).toMatchObject({ width: 512, height: 512, bitDepth: 8, colorType: 6 });
    expect(b.length).toBeLessThanOrEqual(1024 * 1024);
  });

  it('Play feature graphic: 1024x500, no alpha, at most 15 MB', () => {
    const b = png('store/play-feature-graphic-1024x500.png');
    expect(readPngInfo(b)).toMatchObject({ width: 1024, height: 500 });
    expect(pngHasAlphaChannel(b)).toBe(false);
    expect(b.length).toBeLessThanOrEqual(15 * 1024 * 1024);
  });

  it('Android launcher layers per density', () => {
    const d = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
    for (const [name, s] of Object.entries(d)) {
      for (const f of ['ic_launcher_foreground', 'ic_launcher_monochrome']) {
        const info = readPngInfo(png(res, `mipmap-${name}/${f}.png`));
        expect([info.width, info.height, info.colorType]).toEqual([108 * s, 108 * s, 6]);
      }
      for (const f of ['ic_launcher', 'ic_launcher_round']) {
        const info = readPngInfo(png(res, `mipmap-${name}/${f}.png`));
        expect([info.width, info.height]).toEqual([48 * s, 48 * s]);
      }
    }
    for (const f of ['ic_launcher', 'ic_launcher_round']) {
      expect(readFileSync(path.join(root, res, `mipmap-anydpi-v26/${f}.xml`), 'utf8')).toContain(
        '<monochrome',
      );
    }
  });

  it('splash images: iOS 2732 light + dark, Android night variants exist', () => {
    const set = 'ios/App/App/Assets.xcassets/Splash.imageset';
    for (const f of readdirSync(path.join(root, set)).filter((n) => n.endsWith('.png'))) {
      expect(readPngInfo(png(set, f))).toMatchObject({ width: 2732, height: 2732 });
    }
    const contents = JSON.parse(readFileSync(path.join(root, set, 'Contents.json'), 'utf8')) as {
      images: { appearances?: unknown[] }[];
    };
    expect(contents.images.filter((i) => i.appearances).length).toBe(3);
    for (const q of ['night', 'port-night-hdpi', 'land-night-xxxhdpi']) {
      expect(statSync(path.join(root, res, `drawable-${q}/splash.png`)).size).toBeGreaterThan(0);
    }
  });
});

describe('store screenshots', () => {
  // Pixel sizes per store; Google: 320-3840 px, long side at most 2x the short side.
  const sizes = Object.entries(SIZES) as [
    string,
    { store: string; width: number; height: number },
  ][];
  it('declares the required sizes', () => {
    const apple = sizes
      .filter(([, s]) => s.store === 'apple')
      .map(([, s]) => `${s.width}x${s.height}`);
    expect(apple.sort()).toEqual(['1320x2868', '2064x2752']);
    for (const [, s] of sizes.filter(([, s]) => s.store === 'google')) {
      const [a, b] = [Math.min(s.width, s.height), Math.max(s.width, s.height)];
      expect(a).toBeGreaterThanOrEqual(320);
      expect(b).toBeLessThanOrEqual(3840);
      expect(b / a).toBeLessThanOrEqual(2);
    }
    expect(SCENES.filter((c) => c.theme === 'dark')).toHaveLength(1);
  });

  it('committed screenshots match their size, are opaque and 4 to 10 per set', () => {
    for (const [id, s] of sizes) {
      const dir = path.join(store, 'screenshots', id);
      const files = readdirSync(dir).filter((f) => f.endsWith('.png'));
      expect(files.length, id).toBe(SCENES.length);
      expect(SCENES.length).toBe(6);
      for (const f of files) {
        const b = readFileSync(path.join(dir, f));
        expect(readPngInfo(b), `${id}/${f}`).toMatchObject({ width: s.width, height: s.height });
        expect(pngHasAlphaChannel(b), `${id}/${f}`).toBe(false);
        expect(b.length, `${id}/${f}`).toBeLessThanOrEqual(8 * 1024 * 1024);
      }
    }
  });
});
