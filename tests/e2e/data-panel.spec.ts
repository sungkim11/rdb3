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

test.describe('Data Panel (disconnected)', () => {
  test('shows empty workspace', async () => {
    await expect(page.getByText('No results')).toBeVisible();
    await expect(page.getByText('Run a query or click a table from the explorer')).toBeVisible();
  });

  test('no export buttons visible without results', async () => {
    // CSV button should not be in the page at all when no tabs have results
    const csvButtons = page.locator('button', { hasText: 'CSV' });
    await expect(csvButtons).toHaveCount(0);
  });
});

test.describe('Dashboard Panel', () => {
  test('shows Query History', async () => {
    await expect(page.getByText('Query History')).toBeVisible();
  });

  test('shows empty query history', async () => {
    await expect(page.getByText('No queries yet')).toBeVisible();
  });
});
