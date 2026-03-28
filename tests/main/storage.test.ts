import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SavedConnection } from '../../src/main/types';

// Mock fs before importing storage
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

import fs from 'node:fs';
import { loadConnections, saveConnections, saveLastConnectionId, loadLastConnectionId } from '../../src/main/storage';

describe('storage', () => {
  const mockConnections: SavedConnection[] = [
    {
      id: 'conn-1',
      name: 'Dev DB',
      host: 'localhost',
      port: 5432,
      user: 'dev',
      password: 'devpass',
      database: 'devdb',
    },
    {
      id: 'conn-2',
      name: 'Prod DB',
      host: 'prod.example.com',
      port: 5432,
      user: 'prod',
      password: 'prodpass',
      database: 'proddb',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadConnections', () => {
    it('returns empty array when file does not exist', async () => {
      vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));
      const result = await loadConnections();
      expect(result).toEqual([]);
    });

    it('loads and parses connections from file', async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(mockConnections));
      const result = await loadConnections();
      expect(result).toEqual(mockConnections);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Dev DB');
    });

    it('reads from the correct file path', async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue('[]');
      await loadConnections();
      const readPath = vi.mocked(fs.promises.readFile).mock.calls[0][0] as string;
      expect(readPath).toContain('connections.json');
    });
  });

  describe('saveConnections', () => {
    it('writes connections to file as JSON', async () => {
      await saveConnections(mockConnections);
      expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
      const [, content, encoding] = vi.mocked(fs.promises.writeFile).mock.calls[0];
      expect(encoding).toBe('utf-8');
      const parsed = JSON.parse(content as string);
      expect(parsed).toEqual(mockConnections);
    });

    it('writes pretty-printed JSON', async () => {
      await saveConnections(mockConnections);
      const content = vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string;
      expect(content).toContain('\n');
      expect(content).toContain('  ');
    });

    it('handles empty array', async () => {
      await saveConnections([]);
      const content = vi.mocked(fs.promises.writeFile).mock.calls[0][1] as string;
      expect(JSON.parse(content)).toEqual([]);
    });
  });

  describe('saveLastConnectionId', () => {
    it('writes connection id to file', async () => {
      await saveLastConnectionId('conn-123');
      expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
      const [filePath, content, encoding] = vi.mocked(fs.promises.writeFile).mock.calls[0];
      expect(filePath).toContain('last_connection.txt');
      expect(content).toBe('conn-123');
      expect(encoding).toBe('utf-8');
    });

    it('overwrites previous id', async () => {
      await saveLastConnectionId('conn-1');
      await saveLastConnectionId('conn-2');
      const content = vi.mocked(fs.promises.writeFile).mock.calls[1][1] as string;
      expect(content).toBe('conn-2');
    });
  });

  describe('loadLastConnectionId', () => {
    it('returns id from file', async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue('conn-123');
      const result = await loadLastConnectionId();
      expect(result).toBe('conn-123');
    });

    it('trims whitespace', async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue('  conn-123  \n');
      const result = await loadLastConnectionId();
      expect(result).toBe('conn-123');
    });

    it('returns null when file does not exist', async () => {
      vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));
      const result = await loadLastConnectionId();
      expect(result).toBeNull();
    });

    it('reads from correct file path', async () => {
      vi.mocked(fs.promises.readFile).mockResolvedValue('x');
      await loadLastConnectionId();
      const readPath = vi.mocked(fs.promises.readFile).mock.calls[0][0] as string;
      expect(readPath).toContain('last_connection.txt');
    });
  });
});
