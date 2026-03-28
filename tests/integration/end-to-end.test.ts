import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConnection } from '../mocks/pg';

/**
 * End-to-end integration tests that simulate the full flow from
 * IPC handler → postgres layer → mock database, verifying the
 * complete round-trip behavior.
 */

const queries: Array<{ sql: string; params?: unknown[] }> = [];
const queryResponses = new Map<string, { rows: Record<string, unknown>[]; fields?: { name: string }[]; command?: string; rowCount?: number }>();

const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    for (const [pattern, result] of queryResponses) {
      if (sql.includes(pattern)) return Promise.resolve(result);
    }
    return Promise.resolve({ rows: [], fields: [], command: '', rowCount: 0 });
  }),
};

vi.mock('pg', () => ({
  default: {
    Client: vi.fn().mockImplementation(function () { return mockClient; }),
    Pool: vi.fn().mockImplementation(function () { return { connect: vi.fn().mockResolvedValue(mockClient), end: vi.fn().mockResolvedValue(undefined) }; }),
  },
}));
vi.mock('node:fs', () => {
  const mockWriteStream = {
    write: vi.fn().mockReturnValue(true),
    end: vi.fn((cb?: () => void) => { if (cb) cb(); }),
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
  };
  return {
    default: {
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue('[]'),
      writeFileSync: vi.fn(),
      createWriteStream: vi.fn().mockReturnValue(mockWriteStream),
      promises: {
        readdir: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockResolvedValue(''),
        writeFile: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
        access: vi.fn().mockResolvedValue(undefined),
      },
    },
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('[]'),
    writeFileSync: vi.fn(),
    createWriteStream: vi.fn().mockReturnValue(mockWriteStream),
  };
});

import { ipcMain } from 'electron';
import { registerIpcHandlers } from '../../src/main/ipc';
import { appState } from '../../src/main/state';

describe('end-to-end integration', () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const conn = testConnection();

  function invoke(channel: string, ...args: unknown[]) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as Electron.IpcMainInvokeEvent, ...args);
  }

  function resetQueryMock() {
    mockClient.query.mockImplementation((sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      for (const [pattern, result] of queryResponses) {
        if (sql.includes(pattern)) return Promise.resolve(result);
      }
      return Promise.resolve({ rows: [], fields: [], command: '', rowCount: 0 });
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    queries.length = 0;
    queryResponses.clear();
    handlers.clear();
    appState.activeConnection = null;
    resetQueryMock();

    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
      return undefined as never;
    });

    registerIpcHandlers();
  });

  describe('connection lifecycle', () => {
    it('connect → run-query → disconnect', async () => {
      // Step 1: Connect
      const connectResult = await invoke('connect', {
        name: 'Test',
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        password: 'secret',
        database: 'testdb',
      }, false) as { activeConnection: { host: string } };

      expect(appState.activeConnection).not.toBeNull();
      expect(connectResult.activeConnection).not.toBeNull();
      expect(connectResult.activeConnection.host).toBe('127.0.0.1');

      // Step 2: Run a query
      queryResponses.set('_rdb2_sub', {
        rows: [{ count: 42 }],
        fields: [{ name: 'count' }],
      });
      const queryResult = await invoke('run-query', 'SELECT count(*) FROM users', 500) as {
        columns: string[];
        rows: string[][];
        rowCount: number;
      };
      expect(queryResult.columns).toEqual(['count']);
      expect(queryResult.rows).toEqual([['42']]);
      expect(queryResult.rowCount).toBe(1);

      // Step 3: Disconnect
      const disconnectResult = await invoke('disconnect') as { activeConnection: null };
      expect(appState.activeConnection).toBeNull();
      expect(disconnectResult.activeConnection).toBeNull();
    });
  });

  describe('table preview flow', () => {
    beforeEach(() => {
      appState.activeConnection = conn;
    });

    it('preview-table returns formatted data', async () => {
      queryResponses.set('_rdb2_sub', {
        rows: [
          { id: 1, name: 'Alice', email: 'alice@test.com' },
          { id: 2, name: 'Bob', email: null },
        ],
        fields: [{ name: 'id' }, { name: 'name' }, { name: 'email' }],
      });

      const result = await invoke('preview-table', 'public', 'users', 200, 0) as {
        columns: string[];
        rows: string[][];
      };

      expect(result.columns).toEqual(['id', 'name', 'email']);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual(['1', 'Alice', 'alice@test.com']);
      expect(result.rows[1]).toEqual(['2', 'Bob', 'NULL']);
    });
  });

  describe('DDL flow', () => {
    beforeEach(() => {
      appState.activeConnection = conn;
    });

    it('get-table-ddl returns DDL result wrapper', async () => {
      // Mock OID query
      mockClient.query.mockImplementation((sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('pg_class c JOIN pg_namespace')) {
          return Promise.resolve({ rows: [{ oid: 12345 }] });
        }
        if (sql.includes('pg_attribute a')) {
          return Promise.resolve({
            rows: [
              { attname: 'id', data_type: 'integer', attnotnull: true, default_expr: null },
              { attname: 'name', data_type: 'text', attnotnull: false, default_expr: null },
            ],
          });
        }
        if (sql.includes('indisprimary')) {
          return Promise.resolve({
            rows: [{ array_agg: ['id'] }],
          });
        }
        if (sql.includes('pg_get_userbyid')) {
          return Promise.resolve({
            rows: [{ pg_get_userbyid: 'postgres' }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await invoke('get-table-ddl', 'public', 'users') as { ddl: string };
      expect(result.ddl).toContain('create table');
      expect(result.ddl).toContain('"public"."users"');
      expect(result.ddl).toContain('id');
      expect(result.ddl).toContain('name');
    });
  });

  describe('modify table flow', () => {
    beforeEach(() => {
      appState.activeConnection = conn;
    });

    it('get-modify-table-info → alter-table round trip', async () => {
      // Step 1: Get table info
      queryResponses.set('pg_attribute', {
        rows: [
          { name: 'id', data_type: 'integer', nullable: false, default_value: null },
          { name: 'name', data_type: 'text', nullable: true, default_value: null },
        ],
      });

      const info = await invoke('get-modify-table-info', 'public', 'users') as {
        schema: string;
        table: string;
        columns: Array<{ name: string; dataType: string }>;
      };
      expect(info.schema).toBe('public');
      expect(info.table).toBe('users');
      expect(info.columns).toHaveLength(2);

      // Step 2: Apply modifications
      queries.length = 0;
      const actions = [
        { type: 'add_column' as const, columnName: 'email', dataType: 'text', nullable: true },
        { type: 'rename_column' as const, columnName: 'name', newColumnName: 'full_name' },
      ];
      await invoke('alter-table', 'public', 'users', actions);

      const alterQueries = queries.filter((q) => q.sql.includes('ALTER TABLE'));
      expect(alterQueries).toHaveLength(2);
      expect(alterQueries[0].sql).toContain('ADD COLUMN "email" text');
      expect(alterQueries[1].sql).toContain('RENAME COLUMN "name" TO "full_name"');
    });
  });

  describe('edit data flow', () => {
    beforeEach(() => {
      appState.activeConnection = conn;
    });

    it('get-editable-table-data → execute-dml round trip', async () => {
      // Step 1: Load editable data
      // Mock getPrimaryKeyColumns call (which creates its own client)
      let callNum = 0;
      mockClient.query.mockImplementation((sql: string, params?: unknown[]) => {
        callNum++;
        queries.push({ sql, params });
        if (sql.includes('indisprimary')) return Promise.resolve({ rows: [{ attname: 'id' }] });
        if (sql.includes('count(*)')) return Promise.resolve({ rows: [{ cnt: 2 }] });
        if (sql.includes('SELECT * FROM')) return Promise.resolve({
          rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
          fields: [{ name: 'id' }, { name: 'name' }],
        });
        if (sql.includes('format_type')) return Promise.resolve({
          rows: [{ attname: 'id', data_type: 'integer' }, { attname: 'name', data_type: 'text' }],
        });
        return Promise.resolve({ rows: [] });
      });

      const data = await invoke('get-editable-table-data', 'public', 'users', 200, 0) as {
        columns: string[];
        primaryKeyColumns: string[];
        totalCount: number;
      };
      expect(data.columns).toEqual(['id', 'name']);
      expect(data.primaryKeyColumns).toEqual(['id']);
      expect(data.totalCount).toBe(2);

      // Step 2: Execute DML operations
      queries.length = 0;
      mockClient.query.mockImplementation((sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return Promise.resolve({ rows: [] });
      });

      const ops = [
        { type: 'update' as const, pkValues: { id: '1' }, changes: { name: 'Alice Smith' } },
        { type: 'insert' as const, values: { id: '3', name: 'Charlie' } },
        { type: 'delete' as const, pkValues: { id: '2' } },
      ];
      await invoke('execute-dml', 'public', 'users', ops);

      expect(queries.some((q) => q.sql === 'BEGIN')).toBe(true);
      expect(queries.some((q) => q.sql.includes('UPDATE'))).toBe(true);
      expect(queries.some((q) => q.sql.includes('INSERT'))).toBe(true);
      expect(queries.some((q) => q.sql.includes('DELETE'))).toBe(true);
      expect(queries.some((q) => q.sql === 'COMMIT')).toBe(true);
    });
  });

  describe('drop/truncate flow', () => {
    beforeEach(() => {
      appState.activeConnection = conn;
    });

    it('drop-table executes DROP and returns refreshed snapshot', async () => {
      const result = await invoke('drop-table', 'public', 'users', false) as { databaseTree: unknown[] };
      expect(queries.some((q) => q.sql === 'DROP TABLE "public"."users"')).toBe(true);
      expect(result).toHaveProperty('databaseTree');
    });

    it('drop-table with cascade', async () => {
      await invoke('drop-table', 'public', 'users', true);
      expect(queries.some((q) => q.sql === 'DROP TABLE "public"."users" CASCADE')).toBe(true);
    });

    it('truncate-table executes TRUNCATE and returns refreshed snapshot', async () => {
      const result = await invoke('truncate-table', 'public', 'users', false) as { databaseTree: unknown[] };
      expect(queries.some((q) => q.sql === 'TRUNCATE TABLE "public"."users"')).toBe(true);
      expect(result).toHaveProperty('databaseTree');
    });

    it('truncate-table with cascade', async () => {
      await invoke('truncate-table', 'public', 'users', true);
      expect(queries.some((q) => q.sql === 'TRUNCATE TABLE "public"."users" CASCADE')).toBe(true);
    });
  });

  describe('export flow', () => {
    beforeEach(() => {
      appState.activeConnection = conn;
    });

    it('export-table-csv queries the table and returns row count', async () => {
      let fetchCount = 0;
      mockClient.query.mockImplementation((sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.startsWith('FETCH')) {
          fetchCount++;
          if (fetchCount === 1) {
            return Promise.resolve({
              rows: [{ id: 1, name: 'Alice' }],
              fields: [{ name: 'id' }, { name: 'name' }],
            });
          }
          return Promise.resolve({ rows: [], fields: [{ name: 'id' }, { name: 'name' }] });
        }
        for (const [pattern, result] of queryResponses) {
          if (sql.includes(pattern)) return Promise.resolve(result);
        }
        return Promise.resolve({ rows: [], fields: [], command: '', rowCount: 0 });
      });

      const count = await invoke('export-table-csv', 'public', 'users', '/tmp/postgrip-test/users.csv');
      expect(count).toBe(1);
      expect(queries.some((q) => q.sql.includes('"public"."users"'))).toBe(true);
    });
  });

  describe('error handling', () => {
    it('propagates database errors through IPC', async () => {
      appState.activeConnection = conn;
      mockClient.query.mockRejectedValueOnce(new Error('relation "missing" does not exist'));
      // testConnection is called inside connect, which re-tests...
      // Let's test run-query directly
      mockClient.query.mockRejectedValue(new Error('relation "missing" does not exist'));
      await expect(invoke('run-query', 'SELECT * FROM missing')).rejects.toThrow('relation "missing" does not exist');
    });
  });
});
