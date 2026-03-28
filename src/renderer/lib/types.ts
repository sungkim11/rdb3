export type Nullable<T> = T | null;

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  authMethod: 'password' | 'privateKey';
  password: string;
  privateKey: string;
  passphrase: string;
}

export interface ConnectionInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  authMethod?: 'password' | 'pgpass';
  ssh?: SshConfig;
}

export interface SavedConnection extends ConnectionInput {
  id: string;
}

/** Connection info returned from the backend — password stripped. */
export interface SafeSavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database: string;
  authMethod?: 'password' | 'pgpass';
  ssh?: { enabled: boolean; host: string; port: number; user: string; authMethod: string };
}

export interface ActiveConnectionSummary {
  id: string;
  label: string;
  host: string;
  port: number;
  database: string;
  user: string;
}

export interface ColumnNode {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: Nullable<string>;
}

export interface KeyNode {
  name: string;
  type: string;
  columns: string[];
  referencedTable: string | null;
}

export interface IndexNode {
  name: string;
  isUnique: boolean;
  columns: string[];
}

export interface TableNode {
  name: string;
  tableType: string;
  columns: ColumnNode[];
  keys: KeyNode[];
  indexes: IndexNode[];
}

export interface SchemaNode {
  name: string;
  tables: TableNode[];
}

export interface AppSnapshot {
  savedConnections: SafeSavedConnection[];
  activeConnection: Nullable<ActiveConnectionSummary>;
  databaseTree: SchemaNode[];
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

export interface ActiveQuery {
  pid: number;
  usename: string;
  state: string;
  query: string;
  durationMs: number;
}

export interface DdlResult {
  ddl: string;
}

export interface ModifyTableColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: Nullable<string>;
}

export interface ModifyTableInfo {
  schema: string;
  table: string;
  columns: ModifyTableColumn[];
}

export interface EditableTableData {
  columns: string[];
  columnTypes: string[];
  rows: (string | null)[][];
  primaryKeyColumns: string[];
  totalCount: number;
}

export interface DmlOperation {
  type: 'update' | 'insert' | 'delete';
  pkValues?: Record<string, string | null>;
  changes?: Record<string, string | null>;
  values?: Record<string, string | null>;
  columnTypes?: Record<string, string>;
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

export interface BackupOptions {
  filePath: string;
  format: string;
  schemas?: string[];
  tables?: string[];
  dataOnly?: boolean;
  schemaOnly?: boolean;
  noOwner?: boolean;
  noPrivileges?: boolean;
  clean?: boolean;
  createDb?: boolean;
  ifExists?: boolean;
  compress?: number;
  verbose?: boolean;
  blobs?: boolean;
  noBlobs?: boolean;
}

export interface BackupMeta {
  database: string;
  host: string;
  port: number;
  user: string;
  format: string;
  schemas: string[];
  tables: string[];
  scope: string;
  dataOnly: boolean;
  schemaOnly: boolean;
  noOwner: boolean;
  noPrivileges: boolean;
  clean: boolean;
  createDb: boolean;
  ifExists: boolean;
  compress: number;
  createdAt: string;
  durationMs: number;
}

export interface MonitoringData {
  connectionsByState: Array<{ state: string; count: number }>;
  connectionsByUser: Array<{ user: string; count: number }>;
  tableStats: Array<{ schema: string; table: string; seqScan: number; idxScan: number; rowsInserted: number; rowsUpdated: number; rowsDeleted: number; deadTuples: number; lastVacuum: string | null; lastAnalyze: string | null; tableSize: string }>;
  unusedIndexes: Array<{ schema: string; table: string; index: string; size: string }>;
  locksByType: Array<{ locktype: string; mode: string; count: number }>;
  blockedQueries: Array<{ pid: number; query: string; waitingFor: number; durationMs: number }>;
  deadlocks: number;
  tempFiles: number;
  tempBytes: number;
  conflictsCount: number;
  checkpointsTimed: number;
  checkpointsReq: number;
  buffersCheckpoint: number;
  buffersBgwriter: number;
  buffersBackend: number;
  replicationLag: Array<{ clientAddr: string; state: string; sentLag: string; writeLag: string; flushLag: string; replayLag: string }>;
  longRunningTxns: Array<{ pid: number; user: string; duration: string; state: string; query: string }>;
}

export interface BackupSchedule {
  id: string;
  days: string[];
  time: string;
  format: string;
  schemas: string[];
  tables: string[];
  scope: string;
  dataOnly: boolean;
  schemaOnly: boolean;
  noOwner: boolean;
  noPrivileges: boolean;
  outputDir: string;
  enabled: boolean;
  createdAt: string;
  lastRun?: string;
}

export interface BackupEntry {
  name: string;
  path: string;
  size: number;
  modified: string;
  status?: 'completed' | 'in_progress' | 'failed';
  durationMs?: number;
  error?: string;
  meta?: BackupMeta;
}

export interface AppInfo {
  name: string;
  version: string;
  electronVersion: string;
  nodeVersion: string;
  chromiumVersion: string;
  platform: string;
}

export interface GitFileStatus {
  status: string;
  path: string;
}

export interface GitCommit {
  hash: string;
  message: string;
}

export interface GitStatus {
  branch: string;
  files: GitFileStatus[];
  commits: GitCommit[];
}

export interface GitRepo {
  name: string;
  path: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface PgpassEntry {
  host: string;
  port: number;
  user: string;
  database: string;
}

export interface QueryResult {
  columns: string[];
  rows: string[][];
  rowCount: number;
  truncated: boolean;
  executionTimeMs: number;
  notice: Nullable<string>;
}
