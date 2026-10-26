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
  await expect(page.getByRole('button', { name: 'Copy link for another device' })).toBeEnabled();
});

test('a setup link with &hub= also stores the engine server URL; an invalid hub stores nothing', async ({
  page,
}) => {
  await page.goto(`/#setup-token=hub-token-1&hub=${encodeURIComponent('wss://hub.example/ws')}`);
  await expect(page.locator('cg-board')).toBeVisible();
  await expect(page.getByTestId('app-notice')).toContainText(
    'Server address and access token saved',
  );
  const remoteUrl = await page.evaluate(
    () => JSON.parse(localStorage.getItem('daisychess.analysis') ?? '{}').settings?.remoteUrl,
  );
  expect(remoteUrl).toBe('wss://hub.example/ws');
});

test('a setup link with an invalid hub is rejected as a whole', async ({ page }) => {
  await page.goto('/#setup-token=bad-hub-token&hub=https://evil.example');
  await expect(page.locator('cg-board')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Server access token')).toHaveValue('');
});
