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

/**
 * Create an SSH tunnel that forwards a random local port to dbHost:dbPort
 * through the SSH server. Returns the local port to connect pg to.
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

  return new Promise<number>((resolve, reject) => {
    const sshClient = new SshClient();

    const connConfig: Record<string, unknown> = {
      host: ssh.host,
      port: ssh.port,
      username: ssh.user,
      readyTimeout: 10000,
    };

    if (ssh.authMethod === 'privateKey') {
      try {
        connConfig.privateKey = fs.readFileSync(ssh.privateKey, 'utf-8');
      } catch (err) {
        reject(new Error(`Cannot read SSH private key: ${(err as Error).message}`));
        return;
      }
      if (ssh.passphrase) {
        connConfig.passphrase = ssh.passphrase;
      }
    } else {
      connConfig.password = ssh.password;
    }

    sshClient.on('error', (err) => {
      reject(new Error(`SSH connection failed: ${err.message}`));
    });

    sshClient.on('ready', () => {
      // Create a local TCP server that forwards to the remote DB
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
        const localPort = addr.port;
        activeTunnels.set(key, { sshClient, server, localPort });
        resolve(localPort);
      });

      server.on('error', (err) => {
        reject(new Error(`SSH tunnel server error: ${err.message}`));
      });
    });

    sshClient.connect(connConfig as Parameters<typeof sshClient.connect>[0]);
  });
}

function closeTunnel(key: string): void {
  const tunnel = activeTunnels.get(key);
  if (!tunnel) return;
  activeTunnels.delete(key);
  try { tunnel.server.close(); } catch {}
  try { tunnel.sshClient.end(); } catch {}
}

/** Close all active tunnels (called on disconnect / app quit). */
export function closeAllTunnels(): void {
  for (const key of activeTunnels.keys()) {
    closeTunnel(key);
  }
}
