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
import { validateDefault, validateDataType, quoteColumnList, quoteTableRef } from '../../src/main/postgres';

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
      expect(mockClient.connect).toHaveBeenCalled();
      expect(queries.some((q) => q.sql === 'SELECT 1')).toBe(true);
      expect(mockClient.end).toHaveBeenCalled();
    });

    it('disconnects even on query failure', async () => {
      mockClient.query.mockRejectedValueOnce(new Error('connection refused'));
      await expect(postgres.testConnection(conn)).rejects.toThrow('connection refused');
      expect(mockClient.end).toHaveBeenCalled();
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
      let fetchCount = 0;
      mockClient.query.mockImplementation((sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.startsWith('FETCH')) {
          fetchCount++;
          if (fetchCount === 1) {
            return Promise.resolve({
              rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
              fields: [{ name: 'id' }, { name: 'name' }],
            });
          }
          return Promise.resolve({ rows: [], fields: [{ name: 'id' }, { name: 'name' }] });
        }
        return Promise.resolve({ rows: [], fields: [], command: '', rowCount: 0 });
      });

      const count = await postgres.exportTableCsv(conn, 'public', 'users', '/tmp/out.csv');
      expect(count).toBe(2);
      expect(queries.some((q) => q.sql.includes('"public"."users"'))).toBe(true);
    });
  });

  describe('executeDml with typed columns', () => {
    it('casts JSON columns', async () => {
      await postgres.executeDml(conn, 'public', 'users', [
        { type: 'insert', values: { data: '{"key":"val"}' }, columnTypes: { data: 'jsonb' } },
      ]);
      const insertQuery = queries.find((q) => q.sql.includes('INSERT'));
      expect(insertQuery?.sql).toContain('::jsonb');
    });

    it('casts array columns', async () => {
      await postgres.executeDml(conn, 'public', 'users', [
        { type: 'insert', values: { tags: '{a,b}' }, columnTypes: { tags: 'text[]' } },
      ]);
      const insertQuery = queries.find((q) => q.sql.includes('INSERT'));
      expect(insertQuery?.sql).toContain('::text[]');
    });

    it('converts JSON array syntax to PG array literal', async () => {
      await postgres.executeDml(conn, 'public', 'users', [
        { type: 'insert', values: { tags: '["a","b"]' }, columnTypes: { tags: 'text[]' } },
      ]);
      const insertQuery = queries.find((q) => q.sql.includes('INSERT'));
      expect(insertQuery?.params?.[0]).toBe('{a,b}');
    });

    it('handles NULL values in insert', async () => {
      await postgres.executeDml(conn, 'public', 'users', [
        { type: 'insert', values: { name: null } },
      ]);
      const insertQuery = queries.find((q) => q.sql.includes('INSERT'));
      expect(insertQuery?.params).toContain(null);
    });
  });

  describe('getTableDdl', () => {
    it('returns DDL string', async () => {
      queryResponses.set('pg_class c JOIN pg_namespace', {
        rows: [{ oid: 12345 }],
      });
      queryResponses.set('pg_attribute', {
        rows: [
          { attname: 'id', data_type: 'integer', attnotnull: true, default_expr: null },
        ],
      });
      const ddl = await postgres.getTableDdl(conn, 'public', 'users');
      expect(typeof ddl).toBe('string');
      expect(ddl).toContain('create table');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('getEditableTableData', () => {
    it('returns columns, types, rows, and primary keys', async () => {
      // getPrimaryKeyColumns sub-call
      queryResponses.set('indisprimary', {
        rows: [{ attname: 'id' }],
      });
      // count query
      queryResponses.set('count', {
        rows: [{ cnt: 2 }],
      });
      // data query
      queryResponses.set('SELECT * FROM', {
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        fields: [{ name: 'id' }, { name: 'name' }],
      });
      // type query
      queryResponses.set('format_type', {
        rows: [
          { attname: 'id', data_type: 'integer' },
          { attname: 'name', data_type: 'text' },
        ],
      });

      const result = await postgres.getEditableTableData(conn, 'public', 'users', 100, 0);
      expect(result.columns).toBeDefined();
      expect(result.totalCount).toBe(2);
      expect(result.primaryKeyColumns).toBeDefined();
    });
  });

  describe('getHostStats with delta tracking', () => {
    it('returns null TPS on first call (no previous snapshot)', async () => {
      postgres.closeAllPools(); // reset delta counters
      queryResponses.set('pg_database_size', {
        rows: [{ db_size: 0, active: 1, max_conn: 100, txn: 500, uptime: '1 days 02:30:00', cache_ratio: 99.5 }],
      });
      const stats = await postgres.getHostStats(conn);
      expect(stats.tps).toBeNull();
    });

    it('parses uptime with days', async () => {
      queryResponses.set('pg_database_size', {
        rows: [{ db_size: 0, active: 1, max_conn: 100, txn: 0, uptime: '5 days 12:30:45.123', cache_ratio: 0 }],
      });
      const stats = await postgres.getHostStats(conn);
      expect(stats.uptime).toBe('5d 12h 30m');
    });
  });

  describe('closeAllPools', () => {
    it('is callable without error', () => {
      expect(() => postgres.closeAllPools()).not.toThrow();
    });
  });

  describe('executeSql', () => {
    it('executes SQL and releases client', async () => {
      await postgres.executeSql(conn, 'CREATE TABLE test (id int)');
      expect(queries.some((q) => q.sql === 'CREATE TABLE test (id int)')).toBe(true);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('releases client on error', async () => {
      mockClient.query.mockRejectedValueOnce(new Error('syntax error'));
      await expect(postgres.executeSql(conn, 'INVALID SQL')).rejects.toThrow('syntax error');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('getMonitoringData', () => {
    it('returns monitoring data structure', async () => {
      const data = await postgres.getMonitoringData(conn);
      expect(data).toHaveProperty('connectionsByState');
      expect(data).toHaveProperty('connectionsByUser');
      expect(data).toHaveProperty('tableStats');
      expect(data).toHaveProperty('unusedIndexes');
      expect(data).toHaveProperty('locksByType');
      expect(data).toHaveProperty('blockedQueries');
      expect(data).toHaveProperty('deadlocks');
      expect(data).toHaveProperty('tempFiles');
      expect(data).toHaveProperty('tempBytes');
      expect(data).toHaveProperty('conflictsCount');
      expect(data).toHaveProperty('checkpointsTimed');
      expect(data).toHaveProperty('checkpointsReq');
      expect(data).toHaveProperty('buffersCheckpoint');
      expect(data).toHaveProperty('buffersBgwriter');
      expect(data).toHaveProperty('buffersBackend');
      expect(data).toHaveProperty('replicationLag');
      expect(data).toHaveProperty('longRunningTxns');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('parses connection breakdown', async () => {
      queryResponses.set('pg_stat_activity GROUP BY state', {
        rows: [{ state: 'active', count: 5 }, { state: 'idle', count: 10 }],
      });
      const data = await postgres.getMonitoringData(conn);
      expect(data.connectionsByState).toHaveLength(2);
      expect(data.connectionsByState[0]).toEqual({ state: 'active', count: 5 });
    });

    it('parses database stats', async () => {
      queryResponses.set('deadlocks', {
        rows: [{ deadlocks: 3, temp_files: 12, temp_bytes: 1048576, conflicts: 0 }],
      });
      const data = await postgres.getMonitoringData(conn);
      expect(data.deadlocks).toBe(3);
      expect(data.tempFiles).toBe(12);
      expect(data.tempBytes).toBe(1048576);
    });

    it('parses checkpoint stats', async () => {
      queryResponses.set('pg_stat_bgwriter', {
        rows: [{ checkpoints_timed: 100, checkpoints_req: 5, buffers_checkpoint: 500, buffers_clean: 200, buffers_backend: 50 }],
      });
      const data = await postgres.getMonitoringData(conn);
      expect(data.checkpointsTimed).toBe(100);
      expect(data.checkpointsReq).toBe(5);
      expect(data.buffersCheckpoint).toBe(500);
      expect(data.buffersBgwriter).toBe(200);
      expect(data.buffersBackend).toBe(50);
    });

    it('returns empty arrays when queries fail', async () => {
      mockClient.query.mockRejectedValue(new Error('permission denied'));
      // Should not throw — individual queries fail silently
      const data = await postgres.getMonitoringData(conn);
      expect(data.connectionsByState).toEqual([]);
      expect(data.tableStats).toEqual([]);
      expect(data.locksByType).toEqual([]);
    });
  });

  describe('validateDefault', () => {
    it('accepts integer literals', () => {
      expect(validateDefault('42')).toBe('42');
      expect(validateDefault('0')).toBe('0');
    });

    it('accepts decimal literals', () => {
      expect(validateDefault('3.14')).toBe('3.14');
      expect(validateDefault('0.5')).toBe('0.5');
    });

    it('accepts string literals', () => {
      expect(validateDefault("'hello'")).toBe("'hello'");
      expect(validateDefault("'it''s fine'")).toBe("'it''s fine'");
      expect(validateDefault("''")).toBe("''");
    });

    it('accepts NULL', () => {
      expect(validateDefault('NULL')).toBe('NULL');
      expect(validateDefault('null')).toBe('null');
    });

    it('accepts boolean literals', () => {
      expect(validateDefault('TRUE')).toBe('TRUE');
      expect(validateDefault('FALSE')).toBe('FALSE');
      expect(validateDefault('true')).toBe('true');
    });

    it('accepts timestamp functions', () => {
      expect(validateDefault('CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP');
      expect(validateDefault('CURRENT_DATE')).toBe('CURRENT_DATE');
      expect(validateDefault('NOW()')).toBe('NOW()');
    });

    it('accepts gen_random_uuid()', () => {
      expect(validateDefault('gen_random_uuid()')).toBe('gen_random_uuid()');
    });

    it('accepts nextval sequences', () => {
      expect(validateDefault("nextval('my_seq')")).toBe("nextval('my_seq')");
    });

    it('trims whitespace', () => {
      expect(validateDefault('  42  ')).toBe('42');
    });

    it('rejects SQL injection attempts', () => {
      expect(() => validateDefault("'x'; DROP TABLE users; --")).toThrow('Unsafe DEFAULT');
      expect(() => validateDefault('1; DELETE FROM users')).toThrow('Unsafe DEFAULT');
      expect(() => validateDefault('(SELECT password FROM users LIMIT 1)')).toThrow('Unsafe DEFAULT');
    });

    it('rejects subqueries', () => {
      expect(() => validateDefault('(SELECT 1)')).toThrow('Unsafe DEFAULT');
    });

    it('rejects arbitrary function calls', () => {
      expect(() => validateDefault('pg_read_file(\'/etc/passwd\')')).toThrow('Unsafe DEFAULT');
    });
  });

  describe('validateDataType', () => {
    it('accepts common PostgreSQL types', () => {
      expect(validateDataType('integer')).toBe('integer');
      expect(validateDataType('text')).toBe('text');
      expect(validateDataType('boolean')).toBe('boolean');
      expect(validateDataType('bigint')).toBe('bigint');
      expect(validateDataType('serial')).toBe('serial');
      expect(validateDataType('uuid')).toBe('uuid');
      expect(validateDataType('jsonb')).toBe('jsonb');
      expect(validateDataType('timestamptz')).toBe('timestamptz');
    });

    it('accepts types with parameters', () => {
      expect(validateDataType('varchar(255)')).toBe('varchar(255)');
      expect(validateDataType('numeric(10, 2)')).toBe('numeric(10, 2)');
      expect(validateDataType('char(1)')).toBe('char(1)');
    });

    it('accepts array types', () => {
      expect(validateDataType('integer[]')).toBe('integer[]');
      expect(validateDataType('text[]')).toBe('text[]');
    });

    it('accepts multi-word types', () => {
      expect(validateDataType('double precision')).toBe('double precision');
      expect(validateDataType('timestamp without time zone')).toBe('timestamp without time zone');
    });

    it('trims whitespace', () => {
      expect(validateDataType('  text  ')).toBe('text');
    });

    it('rejects SQL injection attempts', () => {
      expect(() => validateDataType('integer); DROP TABLE users; --')).toThrow('Invalid data type');
      expect(() => validateDataType("text'; DELETE FROM users")).toThrow('Invalid data type');
    });

    it('rejects empty strings', () => {
      expect(() => validateDataType('')).toThrow('Invalid data type');
    });

    it('rejects strings starting with numbers', () => {
      expect(() => validateDataType('123abc')).toThrow('Invalid data type');
    });
  });

  describe('quoteColumnList', () => {
    it('quotes a single column', () => {
      expect(quoteColumnList('id')).toBe('"id"');
    });

    it('quotes multiple columns', () => {
      expect(quoteColumnList('id, name, email')).toBe('"id", "name", "email"');
    });

    it('handles columns without spaces after commas', () => {
      expect(quoteColumnList('id,name')).toBe('"id", "name"');
    });

    it('escapes double quotes in column names', () => {
      expect(quoteColumnList('my"col')).toBe('"my""col"');
    });

    it('trims whitespace from column names', () => {
      expect(quoteColumnList('  id  ,  name  ')).toBe('"id", "name"');
    });
  });

  describe('quoteTableRef', () => {
    it('quotes a simple table name', () => {
      expect(quoteTableRef('users')).toBe('"users"');
    });

    it('quotes schema-qualified table name', () => {
      expect(quoteTableRef('public.users')).toBe('"public"."users"');
    });

    it('trims whitespace', () => {
      expect(quoteTableRef(' public . users ')).toBe('"public"."users"');
    });

    it('escapes double quotes', () => {
      expect(quoteTableRef('my"schema.my"table')).toBe('"my""schema"."my""table"');
    });
  });

  describe('createSchema', () => {
    it('executes CREATE SCHEMA with quoted name', async () => {
      await postgres.createSchema(conn, 'my_schema');
      expect(queries.some((q) => q.sql === 'CREATE SCHEMA "my_schema"')).toBe(true);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('escapes special characters in schema name', async () => {
      await postgres.createSchema(conn, 'my"schema');
      expect(queries.some((q) => q.sql === 'CREATE SCHEMA "my""schema"')).toBe(true);
    });

    it('releases client on error', async () => {
      mockClient.query.mockRejectedValueOnce(new Error('already exists'));
      await expect(postgres.createSchema(conn, 'dup')).rejects.toThrow('already exists');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('createTable', () => {
    it('creates a simple table', async () => {
      await postgres.createTable(conn, 'public', 'users', [
        { name: 'id', type: 'serial', nullable: false },
        { name: 'name', type: 'text', nullable: true },
      ]);
      const createQuery = queries.find((q) => q.sql.includes('CREATE TABLE'));
      expect(createQuery).toBeDefined();
      expect(createQuery!.sql).toContain('"public"."users"');
      expect(createQuery!.sql).toContain('"id" serial NOT NULL');
      expect(createQuery!.sql).toContain('"name" text');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('adds primary key constraint', async () => {
      await postgres.createTable(conn, 'public', 'users', [
        { name: 'id', type: 'integer', nullable: false, pk: true },
        { name: 'name', type: 'text', nullable: true },
      ]);
      const createQuery = queries.find((q) => q.sql.includes('CREATE TABLE'));
      expect(createQuery!.sql).toContain('PRIMARY KEY ("id")');
    });

    it('adds composite primary key', async () => {
      await postgres.createTable(conn, 'public', 'order_items', [
        { name: 'order_id', type: 'integer', nullable: false, pk: true },
        { name: 'item_id', type: 'integer', nullable: false, pk: true },
      ]);
      const createQuery = queries.find((q) => q.sql.includes('CREATE TABLE'));
      expect(createQuery!.sql).toContain('PRIMARY KEY ("order_id", "item_id")');
    });

    it('adds foreign keys with quoted references', async () => {
      await postgres.createTable(conn, 'public', 'orders', [
        { name: 'id', type: 'serial', nullable: false },
        { name: 'user_id', type: 'integer', nullable: false },
      ], [
        { column: 'user_id', refTable: 'public.users', refColumn: 'id' },
      ]);
      const createQuery = queries.find((q) => q.sql.includes('CREATE TABLE'));
      expect(createQuery!.sql).toContain('FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id")');
    });

    it('creates indexes with quoted column names', async () => {
      await postgres.createTable(conn, 'public', 'users', [
        { name: 'email', type: 'text', nullable: false },
      ], undefined, [
        { columns: 'email', unique: true },
      ]);
      const idxQuery = queries.find((q) => q.sql.includes('CREATE UNIQUE INDEX'));
      expect(idxQuery).toBeDefined();
      expect(idxQuery!.sql).toContain('("email")');
    });

    it('creates multi-column indexes', async () => {
      await postgres.createTable(conn, 'public', 'users', [
        { name: 'first', type: 'text', nullable: true },
        { name: 'last', type: 'text', nullable: true },
      ], undefined, [
        { columns: 'first, last' },
      ]);
      const idxQuery = queries.find((q) => q.sql.includes('CREATE INDEX'));
      expect(idxQuery!.sql).toContain('("first", "last")');
    });

    it('validates data types', async () => {
      await expect(
        postgres.createTable(conn, 'public', 'bad', [
          { name: 'x', type: 'integer); DROP TABLE users; --', nullable: true },
        ])
      ).rejects.toThrow('Invalid data type');
    });

    it('validates default values', async () => {
      await expect(
        postgres.createTable(conn, 'public', 'bad', [
          { name: 'x', type: 'text', nullable: true, defaultValue: "'; DROP TABLE users; --" },
        ])
      ).rejects.toThrow('Unsafe DEFAULT');
    });

    it('accepts valid default values', async () => {
      await postgres.createTable(conn, 'public', 'test', [
        { name: 'active', type: 'boolean', nullable: false, defaultValue: 'TRUE' },
        { name: 'count', type: 'integer', nullable: false, defaultValue: '0' },
      ]);
      const createQuery = queries.find((q) => q.sql.includes('CREATE TABLE'));
      expect(createQuery!.sql).toContain('DEFAULT TRUE');
      expect(createQuery!.sql).toContain('DEFAULT 0');
    });

    it('releases client on error', async () => {
      mockClient.query.mockRejectedValueOnce(new Error('already exists'));
      await expect(
        postgres.createTable(conn, 'public', 'dup', [{ name: 'id', type: 'serial', nullable: false }])
      ).rejects.toThrow('already exists');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('exportTableParquet', () => {
    it('queries the table and returns row count', async () => {
      const mockWriter = { appendRow: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
      vi.doMock('parquetjs-lite', () => ({
        ParquetSchema: vi.fn(),
        ParquetWriter: { openFile: vi.fn().mockResolvedValue(mockWriter) },
      }));

      let fetchCount = 0;
      mockClient.query.mockImplementation((sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.startsWith('FETCH')) {
          fetchCount++;
          if (fetchCount === 1) {
            return Promise.resolve({
              rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
              fields: [
                { name: 'id', dataTypeID: 23 },
                { name: 'name', dataTypeID: 25 },
              ],
            });
          }
          return Promise.resolve({ rows: [], fields: [] });
        }
        return Promise.resolve({ rows: [], fields: [], command: '', rowCount: 0 });
      });

      const count = await postgres.exportTableParquet(conn, 'public', 'users', '/tmp/test.parquet');
      expect(count).toBe(2);
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
