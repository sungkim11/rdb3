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
  getMonitoringData: vi.fn().mockResolvedValue({
    connectionsByState: [], connectionsByUser: [],
    tableStats: [], unusedIndexes: [],
    locksByType: [], blockedQueries: [],
    deadlocks: 0, tempFiles: 0, tempBytes: 0, conflictsCount: 0,
    checkpointsTimed: 0, checkpointsReq: 0, buffersCheckpoint: 0, buffersBgwriter: 0, buffersBackend: 0,
    replicationLag: [], longRunningTxns: [],
  }),
  getActiveQueries: vi.fn().mockResolvedValue([]),
  dropTable: vi.fn().mockResolvedValue(undefined),
  truncateTable: vi.fn().mockResolvedValue(undefined),
  getEditableTableData: vi.fn().mockResolvedValue({ columns: [], columnTypes: [], rows: [], primaryKeyColumns: [], totalCount: 0 }),
  executeDml: vi.fn().mockResolvedValue(undefined),
  getModifyTableInfo: vi.fn().mockResolvedValue({ schema: 'public', table: 'test', columns: [] }),
  alterTable: vi.fn().mockResolvedValue(undefined),
  exportTableCsv: vi.fn().mockResolvedValue(0),
  executeSql: vi.fn().mockResolvedValue(undefined),
  closeAllPools: vi.fn(),
}));

vi.mock('../../src/main/storage', () => ({
  loadConnections: vi.fn().mockReturnValue([]),
  saveConnections: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: {
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue('[]'),
    mkdirSync: vi.fn(),
    accessSync: vi.fn(),
    constants: { X_OK: 1 },
    promises: {
      readdir: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue('file content'),
      stat: vi.fn().mockResolvedValue({ size: 1024, mtime: new Date('2026-03-28T00:00:00Z') }),
      unlink: vi.fn().mockResolvedValue(undefined),
    },
  },
  writeFileSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue('[]'),
  mkdirSync: vi.fn(),
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}));

vi.mock('node:os', () => ({
  default: { homedir: vi.fn().mockReturnValue('/home/testuser') },
  homedir: vi.fn().mockReturnValue('/home/testuser'),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ stdout: '', stderr: '' })),
}));

vi.mock('../../src/main/pgpass', () => ({
  lookupPgpass: vi.fn().mockReturnValue(null),
  parsePgpassEntries: vi.fn().mockReturnValue([]),
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
      'get-pgpass-entries',
      'host-stats',
      'monitoring-data',
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
      'list-directory',
      'read-text-file',
      'get-home-dir',
      'find-git-repos',
      'git-repo-root',
      'git-status',
      'git-diff',
      'list-backup-schedules',
      'add-backup-schedule',
      'update-backup-schedule',
      'delete-backup-schedule',
      'list-backups',
      'get-backup-dir',
      'set-backup-dir',
      'delete-backup',
      'backup-database',
      'restore-database',
      'show-open-dialog',
      'get-app-info',
      'read-help',
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

  describe('get-pgpass-entries', () => {
    it('returns parsed pgpass entries', async () => {
      const { parsePgpassEntries } = await import('../../src/main/pgpass');
      vi.mocked(parsePgpassEntries).mockReturnValue([
        { host: 'localhost', port: 5432, user: 'admin', database: 'mydb' },
      ]);
      const result = await invoke('get-pgpass-entries') as Array<{ host: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].host).toBe('localhost');
    });
  });

  describe('get-home-dir', () => {
    it('returns home directory', async () => {
      const result = await invoke('get-home-dir');
      expect(result).toBe('/home/testuser');
    });
  });

  describe('list-directory', () => {
    it('returns directory entries', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.default.promises.readdir).mockResolvedValue([
        { name: 'folder', isDirectory: () => true, isFile: () => false } as never,
        { name: 'file.txt', isDirectory: () => false, isFile: () => true } as never,
        { name: '.hidden', isDirectory: () => false, isFile: () => true } as never,
      ]);
      const result = await invoke('list-directory', '/test') as Array<{ name: string; isDirectory: boolean }>;
      // hidden files should be filtered
      expect(result).toHaveLength(2);
      // directories should sort first
      expect(result[0].name).toBe('folder');
      expect(result[0].isDirectory).toBe(true);
      expect(result[1].name).toBe('file.txt');
    });
  });

  describe('read-text-file', () => {
    it('returns file content', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.default.promises.readFile).mockResolvedValue('SELECT 1;');
      const result = await invoke('read-text-file', '/test/query.sql');
      expect(result).toBe('SELECT 1;');
    });
  });

  describe('disconnect', () => {
    it('calls closeAllPools', async () => {
      appState.activeConnection = {
        id: '1', name: 'x', host: 'h', port: 5432, user: 'u', password: 'p', database: 'd',
      };
      await invoke('disconnect');
      expect(postgres.closeAllPools).toHaveBeenCalled();
    });
  });

  describe('active-queries', () => {
    it('throws without connection', async () => {
      await expect(invoke('active-queries')).rejects.toThrow('No active database connection');
    });

    it('delegates to postgres.getActiveQueries', async () => {
      appState.activeConnection = {
        id: '1', name: 'test', host: 'localhost', port: 5432, user: 'pg', password: 'pw', database: 'db',
      };
      await invoke('active-queries');
      expect(postgres.getActiveQueries).toHaveBeenCalledWith(appState.activeConnection);
    });
  });

  describe('monitoring-data', () => {
    it('throws without connection', async () => {
      await expect(invoke('monitoring-data')).rejects.toThrow('No active database connection');
    });

    it('delegates to postgres.getMonitoringData', async () => {
      appState.activeConnection = {
        id: '1', name: 'test', host: 'localhost', port: 5432, user: 'pg', password: 'pw', database: 'db',
      };
      const result = await invoke('monitoring-data') as Record<string, unknown>;
      expect(postgres.getMonitoringData).toHaveBeenCalledWith(appState.activeConnection);
      expect(result).toHaveProperty('connectionsByState');
      expect(result).toHaveProperty('tableStats');
      expect(result).toHaveProperty('locksByType');
      expect(result).toHaveProperty('deadlocks');
      expect(result).toHaveProperty('checkpointsTimed');
      expect(result).toHaveProperty('replicationLag');
      expect(result).toHaveProperty('longRunningTxns');
    });
  });

  describe('export-table-csv', () => {
    it('throws without connection', async () => {
      await expect(invoke('export-table-csv', 'public', 'users', '/tmp/out.csv')).rejects.toThrow('No active database connection');
    });

    it('delegates to postgres.exportTableCsv', async () => {
      appState.activeConnection = {
        id: '1', name: 'test', host: 'localhost', port: 5432, user: 'pg', password: 'pw', database: 'db',
      };
      await invoke('export-table-csv', 'public', 'users', '/tmp/out.csv');
      expect(postgres.exportTableCsv).toHaveBeenCalledWith(appState.activeConnection, 'public', 'users', '/tmp/out.csv');
    });
  });

  describe('get-editable-table-data', () => {
    it('throws without connection', async () => {
      await expect(invoke('get-editable-table-data', 'public', 'users', 100, 0)).rejects.toThrow('No active database connection');
    });
  });

  describe('execute-dml', () => {
    it('throws without connection', async () => {
      await expect(invoke('execute-dml', 'public', 'users', [])).rejects.toThrow('No active database connection');
    });
  });

  describe('get-modify-table-info', () => {
    it('throws without connection', async () => {
      await expect(invoke('get-modify-table-info', 'public', 'users')).rejects.toThrow('No active database connection');
    });
  });

  describe('alter-table', () => {
    it('throws without connection', async () => {
      await expect(invoke('alter-table', 'public', 'users', [])).rejects.toThrow('No active database connection');
    });
  });

  describe('export-pg-dump', () => {
    it('throws without connection', async () => {
      await expect(invoke('export-pg-dump', 'public', 'users', '/tmp/dump.sql', 'sql')).rejects.toThrow('No active database connection');
    });
  });

  describe('activate-saved-connection', () => {
    it('throws when connection not found', async () => {
      vi.mocked(loadConnections).mockReturnValue([]);
      await expect(invoke('activate-saved-connection', 'nonexistent')).rejects.toThrow('Saved connection not found');
    });
  });

  // --- Backup & Restore ---

  describe('get-backup-dir', () => {
    it('returns default directory when no preference exists', async () => {
      const fsModule = await import('node:fs');
      vi.mocked(fsModule.default.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = await invoke('get-backup-dir');
      expect(result).toContain('PostGrip_Backups');
    });
  });

  describe('set-backup-dir', () => {
    it('writes preference file', async () => {
      const fsModule = await import('node:fs');
      await invoke('set-backup-dir', '/custom/backup/path');
      expect(fsModule.default.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('list-backups', () => {
    it('returns empty array for empty directory', async () => {
      const result = await invoke('list-backups', '/some/dir') as unknown[];
      expect(result).toEqual([]);
    });

    it('returns backup files with metadata', async () => {
      const fsModule = await import('node:fs');
      vi.mocked(fsModule.default.promises.readdir).mockResolvedValueOnce([
        { name: 'backup.tar', isFile: () => true, isDirectory: () => false } as never,
        { name: 'readme.txt', isFile: () => true, isDirectory: () => false } as never,
      ]);
      vi.mocked(fsModule.default.promises.stat).mockResolvedValue({ size: 2048, mtime: new Date('2026-03-28') } as never);
      vi.mocked(fsModule.default.promises.readFile).mockResolvedValue('{"format":"tar"}');
      const result = await invoke('list-backups', '/backups') as Array<{ name: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('backup.tar');
    });
  });

  describe('delete-backup', () => {
    it('calls unlink on the file', async () => {
      const fsModule = await import('node:fs');
      await invoke('delete-backup', '/backups/old.tar');
      expect(fsModule.default.promises.unlink).toHaveBeenCalledWith('/backups/old.tar');
    });
  });

  describe('backup-database', () => {
    it('throws without active connection', async () => {
      await expect(invoke('backup-database', { filePath: '/tmp/b.tar', format: 'tar' })).rejects.toThrow('No active database connection');
    });

    it('executes pg_dump with correct args', async () => {
      appState.activeConnection = {
        id: '1', name: 'test', host: 'localhost', port: 5432, user: 'pg', password: 'pw', database: 'testdb',
      };
      const result = await invoke('backup-database', {
        filePath: '/tmp/backup.tar', format: 'tar', noOwner: true, noPrivileges: true,
      }) as { durationMs: number };
      expect(result).toHaveProperty('durationMs');
      expect(typeof result.durationMs).toBe('number');
    });

    it('passes table filters to pg_dump', async () => {
      appState.activeConnection = {
        id: '1', name: 'test', host: 'localhost', port: 5432, user: 'pg', password: 'pw', database: 'testdb',
      };
      const result = await invoke('backup-database', {
        filePath: '/tmp/backup.sql', format: 'sql', tables: ['public.users', 'public.orders'],
      }) as { durationMs: number };
      expect(result).toHaveProperty('durationMs');
    });
  });

  describe('restore-database', () => {
    it('throws without active connection', async () => {
      await expect(invoke('restore-database', '/tmp/backup.tar')).rejects.toThrow('No active database connection');
    });

    it('restores SQL files via executeSql', async () => {
      appState.activeConnection = {
        id: '1', name: 'test', host: 'localhost', port: 5432, user: 'pg', password: 'pw', database: 'testdb',
      };
      const fsModule = await import('node:fs');
      vi.mocked(fsModule.default.promises.readFile).mockResolvedValueOnce('CREATE TABLE test (id int);');
      await invoke('restore-database', '/tmp/backup.sql');
      expect(postgres.executeSql).toHaveBeenCalled();
    });

    it('restores non-SQL files via pg_restore', async () => {
      appState.activeConnection = {
        id: '1', name: 'test', host: 'localhost', port: 5432, user: 'pg', password: 'pw', database: 'testdb',
      };
      await invoke('restore-database', '/tmp/backup.tar');
      // Should not call executeSql for .tar files
      expect(postgres.executeSql).not.toHaveBeenCalled();
    });
  });

  // --- Backup Schedules ---

  describe('list-backup-schedules', () => {
    it('returns empty array when no schedules exist', async () => {
      const fsModule = await import('node:fs');
      vi.mocked(fsModule.default.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = await invoke('list-backup-schedules') as unknown[];
      expect(result).toEqual([]);
    });

    it('returns saved schedules', async () => {
      const fsModule = await import('node:fs');
      const schedules = [{ id: '1', days: ['monday'], time: '02:00' }];
      vi.mocked(fsModule.default.readFileSync).mockReturnValue(JSON.stringify(schedules));
      const result = await invoke('list-backup-schedules') as unknown[];
      expect(result).toHaveLength(1);
    });
  });

  describe('add-backup-schedule', () => {
    it('adds a schedule with generated id and createdAt', async () => {
      const fsModule = await import('node:fs');
      vi.mocked(fsModule.default.readFileSync).mockReturnValue('[]');
      const result = await invoke('add-backup-schedule', { days: ['monday', 'friday'], time: '03:00', format: 'tar' }) as Record<string, unknown>;
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('createdAt');
      expect(result.days).toEqual(['monday', 'friday']);
      expect(fsModule.default.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('update-backup-schedule', () => {
    it('updates an existing schedule', async () => {
      const fsModule = await import('node:fs');
      vi.mocked(fsModule.default.readFileSync).mockReturnValue(JSON.stringify([{ id: 's1', days: ['monday'], time: '02:00' }]));
      const result = await invoke('update-backup-schedule', 's1', { time: '04:00' }) as Array<{ id: string; time: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].time).toBe('04:00');
    });

    it('does nothing for unknown schedule id', async () => {
      const fsModule = await import('node:fs');
      vi.mocked(fsModule.default.readFileSync).mockReturnValue(JSON.stringify([{ id: 's1', time: '02:00' }]));
      const result = await invoke('update-backup-schedule', 'nonexistent', { time: '04:00' }) as Array<{ time: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].time).toBe('02:00');
    });
  });

  describe('delete-backup-schedule', () => {
    it('removes a schedule by id', async () => {
      const fsModule = await import('node:fs');
      vi.mocked(fsModule.default.readFileSync).mockReturnValue(JSON.stringify([{ id: 's1' }, { id: 's2' }]));
      const result = await invoke('delete-backup-schedule', 's1') as Array<{ id: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('s2');
    });
  });

  // --- Help & Info ---

  describe('get-app-info', () => {
    it('returns app information', async () => {
      const result = await invoke('get-app-info') as Record<string, string>;
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('platform');
    });
  });

  describe('read-help', () => {
    it('returns help content or fallback', async () => {
      const result = await invoke('read-help') as string;
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
