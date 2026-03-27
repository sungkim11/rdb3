import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

// Mock postgres module
vi.mock('../../src/main/postgres', () => ({
  testConnection: vi.fn().mockResolvedValue(undefined),
  fetchTree: vi.fn().mockResolvedValue([]),
  runQuery: vi.fn().mockResolvedValue({ columns: [], rows: [], rowCount: 0, truncated: false, executionTimeMs: 0, notice: null }),
  previewTable: vi.fn().mockResolvedValue({ columns: [], rows: [], rowCount: 0, truncated: false, executionTimeMs: 0, notice: null }),
  getTableDdl: vi.fn().mockResolvedValue('CREATE TABLE test (id int);'),
  getHostStats: vi.fn().mockResolvedValue({}),
  getActiveQueries: vi.fn().mockResolvedValue([]),
  dropTable: vi.fn().mockResolvedValue(undefined),
  truncateTable: vi.fn().mockResolvedValue(undefined),
  getEditableTableData: vi.fn().mockResolvedValue({ columns: [], columnTypes: [], rows: [], primaryKeyColumns: [], totalCount: 0 }),
  executeDml: vi.fn().mockResolvedValue(undefined),
  getModifyTableInfo: vi.fn().mockResolvedValue({ schema: 'public', table: 'test', columns: [] }),
  alterTable: vi.fn().mockResolvedValue(undefined),
  exportTableCsv: vi.fn().mockResolvedValue(0),
  closeAllPools: vi.fn(),
}));

vi.mock('../../src/main/storage', () => ({
  loadConnections: vi.fn().mockReturnValue([]),
  saveConnections: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: { writeFileSync: vi.fn() },
  writeFileSync: vi.fn(),
}));

import { registerIpcHandlers } from '../../src/main/ipc';
import { appState } from '../../src/main/state';
import * as postgres from '../../src/main/postgres';
import { loadConnections } from '../../src/main/storage';

describe('IPC handlers', () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    appState.activeConnection = null;

    // Capture registered handlers
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
      return undefined as never;
    });

    registerIpcHandlers();
  });

  function invoke(channel: string, ...args: unknown[]) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as Electron.IpcMainInvokeEvent, ...args);
  }

  it('registers all expected IPC handlers', () => {
    const expectedChannels = [
      'bootstrap',
      'host-stats',
      'active-queries',
      'test-connection',
      'connect',
      'activate-saved-connection',
      'delete-saved-connection',
      'disconnect',
      'run-query',
      'preview-table',
      'get-table-ddl',
      'drop-table',
      'truncate-table',
      'get-editable-table-data',
      'execute-dml',
      'get-modify-table-info',
      'alter-table',
      'export-table-csv',
      'export-pg-dump',
      'show-save-dialog',
      'write-file',
      'close-window',
    ];
    for (const channel of expectedChannels) {
      expect(handlers.has(channel), `Missing handler: ${channel}`).toBe(true);
    }
  });

  describe('bootstrap', () => {
    it('returns app snapshot', async () => {
      const result = await invoke('bootstrap') as { savedConnections: unknown[]; activeConnection: null };
      expect(result).toHaveProperty('savedConnections');
      expect(result).toHaveProperty('activeConnection');
      expect(result).toHaveProperty('databaseTree');
    });
  });

  describe('connection handlers', () => {
    it('test-connection calls postgres.testConnection', async () => {
      const input = { name: 'test', host: 'localhost', port: 5432, user: 'pg', password: 'pw', database: 'db' };
      await invoke('test-connection', input);
      expect(postgres.testConnection).toHaveBeenCalled();
    });

    it('connect sets active connection', async () => {
      const input = { name: 'test', host: 'localhost', port: 5432, user: 'pg', password: 'pw', database: 'db' };
      const result = await invoke('connect', input, true) as { activeConnection: { host: string } };
      expect(appState.activeConnection).not.toBeNull();
      expect(result.activeConnection).not.toBeNull();
    });

    it('disconnect clears active connection', async () => {
      appState.activeConnection = {
        id: '1', name: 'x', host: 'h', port: 5432, user: 'u', password: 'p', database: 'd',
      };
      await invoke('disconnect');
      expect(appState.activeConnection).toBeNull();
    });
  });

  describe('query handlers require active connection', () => {
    it('run-query throws without connection', async () => {
      await expect(invoke('run-query', 'SELECT 1')).rejects.toThrow('No active database connection');
    });

    it('host-stats throws without connection', async () => {
      await expect(invoke('host-stats')).rejects.toThrow('No active database connection');
    });

    it('preview-table throws without connection', async () => {
      await expect(invoke('preview-table', 'public', 'users')).rejects.toThrow('No active database connection');
    });

    it('get-table-ddl throws without connection', async () => {
      await expect(invoke('get-table-ddl', 'public', 'users')).rejects.toThrow('No active database connection');
    });

    it('drop-table throws without connection', async () => {
      await expect(invoke('drop-table', 'public', 'users', false)).rejects.toThrow('No active database connection');
    });

    it('truncate-table throws without connection', async () => {
      await expect(invoke('truncate-table', 'public', 'users', false)).rejects.toThrow('No active database connection');
    });
  });

  describe('query handlers with active connection', () => {
    beforeEach(() => {
      appState.activeConnection = {
        id: '1', name: 'test', host: 'localhost', port: 5432, user: 'pg', password: 'pw', database: 'db',
      };
    });

    it('run-query delegates to postgres.runQuery', async () => {
      await invoke('run-query', 'SELECT 1', 500);
      expect(postgres.runQuery).toHaveBeenCalledWith(appState.activeConnection, 'SELECT 1', 500);
    });

    it('run-query uses default limit of 500', async () => {
      await invoke('run-query', 'SELECT 1');
      expect(postgres.runQuery).toHaveBeenCalledWith(appState.activeConnection, 'SELECT 1', 500);
    });

    it('preview-table delegates with defaults', async () => {
      await invoke('preview-table', 'public', 'users');
      expect(postgres.previewTable).toHaveBeenCalledWith(appState.activeConnection, 'public', 'users', 200, 0);
    });

    it('get-table-ddl returns ddl result', async () => {
      const result = await invoke('get-table-ddl', 'public', 'users') as { ddl: string };
      expect(result).toHaveProperty('ddl');
      expect(postgres.getTableDdl).toHaveBeenCalledWith(appState.activeConnection, 'public', 'users');
    });

    it('drop-table delegates and returns snapshot', async () => {
      const result = await invoke('drop-table', 'public', 'users', true);
      expect(postgres.dropTable).toHaveBeenCalledWith(appState.activeConnection, 'public', 'users', true);
      expect(result).toHaveProperty('databaseTree');
    });

    it('truncate-table delegates and returns snapshot', async () => {
      await invoke('truncate-table', 'public', 'users', false);
      expect(postgres.truncateTable).toHaveBeenCalledWith(appState.activeConnection, 'public', 'users', false);
    });

    it('execute-dml delegates operations', async () => {
      const ops = [{ type: 'insert' as const, values: { name: 'test' } }];
      await invoke('execute-dml', 'public', 'users', ops);
      expect(postgres.executeDml).toHaveBeenCalledWith(appState.activeConnection, 'public', 'users', ops);
    });

    it('alter-table delegates and returns snapshot', async () => {
      const actions = [{ type: 'add_column' as const, columnName: 'email', dataType: 'text' }];
      const result = await invoke('alter-table', 'public', 'users', actions);
      expect(postgres.alterTable).toHaveBeenCalledWith(appState.activeConnection, 'public', 'users', actions);
      expect(result).toHaveProperty('databaseTree');
    });
  });

  describe('delete-saved-connection', () => {
    it('clears active connection if it matches deleted id', async () => {
      appState.activeConnection = {
        id: 'del-1', name: 'x', host: 'h', port: 5432, user: 'u', password: 'p', database: 'd',
      };
      vi.mocked(loadConnections).mockReturnValue([]);
      await invoke('delete-saved-connection', 'del-1');
      expect(appState.activeConnection).toBeNull();
    });
  });

  describe('write-file', () => {
    it('writes content to disk', async () => {
      const fs = await import('node:fs');
      await invoke('write-file', '/tmp/test.sql', 'SELECT 1;');
      expect(fs.default.writeFileSync).toHaveBeenCalledWith('/tmp/test.sql', 'SELECT 1;', 'utf-8');
    });
  });
});
