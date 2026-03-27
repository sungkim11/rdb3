import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConnection } from '../mocks/pg';

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

import * as postgres from '../../src/main/postgres';

describe('postgres', () => {
  const conn = testConnection();

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
    resetQueryMock();
  });

  describe('testConnection', () => {
    it('connects, runs SELECT 1, and disconnects', async () => {
      await postgres.testConnection(conn);
      expect(queries.some((q) => q.sql === 'SELECT 1')).toBe(true);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('disconnects even on query failure', async () => {
      mockClient.query.mockRejectedValueOnce(new Error('connection refused'));
      await expect(postgres.testConnection(conn)).rejects.toThrow('connection refused');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('getHostStats', () => {
    it('returns stats object with all null fields on empty responses', async () => {
      const stats = await postgres.getHostStats(conn);
      expect(stats).toBeDefined();
      expect(stats.dbSizeMb).toBeNull();
      expect(stats.activeConnections).toBeNull();
      expect(stats.tps).toBeNull();
      expect(stats.uptime).toBeNull();
      expect(stats.cacheHitRatio).toBeNull();
      expect(stats.cpuUsagePercent).toBeNull();
      expect(stats.memTotalMb).toBeNull();
    });

    it('parses database size', async () => {
      queryResponses.set('pg_database_size', {
        rows: [{ db_size: 104857600, active: 0, max_conn: 100, txn: 0, uptime: '0:0:0', cache_ratio: 0 }],
      });
      const stats = await postgres.getHostStats(conn);
      expect(stats.dbSizeMb).toBe(100);
    });

    it('parses connection stats and saturation', async () => {
      queryResponses.set('pg_stat_activity', {
        rows: [{ db_size: 0, active: 10, max_conn: 100, txn: 0, uptime: '0:0:0', cache_ratio: 0 }],
      });
      const stats = await postgres.getHostStats(conn);
      expect(stats.activeConnections).toBe(10);
      expect(stats.maxConnections).toBe(100);
      expect(stats.connectionSaturationPercent).toBe(10);
    });

    it('always disconnects', async () => {
      await postgres.getHostStats(conn);
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('getActiveQueries', () => {
    it('returns mapped query results', async () => {
      queryResponses.set('pg_stat_activity', {
        rows: [
          { pid: 123, usename: 'admin', state: 'active', query: 'SELECT 1', duration_ms: 150.7 },
          { pid: 456, usename: 'app', state: 'active', query: 'UPDATE t SET x=1', duration_ms: 5200.3 },
        ],
      });
      const result = await postgres.getActiveQueries(conn);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ pid: 123, usename: 'admin', state: 'active', query: 'SELECT 1', durationMs: 151 });
      expect(result[1].durationMs).toBe(5200);
    });

    it('returns empty array when no active queries', async () => {
      const result = await postgres.getActiveQueries(conn);
      expect(result).toEqual([]);
    });
  });

  describe('runQuery', () => {
    it('wraps query in subselect with limit', async () => {
      queryResponses.set('_rdb2_sub', {
        rows: [{ id: 1, name: 'Alice' }],
        fields: [{ name: 'id' }, { name: 'name' }],
      });
      const result = await postgres.runQuery(conn, 'SELECT * FROM users', 500);
      expect(result.columns).toEqual(['id', 'name']);
      expect(result.rows).toEqual([['1', 'Alice']]);
      expect(result.rowCount).toBe(1);
      expect(result.truncated).toBe(false);
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('converts null values to "NULL" string', async () => {
      queryResponses.set('_rdb2_sub', {
        rows: [{ id: 1, name: null }],
        fields: [{ name: 'id' }, { name: 'name' }],
      });
      const result = await postgres.runQuery(conn, 'SELECT * FROM users', 500);
      expect(result.rows[0][1]).toBe('NULL');
    });

    it('detects truncation when rows exceed limit', async () => {
      const manyRows = Array.from({ length: 4 }, (_, i) => ({ id: i }));
      queryResponses.set('_rdb2_sub', {
        rows: manyRows,
        fields: [{ name: 'id' }],
      });
      const result = await postgres.runQuery(conn, 'SELECT id FROM t', 3);
      expect(result.truncated).toBe(true);
      expect(result.rows).toHaveLength(3);
      expect(result.notice).toBe('Showing the first 3 rows.');
    });

    it('falls back to original SQL on wrapped query failure', async () => {
      let callCount = 0;
      mockClient.query.mockImplementation((sql: string) => {
        callCount++;
        if (callCount === 1) throw new Error('wrapped failed');
        queries.push({ sql });
        return Promise.resolve({ rows: [], fields: [], command: 'CREATE TABLE', rowCount: 0 });
      });
      const result = await postgres.runQuery(conn, 'CREATE TABLE t (id int)', 500);
      expect(result.notice).toBe('CREATE TABLE 0');
    });

    it('strips trailing semicolons before wrapping', async () => {
      queryResponses.set('_rdb2_sub', { rows: [], fields: [] });
      await postgres.runQuery(conn, 'SELECT 1;;;', 500);
      const wrappedQuery = queries.find((q) => q.sql.includes('_rdb2_sub'));
      expect(wrappedQuery?.sql).not.toContain(';;;');
    });
  });

  describe('dropTable', () => {
    it('executes DROP TABLE without cascade', async () => {
      await postgres.dropTable(conn, 'public', 'users', false);
      expect(queries.some((q) => q.sql === 'DROP TABLE "public"."users"')).toBe(true);
    });

    it('executes DROP TABLE with CASCADE', async () => {
      await postgres.dropTable(conn, 'public', 'users', true);
      expect(queries.some((q) => q.sql === 'DROP TABLE "public"."users" CASCADE')).toBe(true);
    });

    it('quotes identifiers with special characters', async () => {
      await postgres.dropTable(conn, 'my schema', 'my table', false);
      expect(queries.some((q) => q.sql === 'DROP TABLE "my schema"."my table"')).toBe(true);
    });
  });

  describe('truncateTable', () => {
    it('executes TRUNCATE TABLE without cascade', async () => {
      await postgres.truncateTable(conn, 'public', 'users', false);
      expect(queries.some((q) => q.sql === 'TRUNCATE TABLE "public"."users"')).toBe(true);
    });

    it('executes TRUNCATE TABLE with CASCADE', async () => {
      await postgres.truncateTable(conn, 'public', 'users', true);
      expect(queries.some((q) => q.sql === 'TRUNCATE TABLE "public"."users" CASCADE')).toBe(true);
    });
  });

  describe('getPrimaryKeyColumns', () => {
    it('returns primary key column names', async () => {
      queryResponses.set('indisprimary', {
        rows: [{ attname: 'id' }, { attname: 'tenant_id' }],
      });
      const result = await postgres.getPrimaryKeyColumns(conn, 'public', 'users');
      expect(result).toEqual(['id', 'tenant_id']);
    });

    it('returns empty array when no primary key', async () => {
      const result = await postgres.getPrimaryKeyColumns(conn, 'public', 'log');
      expect(result).toEqual([]);
    });
  });

  describe('fetchTree', () => {
    it('builds schema tree from query results', async () => {
      // Mock table/column query
      mockClient.query.mockImplementation((sql: string) => {
        queries.push({ sql });
        if (sql.includes('information_schema.tables')) {
          return Promise.resolve({
            rows: [
              { table_schema: 'public', table_name: 'users', table_type: 'BASE TABLE', column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
              { table_schema: 'public', table_name: 'users', table_type: 'BASE TABLE', column_name: 'name', data_type: 'text', is_nullable: 'YES', column_default: null },
            ],
          });
        }
        if (sql.includes('table_constraints')) {
          return Promise.resolve({
            rows: [
              { table_schema: 'public', table_name: 'users', constraint_name: 'users_pkey', constraint_type: 'PRIMARY KEY', columns: ['id'], referenced_table: null },
            ],
          });
        }
        if (sql.includes('pg_index')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const tree = await postgres.fetchTree(conn);
      expect(tree).toHaveLength(1);
      expect(tree[0].name).toBe('public');
      expect(tree[0].tables).toHaveLength(1);

      const usersTable = tree[0].tables[0];
      expect(usersTable.name).toBe('users');
      expect(usersTable.tableType).toBe('BASE TABLE');
      expect(usersTable.columns).toHaveLength(2);
      expect(usersTable.columns[0]).toEqual({ name: 'id', dataType: 'integer', nullable: false, defaultValue: null });
      expect(usersTable.columns[1]).toEqual({ name: 'name', dataType: 'text', nullable: true, defaultValue: null });
      expect(usersTable.keys).toHaveLength(1);
      expect(usersTable.keys[0].type).toBe('PRIMARY KEY');
    });
  });

  describe('executeDml', () => {
    it('wraps operations in a transaction', async () => {
      await postgres.executeDml(conn, 'public', 'users', [
        { type: 'insert', values: { name: 'Alice' } },
      ]);
      const sqlList = queries.map((q) => q.sql);
      expect(sqlList).toContain('BEGIN');
      expect(sqlList).toContain('COMMIT');
      const beginIdx = sqlList.indexOf('BEGIN');
      const commitIdx = sqlList.indexOf('COMMIT');
      const insertIdx = sqlList.findIndex((s) => s.includes('INSERT'));
      expect(beginIdx).toBeLessThan(insertIdx);
      expect(insertIdx).toBeLessThan(commitIdx);
    });

    it('generates correct INSERT SQL', async () => {
      await postgres.executeDml(conn, 'public', 'users', [
        { type: 'insert', values: { name: 'Bob', email: 'bob@test.com' } },
      ]);
      const insertQuery = queries.find((q) => q.sql.includes('INSERT'));
      expect(insertQuery?.sql).toContain('"public"."users"');
      expect(insertQuery?.sql).toContain('"name"');
      expect(insertQuery?.sql).toContain('"email"');
      expect(insertQuery?.params).toContain('Bob');
      expect(insertQuery?.params).toContain('bob@test.com');
    });

    it('generates correct UPDATE SQL with parameterized PK', async () => {
      await postgres.executeDml(conn, 'public', 'users', [
        { type: 'update', pkValues: { id: '1' }, changes: { name: 'Updated' } },
      ]);
      const updateQuery = queries.find((q) => q.sql.includes('UPDATE'));
      expect(updateQuery?.sql).toContain('SET "name" = $1');
      expect(updateQuery?.sql).toContain('WHERE "id" = $2');
      expect(updateQuery?.params).toEqual(['Updated', '1']);
    });

    it('handles NULL pk values with IS NULL', async () => {
      await postgres.executeDml(conn, 'public', 'users', [
        { type: 'delete', pkValues: { id: null } },
      ]);
      const deleteQuery = queries.find((q) => q.sql.includes('DELETE'));
      expect(deleteQuery?.sql).toContain('"id" IS NULL');
    });

    it('generates correct DELETE SQL', async () => {
      await postgres.executeDml(conn, 'public', 'users', [
        { type: 'delete', pkValues: { id: '42' } },
      ]);
      const deleteQuery = queries.find((q) => q.sql.includes('DELETE'));
      expect(deleteQuery?.sql).toContain('DELETE FROM "public"."users"');
      expect(deleteQuery?.sql).toContain('"id" = $1');
      expect(deleteQuery?.params).toEqual(['42']);
    });

    it('rolls back on error', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        queries.push({ sql });
        if (sql.includes('INSERT')) return Promise.reject(new Error('constraint violation'));
        return Promise.resolve({ rows: [] });
      });
      await expect(
        postgres.executeDml(conn, 'public', 'users', [{ type: 'insert', values: { name: 'fail' } }]),
      ).rejects.toThrow('constraint violation');
      expect(queries.some((q) => q.sql === 'ROLLBACK')).toBe(true);
    });

    it('executes multiple operations in sequence', async () => {
      await postgres.executeDml(conn, 'public', 'users', [
        { type: 'insert', values: { name: 'Alice' } },
        { type: 'update', pkValues: { id: '1' }, changes: { name: 'Bob' } },
        { type: 'delete', pkValues: { id: '2' } },
      ]);
      const ops = queries.filter((q) => q.sql.includes('INSERT') || q.sql.includes('UPDATE') || q.sql.includes('DELETE'));
      expect(ops).toHaveLength(3);
    });
  });

  describe('alterTable', () => {
    it('wraps ALTER statements in a transaction', async () => {
      await postgres.alterTable(conn, 'public', 'users', [
        { type: 'add_column', columnName: 'email', dataType: 'text', nullable: true },
      ]);
      const sqlList = queries.map((q) => q.sql);
      expect(sqlList).toContain('BEGIN');
      expect(sqlList).toContain('COMMIT');
    });

    it('generates ADD COLUMN with NOT NULL', async () => {
      await postgres.alterTable(conn, 'public', 'users', [
        { type: 'add_column', columnName: 'age', dataType: 'integer', nullable: false },
      ]);
      const alter = queries.find((q) => q.sql.includes('ADD COLUMN'));
      expect(alter?.sql).toBe('ALTER TABLE "public"."users" ADD COLUMN "age" integer NOT NULL');
    });

    it('generates ADD COLUMN with DEFAULT', async () => {
      await postgres.alterTable(conn, 'public', 'users', [
        { type: 'add_column', columnName: 'status', dataType: 'text', nullable: true, defaultValue: "'active'" },
      ]);
      const alter = queries.find((q) => q.sql.includes('ADD COLUMN'));
      expect(alter?.sql).toContain("DEFAULT 'active'");
    });

    it('generates DROP COLUMN', async () => {
      await postgres.alterTable(conn, 'public', 'users', [
        { type: 'drop_column', columnName: 'email' },
      ]);
      expect(queries.some((q) => q.sql === 'ALTER TABLE "public"."users" DROP COLUMN "email"')).toBe(true);
    });

    it('generates RENAME COLUMN', async () => {
      await postgres.alterTable(conn, 'public', 'users', [
        { type: 'rename_column', columnName: 'name', newColumnName: 'full_name' },
      ]);
      expect(queries.some((q) => q.sql === 'ALTER TABLE "public"."users" RENAME COLUMN "name" TO "full_name"')).toBe(true);
    });

    it('generates ALTER TYPE', async () => {
      await postgres.alterTable(conn, 'public', 'users', [
        { type: 'alter_type', columnName: 'age', dataType: 'bigint' },
      ]);
      expect(queries.some((q) => q.sql === 'ALTER TABLE "public"."users" ALTER COLUMN "age" TYPE bigint')).toBe(true);
    });

    it('generates SET/DROP NOT NULL', async () => {
      await postgres.alterTable(conn, 'public', 'users', [
        { type: 'set_not_null', columnName: 'email' },
        { type: 'drop_not_null', columnName: 'name' },
      ]);
      expect(queries.some((q) => q.sql.includes('SET NOT NULL'))).toBe(true);
      expect(queries.some((q) => q.sql.includes('DROP NOT NULL'))).toBe(true);
    });

    it('generates SET/DROP DEFAULT', async () => {
      await postgres.alterTable(conn, 'public', 'users', [
        { type: 'set_default', columnName: 'role', defaultValue: "'user'" },
        { type: 'drop_default', columnName: 'status' },
      ]);
      expect(queries.some((q) => q.sql.includes("SET DEFAULT 'user'"))).toBe(true);
      expect(queries.some((q) => q.sql.includes('DROP DEFAULT'))).toBe(true);
    });

    it('generates RENAME TABLE', async () => {
      await postgres.alterTable(conn, 'public', 'users', [
        { type: 'rename_table', newTableName: 'accounts' },
      ]);
      expect(queries.some((q) => q.sql === 'ALTER TABLE "public"."users" RENAME TO "accounts"')).toBe(true);
    });

    it('rolls back on ALTER failure', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        queries.push({ sql });
        if (sql.includes('ALTER')) return Promise.reject(new Error('syntax error'));
        return Promise.resolve({ rows: [] });
      });
      await expect(
        postgres.alterTable(conn, 'public', 'users', [{ type: 'drop_column', columnName: 'bad' }]),
      ).rejects.toThrow('syntax error');
      expect(queries.some((q) => q.sql === 'ROLLBACK')).toBe(true);
      expect(queries.some((q) => q.sql === 'COMMIT')).toBe(false);
    });
  });

  describe('getModifyTableInfo', () => {
    it('returns column info for table', async () => {
      queryResponses.set('pg_attribute', {
        rows: [
          { name: 'id', data_type: 'integer', nullable: false, default_value: null },
          { name: 'name', data_type: 'text', nullable: true, default_value: "'unnamed'" },
        ],
      });
      const result = await postgres.getModifyTableInfo(conn, 'public', 'users');
      expect(result.schema).toBe('public');
      expect(result.table).toBe('users');
      expect(result.columns).toHaveLength(2);
      expect(result.columns[0]).toEqual({ name: 'id', dataType: 'integer', nullable: false, defaultValue: null });
      expect(result.columns[1]).toEqual({ name: 'name', dataType: 'text', nullable: true, defaultValue: "'unnamed'" });
    });
  });

  describe('previewTable', () => {
    it('generates correct SELECT with quoted identifiers', async () => {
      queryResponses.set('_rdb2_sub', {
        rows: [{ id: 1 }],
        fields: [{ name: 'id' }],
      });
      await postgres.previewTable(conn, 'public', 'users', 200, 0);
      const selectQuery = queries.find((q) => q.sql.includes('"public"."users"'));
      expect(selectQuery).toBeDefined();
      expect(selectQuery?.sql).toContain('LIMIT 200');
      expect(selectQuery?.sql).toContain('OFFSET 0');
    });
  });

  describe('exportTableCsv', () => {
    it('queries the table and returns row count', async () => {
      queryResponses.set('SELECT * FROM', {
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        fields: [{ name: 'id' }, { name: 'name' }],
      });

      const count = await postgres.exportTableCsv(conn, 'public', 'users', '/tmp/out.csv');
      expect(count).toBe(2);
      expect(queries.some((q) => q.sql.includes('"public"."users"'))).toBe(true);
    });
  });
});
