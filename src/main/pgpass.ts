import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Parse a .pgpass line into fields, handling escaped colons (\:) and backslashes (\\).
 * Returns null if the line is a comment or blank.
 */
function parsePgpassLine(rawLine: string): string[] | null {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;

  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === ':') {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.length >= 5 ? parts : null;
}

/**
 * Look up a password from ~/.pgpass (or $PGPASSFILE).
 * Format: hostname:port:database:username:password
 * Wildcards (*) match any value.
 * See: https://www.postgresql.org/docs/current/libpq-pgpass.html
 */
export function lookupPgpass(host: string, port: number, database: string, user: string): string | null {
  const pgpassPath = process.env.PGPASSFILE || path.join(os.homedir(), '.pgpass');
  try {
    const content = fs.readFileSync(pgpassPath, 'utf-8');
    const portStr = String(port);
    const match = (pattern: string, value: string) => pattern === '*' || pattern === value;

    for (const rawLine of content.split('\n')) {
      const parts = parsePgpassLine(rawLine);
      if (!parts) continue;

      const [pHost, pPort, pDb, pUser, ...pPassParts] = parts;
      if (match(pHost, host) && match(pPort, portStr) && match(pDb, database) && match(pUser, user)) {
        return pPassParts.join(':');
      }
    }
  } catch {
    // File doesn't exist or isn't readable
  }
  return null;
}

/**
 * Check whether ~/.pgpass has a matching entry (without returning the password).
 */
export function hasPgpassEntry(host: string, port: number, database: string, user: string): boolean {
  return lookupPgpass(host, port, database, user) !== null;
}
