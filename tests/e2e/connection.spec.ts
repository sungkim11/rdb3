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

test.describe('Connection Modal - General Tab', () => {
  test.beforeAll(async () => {
    await page.locator('button[title="New connection"]').first().click();
    await expect(page.getByText('New connection')).toBeVisible();
  });

  test('General tab is active by default', async () => {
    await expect(page.locator('button', { hasText: 'General' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'SSH / SSL' })).toBeVisible();
  });

  test('shows connection fields', async () => {
    await expect(page.getByText('Host', { exact: true })).toBeVisible();
    await expect(page.getByText('Port', { exact: true })).toBeVisible();
    await expect(page.getByText('Authentication', { exact: true })).toBeVisible();
    await expect(page.getByText('User', { exact: true })).toBeVisible();
    await expect(page.getByText('Database', { exact: true })).toBeVisible();
    await expect(page.getByText('URL', { exact: true })).toBeVisible();
  });

  test('pgpass auth hides password and shows info', async () => {
    const authSelect = page.locator('label', { hasText: 'Authentication' }).locator('select');
    await authSelect.selectOption('pgpass');
    await expect(page.locator('span.font-mono', { hasText: '~/.pgpass' })).toBeVisible();
    // Switch back
    await authSelect.selectOption('password');
    await expect(page.getByText('Password', { exact: true })).toBeVisible();
  });

  test('Cancel closes modal', async () => {
    await page.locator('button', { hasText: 'Cancel' }).click();
    await expect(page.getByText('New connection')).not.toBeVisible();
  });
});

test.describe('Connection Modal - SSH Tab', () => {
  test.beforeAll(async () => {
    await page.locator('button[title="New connection"]').first().click();
    await expect(page.getByText('New connection')).toBeVisible();
    await page.locator('button', { hasText: 'SSH / SSL' }).click();
  });

  test('shows Enable SSH Tunnel checkbox', async () => {
    await expect(page.getByText('Enable SSH Tunnel')).toBeVisible();
    await expect(page.getByText('SSH tunnel is disabled')).toBeVisible();
  });

  test('enabling SSH reveals fields', async () => {
    await page.getByText('Enable SSH Tunnel').click();
    await expect(page.getByText('SSH Host', { exact: true })).toBeVisible();
    await expect(page.getByText('SSH Port', { exact: true })).toBeVisible();
    await expect(page.getByText('SSH User', { exact: true })).toBeVisible();
    await expect(page.getByText('Auth Method', { exact: true })).toBeVisible();
    await expect(page.getByText('SSH Password', { exact: true })).toBeVisible();
  });

  test('private key auth shows key and passphrase fields', async () => {
    await page.locator('label', { hasText: 'Auth Method' }).locator('select').selectOption('privateKey');
    await expect(page.getByText('Private Key Path', { exact: true })).toBeVisible();
    await expect(page.getByText('Passphrase', { exact: true })).toBeVisible();
    await page.locator('label', { hasText: 'Auth Method' }).locator('select').selectOption('password');
  });

  test('switching tabs preserves SSH state', async () => {
    await page.locator('button', { hasText: 'General' }).click();
    await page.locator('button', { hasText: 'SSH / SSL' }).click();
    // SSH should still be enabled
    await expect(page.getByText('SSH Host', { exact: true })).toBeVisible();
  });

  test('has action buttons', async () => {
    await expect(page.locator('button', { hasText: 'Test Connection' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Cancel' })).toBeVisible();
  });

  test('Cancel closes modal', async () => {
    await page.locator('button', { hasText: 'Cancel' }).click();
    await expect(page.getByText('New connection')).not.toBeVisible();
  });
});
