import { test } from '@playwright/test';

const OUT = 'test-results/screenshots';
const SIZES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

for (const size of SIZES) {
  for (const [name, path] of [
    ['home', '/'],
    ['features', '/features/'],
  ] as const) {
    test(`screenshot ${name} ${size.name}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      // With motion: the first screen as visitors see it (3D pawn after the intro).
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      if (name === 'home') await page.locator('html[data-hero="3d"]').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(3200);
      await page.screenshot({ path: `${OUT}/${name}-${size.name}.png` });
      // Full page without motion (scroll reveals would leave not-yet-revealed sections empty).
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: `${OUT}/${name}-${size.name}-full.png`, fullPage: true });
    });
  }
}

test('screenshot home dark desktop', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.locator('html[data-hero="3d"]').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(3200);
  await page.screenshot({ path: `${OUT}/home-desktop-dark.png` });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.screenshot({ path: `${OUT}/home-desktop-dark-full.png`, fullPage: true });
});
