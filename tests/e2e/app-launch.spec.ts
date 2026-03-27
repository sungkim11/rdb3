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

test.describe('App Launch', () => {
  test('window opens with PostGrip branding', async () => {
    await expect(page.getByText('PostGrip', { exact: true }).first()).toBeVisible();
  });

  test('shows status bar with footer', async () => {
    await expect(page.locator('footer')).toBeVisible();
  });

  test('shows waiting message when not connected', async () => {
    await expect(page.getByText('Waiting for a database connection')).toBeVisible();
  });

  test('shows offline status', async () => {
    await expect(page.locator('footer').getByText('offline')).toBeVisible();
  });

  test('displays Dashboard section', async () => {
    await expect(page.getByText('Dashboard', { exact: true })).toBeVisible();
  });

  test('displays Query History section', async () => {
    await expect(page.getByText('Query History')).toBeVisible();
  });

  test('shows empty query history', async () => {
    await expect(page.getByText('No queries yet')).toBeVisible();
  });

  test('shows No results placeholder in data panel', async () => {
    await expect(page.getByText('No results')).toBeVisible();
  });

  test('shows connect prompt in explorer', async () => {
    await expect(page.getByText('Connect to browse schema')).toBeVisible();
  });
});
