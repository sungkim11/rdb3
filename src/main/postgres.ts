import pg from 'pg';
import type { SavedConnection, QueryResult, SchemaNode, ColumnNode, TableNode, KeyNode, IndexNode } from './types';
import { buildConnectionString } from './types';
import { openTunnel, openEphemeralTunnel } from './ssh-tunnel';
import { lookupPgpass } from './pgpass';

// Per-connection monitoring snapshots to avoid cross-connection pollution (Finding #5)
interface MonitoringSnapshot {
  prevTxnCount: number | null;
  prevTxnTime: number | null;
  prevCpuSnapshot: { idle: number; total: number } | null;
}
const monitoringState = new Map<string, MonitoringSnapshot>();

function getMonitoringState(connId: string): MonitoringSnapshot {
  let state = monitoringState.get(connId);
  if (!state) {
    state = { prevTxnCount: null, prevTxnTime: null, prevCpuSnapshot: null };
    monitoringState.set(connId, state);
  }
  return state;
}

// Connection pool cache keyed by connection id
const pools = new Map<string, pg.Pool>();

function getPool(conn: SavedConnection, host: string, port: number, password: string): pg.Pool {
  const key = `${conn.id}:${host}:${port}`;
  let pool = pools.get(key);
  if (pool) return pool;

  const config: pg.PoolConfig = {
    host,
    port,
    user: conn.user,
    database: conn.database,
    connectionTimeoutMillis: 10000,
    min: 1,
    max: 4,
    idleTimeoutMillis: 30000,
  };
  if (password) config.password = password;

  pool = new pg.Pool(config);
  pools.set(key, pool);
  return pool;
}

/** Close pools belonging to a specific connection (used on connection switch). */
export function closePoolsForConnection(connId: string): void {
  for (const [key, pool] of pools.entries()) {
    if (key.startsWith(connId + ':')) {
      pool.end().catch(() => {});
      pools.delete(key);
    }
  }
  monitoringState.delete(connId);
}

export function closeAllPools(): void {
  for (const pool of pools.values()) {
    pool.end().catch(() => {});
  }
  pools.clear();
  monitoringState.clear();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Split a comma-separated column list and quote each identifier */
export function quoteColumnList(columns: string): string {
  return columns.split(',').map((c) => quoteIdentifier(c.trim())).filter(Boolean).join(', ');
}

/** Quote a possibly schema-qualified table name (e.g. "public.users") */
export function quoteTableRef(ref: string): string {
  const parts = ref.includes('.') ? ref.split('.', 2) : [ref];
  return parts.map((p) => quoteIdentifier(p.trim())).join('.');
}

const SAFE_DEFAULT_RE = /^(?:'(?:[^']*(?:'')*)*'|NULL|TRUE|FALSE|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NOW\(\)|(?:\d+\.?\d*(?:e[+-]?\d+)?)|nextval\([^)]+\)|gen_random_uuid\(\))$/i;

export function validateDefault(val: string): string {
  if (!SAFE_DEFAULT_RE.test(val.trim())) {
    throw new Error(`Unsafe DEFAULT expression: ${val}`);
  }
  return val.trim();
}

const VALID_TYPE_RE = /^[a-z][a-z0-9_ ]*(?:\(\d+(?:,\s*\d+)?\))?(?:\[\])?$/i;

export function validateDataType(val: string): string {
  if (!VALID_TYPE_RE.test(val.trim())) {
    throw new Error(`Invalid data type: ${val}`);
  }
  return val.trim();
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

export function resolveConnParams(conn: SavedConnection): { host: string; port: number; password: string } & Promise<{ host: string; port: number; password: string }> {
  // Synchronous defaults
  let host = conn.host;
  let port = conn.port;
  let password = conn.password;
  if (conn.authMethod === 'pgpass' || !password) {
    password = lookupPgpass(conn.host, conn.port, conn.database, conn.user) ?? '';
  }

  const result = (async () => {
    if (conn.ssh?.enabled) {
      port = await openTunnel(conn.ssh, conn.host, conn.port);
      host = '127.0.0.1';
    }
    return { host, port, password };
  })();

  return Object.assign(result, { host, port, password });
}

async function connect(conn: SavedConnection): Promise<pg.PoolClient> {
  const { host, port, password } = await resolveConnParams(conn);
  const pool = getPool(conn, host, port, password);
  return pool.connect();
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

    // Combined query for core stats — single round trip instead of 5
    try {
      const r = await client.query(`
        SELECT
          pg_database_size(current_database()) AS db_size,
          (SELECT count(*)::int FROM pg_stat_activity) AS active,
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn,
          (SELECT xact_commit + xact_rollback FROM pg_stat_database WHERE datname = current_database()) AS txn,
          (now() - pg_postmaster_start_time())::text AS uptime,
          (SELECT CASE WHEN blks_hit + blks_read = 0 THEN 0
                  ELSE round(100.0 * blks_hit / (blks_hit + blks_read), 1) END
           FROM pg_stat_database WHERE datname = current_database()) AS cache_ratio
      `);
      const row = r.rows[0];

      stats.dbSizeMb = Math.round(Number(row.db_size) / 1024 / 1024);
      stats.activeConnections = row.active;
      stats.maxConnections = row.max_conn;
      if (stats.maxConnections && stats.maxConnections > 0) {
        stats.connectionSaturationPercent = Math.round((stats.activeConnections! / stats.maxConnections) * 100);
      }
      stats.cacheHitRatio = Number(row.cache_ratio);

      // TPS: delta from previous poll — no pg_sleep needed
      const monState = getMonitoringState(conn.id);
      const now = Date.now();
      const txnCount = Number(row.txn);
      if (monState.prevTxnCount !== null && monState.prevTxnTime !== null) {
        const elapsed = (now - monState.prevTxnTime) / 1000;
        if (elapsed > 0) {
          stats.tps = Math.round(Math.max(0, txnCount - monState.prevTxnCount) / elapsed);
        }
      }
      monState.prevTxnCount = txnCount;
      monState.prevTxnTime = now;

      const raw = String(row.uptime);
      const match = raw.match(/^(?:(\d+)\s+days?\s+)?(\d+):(\d+):/);
      if (match) {
        const days = match[1] ? `${match[1]}d ` : '';
        stats.uptime = `${days}${match[2]}h ${match[3]}m`;
      } else {
        stats.uptime = raw.split('.')[0];
      }
    } catch {}

    // Host memory (Linux only, requires superuser)
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

    // Host CPU: delta from previous poll — no pg_sleep needed
    try {
      const r = await client.query("SELECT pg_read_file('/proc/stat') AS info");
      const line = String(r.rows[0].info).split('\n')[0];
      const parts = line.trim().split(/\s+/).slice(1).map(Number);
      const idle = parts[3] + (parts[4] || 0);
      const total = parts.reduce((a, b) => a + b, 0);

      const monState = getMonitoringState(conn.id);
      if (monState.prevCpuSnapshot) {
        const idleDelta = idle - monState.prevCpuSnapshot.idle;
        const totalDelta = total - monState.prevCpuSnapshot.total;
        if (totalDelta > 0) {
          stats.cpuUsagePercent = Math.round(((totalDelta - idleDelta) / totalDelta) * 100);
        }
      }
      monState.prevCpuSnapshot = { idle, total };
    } catch {}

    return stats;
  } finally {
    client.release();
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
    client.release();
  }
}

export interface MonitoringData {
  // Connections breakdown
  connectionsByState: Array<{ state: string; count: number }>;
  connectionsByUser: Array<{ user: string; count: number }>;
  // Table stats
  tableStats: Array<{ schema: string; table: string; seqScan: number; idxScan: number; rowsInserted: number; rowsUpdated: number; rowsDeleted: number; deadTuples: number; lastVacuum: string | null; lastAnalyze: string | null; tableSize: string }>;
  // Index stats
  unusedIndexes: Array<{ schema: string; table: string; index: string; size: string }>;
  // Locks
  locksByType: Array<{ locktype: string; mode: string; count: number }>;
  blockedQueries: Array<{ pid: number; query: string; waitingFor: number; durationMs: number }>;
  // Database stats
  deadlocks: number;
  tempFiles: number;
  tempBytes: number;
  conflictsCount: number;
  // Checkpoint/bgwriter
  checkpointsTimed: number;
  checkpointsReq: number;
  buffersCheckpoint: number;
  buffersBgwriter: number;
  buffersBackend: number;
  // Replication
  replicationLag: Array<{ clientAddr: string; state: string; sentLag: string; writeLag: string; flushLag: string; replayLag: string }>;
  // Long running
  longRunningTxns: Array<{ pid: number; user: string; duration: string; state: string; query: string }>;
}

export async function getMonitoringData(conn: SavedConnection): Promise<MonitoringData> {
  const client = await connect(conn);
  try {
    const data: MonitoringData = {
      connectionsByState: [], connectionsByUser: [],
      tableStats: [], unusedIndexes: [],
      locksByType: [], blockedQueries: [],
      deadlocks: 0, tempFiles: 0, tempBytes: 0, conflictsCount: 0,
      checkpointsTimed: 0, checkpointsReq: 0, buffersCheckpoint: 0, buffersBgwriter: 0, buffersBackend: 0,
      replicationLag: [], longRunningTxns: [],
    };

    // Connections by state
    try {
      const r = await client.query(`SELECT COALESCE(state, 'unknown') AS state, count(*)::int AS count FROM pg_stat_activity GROUP BY state ORDER BY count DESC`);
      data.connectionsByState = r.rows.map((row: Record<string, unknown>) => ({ state: row.state as string, count: row.count as number }));
    } catch {}

    // Connections by user
    try {
      const r = await client.query(`SELECT usename AS user, count(*)::int AS count FROM pg_stat_activity WHERE usename IS NOT NULL GROUP BY usename ORDER BY count DESC`);
      data.connectionsByUser = r.rows.map((row: Record<string, unknown>) => ({ user: row.user as string, count: row.count as number }));
    } catch {}

    // Table stats (top 50 by total activity)
    try {
      const r = await client.query(`
        SELECT schemaname AS schema, relname AS table,
          seq_scan::int, idx_scan::int,
          n_tup_ins::int AS rows_inserted, n_tup_upd::int AS rows_updated, n_tup_del::int AS rows_deleted,
          n_dead_tup::int AS dead_tuples,
          last_vacuum::text, last_analyze::text,
          pg_size_pretty(pg_total_relation_size(schemaname || '.' || relname)) AS table_size
        FROM pg_stat_user_tables
        ORDER BY (seq_scan + idx_scan + n_tup_ins + n_tup_upd + n_tup_del) DESC
        LIMIT 50
      `);
      data.tableStats = r.rows.map((row: Record<string, unknown>) => ({
        schema: row.schema as string, table: row.table as string,
        seqScan: row.seq_scan as number, idxScan: row.idx_scan as number,
        rowsInserted: row.rows_inserted as number, rowsUpdated: row.rows_updated as number, rowsDeleted: row.rows_deleted as number,
        deadTuples: row.dead_tuples as number,
        lastVacuum: row.last_vacuum as string | null, lastAnalyze: row.last_analyze as string | null,
        tableSize: row.table_size as string,
      }));
    } catch {}

    // Unused indexes
    try {
      const r = await client.query(`
        SELECT schemaname AS schema, relname AS table, indexrelname AS index,
          pg_size_pretty(pg_relation_size(indexrelid)) AS size
        FROM pg_stat_user_indexes
        WHERE idx_scan = 0 AND schemaname NOT IN ('pg_catalog','information_schema')
        ORDER BY pg_relation_size(indexrelid) DESC
        LIMIT 20
      `);
      data.unusedIndexes = r.rows.map((row: Record<string, unknown>) => ({
        schema: row.schema as string, table: row.table as string,
        index: row.index as string, size: row.size as string,
      }));
    } catch {}

    // Locks by type
    try {
      const r = await client.query(`SELECT locktype, mode, count(*)::int AS count FROM pg_locks GROUP BY locktype, mode ORDER BY count DESC LIMIT 20`);
      data.locksByType = r.rows.map((row: Record<string, unknown>) => ({ locktype: row.locktype as string, mode: row.mode as string, count: row.count as number }));
    } catch {}

    // Blocked queries
    try {
      const r = await client.query(`
        SELECT blocked.pid, blocked.query, blocking.pid AS waiting_for,
          EXTRACT(EPOCH FROM (now() - blocked.query_start))::float * 1000 AS duration_ms
        FROM pg_locks bl JOIN pg_stat_activity blocked ON bl.pid = blocked.pid
        JOIN pg_locks kl ON bl.locktype = kl.locktype AND bl.database IS NOT DISTINCT FROM kl.database
          AND bl.relation IS NOT DISTINCT FROM kl.relation AND bl.page IS NOT DISTINCT FROM kl.page
          AND bl.tuple IS NOT DISTINCT FROM kl.tuple AND bl.virtualxid IS NOT DISTINCT FROM kl.virtualxid
          AND bl.transactionid IS NOT DISTINCT FROM kl.transactionid AND bl.classid IS NOT DISTINCT FROM kl.classid
          AND bl.objid IS NOT DISTINCT FROM kl.objid AND bl.objsubid IS NOT DISTINCT FROM kl.objsubid AND bl.pid != kl.pid
        JOIN pg_stat_activity blocking ON kl.pid = blocking.pid
        WHERE NOT bl.granted LIMIT 10
      `);
      data.blockedQueries = r.rows.map((row: Record<string, unknown>) => ({
        pid: row.pid as number, query: row.query as string,
        waitingFor: row.waiting_for as number, durationMs: Math.round(row.duration_ms as number),
      }));
    } catch {}

    // Database stats
    try {
      const r = await client.query(`SELECT deadlocks::int, temp_files::int, temp_bytes::bigint, conflicts::int FROM pg_stat_database WHERE datname = current_database()`);
      if (r.rows.length) {
        data.deadlocks = r.rows[0].deadlocks as number;
        data.tempFiles = r.rows[0].temp_files as number;
        data.tempBytes = Number(r.rows[0].temp_bytes);
        data.conflictsCount = r.rows[0].conflicts as number;
      }
    } catch {}

    // Checkpoint/bgwriter
    try {
      const r = await client.query(`SELECT checkpoints_timed::int, checkpoints_req::int, buffers_checkpoint::int, buffers_clean::int, buffers_backend::int FROM pg_stat_bgwriter`);
      if (r.rows.length) {
        data.checkpointsTimed = r.rows[0].checkpoints_timed as number;
        data.checkpointsReq = r.rows[0].checkpoints_req as number;
        data.buffersCheckpoint = r.rows[0].buffers_checkpoint as number;
        data.buffersBgwriter = r.rows[0].buffers_clean as number;
        data.buffersBackend = r.rows[0].buffers_backend as number;
      }
    } catch {}

    // Replication lag
    try {
      const r = await client.query(`
        SELECT client_addr::text, state,
          COALESCE(sent_lsn - write_lsn, '0/0')::text AS sent_lag,
          COALESCE(write_lag::text, '--') AS write_lag,
          COALESCE(flush_lag::text, '--') AS flush_lag,
          COALESCE(replay_lag::text, '--') AS replay_lag
        FROM pg_stat_replication
      `);
      data.replicationLag = r.rows.map((row: Record<string, unknown>) => ({
        clientAddr: row.client_addr as string, state: row.state as string,
        sentLag: row.sent_lag as string, writeLag: row.write_lag as string,
        flushLag: row.flush_lag as string, replayLag: row.replay_lag as string,
      }));
    } catch {}

    // Long running transactions (>1 min)
    try {
      const r = await client.query(`
        SELECT pid, usename AS user, (now() - xact_start)::text AS duration, state, query
        FROM pg_stat_activity
        WHERE xact_start IS NOT NULL AND state != 'idle' AND (now() - xact_start) > interval '1 minute'
        ORDER BY xact_start ASC LIMIT 20
      `);
      data.longRunningTxns = r.rows.map((row: Record<string, unknown>) => ({
        pid: row.pid as number, user: row.user as string,
        duration: row.duration as string, state: row.state as string, query: row.query as string,
      }));
    } catch {}

    return data;
  } finally {
    client.release();
  }
}

export async function createSchema(conn: SavedConnection, schemaName: string): Promise<void> {
  const client = await connect(conn);
  try {
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  } finally {
    client.release();
  }
}

export async function createTable(conn: SavedConnection, schema: string, tableName: string, columns: Array<{ name: string; type: string; nullable: boolean; defaultValue?: string; pk?: boolean }>, foreignKeys?: Array<{ column: string; refTable: string; refColumn: string }>, indexes?: Array<{ name?: string; columns: string; unique?: boolean }>): Promise<void> {
  const client = await connect(conn);
  try {
    const qt = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
    const lines: string[] = [];
    for (const c of columns) {
      let def = `${quoteIdentifier(c.name)} ${validateDataType(c.type)}`;
      if (!c.nullable) def += ' NOT NULL';
      if (c.defaultValue) def += ` DEFAULT ${validateDefault(c.defaultValue)}`;
      lines.push(def);
    }
    const pkCols = columns.filter((c) => c.pk);
    if (pkCols.length > 0) {
      lines.push(`PRIMARY KEY (${pkCols.map((c) => quoteIdentifier(c.name)).join(', ')})`);
    }
    if (foreignKeys) {
      for (const fk of foreignKeys) {
        if (fk.column && fk.refTable && fk.refColumn) {
          lines.push(`FOREIGN KEY (${quoteIdentifier(fk.column)}) REFERENCES ${quoteTableRef(fk.refTable)} (${quoteIdentifier(fk.refColumn)})`);
        }
      }
    }
    await client.query(`CREATE TABLE ${qt} (\n  ${lines.join(',\n  ')}\n)`);
    if (indexes) {
      for (const idx of indexes) {
        if (idx.columns) {
          const idxName = idx.name || `idx_${tableName}_${idx.columns.replace(/,\s*/g, '_')}`;
          const unique = idx.unique ? 'UNIQUE ' : '';
          await client.query(`CREATE ${unique}INDEX ${quoteIdentifier(idxName)} ON ${qt} (${quoteColumnList(idx.columns)})`);
        }
      }
    }
  } finally {
    client.release();
  }
}

export async function executeSql(conn: SavedConnection, sql: string): Promise<void> {
  const client = await connect(conn);
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}

/**
 * Test a connection using a standalone client and ephemeral SSH tunnel.
 * - Uses pg.Client (not the pool) to avoid orphaned pools on id dedup.
 * - Uses openEphemeralTunnel (not the cached openTunnel) so the probe
 *   never reuses or tears down a tunnel belonging to a live session.
 */
export async function testConnection(conn: SavedConnection): Promise<void> {
  let host = conn.host;
  let port = conn.port;
  let password = conn.password;
  if (conn.authMethod === 'pgpass' || !password) {
    password = lookupPgpass(conn.host, conn.port, conn.database, conn.user) ?? '';
  }

  let closeTunnel: (() => void) | undefined;
  if (conn.ssh?.enabled) {
    const tunnel = await openEphemeralTunnel(conn.ssh, conn.host, conn.port);
    host = '127.0.0.1';
    port = tunnel.localPort;
    closeTunnel = tunnel.close;
  }

  const config: pg.PoolConfig = {
    host,
    port,
    user: conn.user,
    database: conn.database,
    connectionTimeoutMillis: 10000,
  };
  if (password) config.password = password;
  const client = new pg.Client(config);
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end();
    closeTunnel?.();
  }
}

export async function fetchTree(conn: SavedConnection): Promise<SchemaNode[]> {
  const client = await connect(conn);
  try {
    const { rows } = await client.query(
      `SELECT t.table_schema, t.table_name, t.table_type, c.column_name, c.data_type, c.is_nullable, c.column_default
       FROM information_schema.tables t
       LEFT JOIN information_schema.columns c
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
      const columnName: string | null = row.column_name;
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

      // Skip if no columns (LEFT JOIN produced null)
      if (!columnName) continue;

      const col: ColumnNode = {
        name: columnName,
        dataType,
        nullable: isNullable === 'YES',
        defaultValue,
      };
      tableMap.get(key)!.columns.push(col);
    }

    // Fetch keys, indexes, and empty schemas in parallel (all independent)
    const [{ rows: keyRows }, { rows: indexRows }, { rows: allSchemas }] = await Promise.all([
      client.query(
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
      ),
      client.query(
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
      ),
      client.query(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         ORDER BY schema_name`
      ),
    ]);

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

    for (const row of allSchemas) {
      const name: string = row.schema_name;
      if (!schemaMap.has(name)) {
        schemaOrder.push(name);
        schemaMap.set(name, []);
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
    client.release();
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
    const limitedSql = `SELECT * FROM (${trimmed}) AS _rdb2_sub LIMIT $1`;

    let result: pg.QueryResult;
    try {
      result = await client.query(limitedSql, [fetchLimit]);
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
    client.release();
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
    client.release();
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
    client.release();
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
    client.release();
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
    const qt = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

    // Run all 4 queries in parallel — they are independent
    const [countRes, dataRes, typeRes, pkRes] = await Promise.all([
      client.query(`SELECT count(*)::int AS cnt FROM ${qt}`),
      client.query(`SELECT * FROM ${qt} LIMIT $1 OFFSET $2`, [limit, offset]),
      client.query(
        `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS data_type
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [schema, table],
      ),
      client.query(
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
      ),
    ]);

    const totalCount: number = countRes.rows[0].cnt;
    const pkCols = pkRes.rows.map((r: Record<string, unknown>) => r.attname as string);
    const columns = dataRes.fields?.map((f) => f.name) ?? [];

    const typeMap = new Map<string, string>();
    for (const r of typeRes.rows) {
      typeMap.set(r.attname as string, r.data_type as string);
    }
    const columnTypes: string[] = [];
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
    client.release();
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
    client.release();
  }
}

export async function previewTable(
  conn: SavedConnection,
  schema: string,
  table: string,
  limit: number,
  offset: number,
): Promise<QueryResult> {
  const sql = `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
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
    client.release();
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
    client.release();
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
          let sql = `ALTER TABLE ${qualifiedTable} ADD COLUMN ${quoteIdentifier(action.columnName!)} ${validateDataType(action.dataType!)}`;
          if (!action.nullable) sql += ' NOT NULL';
          if (action.defaultValue) sql += ` DEFAULT ${validateDefault(action.defaultValue)}`;
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
          sqls.push(`ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(action.columnName!)} TYPE ${validateDataType(action.dataType!)}`);
          break;
        case 'set_not_null':
          sqls.push(`ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(action.columnName!)} SET NOT NULL`);
          break;
        case 'drop_not_null':
          sqls.push(`ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(action.columnName!)} DROP NOT NULL`);
          break;
        case 'set_default':
          sqls.push(`ALTER TABLE ${qualifiedTable} ALTER COLUMN ${quoteIdentifier(action.columnName!)} SET DEFAULT ${validateDefault(action.defaultValue!)}`);
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
    client.release();
  }
}

export async function exportTableParquet(
  conn: SavedConnection,
  schema: string,
  table: string,
  filePath: string,
): Promise<number> {
  const client = await connect(conn);
  try {
    const cursorName = 'export_parquet_cursor';
    const batchSize = 5000;
    const sqlText = `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

    await client.query('BEGIN');
    await client.query(`DECLARE ${cursorName} CURSOR FOR ${sqlText}`);

    // Fetch the first batch to get column metadata
    const firstBatch = await client.query(`FETCH ${batchSize} FROM ${cursorName}`);
    const columns = firstBatch.fields ?? [];

    // Map PG OIDs to Parquet types
    const pgToParquet: Record<number, string> = {
      16: 'BOOLEAN',    // bool
      20: 'INT64',      // int8
      21: 'INT32',      // int2
      23: 'INT32',      // int4
      700: 'FLOAT',     // float4
      701: 'DOUBLE',    // float8
      1700: 'DOUBLE',   // numeric
    };

    const { ParquetSchema, ParquetWriter } = await import('parquetjs-lite');
    const schemaDef: Record<string, { type: string; optional: boolean }> = {};
    for (const col of columns) {
      const pType = pgToParquet[col.dataTypeID] ?? 'UTF8';
      schemaDef[col.name] = { type: pType, optional: true };
    }
    const parquetSchema = new ParquetSchema(schemaDef);
    const writer = await ParquetWriter.openFile(parquetSchema, filePath);

    let totalRows = 0;

    async function writeRows(rows: Record<string, unknown>[]) {
      for (const row of rows) {
        const record: Record<string, unknown> = {};
        for (const col of columns) {
          const val = row[col.name];
          if (val == null) continue;
          const pType = pgToParquet[col.dataTypeID];
          if (pType === 'BOOLEAN') record[col.name] = Boolean(val);
          else if (pType === 'INT32' || pType === 'INT64') record[col.name] = Number(val);
          else if (pType === 'FLOAT' || pType === 'DOUBLE') record[col.name] = Number(val);
          else record[col.name] = String(val);
        }
        await writer.appendRow(record);
      }
    }

    // Write first batch
    await writeRows(firstBatch.rows ?? []);
    totalRows += (firstBatch.rows ?? []).length;

    // Fetch remaining batches
    while ((firstBatch.rows ?? []).length > 0) {
      const batch = await client.query(`FETCH ${batchSize} FROM ${cursorName}`);
      if (!batch.rows?.length) break;
      await writeRows(batch.rows);
      totalRows += batch.rows.length;
    }

    await writer.close();
    await client.query('CLOSE ' + cursorName);
    await client.query('COMMIT');
    return totalRows;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
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
    const cursorName = 'export_csv_cursor';
    const batchSize = 5000;
    const sqlText = `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

    await client.query('BEGIN');
    await client.query(`DECLARE ${cursorName} CURSOR FOR ${sqlText}`);

    const fsNode = await import('node:fs');
    const writeStream = fsNode.createWriteStream(filePath, { encoding: 'utf-8' });

    /** Write a chunk and wait for drain if the buffer is full. */
    function writeWithBackpressure(chunk: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const canContinue = writeStream.write(chunk);
        if (canContinue) {
          resolve();
        } else {
          writeStream.once('drain', resolve);
          writeStream.once('error', reject);
        }
      });
    }

    let totalRows = 0;
    let headerWritten = false;
    let columnNames: string[] = [];

    // Fetch and write in batches
    while (true) {
      const batch = await client.query(`FETCH ${batchSize} FROM ${cursorName}`);
      if (!headerWritten) {
        columnNames = batch.fields?.map((f) => f.name) ?? [];
        const header = columnNames.map((c) => `"${c.replace(/"/g, '""')}"`).join(',');
        await writeWithBackpressure(header + '\n');
        headerWritten = true;
      }
      if (!batch.rows?.length) break;

      // Build the entire batch into one string to reduce write() calls
      const lines: string[] = [];
      for (const row of batch.rows as Record<string, unknown>[]) {
        const csvRow = columnNames.map((col) => {
          const val = row[col];
          const cell = val == null ? '' : serializeValue(val);
          return `"${cell.replace(/"/g, '""')}"`;
        }).join(',');
        lines.push(csvRow);
      }
      await writeWithBackpressure(lines.join('\n') + '\n');
      totalRows += batch.rows.length;
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.end(() => resolve());
      writeStream.once('error', reject);
    });

    await client.query('CLOSE ' + cursorName);
    await client.query('COMMIT');
    return totalRows;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}
