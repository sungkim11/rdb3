import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from './ipc';

// Prevent the app from crashing on transient connection errors (e.g. server
// restarts, admin-terminated connections). These are recoverable — the pool
// will create fresh connections on the next query.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Allow E2E tests to isolate userData to a temp directory
if (process.env.ELECTRON_USER_DATA_DIR) {
  app.setPath('userData', process.env.ELECTRON_USER_DATA_DIR);
}

registerIpcHandlers();

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
};

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
