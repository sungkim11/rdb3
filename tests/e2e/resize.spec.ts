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

test.describe('Layout', () => {
  test('sidebar is visible', async () => {
    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible();
    const box = await sidebar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(240);
  });

  test('footer spans full width', async () => {
    const footer = page.locator('footer');
    const box = await footer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(500);
  });

  test('header has toolbar area', async () => {
    const header = page.locator('header');
    await expect(header).toBeVisible();
  });
});
