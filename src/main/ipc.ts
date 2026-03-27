import { ipcMain, dialog, BrowserWindow } from 'electron';
import { appState } from './state';
import { loadConnections, saveConnections } from './storage';
import * as postgres from './postgres';
import { closeAllPools } from './postgres';
import { closeAllTunnels } from './ssh-tunnel';
import {
  buildConnectionString,
  toSavedConnection,
  toSafe,
  toSummary,
  type AppSnapshot,
  type ConnectionInput,
} from './types';
import { parsePgpassEntries } from './pgpass';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function snapshot(): AppSnapshot {
  const savedConnections = loadConnections().map(toSafe);
  const activeConnection = appState.activeConnection
    ? toSummary(appState.activeConnection)
    : null;

  return {
    savedConnections,
    activeConnection,
    databaseTree: [],
  };
}

async function snapshotWithTree(): Promise<AppSnapshot> {
  const snap = snapshot();
  if (appState.activeConnection) {
    snap.databaseTree = await postgres.fetchTree(appState.activeConnection);
  }
  return snap;
}

export function registerIpcHandlers(): void {
  ipcMain.handle('bootstrap', async () => {
    return snapshotWithTree();
  });

  ipcMain.handle('get-pgpass-entries', () => {
    return parsePgpassEntries();
  });

  ipcMain.handle('host-stats', async () => {
    if (!appState.activeConnection) throw new Error('No active database connection');
    return postgres.getHostStats(appState.activeConnection);
  });

  ipcMain.handle('active-queries', async () => {
    if (!appState.activeConnection) throw new Error('No active database connection');
    return postgres.getActiveQueries(appState.activeConnection);
  });

  ipcMain.handle('test-connection', async (_event, connection: ConnectionInput) => {
    console.log('[test-connection] received:', JSON.stringify(connection));
    const saved = toSavedConnection(connection);
    console.log('[test-connection] connectionString:', buildConnectionString(saved));
    await postgres.testConnection(saved);
    return { success: true };
  });

  ipcMain.handle('connect', async (_event, connection: ConnectionInput, save: boolean) => {
    const saved = toSavedConnection(connection);
    await postgres.testConnection(saved);

    if (save) {
      const existing = loadConnections();
      const idx = existing.findIndex((c) =>
        c.id === saved.id ||
        (c.host === saved.host && c.port === saved.port && c.database === saved.database && c.user === saved.user)
      );
      if (idx >= 0) {
        saved.id = existing[idx].id;
        existing[idx] = saved;
      } else {
        existing.push(saved);
      }
      saveConnections(existing);
    }

    appState.activeConnection = saved;
    return snapshotWithTree();
  });

  ipcMain.handle('activate-saved-connection', async (_event, id: string) => {
    const saved = loadConnections();
    const conn = saved.find((c) => c.id === id);
    if (!conn) throw new Error('Saved connection not found');

    await postgres.testConnection(conn);
    appState.activeConnection = conn;
    return snapshotWithTree();
  });

  ipcMain.handle('delete-saved-connection', async (_event, id: string) => {
    const saved = loadConnections().filter((c) => c.id !== id);
    saveConnections(saved);

    if (appState.activeConnection?.id === id) {
      appState.activeConnection = null;
    }

    return snapshotWithTree();
  });

  ipcMain.handle('disconnect', async () => {
    appState.activeConnection = null;
    closeAllPools();
    closeAllTunnels();
    return snapshotWithTree();
  });

  ipcMain.handle('run-query', async (_event, sql: string, limit?: number) => {
    if (!appState.activeConnection) throw new Error('No active database connection');
    return postgres.runQuery(appState.activeConnection, sql, limit ?? 500);
  });

  ipcMain.handle('preview-table', async (_event, schema: string, table: string, limit?: number, offset?: number) => {
    if (!appState.activeConnection) throw new Error('No active database connection');
    return postgres.previewTable(appState.activeConnection, schema, table, limit ?? 200, offset ?? 0);
  });

  ipcMain.handle('get-table-ddl', async (_event, schema: string, table: string) => {
    if (!appState.activeConnection) throw new Error('No active database connection');
    const ddl = await postgres.getTableDdl(appState.activeConnection, schema, table);
    return { ddl };
  });

  ipcMain.handle('drop-table', async (_event, schema: string, table: string, cascade: boolean) => {
    if (!appState.activeConnection) throw new Error('No active database connection');
    await postgres.dropTable(appState.activeConnection, schema, table, cascade);
    return snapshotWithTree();
  });

  ipcMain.handle('truncate-table', async (_event, schema: string, table: string, cascade: boolean) => {
    if (!appState.activeConnection) throw new Error('No active database connection');
    await postgres.truncateTable(appState.activeConnection, schema, table, cascade);
    return snapshotWithTree();
  });

  ipcMain.handle('get-editable-table-data', async (_event, schema: string, table: string, limit: number, offset: number) => {
    if (!appState.activeConnection) throw new Error('No active database connection');
    return postgres.getEditableTableData(appState.activeConnection, schema, table, limit, offset);
  });

  ipcMain.handle('execute-dml', async (_event, schema: string, table: string, operations: postgres.DmlOperation[]) => {
    if (!appState.activeConnection) throw new Error('No active database connection');
    await postgres.executeDml(appState.activeConnection, schema, table, operations);
  });

  ipcMain.handle('get-modify-table-info', async (_event, schema: string, table: string) => {
    if (!appState.activeConnection) throw new Error('No active database connection');
    return postgres.getModifyTableInfo(appState.activeConnection, schema, table);
  });

  ipcMain.handle('alter-table', async (_event, schema: string, table: string, actions: postgres.AlterTableAction[]) => {
    if (!appState.activeConnection) throw new Error('No active database connection');
    await postgres.alterTable(appState.activeConnection, schema, table, actions);
    return snapshotWithTree();
  });

  ipcMain.handle('export-table-csv', async (_event, schema: string, table: string, path: string) => {
    if (!appState.activeConnection) throw new Error('No active database connection');
    return postgres.exportTableCsv(appState.activeConnection, schema, table, path);
  });

  ipcMain.handle('export-pg-dump', async (_event, schema: string, table: string, filePath: string, format: string) => {
    if (!appState.activeConnection) throw new Error('No active database connection');
    const conn = appState.activeConnection;
    const args = [
      '-h', conn.host,
      '-p', String(conn.port),
      '-U', conn.user,
      '-d', conn.database,
      '-t', `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`,
      '-f', filePath,
    ];
    if (format === 'sql') {
      args.push('--no-owner', '--no-acl');
    } else if (format === 'custom') {
      args.push('-Fc');
    } else if (format === 'tar') {
      args.push('-Ft');
    }

    const env = { ...process.env, PGPASSWORD: conn.password };
    await execFileAsync('pg_dump', args, { env, timeout: 120000 });
  });

  ipcMain.handle('show-save-dialog', async (_event, options: Electron.SaveDialogOptions) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showSaveDialog(win, options);
    return result.canceled ? null : result.filePath;
  });

  ipcMain.handle('write-file', async (_event, filePath: string, content: string) => {
    fs.writeFileSync(filePath, content, 'utf-8');
  });

  ipcMain.handle('list-directory', async (_event, dirPath: string) => {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
      }));
  });

  ipcMain.handle('read-text-file', async (_event, filePath: string) => {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return content;
  });

  ipcMain.handle('get-home-dir', () => {
    return os.homedir();
  });

  ipcMain.handle('find-git-repos', async (_event, dirPath: string, maxDepth = 3) => {
    const repos: Array<{ name: string; path: string }> = [];
    async function scan(dir: string, depth: number) {
      if (depth > maxDepth) return;
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const dirs: string[] = [];
        let hasGit = false;
        for (const e of entries) {
          if (e.name === '.git' && e.isDirectory()) { hasGit = true; break; }
          if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
            dirs.push(path.join(dir, e.name));
          }
        }
        if (hasGit) {
          repos.push({ name: path.basename(dir), path: dir });
        } else {
          await Promise.all(dirs.map((d) => scan(d, depth + 1)));
        }
      } catch { /* permission denied, etc */ }
    }
    await scan(dirPath, 0);
    repos.sort((a, b) => a.name.localeCompare(b.name));
    return repos;
  });

  ipcMain.handle('git-repo-root', async (_event, dirPath: string) => {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: dirPath });
      return stdout.trim();
    } catch {
      return null;
    }
  });

  ipcMain.handle('git-status', async (_event, repoPath: string) => {
    try {
      const [branchResult, statusResult, logResult] = await Promise.all([
        execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath }),
        execFileAsync('git', ['status', '--porcelain', '-u'], { cwd: repoPath }),
        execFileAsync('git', ['log', '--oneline', '-20'], { cwd: repoPath }),
      ]);
      const files = branchResult.stdout && statusResult.stdout.trim()
        ? statusResult.stdout.trim().split('\n').filter(Boolean).map((line: string) => ({
            status: line.substring(0, 2).trim(),
            path: line.substring(3),
          }))
        : [];
      const commits = logResult.stdout.trim().split('\n').filter(Boolean).map((line: string) => {
        const spaceIdx = line.indexOf(' ');
        return { hash: line.substring(0, spaceIdx), message: line.substring(spaceIdx + 1) };
      });
      return { branch: branchResult.stdout.trim(), files, commits };
    } catch {
      return null;
    }
  });

  ipcMain.handle('git-diff', async (_event, repoPath: string, filePath: string) => {
    try {
      const { stdout } = await execFileAsync('git', ['diff', 'HEAD', '--', filePath], { cwd: repoPath });
      return stdout || '(no changes)';
    } catch {
      return null;
    }
  });

  ipcMain.handle('close-window', () => {
    const win = BrowserWindow.getFocusedWindow();
    win?.close();
  });
}
