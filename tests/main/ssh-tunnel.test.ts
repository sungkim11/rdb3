import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ssh2 and node modules before importing
vi.mock('ssh2', () => {
  const mockSshClient = {
    on: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
    forwardOut: vi.fn(),
  };
  return {
    Client: vi.fn().mockImplementation(function () { return mockSshClient; }),
    _mockClient: mockSshClient,
  };
});

vi.mock('node:net', () => {
  const mockServer = {
    listen: vi.fn(),
    close: vi.fn(),
    address: vi.fn().mockReturnValue({ port: 54321 }),
    listening: true,
    on: vi.fn(),
  };
  return {
    default: {
      createServer: vi.fn().mockReturnValue(mockServer),
    },
    createServer: vi.fn().mockReturnValue(mockServer),
    _mockServer: mockServer,
  };
});

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn().mockReturnValue('FAKE_PRIVATE_KEY'),
  },
  readFileSync: vi.fn().mockReturnValue('FAKE_PRIVATE_KEY'),
}));

import { openTunnel, closeAllTunnels } from '../../src/main/ssh-tunnel';
import { Client as SshClient } from 'ssh2';
import net from 'node:net';
import type { SshConfig } from '../../src/main/types';

const sshModule = await import('ssh2') as unknown as { _mockClient: ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>> };
const netModule = await import('node:net') as unknown as { _mockServer: Record<string, ReturnType<typeof vi.fn>> };

describe('ssh-tunnel', () => {
  const baseSsh: SshConfig = {
    enabled: true,
    host: 'bastion.example.com',
    port: 22,
    user: 'tunnel_user',
    authMethod: 'password',
    password: 'tunnel_pass',
    privateKey: '',
    passphrase: '',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    closeAllTunnels();

    // Reset mock implementations
    const mockClient = sshModule._mockClient;
    const mockServer = netModule._mockServer;

    mockClient.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'ready') {
        // Trigger ready callback asynchronously
        setTimeout(() => cb(), 0);
      }
      return mockClient;
    });

    mockServer.listen.mockImplementation((_port: number, _host: string, cb: () => void) => {
      setTimeout(() => cb(), 0);
    });

    mockServer.address.mockReturnValue({ port: 54321 });
    mockServer.listening = true;
  });

  describe('openTunnel', () => {
    it('creates SSH client and returns local port', async () => {
      const port = await openTunnel(baseSsh, 'db.internal', 5432);
      expect(port).toBe(54321);
      expect(SshClient).toHaveBeenCalled();
    });

    it('passes password auth config to SSH client', async () => {
      await openTunnel(baseSsh, 'db.internal', 5432);
      const mockClient = sshModule._mockClient;
      expect(mockClient.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'bastion.example.com',
          port: 22,
          username: 'tunnel_user',
          password: 'tunnel_pass',
        }),
      );
    });

    it('passes private key auth config to SSH client', async () => {
      const sshWithKey: SshConfig = {
        ...baseSsh,
        authMethod: 'privateKey',
        privateKey: '/home/user/.ssh/id_rsa',
        passphrase: 'my_passphrase',
        password: '',
      };
      await openTunnel(sshWithKey, 'db.internal', 5432);
      const mockClient = sshModule._mockClient;
      expect(mockClient.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'bastion.example.com',
          privateKey: 'FAKE_PRIVATE_KEY',
          passphrase: 'my_passphrase',
        }),
      );
    });

    it('reuses existing tunnel if still listening', async () => {
      const port1 = await openTunnel(baseSsh, 'db.internal', 5432);
      const port2 = await openTunnel(baseSsh, 'db.internal', 5432);
      expect(port1).toBe(port2);
      // SshClient constructor called only once
      expect(SshClient).toHaveBeenCalledTimes(1);
    });

    it('rejects when SSH client emits error', async () => {
      const mockClient = sshModule._mockClient;
      mockClient.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'error') {
          setTimeout(() => cb(new Error('Connection refused')), 0);
        }
        return mockClient;
      });

      await expect(openTunnel(baseSsh, 'db.internal', 5432)).rejects.toThrow('SSH connection failed');
    });

    it('rejects when private key file is unreadable', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.default.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

      const sshWithKey: SshConfig = { ...baseSsh, authMethod: 'privateKey', privateKey: '/bad/path' };
      await expect(openTunnel(sshWithKey, 'db.internal', 5432)).rejects.toThrow('Cannot read SSH private key');
    });
  });

  describe('closeAllTunnels', () => {
    it('closes server and SSH client for all tunnels', async () => {
      await openTunnel(baseSsh, 'db.internal', 5432);
      const mockClient = sshModule._mockClient;
      const mockServer = netModule._mockServer;

      closeAllTunnels();

      expect(mockServer.close).toHaveBeenCalled();
      expect(mockClient.end).toHaveBeenCalled();
    });

    it('is safe to call when no tunnels exist', () => {
      expect(() => closeAllTunnels()).not.toThrow();
    });
  });
});
