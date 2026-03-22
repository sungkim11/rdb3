import pg from 'pg';
import type { SavedConnection, QueryResult, SchemaNode, ColumnNode, TableNode, KeyNode, IndexNode } from './types';
import { buildConnectionString } from './types';
import { openTunnel } from './ssh-tunnel';
import { lookupPgpass } from './pgpass';

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Convert a JS array to PostgreSQL array literal format: {a,b,"c with spaces"} */
function toPgArrayLiteral(arr: unknown[]): string {
  const elements = arr.map((el) => {
    if (el == null) return 'NULL';
    if (Array.isArray(el)) return toPgArrayLiteral(el);
    const s = String(el);
    // Quote if contains special chars, is empty, or looks like NULL
    if (s === '' || /[{},"\\\s]/.test(s) || s.toUpperCase() === 'NULL') {
      return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return s;
  });
  return `{${elements.join(',')}}`;
}

/** Serialize a PostgreSQL value to a lossless string representation. */
function serializeValue(val: unknown): string {
  if (val == null) return 'NULL';
  if (Array.isArray(val)) {
    return toPgArrayLiteral(val);
  }
  if (typeof val === 'object') {
    // json, jsonb, composite types — use JSON.stringify for lossless round-trip
    return JSON.stringify(val);
  }
  return String(val);
}

async function connect(conn: SavedConnection): Promise<pg.Client> {
  let host = conn.host;
  let port = conn.port;

  // If SSH tunnel is enabled, route through it
  if (conn.ssh?.enabled) {
    port = await openTunnel(conn.ssh, conn.host, conn.port);
    host = '127.0.0.1';
  }

  // Resolve password: use pgpass if authMethod is 'pgpass' or if password is empty
  let password = conn.password;
  if (conn.authMethod === 'pgpass' || !password) {
    password = lookupPgpass(conn.host, conn.port, conn.database, conn.user) ?? '';
  }

  const config: pg.ClientConfig = {
    host,
    port,
    user: conn.user,
    database: conn.database,
    connectionTimeoutMillis: 10000,
  };
  // Only set password if we have one — omitting lets libpq/pg try env vars and pgpass
  if (password) {
    config.password = password;
  }

  const client = new pg.Client(config);
  await client.connect();
  return client;
}


export interface HostStats {
  cpuUsagePercent: number | null;
  memTotalMb: number | null;
  memUsedMb: number | null;
  memUsagePercent: number | null;
  dbSizeMb: number | null;
  activeConnections: number | null;
  maxConnections: number | null;
  connectionSaturationPercent: number | null;
  tps: number | null;
  uptime: string | null;
  cacheHitRatio: number | null;
}

export async function getHostStats(conn: SavedConnection): Promise<HostStats> {
  const client = await connect(conn);
  try {
    const stats: HostStats = {
      cpuUsagePercent: null,
      memTotalMb: null,
      memUsedMb: null,
      memUsagePercent: null,
      dbSizeMb: null,
      activeConnections: null,
      maxConnections: null,
      connectionSaturationPercent: null,
      tps: null,
      uptime: null,
      cacheHitRatio: null,
    };

    // DB size
    try {
      const r = await client.query('SELECT pg_database_size(current_database()) AS size');
      stats.dbSizeMb = Math.round(Number(r.rows[0].size) / 1024 / 1024);
    } catch {}

    // Active connections + saturation
    try {
      const r = await client.query(`
        SELECT
          (SELECT count(*)::int FROM pg_stat_activity) AS active,
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn
      `);
      stats.activeConnections = r.rows[0].active;
      stats.maxConnections = r.rows[0].max_conn;
      if (stats.maxConnections && stats.maxConnections > 0) {
        stats.connectionSaturationPercent = Math.round((stats.activeConnections! / stats.maxConnections) * 100);
      }
    } catch {}

    // Transaction throughput (TPS) - measure over 1 second
    try {
      const r1 = await client.query(
        `SELECT xact_commit + xact_rollback AS txn FROM pg_stat_database WHERE datname = current_database()`
      );
      await client.query('SELECT pg_sleep(1)');
      const r2 = await client.query(
        `SELECT xact_commit + xact_rollback AS txn FROM pg_stat_database WHERE datname = current_database()`
      );
      const t1 = Number(r1.rows[0].txn);
      const t2 = Number(r2.rows[0].txn);
      stats.tps = Math.max(0, t2 - t1);
    } catch {}

    // Uptime
    try {
      const r = await client.query("SELECT now() - pg_postmaster_start_time() AS uptime");
      const raw = String(r.rows[0].uptime);
      // Format: "X days HH:MM:SS.xxx" -> simplify
      const match = raw.match(/^(?:(\d+)\s+days?\s+)?(\d+):(\d+):/);
      if (match) {
        const days = match[1] ? `${match[1]}d ` : '';
        stats.uptime = `${days}${match[2]}h ${match[3]}m`;
      } else {
        stats.uptime = raw.split('.')[0];
      }
    } catch {}

    // Cache hit ratio
    try {
      const r = await client.query(
        `SELECT CASE WHEN blks_hit + blks_read = 0 THEN 0
                ELSE round(100.0 * blks_hit / (blks_hit + blks_read), 1) END AS ratio
         FROM pg_stat_database WHERE datname = current_database()`
      );
      stats.cacheHitRatio = Number(r.rows[0].ratio);
    } catch {}

    // Host memory from /proc/meminfo (Linux only, requires superuser)
    try {
      const r = await client.query("SELECT pg_read_file('/proc/meminfo') AS info");
      const info = String(r.rows[0].info);
      const totalMatch = info.match(/MemTotal:\s+(\d+)/);
      const availMatch = info.match(/MemAvailable:\s+(\d+)/);
      if (totalMatch && availMatch) {
        const totalKb = Number(totalMatch[1]);
        const availKb = Number(availMatch[1]);
        stats.memTotalMb = Math.round(totalKb / 1024);
        stats.memUsedMb = Math.round((totalKb - availKb) / 1024);
        stats.memUsagePercent = Math.round(((totalKb - availKb) / totalKb) * 100);
      }
    } catch {}

    // Host CPU from /proc/stat (Linux only, requires superuser)
    // Take two snapshots 500ms apart to measure usage
    try {
      const r1 = await client.query("SELECT pg_read_file('/proc/stat') AS info");
      await client.query("SELECT pg_sleep(0.5)");
      const r2 = await client.query("SELECT pg_read_file('/proc/stat') AS info");

      const parseCpu = (text: string) => {
        const line = String(text).split('\n')[0]; // "cpu  user nice system idle ..."
        const parts = line.trim().split(/\s+/).slice(1).map(Number);
        const idle = parts[3] + (parts[4] || 0); // idle + iowait
        const total = parts.reduce((a, b) => a + b, 0);
        return { idle, total };
      };

      const s1 = parseCpu(r1.rows[0].info);
      const s2 = parseCpu(r2.rows[0].info);
      const idleDelta = s2.idle - s1.idle;
      const totalDelta = s2.total - s1.total;
      if (totalDelta > 0) {
        stats.cpuUsagePercent = Math.round(((totalDelta - idleDelta) / totalDelta) * 100);
      }
    } catch {}

    return stats;
  } finally {
    await client.end();
  }
}

export interface ActiveQuery {
  pid: number;
  usename: string;
  state: string;
  query: string;
  durationMs: number;
}

export async function getActiveQueries(conn: SavedConnection): Promise<ActiveQuery[]> {
  const client = await connect(conn);
  try {
    const result = await client.query(`
      SELECT pid,
             usename,
             state,
             query,
             EXTRACT(EPOCH FROM (now() - query_start))::float * 1000 AS duration_ms
      FROM pg_stat_activity
      WHERE query IS NOT NULL
        AND pid != pg_backend_pid()
        AND state != 'idle'
      ORDER BY query_start ASC
      LIMIT 50
    `);
    return result.rows.map((r: Record<string, unknown>) => ({
      pid: r.pid as number,
      usename: r.usename as string,
      state: r.state as string,
      query: r.query as string,
      durationMs: Math.round(r.duration_ms as number),
    }));
  } finally {
    await client.end();
  }
}

export async function testConnection(conn: SavedConnection): Promise<void> {
  const client = await connect(conn);
  try {
    await client.query('SELECT 1');
  } finally {
    await client.end();
  }
}

export async function fetchTree(conn: SavedConnection): Promise<SchemaNode[]> {
  const client = await connect(conn);
  try {
    const { rows } = await client.query(
      `SELECT t.table_schema, t.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable, c.column_default
       FROM information_schema.tables t
       JOIN information_schema.columns c
         ON c.table_schema = t.table_schema AND c.table_name = t.table_name
       WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY t.table_schema, t.table_name, c.ordinal_position`
    );

    const schemaOrder: string[] = [];
    const schemaMap = new Map<string, string[]>();
    const tableMap = new Map<string, TableNode>();

    for (const row of rows) {
      const schemaName: string = row.table_schema;
      const tableName: string = row.table_name;
      const tableType: string = row.table_type;
      const columnName: string = row.column_name;
      const dataType: string = row.data_type;
      const isNullable: string = row.is_nullable;
      const defaultValue: string | null = row.column_default;

      if (!schemaMap.has(schemaName)) {
        schemaOrder.push(schemaName);
        schemaMap.set(schemaName, []);
      }

      const key = `${schemaName}.${tableName}`;
      if (!tableMap.has(key)) {
        schemaMap.get(schemaName)!.push(tableName);
        tableMap.set(key, { name: tableName, tableType, columns: [], keys: [], indexes: [] });
      }

      const col: ColumnNode = {
        name: columnName,
        dataType,
        nullable: isNullable === 'YES',
        defaultValue,
      };
      tableMap.get(key)!.columns.push(col);
    }

    // Fetch keys (primary, unique, foreign)
    const { rows: keyRows } = await client.query(
      `SELECT
         tc.table_schema, tc.table_name, tc.constraint_name, tc.constraint_type,
         array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns,
         ccu.table_schema || '.' || ccu.table_name AS referenced_table
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       LEFT JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
         AND tc.constraint_type = 'FOREIGN KEY'
       WHERE tc.table_schema NOT IN ('pg_catalog', 'information_schema')
         AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
       GROUP BY tc.table_schema, tc.table_name, tc.constraint_name, tc.constraint_type, ccu.table_schema, ccu.table_name
       ORDER BY tc.table_schema, tc.table_name, tc.constraint_type`
    );

    for (const row of keyRows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const table = tableMap.get(key);
      if (table) {
        const keyNode: KeyNode = {
          name: row.constraint_name,
          type: row.constraint_type,
          columns: row.columns,
          referencedTable: row.referenced_table ?? null,
        };
        table.keys.push(keyNode);
      }
    }

    // Fetch indexes
    const { rows: indexRows } = await client.query(
      `SELECT
         n.nspname AS table_schema,
         t.relname AS table_name,
         i.relname AS index_name,
         ix.indisunique AS is_unique,
         array_agg(a.attname ORDER BY x.n) AS columns
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, n) ON true
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND NOT ix.indisprimary
       GROUP BY n.nspname, t.relname, i.relname, ix.indisunique
       ORDER BY n.nspname, t.relname, i.relname`
    );

    for (const row of indexRows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const table = tableMap.get(key);
      if (table) {
        const indexNode: IndexNode = {
          name: row.index_name,
          isUnique: row.is_unique,
          columns: row.columns,
        };
        table.indexes.push(indexNode);
      }
    }

    return schemaOrder.map((schemaName) => {
      const tableNames = schemaMap.get(schemaName) ?? [];
      const tables = tableNames
        .map((tn) => tableMap.get(`${schemaName}.${tn}`))
        .filter((t): t is TableNode => t != null);
      return { name: schemaName, tables };
    });
  } finally {
    await client.end();
  }
}

export async function runQuery(
  conn: SavedConnection,
  sql: string,
  limit: number,
): Promise<QueryResult> {
  const client = await connect(conn);
  try {
    const started = performance.now();
    const fetchLimit = limit + 1;
    const trimmed = sql.trim().replace(/;+$/, '');
    const limitedSql = `SELECT * FROM (${trimmed}) AS _rdb2_sub LIMIT ${fetchLimit}`;

    let result: pg.QueryResult;
    try {
      result = await client.query(limitedSql);
    } catch {
      // If wrapped query fails (DDL/DML), try original SQL directly
      result = await client.query(sql);
    }

    const elapsed = Math.round(performance.now() - started);
    const columns = result.fields?.map((f) => f.name) ?? [];
    const allRows: string[][] = (result.rows ?? []).map((row: Record<string, unknown>) =>
      columns.map((col) => {
        const val = row[col];
        return val == null ? 'NULL' : String(val);
      }),
    );

    const truncated = allRows.length > limit;
    const rows = truncated ? allRows.slice(0, limit) : allRows;
    let notice: string | null = null;

    if (truncated) {
      notice = `Showing the first ${limit} rows.`;
    } else if (rows.length === 0 && result.command) {
      notice = `${result.command} ${result.rowCount ?? 0}`;
    }

    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      executionTimeMs: elapsed,
      notice,
    };
  } finally {
    await client.end();
  }
}

export async function dropTable(
  conn: SavedConnection,
  schema: string,
  table: string,
  cascade: boolean,
): Promise<void> {
  const client = await connect(conn);
  try {
    const sql = `DROP TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)}${cascade ? ' CASCADE' : ''}`;
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function truncateTable(
  conn: SavedConnection,
  schema: string,
  table: string,
  cascade: boolean,
): Promise<void> {
  const client = await connect(conn);
  try {
    const sql = `TRUNCATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)}${cascade ? ' CASCADE' : ''}`;
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function getPrimaryKeyColumns(
  conn: SavedConnection,
  schema: string,
  table: string,
): Promise<string[]> {
  const client = await connect(conn);
  try {
    const result = await client.query(
      `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid
       JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum, n)
         ON a.attnum = x.attnum
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = $1 AND c.relname = $2 AND i.indisprimary
       ORDER BY x.n`,
      [schema, table],
    );
    return result.rows.map((r: Record<string, unknown>) => r.attname as string);
  } finally {
    await client.end();
  }
}

export async function getEditableTableData(
  conn: SavedConnection,
  schema: string,
  table: string,
  limit: number,
  offset: number,
): Promise<{ columns: string[]; columnTypes: string[]; rows: (string | null)[][]; primaryKeyColumns: string[]; totalCount: number }> {
  const client = await connect(conn);
  try {
    const pkCols = await getPrimaryKeyColumns(conn, schema, table);
    const qt = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

    const countRes = await client.query(`SELECT count(*)::int AS cnt FROM ${qt}`);
    const totalCount: number = countRes.rows[0].cnt;

    const dataRes = await client.query(`SELECT * FROM ${qt} LIMIT ${limit} OFFSET ${offset}`);
    const columns = dataRes.fields?.map((f) => f.name) ?? [];
    const columnTypes: string[] = [];

    // Fetch column types
    const typeRes = await client.query(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS data_type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schema, table],
    );
    const typeMap = new Map<string, string>();
    for (const r of typeRes.rows) {
      typeMap.set(r.attname as string, r.data_type as string);
    }
    for (const col of columns) {
      columnTypes.push(typeMap.get(col) ?? 'text');
    }

    const rows: (string | null)[][] = (dataRes.rows ?? []).map((row: Record<string, unknown>) =>
      columns.map((col) => {
        const val = row[col];
        return val == null ? null : serializeValue(val);
      }),
    );

    return { columns, columnTypes, rows, primaryKeyColumns: pkCols, totalCount };
  } finally {
    await client.end();
  }
}

export interface DmlOperation {
  type: 'update' | 'insert' | 'delete';
  // For update/delete: original row values keyed by PK column names
  pkValues?: Record<string, string | null>;
  // For update: changed column values
  changes?: Record<string, string | null>;
  // For insert: all column values
  values?: Record<string, string | null>;
  // Column type map for proper casting (col -> pg type)
  columnTypes?: Record<string, string>;
}

const JSON_TYPES = new Set(['json', 'jsonb']);
const ARRAY_TYPE_RE = /\[\]$|^ARRAY/i;

function isArrayType(pgType: string): boolean {
  return ARRAY_TYPE_RE.test(pgType);
}

function needsCast(pgType: string): string | null {
  if (JSON_TYPES.has(pgType.toLowerCase())) return pgType;
  if (isArrayType(pgType)) return pgType;
  return null;
}

/**
 * Normalize an array value string for PostgreSQL.
 * If user entered JSON array syntax like ["a","b"], convert to PG literal {a,b}.
 * If already in PG literal format {a,b}, pass through.
 */
function normalizeArrayParam(val: string): string {
  const trimmed = val.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return toPgArrayLiteral(parsed);
      }
    } catch {
      // Not valid JSON, pass through
    }
  }
  return val;
}

/** Prepare a DML parameter value, converting array syntax if needed. */
function prepareDmlParam(val: string | null, pgType: string | undefined): string | null {
  if (val === null || !pgType) return val;
  if (isArrayType(pgType)) return normalizeArrayParam(val);
  return val;
}

export async function executeDml(
  conn: SavedConnection,
  schema: string,
  table: string,
  operations: DmlOperation[],
): Promise<void> {
  const client = await connect(conn);
  try {
    const qt = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

    await client.query('BEGIN');
    try {
      for (const op of operations) {
        switch (op.type) {
          case 'update': {
            const sets: string[] = [];
            const params: (string | null)[] = [];
            let paramIdx = 1;

            for (const [col, val] of Object.entries(op.changes!)) {
              const colType = op.columnTypes?.[col] ?? '';
              const cast = needsCast(colType);
              sets.push(`${quoteIdentifier(col)} = $${paramIdx}${cast ? `::${cast}` : ''}`);
              params.push(prepareDmlParam(val, colType));
              paramIdx++;
            }

            const wheres: string[] = [];
            for (const [col, val] of Object.entries(op.pkValues!)) {
              if (val === null) {
                wheres.push(`${quoteIdentifier(col)} IS NULL`);
              } else {
                wheres.push(`${quoteIdentifier(col)} = $${paramIdx}`);
                params.push(val);
                paramIdx++;
              }
            }

            const sql = `UPDATE ${qt} SET ${sets.join(', ')} WHERE ${wheres.join(' AND ')}`;
            await client.query(sql, params);
            break;
          }
          case 'insert': {
            const cols: string[] = [];
            const placeholders: string[] = [];
            const params: (string | null)[] = [];
            let paramIdx = 1;

            for (const [col, val] of Object.entries(op.values!)) {
              const colType = op.columnTypes?.[col] ?? '';
              const cast = needsCast(colType);
              cols.push(quoteIdentifier(col));
              placeholders.push(`$${paramIdx}${cast ? `::${cast}` : ''}`);
              params.push(prepareDmlParam(val, colType));
              paramIdx++;
            }

            const sql = `INSERT INTO ${qt} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
            await client.query(sql, params);
            break;
          }
          case 'delete': {
            const wheres: string[] = [];
            const params: (string | null)[] = [];
            let paramIdx = 1;

            for (const [col, val] of Object.entries(op.pkValues!)) {
              if (val === null) {
                wheres.push(`${quoteIdentifier(col)} IS NULL`);
              } else {
                wheres.push(`${quoteIdentifier(col)} = $${paramIdx}`);
                params.push(val);
                paramIdx++;
              }
            }

            const sql = `DELETE FROM ${qt} WHERE ${wheres.join(' AND ')}`;
            await client.query(sql, params);
            break;
          }
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    await client.end();
  }
}

export async function previewTable(
  conn: SavedConnection,
  schema: string,
  table: string,
  limit: number,
  offset: number,
): Promise<QueryResult> {
  const sql = `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} LIMIT ${limit} OFFSET ${offset}`;
  return runQuery(conn, sql, limit);
}

export async function getTableDdl(
  conn: SavedConnection,
  schema: string,
  table: string,
): Promise<string> {
  const client = await connect(conn);
  try {
    // Get table OID
    const oidResult = await client.query(
      `SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, table],
    );
    if (oidResult.rows.length === 0) throw new Error('Table not found');
    const tableOid = oidResult.rows[0].oid;

    // Columns with types, defaults, not-null
    const colResult = await client.query(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS data_type,
              a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [tableOid],
    );

    const colData = colResult.rows.map((r) => ({
      name: r.attname as string,
      dtype: r.data_type as string,
      notnull: r.attnotnull as boolean,
      defaultExpr: r.default_expr as string | null,
    }));

    const maxNameLen = Math.max(...colData.map((c) => c.name.length), 0);
    const colDefs: string[] = [];

    for (const col of colData) {
      const isSerial = col.defaultExpr?.startsWith('nextval(') ?? false;
      let displayType: string;
      if (isSerial) {
        displayType =
          col.dtype === 'bigint' ? 'bigserial' : col.dtype === 'smallint' ? 'smallserial' : 'serial';
      } else {
        displayType = col.dtype;
      }

      let def = `    ${col.name.padEnd(maxNameLen)} ${displayType}`;
      if (!isSerial && col.defaultExpr) {
        def += ` default ${col.defaultExpr}`;
      }
      if (col.notnull && !isSerial) {
        def += ' not null';
      }
      colDefs.push(def);
    }

    // Primary key
    const pkResult = await client.query(
      `SELECT array_agg(a.attname ORDER BY x.n)
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid
       JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum, n)
         ON a.attnum = x.attnum
       WHERE i.indrelid = $1 AND i.indisprimary
       GROUP BY i.indexrelid`,
      [tableOid],
    );

    if (pkResult.rows.length > 0) {
      const raw = pkResult.rows[0].array_agg;
      const pkCols: string[] = Array.isArray(raw) ? raw : String(raw).replace(/^\{|\}$/g, '').split(',');
      colDefs.push(`    constraint ${table}_pkey primary key (${pkCols.join(', ')})`);
    }

    let ddl = `create table ${quoteIdentifier(schema)}.${quoteIdentifier(table)}\n(\n${colDefs.join(',\n')}\n);`;

    // Owner
    const ownerResult = await client.query(
      `SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = $1`,
      [tableOid],
    );

    if (ownerResult.rows.length > 0) {
      const owner: string = ownerResult.rows[0].pg_get_userbyid;
      ddl += `\n\nalter table ${quoteIdentifier(schema)}.${quoteIdentifier(table)}\n    owner to ${quoteIdentifier(owner)};`;
    }

    return ddl;
  } finally {
    await client.end();
  }
}

export interface ModifyTableColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
}

export interface ModifyTableInfo {
  schema: string;
  table: string;
  columns: ModifyTableColumn[];
}

export async function getModifyTableInfo(
  conn: SavedConnection,
  schema: string,
  table: string,
): Promise<ModifyTableInfo> {
  const client = await connect(conn);
  try {
    const result = await client.query(
      `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS data_type,
              NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS default_value
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = $1 AND c.relname = $2
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schema, table],
    );
    return {
      schema,
      table,
      columns: result.rows.map((r: Record<string, unknown>) => ({
        name: r.name as string,
        dataType: r.data_type as string,
        nullable: r.nullable as boolean,
        defaultValue: r.default_value as string | null,
      })),
    };
  } finally {
    await client.end();
  }
}

export interface AlterTableAction {
  type: 'add_column' | 'drop_column' | 'rename_column' | 'alter_type' | 'set_not_null' | 'drop_not_null' | 'set_default' | 'drop_default' | 'rename_table';
  columnName?: string;
  newColumnName?: string;
  dataType?: string;
  nullable?: boolean;
  defaultValue?: string | null;
  newTableName?: string;
}

export async function alterTable(
  conn: SavedConnection,
  schema: string,
  table: string,
  actions: AlterTableAction[],
): Promise<void> {
  const client = await connect(conn);
  try {
    // Partition: schema changes first (against original name), rename last
    const schemaActions = actions.filter((a) => a.type !== 'rename_table');
    const renameAction = actions.find((a) => a.type === 'rename_table');

    const sqls: string[] = [];
    const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

    for (const action of schemaActions) {
      switch (action.type) {
        case 'add_column': {
          let sql = `ALTER TABLE ${qualifiedTable} ADD COLUMN ${quoteIdentifier(action.columnName!)} ${action.dataType!}`;
          if (!action.nullable) sql += ' NOT NULL';
          if (action.defaultValue) sql += ` DEFAULT ${action.defaultValue}`;
          sqls.push(sql);
          break;
        }
        case 'drop_column':
          sqls.push(`ALTER TABLE ${qualifiedTable} DROP COLUMN ${quoteIdentifier(action.columnName!)}`);
          break;
        case 'rename_column':
          sqls.push(`ALTER TABLE ${qualifiedTable} RENAME COLUMN ${quoteIdentifier(action.columnName!)} TO ${quoteIdentifier(action.newColumnName!)}`);
          break;
        case 'alter_type':
          sqls.push(`ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(action.columnName!)} TYPE ${action.dataType!}`);
          break;
        case 'set_not_null':
          sqls.push(`ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(action.columnName!)} SET NOT NULL`);
          break;
        case 'drop_not_null':
          sqls.push(`ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(action.columnName!)} DROP NOT NULL`);
          break;
        case 'set_default':
          sqls.push(`ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(action.columnName!)} SET DEFAULT ${action.defaultValue!}`);
          break;
        case 'drop_default':
          sqls.push(`ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(action.columnName!)} DROP DEFAULT`);
          break;
      }
    }

    // Rename must be last so all prior ALTER statements reference the original name
    if (renameAction) {
      sqls.push(`ALTER TABLE ${qualifiedTable} RENAME TO ${quoteIdentifier(renameAction.newTableName!)}`);
    }

    await client.query('BEGIN');
    try {
      for (const sql of sqls) {
        await client.query(sql);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    await client.end();
  }
}

export async function exportTableCsv(
  conn: SavedConnection,
  schema: string,
  table: string,
  filePath: string,
): Promise<number> {
  const client = await connect(conn);
  try {
    const sqlText = `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const result = await client.query(sqlText);
    const columns = result.fields?.map((f) => f.name) ?? [];
    const rows: string[][] = (result.rows ?? []).map((row: Record<string, unknown>) =>
      columns.map((col) => {
        const val = row[col];
        return val == null ? '' : serializeValue(val);
      }),
    );

    const fs = await import('node:fs');
    const header = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(',');
    const csvRows = rows.map((r) =>
      r.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','),
    );
    fs.writeFileSync(filePath, [header, ...csvRows].join('\n'), 'utf-8');
    return rows.length;
  } finally {
    await client.end();
  }
}
