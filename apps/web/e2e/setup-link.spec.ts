import { expect, test } from '@playwright/test';

test('a setup link stores the token, removes the fragment and shows a notice', async ({ page }) => {
  await page.goto('/#setup-token=test-token-123');
  await expect(page.locator('cg-board')).toBeVisible();
  await expect(page.getByTestId('app-notice')).toContainText(
    'Server access token saved on this device',
  );
  expect(new URL(page.url()).hash).toBe('');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Server access token')).toHaveValue('test-token-123');
  await expect(
    page.getByRole('button', { name: 'Copy link for another device' }),
  ).toBeEnabled();
});
