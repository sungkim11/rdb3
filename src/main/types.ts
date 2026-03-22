import { randomUUID } from 'node:crypto';

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

export const EMPTY_SSH_CONFIG: SshConfig = {
  enabled: false,
  host: '',
  port: 22,
  user: '',
  authMethod: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
};

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

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  authMethod?: 'password' | 'pgpass';
  ssh?: SshConfig;
}

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
  defaultValue: string | null;
}

export interface KeyNode {
  name: string;
  type: string; // 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY'
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
  activeConnection: ActiveConnectionSummary | null;
  databaseTree: SchemaNode[];
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
  notice: string | null;
}

export function toSavedConnection(input: ConnectionInput): SavedConnection {
  return {
    id: input.id ?? randomUUID(),
    name: input.name,
    host: input.host,
    port: input.port,
    user: input.user,
    password: input.password,
    database: input.database,
    authMethod: input.authMethod,
    ssh: input.ssh,
  };
}

export function toSafe(conn: SavedConnection): SafeSavedConnection {
  return {
    id: conn.id,
    name: conn.name,
    host: conn.host,
    port: conn.port,
    user: conn.user,
    database: conn.database,
    authMethod: conn.authMethod,
    ssh: conn.ssh ? { enabled: conn.ssh.enabled, host: conn.ssh.host, port: conn.ssh.port, user: conn.ssh.user, authMethod: conn.ssh.authMethod } : undefined,
  };
}

export function toSummary(conn: SavedConnection): ActiveConnectionSummary {
  const label = conn.name.trim() || `${conn.user}@${conn.host}`;
  return {
    id: conn.id,
    label,
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
  };
}

function escapeLibpqValue(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9._-]+$/.test(value)) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${escaped}'`;
}

export function buildConnectionString(conn: SavedConnection): string {
  return `host=${escapeLibpqValue(conn.host)} port=${conn.port} user=${escapeLibpqValue(conn.user)} password=${escapeLibpqValue(conn.password)} dbname=${escapeLibpqValue(conn.database)} connect_timeout=5`;
}
