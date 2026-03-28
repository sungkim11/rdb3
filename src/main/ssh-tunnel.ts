import { Client as SshClient } from 'ssh2';
import net from 'node:net';
import fs from 'node:fs';
import type { SshConfig } from './types';

interface ActiveTunnel {
  sshClient: SshClient;
  server: net.Server;
  localPort: number;
}

const activeTunnels = new Map<string, ActiveTunnel>();

function tunnelKey(ssh: SshConfig, dbHost: string, dbPort: number): string {
  return `${ssh.host}:${ssh.port}:${ssh.user}@${dbHost}:${dbPort}`;
}

/** Build the ssh2 connection config from an SshConfig. */
function buildSshConnConfig(ssh: SshConfig): Record<string, unknown> {
  const connConfig: Record<string, unknown> = {
    host: ssh.host,
    port: ssh.port,
    username: ssh.user,
    readyTimeout: 10000,
  };

  if (ssh.authMethod === 'privateKey') {
    connConfig.privateKey = fs.readFileSync(ssh.privateKey, 'utf-8');
    if (ssh.passphrase) {
      connConfig.passphrase = ssh.passphrase;
    }
  } else {
    connConfig.password = ssh.password;
  }

  return connConfig;
}

/**
 * Core tunnel creation. Opens an SSH tunnel forwarding a random local port
 * to dbHost:dbPort. Returns the local port, server, and sshClient.
 */
function createTunnel(
  ssh: SshConfig,
  dbHost: string,
  dbPort: number,
): Promise<{ localPort: number; server: net.Server; sshClient: SshClient }> {
  return new Promise((resolve, reject) => {
    const sshClient = new SshClient();

    let connConfig: Record<string, unknown>;
    try {
      connConfig = buildSshConnConfig(ssh);
    } catch (err) {
      reject(new Error(`Cannot read SSH private key: ${(err as Error).message}`));
      return;
    }

    sshClient.on('error', (err) => {
      reject(new Error(`SSH connection failed: ${err.message}`));
    });

    sshClient.on('ready', () => {
      const server = net.createServer((localSocket) => {
        sshClient.forwardOut(
          '127.0.0.1',
          0,
          dbHost,
          dbPort,
          (err, stream) => {
            if (err) {
              localSocket.destroy();
              return;
            }
            localSocket.pipe(stream).pipe(localSocket);
            localSocket.on('error', () => stream.destroy());
            stream.on('error', () => localSocket.destroy());
          },
        );
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind local tunnel port'));
          return;
        }
        resolve({ localPort: addr.port, server, sshClient });
      });

      server.on('error', (err) => {
        reject(new Error(`SSH tunnel server error: ${err.message}`));
      });
    });

    sshClient.connect(connConfig as Parameters<typeof sshClient.connect>[0]);
  });
}

/**
 * Create an SSH tunnel that forwards a random local port to dbHost:dbPort
 * through the SSH server. Returns the local port to connect pg to.
 * The tunnel is cached and reused for subsequent calls with the same key.
 */
export async function openTunnel(
  ssh: SshConfig,
  dbHost: string,
  dbPort: number,
): Promise<number> {
  const key = tunnelKey(ssh, dbHost, dbPort);

  // Reuse existing tunnel if still alive
  const existing = activeTunnels.get(key);
  if (existing) {
    try {
      // Quick liveness check
      if (existing.server.listening) return existing.localPort;
    } catch {
      // stale, clean up below
    }
    closeTunnel(key);
  }

  const { localPort, server, sshClient } = await createTunnel(ssh, dbHost, dbPort);
  activeTunnels.set(key, { sshClient, server, localPort });
  return localPort;
}

/**
 * Open an ephemeral SSH tunnel that is NOT cached. Returns the local port
 * and a close function. Used by testConnection to avoid interfering with
 * tunnels used by live sessions.
 */
export async function openEphemeralTunnel(
  ssh: SshConfig,
  dbHost: string,
  dbPort: number,
): Promise<{ localPort: number; close: () => void }> {
  const { localPort, server, sshClient } = await createTunnel(ssh, dbHost, dbPort);
  return {
    localPort,
    close() {
      try { server.close(); } catch {}
      try { sshClient.end(); } catch {}
    },
  };
}

function closeTunnel(key: string): void {
  const tunnel = activeTunnels.get(key);
  if (!tunnel) return;
  activeTunnels.delete(key);
  try { tunnel.server.close(); } catch {}
  try { tunnel.sshClient.end(); } catch {}
}

/** Close the specific tunnel for a given SSH config + DB endpoint. */
export function closeTunnelFor(ssh: SshConfig, dbHost: string, dbPort: number): void {
  const key = tunnelKey(ssh, dbHost, dbPort);
  closeTunnel(key);
}

/** Close tunnels that were opened for a specific SSH config (used on connection switch). */
export function closeTunnelsForSsh(sshHost: string, sshPort: number, sshUser: string): void {
  for (const key of activeTunnels.keys()) {
    if (key.startsWith(`${sshHost}:${sshPort}:${sshUser}@`)) {
      closeTunnel(key);
    }
  }
}

/** Close all active tunnels (called on disconnect / app quit). */
export function closeAllTunnels(): void {
  for (const key of activeTunnels.keys()) {
    closeTunnel(key);
  }
}
