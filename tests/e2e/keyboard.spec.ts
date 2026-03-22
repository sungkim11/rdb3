import { test, expect } from '@playwright/test';
import { launchApp, closeApp } from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';

let app: ElectronApplication | undefined;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp());
});

test.afterAll(async () => {
  await closeApp(app);
});

test.describe('Keyboard and Input', () => {
  test('SQL editor accepts keyboard input', async () => {
    await page.locator('button', { hasText: 'SQL Editor' }).click();
    await expect(page.locator('.cm-editor')).toBeVisible({ timeout: 5000 });

    const editor = page.locator('.cm-content');
    await editor.click();
    await page.keyboard.type('SELECT 42 AS answer');
    await expect(editor).toContainText('SELECT 42 AS answer');

    await page.locator('button', { hasText: 'Close' }).click();
  });

  test('Cancel button closes connection modal', async () => {
    await page.locator('button[title="New connection"]').first().click();
    await expect(page.getByText('New connection')).toBeVisible();
    await page.locator('button', { hasText: 'Cancel' }).click();
    await expect(page.getByText('New connection')).not.toBeVisible();
  });
});
