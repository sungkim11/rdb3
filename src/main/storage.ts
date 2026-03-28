import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { SavedConnection, SshConfig } from './types';

const CONNECTIONS_FILE = 'connections.json';

function connectionsPath(): string {
  const dir = app.getPath('userData');
  return path.join(dir, CONNECTIONS_FILE);
}

// --- Credential encryption helpers (Finding #2) ---

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptString(value: string): string {
  if (!value || !canEncrypt()) return value;
  const encrypted = safeStorage.encryptString(value);
  return 'enc:' + encrypted.toString('base64');
}

function decryptString(value: string): string {
  if (!value || !value.startsWith('enc:')) return value;
  try {
    const buf = Buffer.from(value.slice(4), 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    // If decryption fails (e.g. different machine), return empty to force re-entry
    return '';
  }
}

/** Encrypt sensitive fields before writing to disk. */
function encryptConnection(conn: SavedConnection): SavedConnection {
  const encrypted = { ...conn };
  encrypted.password = encryptString(conn.password);
  if (conn.ssh) {
    encrypted.ssh = { ...conn.ssh };
    encrypted.ssh.password = encryptString(conn.ssh.password);
    encrypted.ssh.passphrase = encryptString(conn.ssh.passphrase);
  }
  return encrypted;
}

/** Decrypt sensitive fields after reading from disk. */
function decryptConnection(conn: SavedConnection): SavedConnection {
  const decrypted = { ...conn };
  decrypted.password = decryptString(conn.password);
  if (conn.ssh) {
    decrypted.ssh = { ...conn.ssh } as SshConfig;
    decrypted.ssh.password = decryptString(conn.ssh.password);
    decrypted.ssh.passphrase = decryptString(conn.ssh.passphrase);
  }
  return decrypted;
}

export async function loadConnections(): Promise<SavedConnection[]> {
  const filePath = connectionsPath();
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const connections = JSON.parse(raw) as SavedConnection[];
    return connections.map(decryptConnection);
  } catch {
    return [];
  }
}

export async function saveConnections(connections: SavedConnection[]): Promise<void> {
  const filePath = connectionsPath();
  const encrypted = connections.map(encryptConnection);
  await fs.promises.writeFile(filePath, JSON.stringify(encrypted, null, 2), 'utf-8');
}

const LAST_CONNECTION_FILE = 'last_connection.txt';

export async function saveLastConnectionId(id: string): Promise<void> {
  const filePath = path.join(app.getPath('userData'), LAST_CONNECTION_FILE);
  await fs.promises.writeFile(filePath, id, 'utf-8');
}

export async function loadLastConnectionId(): Promise<string | null> {
  const filePath = path.join(app.getPath('userData'), LAST_CONNECTION_FILE);
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return content.trim();
  } catch {
    return null;
  }
}
