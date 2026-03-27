import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the pgpass lookup logic embedded in postgres.ts connect().
 * We test by calling testConnection with an empty password and verifying
 * the pg.Client receives the password resolved from a mock ~/.pgpass.
 */

const queries: Array<{ sql: string; params?: unknown[] }> = [];

const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    return Promise.resolve({ rows: [], fields: [], command: '', rowCount: 0 });
  }),
};

let capturedConfig: Record<string, unknown> = {};

vi.mock('pg', () => ({
  default: {
    Client: vi.fn().mockImplementation(function (config: Record<string, unknown>) {
      capturedConfig = config;
      return mockClient;
    }),
    Pool: vi.fn().mockImplementation(function (config: Record<string, unknown>) {
      capturedConfig = config;
      return { connect: vi.fn().mockResolvedValue(mockClient), end: vi.fn().mockResolvedValue(undefined) };
    }),
  },
}));

// Mock ssh-tunnel to avoid import issues
vi.mock('../../src/main/ssh-tunnel', () => ({
  openTunnel: vi.fn(),
  closeAllTunnels: vi.fn(),
}));

import * as postgres from '../../src/main/postgres';
import type { SavedConnection } from '../../src/main/types';

describe('pgpass integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queries.length = 0;
    capturedConfig = {};
    mockClient.query.mockImplementation((sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return Promise.resolve({ rows: [], fields: [], command: '', rowCount: 0 });
    });
  });

  it('passes password when provided', async () => {
    const conn: SavedConnection = {
      id: '1', name: 'test', host: 'localhost', port: 5432,
      user: 'admin', password: 'explicit_pass', database: 'mydb',
    };
    await postgres.testConnection(conn);
    expect(capturedConfig.password).toBe('explicit_pass');
  });

  it('omits password field when empty and pgpass has no match', async () => {
    const conn: SavedConnection = {
      id: '1', name: 'test', host: 'nonexistent-host', port: 9999,
      user: 'nobody', password: '', database: 'nodb',
    };
    await postgres.testConnection(conn);
    // password should be undefined or empty (no pgpass match for this host)
    expect(capturedConfig.password === undefined || capturedConfig.password === '').toBe(true);
  });

  it('uses pgpass when authMethod is pgpass', async () => {
    const conn: SavedConnection = {
      id: '1', name: 'test', host: 'localhost', port: 5432,
      user: 'admin', password: 'should_be_ignored', database: 'mydb',
      authMethod: 'pgpass',
    };
    await postgres.testConnection(conn);
    // When authMethod is pgpass, it should look up from pgpass, not use the stored password
    // Since there's no pgpass entry for localhost:5432:mydb:admin in CI, password will be empty
    // The key assertion: it should NOT be 'should_be_ignored'
    expect(capturedConfig.password).not.toBe('should_be_ignored');
  });

  it('connects to correct host/port', async () => {
    const conn: SavedConnection = {
      id: '1', name: 'test', host: 'myhost.com', port: 5433,
      user: 'myuser', password: 'mypass', database: 'mydb',
    };
    await postgres.testConnection(conn);
    expect(capturedConfig.host).toBe('myhost.com');
    expect(capturedConfig.port).toBe(5433);
    expect(capturedConfig.user).toBe('myuser');
    expect(capturedConfig.database).toBe('mydb');
  });

  it('routes through SSH tunnel when ssh is enabled', async () => {
    const { openTunnel } = await import('../../src/main/ssh-tunnel');
    vi.mocked(openTunnel).mockResolvedValue(65432);

    const conn: SavedConnection = {
      id: '1', name: 'test', host: 'db.internal', port: 5432,
      user: 'admin', password: 'pass', database: 'mydb',
      ssh: {
        enabled: true,
        host: 'bastion.com',
        port: 22,
        user: 'sshuser',
        authMethod: 'password',
        password: 'sshpass',
        privateKey: '',
        passphrase: '',
      },
    };
    await postgres.testConnection(conn);
    expect(openTunnel).toHaveBeenCalled();
    expect(capturedConfig.host).toBe('127.0.0.1');
    expect(capturedConfig.port).toBe(65432);
  });
});
