import { test, expect } from '@playwright/test';
import { launchApp, closeApp, hasDb, DB_HOST, DB_PORT, DB_USER, DB_NAME } from './helpers';
import type { ElectronApplication, Page } from '@playwright/test';

let app: ElectronApplication | undefined;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp());
});

test.afterAll(async () => {
  await closeApp(app);
});

test.describe('Connected Database Flow', () => {
  test.skip(!hasDb, 'Requires DB_HOST/DB_USER in .env and matching ~/.pgpass entry');

  test('connect via modal with pgpass auth', async () => {
    await page.locator('button[title="New connection"]').first().click();
    await expect(page.getByText('New connection')).toBeVisible();

    // Fill Host
    await page.locator('label', { hasText: 'Host' }).locator('input').fill(DB_HOST);
    // Fill Port
    await page.locator('label', { hasText: 'Port' }).locator('input').fill(DB_PORT);
    // Select pgpass
    await page.locator('label', { hasText: 'Authentication' }).locator('select').selectOption('pgpass');
    // Fill User
    await page.locator('label', { hasText: 'User' }).locator('input').fill(DB_USER);
    // Fill Database
    await page.locator('label', { hasText: 'Database' }).locator('input').fill(DB_NAME);

    // Click the Connect button (exact match, inside the modal footer)
    await page.locator('button.rounded-lg.bg-\\[var\\(--accent\\)\\]', { hasText: 'Connect' }).click();

    await expect(page.getByText(`Connected as ${DB_USER}`)).toBeVisible({ timeout: 30000 });
  });

  test('status bar shows online', async () => {
    await expect(page.locator('footer').getByText('online')).toBeVisible();
  });

  test('Explorer shows database tree', async () => {
    // The database tree node has the db@host text inside a span
    const treeNode = page.locator('.sidebar-scroll span', { hasText: `${DB_NAME}@${DB_HOST}` });
    await expect(treeNode.first()).toBeVisible({ timeout: 10000 });
  });

  test('schema tree has tables', async () => {
    // Wait for tree to load — look for any table icon row in sidebar
    const tableRows = page.locator('.sidebar-scroll button.truncate');
    await expect(tableRows.first()).toBeVisible({ timeout: 10000 });
  });

  test('SQL editor can run a query and show results', async () => {
    await page.locator('button', { hasText: 'SQL Editor' }).click();
    await expect(page.locator('.cm-editor')).toBeVisible({ timeout: 5000 });

    const editor = page.locator('.cm-content');
    await editor.click();
    await page.keyboard.type('SELECT 1 AS test_col');
    await page.keyboard.press('Control+Enter');

    // Should see column header and result
    await expect(page.getByText('test_col')).toBeVisible({ timeout: 10000 });

    // Export buttons should appear when results exist
    await expect(page.locator('button', { hasText: /^CSV$/ }).first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button', { hasText: /^Excel$/ }).first()).toBeVisible();

    await page.locator('button', { hasText: 'Close' }).click();
  });

  test('table preview via click', async () => {
    // The table names in the tree are cursor-grab divs with a button child
    // Click the button inside the draggable row
    const draggableRows = page.locator('.sidebar-scroll [draggable="true"]');
    const count = await draggableRows.count();
    test.skip(count === 0, 'No tables');

    // Click the table name button (not the expand arrow)
    const tableBtn = draggableRows.first().locator('button.truncate');
    await tableBtn.click();

    await expect(page.locator('thead th').first()).toBeVisible({ timeout: 15000 });
  });

  test('right-click table shows context menu and Show DDL works', async () => {
    const draggableRows = page.locator('.sidebar-scroll [draggable="true"]');
    const count = await draggableRows.count();
    test.skip(count === 0, 'No tables');

    await draggableRows.first().click({ button: 'right' });

    await expect(page.getByText('Show DDL')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Edit Data')).toBeVisible();
    await expect(page.getByText('Modify Table')).toBeVisible();
    await expect(page.getByText('Truncate Table')).toBeVisible();
    await expect(page.getByText('Drop Table')).toBeVisible();

    // Click Show DDL
    await page.getByText('Show DDL').click();
    await expect(page.getByText('create table')).toBeVisible({ timeout: 10000 });
  });
});
