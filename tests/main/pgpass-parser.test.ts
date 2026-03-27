import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lookupPgpass, hasPgpassEntry, parsePgpassEntries } from '../../src/main/pgpass';

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(),
  },
  readFileSync: vi.fn(),
}));

import fs from 'node:fs';

describe('pgpass parser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('lookupPgpass', () => {
    it('returns password for exact match', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('localhost:5432:mydb:admin:secret123\n');
      expect(lookupPgpass('localhost', 5432, 'mydb', 'admin')).toBe('secret123');
    });

    it('returns null when no match', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('localhost:5432:mydb:admin:secret123\n');
      expect(lookupPgpass('otherhost', 5432, 'mydb', 'admin')).toBeNull();
    });

    it('supports wildcard host', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('*:5432:mydb:admin:wildcard_pw\n');
      expect(lookupPgpass('anyhost', 5432, 'mydb', 'admin')).toBe('wildcard_pw');
    });

    it('supports wildcard port', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('localhost:*:mydb:admin:wildcard_pw\n');
      expect(lookupPgpass('localhost', 9999, 'mydb', 'admin')).toBe('wildcard_pw');
    });

    it('supports wildcard database', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('localhost:5432:*:admin:wildcard_pw\n');
      expect(lookupPgpass('localhost', 5432, 'anydb', 'admin')).toBe('wildcard_pw');
    });

    it('supports wildcard user', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('localhost:5432:mydb:*:wildcard_pw\n');
      expect(lookupPgpass('localhost', 5432, 'mydb', 'anyuser')).toBe('wildcard_pw');
    });

    it('returns first match when multiple lines match', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('localhost:5432:mydb:admin:first\n*:*:*:*:fallback\n');
      expect(lookupPgpass('localhost', 5432, 'mydb', 'admin')).toBe('first');
    });

    it('skips comment lines', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('# this is a comment\nlocalhost:5432:mydb:admin:secret\n');
      expect(lookupPgpass('localhost', 5432, 'mydb', 'admin')).toBe('secret');
    });

    it('skips blank lines', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('\n\nlocalhost:5432:mydb:admin:secret\n\n');
      expect(lookupPgpass('localhost', 5432, 'mydb', 'admin')).toBe('secret');
    });

    it('handles escaped colons in password', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('localhost:5432:mydb:admin:pass\\:word\n');
      expect(lookupPgpass('localhost', 5432, 'mydb', 'admin')).toBe('pass:word');
    });

    it('handles escaped backslashes', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('localhost:5432:mydb:admin:pass\\\\word\n');
      expect(lookupPgpass('localhost', 5432, 'mydb', 'admin')).toBe('pass\\word');
    });

    it('returns null when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(lookupPgpass('localhost', 5432, 'mydb', 'admin')).toBeNull();
    });

    it('ignores lines with fewer than 5 fields', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('localhost:5432:mydb\nlocalhost:5432:mydb:admin:secret\n');
      expect(lookupPgpass('localhost', 5432, 'mydb', 'admin')).toBe('secret');
    });
  });

  describe('hasPgpassEntry', () => {
    it('returns true when entry exists', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('localhost:5432:mydb:admin:secret\n');
      expect(hasPgpassEntry('localhost', 5432, 'mydb', 'admin')).toBe(true);
    });

    it('returns false when no entry', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('localhost:5432:mydb:admin:secret\n');
      expect(hasPgpassEntry('otherhost', 5432, 'mydb', 'admin')).toBe(false);
    });

    it('returns false when file missing', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(hasPgpassEntry('localhost', 5432, 'mydb', 'admin')).toBe(false);
    });
  });

  describe('parsePgpassEntries', () => {
    it('returns concrete entries', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        'localhost:5432:mydb:admin:pw1\nremote:5433:other:user2:pw2\n'
      );
      const entries = parsePgpassEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ host: 'localhost', port: 5432, user: 'admin', database: 'mydb' });
      expect(entries[1]).toEqual({ host: 'remote', port: 5433, user: 'user2', database: 'other' });
    });

    it('skips wildcard entries', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        '*:5432:mydb:admin:pw1\nlocalhost:*:mydb:admin:pw2\nlocalhost:5432:*:admin:pw3\nlocalhost:5432:mydb:*:pw4\n'
      );
      const entries = parsePgpassEntries();
      expect(entries).toHaveLength(0);
    });

    it('deduplicates entries', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        'localhost:5432:mydb:admin:pw1\nlocalhost:5432:mydb:admin:pw2\n'
      );
      const entries = parsePgpassEntries();
      expect(entries).toHaveLength(1);
    });

    it('skips invalid port', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('localhost:abc:mydb:admin:pw1\n');
      const entries = parsePgpassEntries();
      expect(entries).toHaveLength(0);
    });

    it('skips comments and blanks', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        '# comment\n\nlocalhost:5432:mydb:admin:pw1\n'
      );
      const entries = parsePgpassEntries();
      expect(entries).toHaveLength(1);
    });

    it('returns empty array when file missing', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const entries = parsePgpassEntries();
      expect(entries).toHaveLength(0);
    });
  });
});
