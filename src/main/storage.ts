import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { SavedConnection } from './types';

const CONNECTIONS_FILE = 'connections.json';

function connectionsPath(): string {
  const dir = app.getPath('userData');
  return path.join(dir, CONNECTIONS_FILE);
}

export function loadConnections(): SavedConnection[] {
  const filePath = connectionsPath();
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as SavedConnection[];
}

export function saveConnections(connections: SavedConnection[]): void {
  const filePath = connectionsPath();
  fs.writeFileSync(filePath, JSON.stringify(connections, null, 2), 'utf-8');
}

const LAST_CONNECTION_FILE = 'last_connection.txt';

export function saveLastConnectionId(id: string): void {
  const filePath = path.join(app.getPath('userData'), LAST_CONNECTION_FILE);
  fs.writeFileSync(filePath, id, 'utf-8');
}

export function loadLastConnectionId(): string | null {
  const filePath = path.join(app.getPath('userData'), LAST_CONNECTION_FILE);
  try { return fs.readFileSync(filePath, 'utf-8').trim(); } catch { return null; }
}
