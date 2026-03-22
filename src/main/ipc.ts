import { ipcMain, dialog, BrowserWindow } from 'electron';
import { appState } from './state';
import { loadConnections, saveConnections } from './storage';
import * as postgres from './postgres';
import { closeAllTunnels } from './ssh-tunnel';
import {
  buildConnectionString,
  toSavedConnection,
  toSafe,
  toSummary,
  type AppSnapshot,
  type ConnectionInput,
} from './types';
import fs from 'node:fs';

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
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

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

  ipcMain.handle('close-window', () => {
    const win = BrowserWindow.getFocusedWindow();
    win?.close();
  });
}
