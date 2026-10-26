import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// M26-4: with the safe-area insets simulated (Capacitor injects --safe-area-inset-* on old Android
// WebViews; iOS provides env()), the phone layout has no horizontal scroll and stays accessible.
test.use({ viewport: { width: 375, height: 812 } });

test('375 px with simulated insets: no horizontal scroll, header clears the notch, axe clean', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  // CSSOM, not a <style> tag: the production CSP forbids inline styles.
  await page.evaluate(() => {
    const st = document.documentElement.style;
    st.setProperty('--safe-area-inset-top', '47px');
    st.setProperty('--safe-area-inset-bottom', '34px');
    st.setProperty('--safe-area-inset-left', '8px');
    st.setProperty('--safe-area-inset-right', '8px');
  });
  const m = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    headerTop: document.querySelector('header')!.getBoundingClientRect().height,
    titleTop: document.querySelector('h1')!.getBoundingClientRect().top,
    // Phone layout (M29-6): the bottom tab bar pads itself above the home indicator.
    tabsPadBottom: getComputedStyle(document.querySelector('[data-testid="bottom-tabs"]')!)
      .paddingBottom,
    tabsBottom: document.querySelector('[data-testid="bottom-tabs"]')!.getBoundingClientRect()
      .bottom,
    tabBottom: document.querySelector('#tab-moves')!.getBoundingClientRect().bottom,
  }));
  expect(m.scroll).toBeLessThanOrEqual(m.client);
  // Compact 48 px header on phones (M29-6) below the 47 px notch.
  expect(m.headerTop).toBeGreaterThanOrEqual(48 + 47);
  expect(m.titleTop).toBeGreaterThanOrEqual(47);
  expect(m.tabsPadBottom).toBe('34px');
  expect(m.tabsBottom).toBeLessThanOrEqual(812);
  expect(m.tabBottom).toBeLessThanOrEqual(812 - 34);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
});
