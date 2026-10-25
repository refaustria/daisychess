import { expect, test } from '@playwright/test';
import { watchProblems } from './helpers';

test.describe('3D hero', () => {
  test('renders a WebGL canvas when motion is allowed, and lazy-loads three only then', async ({ page }) => {
    const scripts: string[] = [];
    page.on('request', (r) => r.resourceType() === 'script' && scripts.push(new URL(r.url()).pathname));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const problems = await watchProblems(page);
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-hero', '3d', { timeout: 15_000 });
    await expect(html).toHaveAttribute('data-motion', 'smooth');
    const canvas = page.locator('[data-hero-visual] canvas.hero-canvas');
    await expect(canvas).toHaveCount(1);
    await expect(canvas).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('[data-hero-visual]')).toHaveClass(/is-3d/);
    await expect(page.locator('[data-hero-visual]')).toHaveAttribute('data-rendering', 'on');
    const size = await canvas.evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height, cw: c.clientWidth }));
    expect(size.w).toBeGreaterThan(100);
    expect(size.h).toBeGreaterThan(100);
    // devicePixelRatio cap of 2.
    expect(size.w / size.cw).toBeLessThanOrEqual(2.01);
    expect(scripts.some((s) => /\/assets\/hero-/.test(s))).toBe(true);
    expect(problems.console).toEqual([]);
    expect(problems.csp).toEqual([]);
  });

  test('pauses rendering when the hero is off screen or the tab is hidden', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    const visual = page.locator('[data-hero-visual]');
    await expect(visual).toHaveAttribute('data-rendering', 'on', { timeout: 15_000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(visual).toHaveAttribute('data-rendering', 'off');
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(visual).toHaveAttribute('data-rendering', 'on');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(visual).toHaveAttribute('data-rendering', 'off');
  });

  test('reduced motion: static image, no smooth scroll, no animation libraries, no three.js', async ({ page }) => {
    const scripts: string[] = [];
    page.on('request', (r) => r.resourceType() === 'script' && scripts.push(new URL(r.url()).pathname));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-hero', 'static');
    await expect(html).toHaveAttribute('data-motion', 'reduced');
    await expect(html).not.toHaveClass(/lenis/);
    await expect(page.locator('canvas')).toHaveCount(0);
    const img = page.locator('img.hero-fallback');
    await expect(img).toBeVisible();
    expect(await img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
    await expect(img).toHaveAttribute('alt', /pawn/);
    expect(scripts.filter((s) => /\/assets\/(hero|ScrollTrigger|motion)-/.test(s))).toEqual([]);
  });

  test('no WebGL: falls back to the image without errors', async ({ page }) => {
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      // @ts-expect-error -- test stub: deny WebGL contexts, keep 2D
      HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) {
        if (type.startsWith('webgl') || type === 'experimental-webgl') return null;
        return (orig as (this: HTMLCanvasElement, ...a: unknown[]) => unknown).call(this, type, ...rest);
      };
    });
    const problems = await watchProblems(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-hero', 'fallback', { timeout: 15_000 });
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(page.locator('img.hero-fallback')).toBeVisible();
    expect(problems.console).toEqual([]);
  });

  test('without JavaScript the content and the image are all there', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Every move');
    await expect(page.locator('img.hero-fallback')).toBeVisible();
    await expect(page.getByRole('link', { name: /Play now/ }).first()).toHaveAttribute('href', 'https://play.daisychess.org');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Features' })).toBeVisible();
    await ctx.close();
  });
});
