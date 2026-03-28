import { vi } from 'vitest';

// Mock Electron modules globally
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/postgrip-test'),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    loadFile: vi.fn(),
    loadURL: vi.fn(),
  })),
  ipcMain: {
    handle: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn(),
  },
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  dialog: {
    showSaveDialog: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((buf: Buffer) => buf.toString()),
  },
}));
