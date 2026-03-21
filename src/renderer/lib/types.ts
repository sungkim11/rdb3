export type Nullable<T> = T | null;

export interface ConnectionInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
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

export interface QueryResult {
  columns: string[];
  rows: string[][];
  rowCount: number;
  truncated: boolean;
  executionTimeMs: number;
  notice: Nullable<string>;
}
