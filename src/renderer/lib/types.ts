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
