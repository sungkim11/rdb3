import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  hostStats: () => ipcRenderer.invoke('host-stats'),
  activeQueries: () => ipcRenderer.invoke('active-queries'),
  testConnection: (connection: unknown) =>
    ipcRenderer.invoke('test-connection', connection),
  connect: (connection: unknown, save: boolean) =>
    ipcRenderer.invoke('connect', connection, save),
  activateSavedConnection: (id: string) =>
    ipcRenderer.invoke('activate-saved-connection', id),
  deleteSavedConnection: (id: string) =>
    ipcRenderer.invoke('delete-saved-connection', id),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  runQuery: (sql: string, limit?: number) =>
    ipcRenderer.invoke('run-query', sql, limit),
  previewTable: (schema: string, table: string, limit?: number, offset?: number) =>
    ipcRenderer.invoke('preview-table', schema, table, limit, offset),
  getTableDdl: (schema: string, table: string) =>
    ipcRenderer.invoke('get-table-ddl', schema, table),
  dropTable: (schema: string, table: string, cascade: boolean) =>
    ipcRenderer.invoke('drop-table', schema, table, cascade),
  truncateTable: (schema: string, table: string, cascade: boolean) =>
    ipcRenderer.invoke('truncate-table', schema, table, cascade),
  getEditableTableData: (schema: string, table: string, limit: number, offset: number) =>
    ipcRenderer.invoke('get-editable-table-data', schema, table, limit, offset),
  executeDml: (schema: string, table: string, operations: unknown[]) =>
    ipcRenderer.invoke('execute-dml', schema, table, operations),
  getModifyTableInfo: (schema: string, table: string) =>
    ipcRenderer.invoke('get-modify-table-info', schema, table),
  alterTable: (schema: string, table: string, actions: unknown[]) =>
    ipcRenderer.invoke('alter-table', schema, table, actions),
  exportTableCsv: (schema: string, table: string, path: string) =>
    ipcRenderer.invoke('export-table-csv', schema, table, path),
  exportPgDump: (schema: string, table: string, filePath: string, format: string) =>
    ipcRenderer.invoke('export-pg-dump', schema, table, filePath, format),
  showSaveDialog: (options: unknown) =>
    ipcRenderer.invoke('show-save-dialog', options),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('write-file', filePath, content),
  getPgpassEntries: () => ipcRenderer.invoke('get-pgpass-entries'),
  listDirectory: (dirPath: string) => ipcRenderer.invoke('list-directory', dirPath),
  readTextFile: (filePath: string) => ipcRenderer.invoke('read-text-file', filePath),
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),
  gitStatus: (repoPath: string) => ipcRenderer.invoke('git-status', repoPath),
  gitDiff: (repoPath: string, filePath: string) => ipcRenderer.invoke('git-diff', repoPath, filePath),
  closeWindow: () => ipcRenderer.invoke('close-window'),
});
