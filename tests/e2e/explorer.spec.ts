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

test.describe('Explorer Panel (disconnected)', () => {
  test('shows connect prompt', async () => {
    await expect(page.getByText('Connect to browse schema')).toBeVisible();
  });

  test('has Refresh button', async () => {
    await expect(page.locator('button[title="Refresh"]').first()).toBeVisible();
  });

  test('has Open SQL editor button', async () => {
    await expect(page.locator('button[title="Open SQL editor"]').first()).toBeVisible();
  });
});
