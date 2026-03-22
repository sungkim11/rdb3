import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import dotenv from 'dotenv';
import { hasPgpassEntry } from '../../src/main/pgpass';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Launch the Electron app for E2E testing.
 * Uses an isolated temp directory for userData so tests never
 * touch the developer's real saved connections.
 */
export async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdb3-e2e-'));

  const app = await electron.launch({
    args: [
      path.resolve(__dirname, '../../dist/main/index.js'),
      `--user-data-dir=${userDataDir}`,
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // Electron respects this to override app.getPath('userData')
      ELECTRON_USER_DATA_DIR: userDataDir,
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('main', { timeout: 15000 });
  return { app, page };
}

export async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (app) {
    await app.close();
  }
}

export const DB_HOST = process.env.DB_HOST ?? '';
export const DB_PORT = process.env.DB_PORT ?? '5432';
export const DB_USER = process.env.DB_USER ?? '';
export const DB_NAME = process.env.DB_NAME ?? 'postgres';

/**
 * Check if the connected E2E tests can run:
 * - DB_HOST and DB_USER must be set in .env
 * - A matching entry must exist in ~/.pgpass (or $PGPASSFILE)
 *
 * Uses the same pgpass parser as the production code to avoid
 * false negatives from entries with escaped colons or backslashes.
 */
export const hasDb = !!(DB_HOST && DB_USER && hasPgpassEntry(DB_HOST, Number(DB_PORT), DB_NAME, DB_USER));
