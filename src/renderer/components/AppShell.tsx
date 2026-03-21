import type { PropsWithChildren, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { SqlEditor } from './SqlEditor';
import type {
  ActiveConnectionSummary,
  AppSnapshot,
  ConnectionInput,
  DdlResult,
  HostStats,
  IndexNode,
  KeyNode,
  QueryResult,
  SafeSavedConnection,
  SchemaNode,
  TableNode,
} from '../lib/types';

const EMPTY_CONNECTION: ConnectionInput = {
  name: '',
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password: '',
  database: 'postgres',
};

const QUERY_PRESETS = [
  {
    label: 'Session',
    sql: 'select current_database(), current_user, now();',
  },
  {
    label: 'Tables',
    sql: "select table_schema, table_name\nfrom information_schema.tables\nwhere table_schema not in ('pg_catalog', 'information_schema')\norder by 1, 2\nlimit 200;",
  },
  {
    label: 'Activity',
    sql: 'select pid, usename, state, query\nfrom pg_stat_activity\norder by backend_start desc\nlimit 50;',
  },
];

interface QueryHistoryEntry {
  id: string;
  title: string;
  sql: string;
  resultMeta: string;
}

type TopMenu = 'file' | 'view' | null;

type EditorTab = {
  id: string;
  kind: 'query' | 'table' | 'ddl';
  title: string;
  sql: string;
  source?: { schema: string; table: string };
  sortState: SortState;
  currentPage: number;
  result: QueryResult | null;
  ddlText?: string;
};

type ContextMenuState = {
  x: number;
  y: number;
  schema: string;
  table: string;
} | null;

type ConnectionContextMenuState = {
  x: number;
  y: number;
  connection: SafeSavedConnection;
} | null;

type ConfirmDialogState = {
  message: string;
  onConfirm: () => void;
} | null;

type SqlTab = {
  id: string;
  title: string;
  sql: string;
};

type SortState = {
  columnIndex: number;
  direction: 'asc' | 'desc';
} | null;

type DragState = 'sidebar' | 'connections' | null;

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function makeTabId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.floor(s % 60)}s`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'An unknown error occurred.';
}

export function AppShell() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [queryHistory, setQueryHistory] = useState<QueryHistoryEntry[]>([]);
  const [loading, setLoading] = useState('Booting desktop shell...');
  const [error, setError] = useState<string | null>(null);
  const [showConnectionModal, setShowConnectionModal] = useState(false);
  const [showSqlEditor, setShowSqlEditor] = useState(false);
  const [sqlTabs, setSqlTabs] = useState<SqlTab[]>([]);
  const [activeSqlTabId, setActiveSqlTabId] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<TopMenu>(null);
  const [draft, setDraft] = useState<ConnectionInput>(EMPTY_CONNECTION);
  const [persistConnection, setPersistConnection] = useState(true);
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [activeEditorTabId, setActiveEditorTabId] = useState('');
  const PAGE_SIZE = 500;
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [connectionsHeight, setConnectionsHeight] = useState(180);
  const [dragState, setDragState] = useState<DragState>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [connectionContextMenu, setConnectionContextMenu] = useState<ConnectionContextMenuState>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(null);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'fail'>('idle');
  const [testError, setTestError] = useState('');
  const [hostStats, setHostStats] = useState<HostStats | null>(null);
  const MAX_HISTORY = 30;
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [ramHistory, setRamHistory] = useState<number[]>([]);
  const [tpsHistory, setTpsHistory] = useState<number[]>([]);
  const [saturationHistory, setSaturationHistory] = useState<number[]>([]);
  const [cacheHitHistory, setCacheHitHistory] = useState<number[]>([]);

  const activeEditorTab = useMemo(
    () => editorTabs.find((tab) => tab.id === activeEditorTabId) ?? editorTabs[0],
    [activeEditorTabId, editorTabs],
  );

  const databaseTree = snapshot?.databaseTree ?? [];

  const activeSqlTab = useMemo(
    () => sqlTabs.find((t) => t.id === activeSqlTabId) ?? sqlTabs[0] ?? null,
    [activeSqlTabId, sqlTabs],
  );

  const sqlEditorText = activeSqlTab?.sql ?? '';
  const setSqlEditorText = (text: string) => {
    if (!activeSqlTab) return;
    setSqlTabs((tabs) => tabs.map((t) => (t.id === activeSqlTab.id ? { ...t, sql: text } : t)));
  };

  function openSqlEditor() {
    setShowSqlEditor(true);
    if (sqlTabs.length === 0) addSqlTab();
  }

  function addSqlTab() {
    const id = makeTabId('sql');
    const num = sqlTabs.length + 1;
    setSqlTabs((tabs) => [...tabs, { id, title: `Query ${num}`, sql: '' }]);
    setActiveSqlTabId(id);
  }

  function closeSqlTab(id: string) {
    setSqlTabs((tabs) => {
      const next = tabs.filter((t) => t.id !== id);
      if (next.length === 0) {
        setShowSqlEditor(false);
        setActiveSqlTabId(null);
        setEditorTabs([]);
        setActiveEditorTabId('');
      } else if (activeSqlTabId === id) {
        setActiveSqlTabId(next[next.length - 1]?.id ?? null);
      }
      return next;
    });
  }

  const processedResult = useMemo(() => {
    const result = activeEditorTab?.result;
    if (!result) {
      return null;
    }

    const tabSort = activeEditorTab.sortState;
    const tabPage = activeEditorTab.currentPage;
    let rows = result.rows;

    if (tabSort) {
      rows = [...rows].sort((left, right) => {
        const leftValue = left[tabSort.columnIndex] ?? '';
        const rightValue = right[tabSort.columnIndex] ?? '';
        const ordered = leftValue.localeCompare(rightValue, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
        return tabSort.direction === 'asc' ? ordered : -ordered;
      });
    }

    const totalRows = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    const safePage = Math.min(tabPage, totalPages - 1);
    const pagedRows = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

    return {
      ...result,
      rows: pagedRows,
      rowCount: totalRows,
      totalPages,
      currentPage: safePage,
      pageStart: safePage * PAGE_SIZE,
      notice: tabSort
        ? `View rows ${totalRows} of ${result.rows.length}`
        : result.notice,
    };
  }, [activeEditorTab]);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!snapshot?.activeConnection) {
      setHostStats(null);
      setCpuHistory([]);
      setRamHistory([]);
      setTpsHistory([]);
      setSaturationHistory([]);
      setCacheHitHistory([]);
      return;
    }

    let cancelled = false;
    async function fetchStats() {
      try {
        const stats = await api.hostStats();
        if (cancelled) return;
        setHostStats(stats);
        if (stats.cpuUsagePercent != null) {
          setCpuHistory((h) => [...h, stats.cpuUsagePercent!].slice(-MAX_HISTORY));
        }
        if (stats.memUsagePercent != null) {
          setRamHistory((h) => [...h, stats.memUsagePercent!].slice(-MAX_HISTORY));
        }
        if (stats.tps != null) {
          setTpsHistory((h) => [...h, stats.tps!].slice(-MAX_HISTORY));
        }
        if (stats.connectionSaturationPercent != null) {
          setSaturationHistory((h) => [...h, stats.connectionSaturationPercent!].slice(-MAX_HISTORY));
        }
        if (stats.cacheHitRatio != null) {
          setCacheHitHistory((h) => [...h, stats.cacheHitRatio!].slice(-MAX_HISTORY));
        }
      } catch {}
    }

    void fetchStats();
    const interval = setInterval(() => void fetchStats(), 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [snapshot?.activeConnection?.id]);

  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      if (dragState === 'sidebar') {
        setSidebarWidth(Math.min(520, Math.max(240, event.clientX)));
      } else if (dragState === 'connections') {
        const headerHeight = 36;
        const y = event.clientY - headerHeight;
        setConnectionsHeight(Math.min(400, Math.max(80, y)));
      }
    }

    function onPointerUp() {
      setDragState(null);
    }

    if (dragState) {
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    }

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [dragState]);

  async function refresh() {
    try {
      setLoading('Loading workspace...');
      setError(null);
      setSnapshot(await api.bootstrap());
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(errorMessage(err));
    }
  }

  function updateActiveTab(patch: Partial<EditorTab>) {
    if (!activeEditorTab) {
      return;
    }

    setEditorTabs((current) =>
      current.map((tab) => (tab.id === activeEditorTab.id ? { ...tab, ...patch } : tab)),
    );
  }

  async function handleExit() {
    await api.closeWindow();
  }

  function openNewQueryTab(sql = QUERY_PRESETS[0].sql) {
    const id = makeTabId('query');
    setEditorTabs((current) => [
      ...current,
      {
        id,
        kind: 'query',
        title: 'sql-query.sql',
        sql,
        result: null,
        sortState: null,
        currentPage: 0,
      },
    ]);
    setActiveEditorTabId(id);
    openSqlEditor();
    setOpenMenu(null);
  }

  function openOrActivateTableTab(schema: string, table: string, sql: string, result: QueryResult) {
    const existing = editorTabs.find((tab) => tab.kind === 'table' && tab.source?.schema === schema && tab.source?.table === table);
    if (existing) {
      setEditorTabs((current) =>
        current.map((tab) =>
          tab.id === existing.id
            ? { ...tab, sql, result, title: `${schema}.${table}`, source: { schema, table }, sortState: null, currentPage: 0 }
            : tab,
        ),
      );
      setActiveEditorTabId(existing.id);
      return;
    }

    const id = makeTabId('table');
    setEditorTabs((current) => [
      ...current,
      {
        id,
        kind: 'table',
        title: `${schema}.${table}`,
        sql,
        source: { schema, table },
        result,
        sortState: null,
        currentPage: 0,
      },
    ]);
    setActiveEditorTabId(id);
  }

  function closeEditorTab(id: string) {
    setEditorTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      if (activeEditorTabId === id) {
        setActiveEditorTabId(next.length > 0 ? next[next.length - 1].id : '');
      }
      return next;
    });
  }

  function clearResultView() {
    updateActiveTab({ sortState: null, currentPage: 0 });
  }

  function toggleSort(columnIndex: number) {
    const current = activeEditorTab?.sortState ?? null;
    if (!current || current.columnIndex !== columnIndex) {
      updateActiveTab({ sortState: { columnIndex, direction: 'asc' } });
    } else if (current.direction === 'asc') {
      updateActiveTab({ sortState: { columnIndex, direction: 'desc' } });
    } else {
      updateActiveTab({ sortState: null });
    }
  }

  function exportCurrentResult() {
    if (!processedResult) {
      return;
    }

    const header = ['#', ...processedResult.columns];
    const rows = processedResult.rows.map((row, index) => [String(index + 1), ...row]);
    const csv = [header, ...rows]
      .map((row) =>
        row
          .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
          .join(','),
      )
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${activeEditorTab?.title ?? 'results'}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function openNewConnectionModal() {
    setDraft(EMPTY_CONNECTION);
    setPersistConnection(true);
    setTestStatus('idle');
    setTestError('');
    setShowConnectionModal(true);
    setOpenMenu(null);
  }

  function openEditConnectionModal(connection: SafeSavedConnection) {
    setDraft({
      id: connection.id,
      name: connection.name,
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password: '',
      database: connection.database,
    });
    setPersistConnection(true);
    setTestStatus('idle');
    setTestError('');
    setShowConnectionModal(true);
  }

  async function handleTestConnection() {
    try {
      setTestStatus('testing');
      setTestError('');
      await api.testConnection(draft);
      setTestStatus('success');
    } catch (err) {
      setTestStatus('fail');
      setTestError(errorMessage(err));
    }
  }

  async function handleConnect() {
    try {
      setLoading(draft.id ? 'Updating saved connection...' : 'Opening database connection...');
      setError(null);
      const next = await api.connect(draft, persistConnection);
      setSnapshot(next);
      setShowConnectionModal(false);
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(errorMessage(err));
    }
  }

  async function handleActivate(connection: SafeSavedConnection) {
    try {
      setLoading(`Connecting to ${connection.host}...`);
      setError(null);
      const next = await api.activateSavedConnection(connection.id);
      setSnapshot(next);
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(errorMessage(err));
    }
  }

  async function handleDeleteConnection(connection: SafeSavedConnection) {
    try {
      setLoading(`Removing ${connection.name || connection.host}...`);
      setError(null);
      setSnapshot(await api.deleteSavedConnection(connection.id));
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(errorMessage(err));
    }
  }

  async function handleDisconnect() {
    try {
      setLoading('Closing connection...');
      setError(null);
      setSnapshot(await api.disconnect());
      setOpenMenu(null);
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(errorMessage(err));
    }
  }

  async function handleRunQuery(sqlOverride?: string) {
    const sql = (sqlOverride ?? sqlEditorText).trim();
    if (!sql) return;

    try {
      setLoading('Running SQL...');
      setError(null);
      const nextResult = await api.runQuery(sql, 500);
      const title = summarizeSql(sql);

      const existingQueryTab = editorTabs.find((tab) => tab.kind === 'query');
      if (existingQueryTab) {
        setEditorTabs((current) =>
          current.map((tab) =>
            tab.id === existingQueryTab.id
              ? { ...tab, sql, result: nextResult, title, sortState: null, currentPage: 0 }
              : tab,
          ),
        );
        setActiveEditorTabId(existingQueryTab.id);
      } else {
        const id = makeTabId('query');
        setEditorTabs((current) => [
          ...current,
          { id, kind: 'query', title, sql, result: nextResult, sortState: null, currentPage: 0 },
        ]);
        setActiveEditorTabId(id);
      }

      setOpenMenu(null);
      setQueryHistory((current) => [
        {
          id: crypto.randomUUID(),
          title,
          sql,
          resultMeta: formatDuration(nextResult.executionTimeMs),
        },
        ...current,
      ].slice(0, 12));
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(errorMessage(err));
    }
  }

  async function handleSaveAs() {
    const text = sqlEditorText.trim();
    if (!text) return;
    try {
      const path = await api.showSaveDialog({
        defaultPath: 'query.sql',
        filters: [{ name: 'SQL Files', extensions: ['sql'] }],
      });
      if (path) {
        await api.writeFile(path, text);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handlePreviewTable(schema: string, table: string) {
    try {
      setLoading(`Loading ${schema}.${table}...`);
      setError(null);
      const nextResult = await api.previewTable(schema, table, 200, 0);
      const sql = `select *\nfrom ${schema}.${table}\nlimit 200;`;
      openOrActivateTableTab(schema, table, sql, nextResult);
      clearResultView();
      setQueryHistory((current) => [
        {
          id: crypto.randomUUID(),
          title: `${schema}.${table}`,
          sql,
          resultMeta: formatDuration(nextResult.executionTimeMs),
        },
        ...current,
      ].slice(0, 12));
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(errorMessage(err));
    }
  }

  async function handleExportTable(schema: string, table: string) {
    try {
      setLoading(`Exporting ${schema}.${table}...`);
      setError(null);
      const result = await api.previewTable(schema, table, 10000, 0);
      const header = result.columns;
      const csv = [header, ...result.rows]
        .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
        .join('\n');
      const path = await api.showSaveDialog({
        defaultPath: `${schema}.${table}.csv`,
        filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      });
      if (path) {
        await api.writeFile(path, csv);
      }
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(errorMessage(err));
    }
  }

  async function handleExportParquet(schema: string, table: string) {
    try {
      const path = await api.showSaveDialog({
        defaultPath: `${schema}.${table}.parquet`,
        filters: [{ name: 'Parquet Files', extensions: ['parquet'] }],
      });
      if (!path) return;
      setLoading(`Exporting ${schema}.${table} to Parquet...`);
      setError(null);
      const rowCount = await api.exportParquet(schema, table, path);
      setLoading(`Exported ${rowCount} rows to Parquet.`);
      setTimeout(() => setLoading(''), 3000);
    } catch (err) {
      setLoading('');
      setError(errorMessage(err));
    }
  }

  async function handleShowDdl(schema: string, table: string) {
    try {
      setLoading(`Loading DDL for ${schema}.${table}...`);
      setError(null);
      const result = await api.getTableDdl(schema, table);

      const existing = editorTabs.find((tab) => tab.kind === 'ddl' && tab.source?.schema === schema && tab.source?.table === table);
      if (existing) {
        setEditorTabs((current) =>
          current.map((tab) =>
            tab.id === existing.id
              ? { ...tab, ddlText: result.ddl, title: `${table} DDL` }
              : tab,
          ),
        );
        setActiveEditorTabId(existing.id);
      } else {
        const id = makeTabId('ddl');
        setEditorTabs((current) => [
          ...current,
          {
            id,
            kind: 'ddl',
            title: `${table} DDL`,
            sql: '',
            source: { schema, table },
            result: null,
            sortState: null,
            currentPage: 0,
            ddlText: result.ddl,
          },
        ]);
        setActiveEditorTabId(id);
      }
      setLoading('');
    } catch (err) {
      setLoading('');
      setError(errorMessage(err));
    }
  }

  return (
    <main className="h-screen bg-transparent text-[13px] text-black" onClick={() => { if (openMenu) setOpenMenu(null); setContextMenu(null); setConnectionContextMenu(null); }}>
      <div className="flex h-screen flex-col overflow-hidden">
        <header className="relative m-1.5 mb-0 shrink-0 overflow-hidden rounded-lg border border-white/20 bg-[#0f1a2e]/90 backdrop-blur-md">
          <div className="flex h-7 items-center justify-between px-3">
            <div className="flex min-w-0 items-center gap-4" onClick={(event) => event.stopPropagation()}>
              <div className="rounded-md bg-[var(--accent)] px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.14em] text-white">
                rdb3
              </div>
              <div className="flex items-center gap-1 text-[12px] text-[var(--muted)]">
                <MenuButton active={openMenu === 'file'} label="File" onClick={() => setOpenMenu((current) => (current === 'file' ? null : 'file'))} />
                <MenuButton active={false} label="SQL Editor" onClick={() => { openSqlEditor(); setOpenMenu(null); }} />
                <MenuButton active={openMenu === 'view'} label="View" onClick={() => setOpenMenu((current) => (current === 'view' ? null : 'view'))} />
              </div>
            </div>

            <div className="truncate text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]">
              {snapshot?.activeConnection ? snapshot.activeConnection.database : 'No active database'}
            </div>
          </div>

          <div className="flex items-center gap-1 bg-[#1e3a5f]/80 px-3 py-0.5 text-[var(--muted)]">
            <ToolbarIconButton onClick={openNewConnectionModal} title="New connection"><PlusIcon /></ToolbarIconButton>
            <ToolbarIconButton onClick={() => openNewQueryTab()} title="New query"><QueryIcon /></ToolbarIconButton>
            <ToolbarIconButton onClick={() => openSqlEditor()} title="Open SQL editor"><PanelIcon /></ToolbarIconButton>
            <ToolbarIconButton onClick={() => void refresh()} title="Refresh"><RefreshIcon /></ToolbarIconButton>
            <ToolbarIconButton onClick={() => { exportCurrentResult(); }} title="Export CSV"><ExportIcon /></ToolbarIconButton>
          </div>

          {openMenu ? (
            <div className="absolute left-16 top-7 z-10 min-w-[220px] rounded-xl border border-white/20 bg-[#252526]/90 shadow-[0_8px_24px_rgba(0,0,0,0.3)] backdrop-blur-xl" onClick={(event) => event.stopPropagation()}>
              {openMenu === 'file' ? (
                <MenuPanel>
                  <MenuItem label="Exit" onClick={() => void handleExit()} />
                </MenuPanel>
              ) : null}
              {openMenu === 'view' ? (
                <MenuPanel>
                  <MenuItem label="Clear Results" onClick={() => { clearResultView(); setOpenMenu(null); }} />
                  <MenuItem label="Export CSV" onClick={() => { exportCurrentResult(); setOpenMenu(null); }} />
                </MenuPanel>
              ) : null}
            </div>
          ) : null}
        </header>

        <div className="flex flex-1 gap-1.5 overflow-hidden px-1.5 pb-0 pt-1.5">
          <aside className="flex min-h-0 shrink-0 flex-col gap-1.5 text-[12px]" style={{ width: sidebarWidth }}>
            <div className="glass-panel flex shrink-0 flex-col overflow-hidden rounded-xl" style={{ height: connectionsHeight }}>
              <div className="flex h-7 items-center justify-between border-b border-black/5 px-3">
                <div className="text-[13px] font-medium text-black">Connections</div>
                <ToolbarIconButton onClick={openNewConnectionModal} title="New connection"><PlusIcon /></ToolbarIconButton>
              </div>
              <div className="sidebar-scroll flex-1 overflow-y-scroll rounded-b-xl bg-white px-2 py-2">
                {snapshot?.savedConnections.length ? (
                  <div>
                    {snapshot.savedConnections.map((connection) => {
                      const active = snapshot.activeConnection?.id === connection.id;
                      return (
                        <div className="group flex items-center gap-2 px-1 py-1" key={connection.id} onContextMenu={(event) => { event.preventDefault(); setConnectionContextMenu({ x: event.clientX, y: event.clientY, connection }); }}>
                          <ExplorerIcon><ConnectionIcon active={active} /></ExplorerIcon>
                          <button className="min-w-0 flex-1 truncate text-left text-black" onClick={() => void handleActivate(connection)} type="button">
                            {`${connection.database}@${connection.host}`}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyInline message="No saved connections" />
                )}
              </div>
            </div>

            <div className="h-px shrink-0 cursor-row-resize bg-black/10 hover:bg-[var(--accent)]" onPointerDown={(event) => { event.stopPropagation(); setDragState('connections'); }} />

            <div className="glass-panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
              <div className="flex h-7 items-center justify-between border-b border-black/5 px-3">
                <div className="text-[13px] font-medium text-black">Explorer</div>
                <div className="flex items-center gap-1 text-gray-500">
                  <ToolbarIconButton onClick={() => void refresh()} title="Refresh"><RefreshIcon /></ToolbarIconButton>
                  <ToolbarIconButton onClick={() => openSqlEditor()} title="Open SQL editor"><PanelIcon /></ToolbarIconButton>
                </div>
              </div>
              <div className="sidebar-scroll min-h-0 flex-1 overflow-y-scroll rounded-b-xl bg-white px-2 py-2">
                {snapshot?.activeConnection ? (
                  <DatabaseTree
                    connection={snapshot.activeConnection}
                    tree={databaseTree}
                    onPreview={handlePreviewTable}
                    onTableContextMenu={(event, schema, table) => {
                      event.preventDefault();
                      setContextMenu({ x: event.clientX, y: event.clientY, schema, table });
                    }}
                  />
                ) : (
                  <EmptyInline message="Connect to browse schema" />
                )}
              </div>
            </div>
          </aside>

          <div className="w-px shrink-0 cursor-col-resize bg-black/10 hover:bg-[var(--accent)]" onPointerDown={(event) => { event.stopPropagation(); setDragState('sidebar'); }} />

          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="glass-panel flex shrink-0 flex-col overflow-hidden rounded-xl" style={{ height: connectionsHeight }}>
              <div className="flex h-7 items-center justify-between border-b border-black/5 px-3">
                <div className="text-[13px] font-medium text-black">Dashboard</div>
              </div>
              <div className="flex flex-1 gap-3 overflow-hidden rounded-b-xl bg-white px-3 py-3">
                <div className="flex w-1/2 shrink-0 gap-2 overflow-hidden">
                  <DashboardGraphCard label={"Server\nCPU"} value={hostStats?.cpuUsagePercent != null ? `${hostStats.cpuUsagePercent}%` : '—'} data={cpuHistory} max={100} color="#3b82f6" warnColor="#ef4444" warn={hostStats?.cpuUsagePercent != null && hostStats.cpuUsagePercent > 80} />
                  <DashboardGraphCard label={"Server\nRAM"} value={hostStats?.memUsagePercent != null ? `${hostStats.memUsagePercent}%` : '—'} subtitle={hostStats?.memUsedMb != null ? `${hostStats.memUsedMb}/${hostStats.memTotalMb} MB` : undefined} data={ramHistory} max={100} color="#8b5cf6" warnColor="#ef4444" warn={hostStats?.memUsagePercent != null && hostStats.memUsagePercent > 80} />
                  <DashboardGraphCard label={"Cache\nHit"} value={hostStats?.cacheHitRatio != null ? `${hostStats.cacheHitRatio}%` : '—'} data={cacheHitHistory} max={100} color="#06b6d4" />
                  <DashboardGraphCard label="TXN Throughput" value={hostStats?.tps != null ? `${hostStats.tps} tps` : '—'} data={tpsHistory} color="#f59e0b" />
                  <DashboardGraphCard label="Conn Saturation" value={hostStats?.connectionSaturationPercent != null ? `${hostStats.connectionSaturationPercent}%` : '—'} subtitle={hostStats?.activeConnections != null ? `${hostStats.activeConnections}/${hostStats.maxConnections}` : undefined} data={saturationHistory} max={100} color="#10b981" warnColor="#ef4444" warn={hostStats?.connectionSaturationPercent != null && hostStats.connectionSaturationPercent > 80} />
                </div>
                <div className="flex w-1/2 flex-col overflow-hidden rounded-lg border border-black/5">
                  <div className="flex h-7 shrink-0 items-center border-b border-black/5 bg-gray-50 px-3">
                    <span className="text-[12px] font-medium text-gray-600">Query History</span>
                    <span className="ml-auto text-[11px] text-gray-400">{queryHistory.length} queries</span>
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {queryHistory.length === 0 ? (
                      <div className="flex h-full items-center justify-center text-[12px] text-gray-400">No queries yet</div>
                    ) : (
                      <table className="w-full text-[11px]">
                        <tbody>
                          {queryHistory.map((entry) => (
                            <tr key={entry.id} className="group relative border-b border-black/5 hover:bg-gray-50">
                              <td className="w-full px-2 py-1 font-mono text-gray-700">
                                <div className="truncate">{entry.sql}</div>
                                <div className="pointer-events-none absolute left-2 top-full z-50 hidden max-h-[200px] max-w-[500px] overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-black/10 bg-white px-3 py-2 font-mono text-[11px] text-gray-800 shadow-lg group-hover:block">{entry.sql}</div>
                              </td>
                              <td className="whitespace-nowrap px-2 py-1 text-right align-top tabular-nums text-gray-500">{entry.resultMeta}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="h-px shrink-0 cursor-row-resize bg-black/10 hover:bg-[var(--accent)]" />

            {showSqlEditor ? (
              <div className="glass-panel flex h-[38%] shrink-0 flex-col overflow-hidden rounded-xl">
                <div className="flex h-7 items-center justify-between border-b border-black/5 px-3">
                  <div className="text-[13px] font-medium text-black">SQL Editor</div>
                  <button className="px-1 py-0.5 text-[12px] leading-tight text-gray-500 hover:text-black" onClick={() => { setShowSqlEditor(false); setSqlTabs([]); setActiveSqlTabId(null); setEditorTabs([]); setActiveEditorTabId(''); }} type="button">Close</button>
                </div>
                <div className="flex items-center border-b border-black/5 bg-white px-1 pt-1">
                  <div className="flex min-w-0 flex-1 overflow-auto">
                    {sqlTabs.map((tab) => (
                      <button
                        className={classNames(
                          'group flex min-w-[100px] max-w-[200px] items-center gap-2 border-r border-black/5 px-3 py-1.5 text-left rounded-t-lg',
                          tab.id === activeSqlTab?.id ? 'bg-white text-black' : 'bg-gray-50 text-gray-400',
                        )}
                        key={tab.id}
                        onClick={() => setActiveSqlTabId(tab.id)}
                        type="button"
                      >
                        <span className="text-[11px] text-gray-500"><QueryIcon /></span>
                        <span className="truncate text-[12px]">{tab.title}</span>
                        <span
                          role="button"
                          tabIndex={-1}
                          className="ml-auto shrink-0 cursor-pointer px-1 text-gray-500 hover:text-black"
                          onPointerDown={(event) => { event.stopPropagation(); event.preventDefault(); closeSqlTab(tab.id); }}
                        >
                          x
                        </span>
                      </button>
                    ))}
                    <button className="px-2 py-1 text-[18px] font-bold text-gray-400 hover:text-black" onClick={addSqlTab} type="button" title="New tab">+</button>
                  </div>
                </div>
                <div className="flex min-h-0 flex-1 rounded-b-xl bg-white">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center gap-3 border-b border-black/5 px-2 py-1">
                      <button className="rounded-lg bg-[var(--accent)] px-3 py-0.5 text-[12px] leading-tight text-white hover:opacity-90" onClick={() => void handleRunQuery(sqlEditorText)} type="button">Run</button>
                      <button className="px-1 py-0.5 text-[12px] leading-tight text-gray-500 hover:text-black" onClick={() => void handleSaveAs()} type="button">Save As</button>
                    </div>
                    <SqlEditor
                      value={sqlEditorText}
                      onChange={setSqlEditorText}
                      onRun={(text) => void handleRunQuery(text)}
                    />
                  </div>
                  <div className="flex w-[270px] shrink-0 flex-col gap-1 overflow-y-auto border-l border-black/5 px-2 py-1">
                    <span className="text-[12px] font-medium text-gray-500">History</span>
                    {queryHistory.map((entry) => (
                      <button
                        key={entry.id}
                        className="rounded-lg bg-white/40 px-2 py-1 text-left text-[12px] text-gray-600 hover:bg-white/60 hover:text-black"
                        onClick={() => setSqlEditorText(entry.sql)}
                        title={entry.sql}
                        type="button"
                      >
                        <div className="line-clamp-2 break-all">{entry.sql}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            <div className="glass-panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
              <div className="flex h-7 items-center justify-between border-b border-black/5 px-3">
                <div className="text-[13px] font-medium text-black">
                  {activeEditorTab?.kind === 'table' && activeEditorTab.source ? `Data - ${activeEditorTab.source.schema}.${activeEditorTab.source.table}` : 'Data'}
                </div>
              </div>
              <div className="flex items-center border-b border-black/5 bg-white px-1 pt-1">
                <div className="flex min-w-0 flex-1 overflow-auto">
                  {editorTabs.map((tab) => (
                    <button
                      className={classNames(
                        'group flex min-w-[160px] max-w-[360px] items-center gap-2 border-r border-black/5 px-3 py-1.5 text-left rounded-t-lg',
                        tab.id === activeEditorTab?.id ? 'bg-white text-black' : 'bg-gray-50 text-gray-400',
                      )}
                      key={tab.id}
                      onClick={() => setActiveEditorTabId(tab.id)}
                      type="button"
                    >
                      <span className="text-[11px] text-gray-500">
                        {tab.kind === 'table' ? <TableIcon /> : tab.kind === 'ddl' ? <DdlIcon /> : <QueryIcon />}
                      </span>
                      <span className="truncate font-sans text-[12px]">
                        {tab.title}
                      </span>
                      <span
                        className="ml-auto shrink-0 text-gray-500 hover:text-black"
                        onClick={(event) => {
                          event.stopPropagation();
                          closeEditorTab(tab.id);
                        }}
                      >
                        x
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col rounded-b-xl bg-white">
                {activeEditorTab?.kind === 'ddl' && activeEditorTab.ddlText ? (
                  <div className="min-h-0 flex-1 overflow-auto p-4">
                    <pre className="font-mono text-[13px] leading-relaxed text-black whitespace-pre">{activeEditorTab.ddlText}</pre>
                  </div>
                ) : processedResult ? (
                  <>
                    <div className="min-h-0 flex-1 overflow-scroll">
                      <ResultsTable
                        result={processedResult}
                        sortState={activeEditorTab?.sortState ?? null}
                        onSort={toggleSort}
                        rowOffset={processedResult.pageStart}
                      />
                    </div>
                    <div className="flex shrink-0 items-center justify-center gap-2 border-t border-black/5 bg-white/30 px-3 py-1.5 text-[14px] text-gray-600">
                      <button className="px-1 py-0.5 text-[16px] font-extrabold hover:text-black disabled:opacity-30" disabled={processedResult.currentPage === 0} onClick={() => updateActiveTab({ currentPage: 0 })} type="button">{'<<'}</button>
                      <button className="px-1 py-0.5 text-[16px] font-extrabold hover:text-black disabled:opacity-30" disabled={processedResult.currentPage === 0} onClick={() => updateActiveTab({ currentPage: processedResult.currentPage - 1 })} type="button">{'<'}</button>
                      <span>{processedResult.rowCount > 0 ? `${(processedResult.pageStart + 1).toLocaleString()}-${Math.min(processedResult.pageStart + PAGE_SIZE, processedResult.rowCount).toLocaleString()}` : '0'} of {processedResult.rowCount.toLocaleString()}</span>
                      <button className="px-1 py-0.5 text-[16px] font-extrabold hover:text-black disabled:opacity-30" disabled={processedResult.currentPage >= processedResult.totalPages - 1} onClick={() => updateActiveTab({ currentPage: processedResult.currentPage + 1 })} type="button">{'>'}</button>
                      <button className="px-1 py-0.5 text-[16px] font-extrabold hover:text-black disabled:opacity-30" disabled={processedResult.currentPage >= processedResult.totalPages - 1} onClick={() => updateActiveTab({ currentPage: processedResult.totalPages - 1 })} type="button">{'>>'}</button>
                    </div>
                  </>
                ) : (
                  <div className="min-h-0 flex-1 overflow-auto p-2">
                    <WorkspaceEmpty title="No results" body="Run a query or click a table from the explorer." />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <footer className="flex h-6 items-center justify-between gap-3 border-t border-white/20 bg-white/40 px-3 text-[11px] text-gray-500 backdrop-blur-md">
          <div className="truncate">{loading || error || (snapshot?.activeConnection ? `Connected as ${snapshot.activeConnection.user}` : 'Waiting for a database connection.')}</div>
          <div>{error ? 'error' : snapshot?.activeConnection ? 'online' : 'offline'}</div>
        </footer>
      </div>

      {contextMenu ? (
        <div
          className="fixed inset-0 z-30"
          onClick={() => setContextMenu(null)}
          onContextMenu={(event) => { event.preventDefault(); setContextMenu(null); }}
        >
          <div
            className="glass-panel-strong absolute min-w-[180px] rounded-xl py-1 shadow-lg"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-black hover:bg-white/40"
              onClick={() => {
                const { schema, table } = contextMenu;
                setContextMenu(null);
                void handleShowDdl(schema, table);
              }}
              type="button"
            >
              <span className="text-gray-500"><QueryIcon /></span>
              Show DDL
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-black hover:bg-white/40"
              onClick={() => {
                const { schema, table } = contextMenu;
                setContextMenu(null);
                void handleExportTable(schema, table);
              }}
              type="button"
            >
              <span className="text-gray-500"><ExportIcon /></span>
              Export CSV
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-black hover:bg-white/40"
              onClick={() => {
                const { schema, table } = contextMenu;
                setContextMenu(null);
                void handleExportParquet(schema, table);
              }}
              type="button"
            >
              <span className="text-gray-500"><ExportIcon /></span>
              Export Parquet
            </button>
          </div>
        </div>
      ) : null}

      {connectionContextMenu ? (
        <div
          className="fixed inset-0 z-30"
          onClick={() => setConnectionContextMenu(null)}
          onContextMenu={(event) => { event.preventDefault(); setConnectionContextMenu(null); }}
        >
          <div
            className="glass-panel-strong absolute min-w-[160px] rounded-xl py-1 shadow-lg"
            style={{ left: connectionContextMenu.x, top: connectionContextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-black hover:bg-white/40"
              onClick={() => {
                const conn = connectionContextMenu.connection;
                setConnectionContextMenu(null);
                openEditConnectionModal(conn);
              }}
              type="button"
            >
              Edit
            </button>
            <button
              className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-black hover:bg-white/40"
              onClick={() => {
                const conn = connectionContextMenu.connection;
                setConnectionContextMenu(null);
                setConfirmDialog({
                  message: `Disconnect from ${conn.database}@${conn.host}?`,
                  onConfirm: () => { setConfirmDialog(null); void handleDisconnect(); },
                });
              }}
              type="button"
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : null}

      {confirmDialog ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/20 backdrop-blur-sm p-4">
          <div className="glass-panel-strong w-full max-w-xs rounded-2xl shadow-xl">
            <div className="px-5 py-4 text-[13px] text-black">{confirmDialog.message}</div>
            <div className="flex justify-end gap-2 border-t border-black/5 px-5 py-3">
              <button className="rounded-lg px-3 py-1 text-[12px] text-gray-500 hover:text-black" onClick={confirmDialog.onConfirm} type="button">Yes</button>
              <button autoFocus className="rounded-lg bg-[var(--accent)] px-3 py-1 text-[12px] text-white hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30" onClick={() => setConfirmDialog(null)} type="button">No</button>
            </div>
          </div>
        </div>
      ) : null}

      {showConnectionModal ? (
        <div className="fixed inset-0 z-20 grid place-items-center bg-black/20 backdrop-blur-sm p-4">
          <div className="glass-panel-strong w-full max-w-sm rounded-2xl shadow-xl">
            <div className="border-b border-black/5 px-5 py-3">
              <div className="text-[13px] font-medium text-black">{draft.id ? 'Edit connection' : 'New connection'}</div>
            </div>
            <div className="flex flex-col gap-4 p-5">
              <div className="grid grid-cols-[1fr_120px] gap-4">
                <Field label="Host"><input className="input" value={draft.host} onChange={(event) => setDraft((current) => ({ ...current, host: event.target.value }))} /></Field>
                <Field label="Port"><input className="input" inputMode="numeric" value={String(draft.port)} onChange={(event) => setDraft((current) => ({ ...current, port: Number.parseInt(event.target.value || '5432', 10) }))} /></Field>
              </div>
              <Field label="Authentication">
                <select className="input text-gray-400" disabled>
                  <option>User &amp; Password</option>
                </select>
              </Field>
              <Field label="User"><input className="input" value={draft.user} onChange={(event) => setDraft((current) => ({ ...current, user: event.target.value }))} /></Field>
              <div className="grid grid-cols-[1fr_160px] gap-4">
                <Field label="Password"><input className="input" type="password" value={draft.password} onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))} /></Field>
                <Field label="Save">
                  <select className="input text-gray-400" disabled>
                    <option>Forever</option>
                  </select>
                </Field>
              </div>
              <Field label="Database"><input className="input" value={draft.database} onChange={(event) => setDraft((current) => ({ ...current, database: event.target.value }))} /></Field>
              <Field label="URL">
                <div className="input bg-gray-50 text-gray-400">{`postgresql://${draft.user}@${draft.host}:${draft.port}/${draft.database}`}</div>
              </Field>
            </div>
            {testStatus === 'success' ? (
              <div className="mx-5 rounded-lg bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700">Connection successful</div>
            ) : testStatus === 'fail' ? (
              <div className="mx-5 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-600">{testError || 'Connection failed'}</div>
            ) : null}
            <div className="flex items-center justify-between border-t border-black/5 px-5 py-3">
              <button className="rounded-lg border border-black/10 px-3 py-1.5 text-[12px] text-gray-500 hover:text-black" onClick={() => void handleTestConnection()} disabled={testStatus === 'testing'} type="button">{testStatus === 'testing' ? 'Testing...' : 'Test Connection'}</button>
              <div className="flex items-center gap-2">
                <button className="rounded-lg border border-black/10 px-3 py-1.5 text-[12px] text-gray-500 hover:text-black" onClick={() => setShowConnectionModal(false)} type="button">Cancel</button>
                <button className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[12px] text-white hover:opacity-90" onClick={() => void handleConnect()} type="button">{draft.id ? 'Save' : 'Connect'}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function MenuButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className={classNames(
        'rounded-md px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-white/10 hover:text-[var(--text)]',
        active && 'bg-white/10 text-[var(--text)]',
      )}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function MenuPanel({ children }: PropsWithChildren) {
  return <div className="py-1 text-[12px] text-[var(--text)]">{children}</div>;
}

function MenuItem({ label, shortcut, onClick }: { label: string; shortcut?: string; onClick: () => void }) {
  return (
    <button
      className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[var(--text)] hover:bg-[var(--selection)]"
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
      {shortcut ? <span className="ml-6 text-[11px] text-[var(--muted)]">{shortcut}</span> : null}
    </button>
  );
}

function ToolbarIconButton({ children, onClick, title }: PropsWithChildren<{ onClick: () => void; title: string }>) {
  return (
    <button className="grid h-6 w-6 place-items-center rounded-md border border-transparent text-[12px] text-[var(--muted)] hover:border-white/20 hover:bg-white/10" onClick={onClick} title={title} type="button">
      {children}
    </button>
  );
}

function ExplorerIcon({ children }: PropsWithChildren) {
  return <span className="grid w-4 shrink-0 place-items-center text-gray-500">{children}</span>;
}

function Field({ label, children }: PropsWithChildren<{ label: string }>) {
  return (
    <label className="block text-[12px] text-gray-500">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-black">{label}</div>
      {children}
    </label>
  );
}

function Sparkline({ data, max, color, warnColor, warn, width = 120, height = 32 }: { data: number[]; max?: number; color: string; warnColor?: string; warn?: boolean; width?: number; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [actualWidth, setActualWidth] = useState(width);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setActualWidth(entry.contentRect.width);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const strokeColor = warn && warnColor ? warnColor : color;
  const fillColor = warn && warnColor ? warnColor : color;
  const gradId = `sg-${color.replace('#', '')}-${warn ? 'w' : 'n'}`;

  return (
    <div ref={containerRef} style={{ height }} className="w-full shrink-0">
      <svg width={actualWidth} height={height}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={fillColor} stopOpacity="0.25" />
            <stop offset="100%" stopColor={fillColor} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {data.length >= 2 ? (() => {
          const ceiling = max ?? Math.max(...data, 1);
          const step = actualWidth / (data.length - 1);
          const points = data.map((v, i) => `${i * step},${height - (v / ceiling) * height}`).join(' ');
          const fillPoints = `0,${height} ${points} ${(data.length - 1) * step},${height}`;
          return (
            <>
              <polygon points={fillPoints} fill={`url(#${gradId})`} />
              <polyline points={points} fill="none" stroke={strokeColor} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
            </>
          );
        })() : (
          <line x1="0" y1={height - 1} x2={actualWidth} y2={height - 1} stroke={color} strokeWidth="1" strokeOpacity="0.2" />
        )}
      </svg>
    </div>
  );
}

function DashboardGraphCard({ label, value, subtitle, data, max, color, warnColor, warn }: { label: string; value: string; subtitle?: string; data: number[]; max?: number; color: string; warnColor?: string; warn?: boolean }) {
  return (
    <div className="flex min-w-[140px] flex-1 flex-col gap-1 rounded-lg border border-gray-200 bg-white/40 px-3 py-2">
      <div className="flex items-baseline justify-between">
        <div className="whitespace-pre-line text-[10px] font-medium uppercase leading-tight tracking-[0.08em] text-gray-500">{label}</div>
        <div className={classNames('text-[16px] font-bold tabular-nums', warn ? 'text-red-500' : 'text-black')}>{value}</div>
      </div>
      <Sparkline data={data} max={max} color={color} warnColor={warnColor} warn={warn} height={36} />
      {subtitle ? <div className="text-[9px] text-gray-400">{subtitle}</div> : null}
    </div>
  );
}

function DashboardCard({ label, value, accent, warn }: { label: string; value: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className="flex min-w-[90px] flex-1 flex-col justify-center rounded-lg border border-gray-200 bg-white/40 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-gray-500">{label}</div>
      <div className={classNames('mt-0.5 truncate text-[14px] font-semibold', warn ? 'text-red-500' : accent ? 'text-emerald-600' : 'text-black')}>{value}</div>
    </div>
  );
}

function EmptyInline({ message }: { message: string }) {
  return <div className="px-1 py-1 text-gray-500">{message}</div>;
}

function WorkspaceEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid min-h-[240px] place-items-center rounded-xl border border-dashed border-black/10 bg-white/20 p-5 text-center">
      <div>
        <div className="text-sm text-black">{title}</div>
        <div className="mt-1 text-sm text-gray-500">{body}</div>
      </div>
    </div>
  );
}

function TableTreeNode({ schema, table, onPreview, onContextMenu }: { schema: string; table: TableNode; onPreview: (schema: string, table: string) => Promise<void>; onContextMenu: (event: React.MouseEvent, schema: string, table: string) => void }) {
  const [open, setOpen] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

  const toggleSection = (section: string) => {
    setOpenSections((c) => ({ ...c, [section]: !c[section] }));
  };

  return (
    <div>
      <div
        className="flex cursor-grab items-center gap-1 pl-14 pr-2"
        draggable
        onDragStart={(event) => { event.dataTransfer.setData('text/plain', `${schema}.${table.name}`); event.dataTransfer.effectAllowed = 'copy'; }}
        onContextMenu={(event) => onContextMenu(event, schema, table.name)}
      >
        <button className="w-4 shrink-0 text-center text-[10px] text-gray-400" onClick={() => setOpen((c) => !c)} type="button">
          {open ? '\u25BE' : '\u25B8'}
        </button>
        <ExplorerIcon><TableIcon /></ExplorerIcon>
        <button className="flex-1 truncate py-0.5 text-left text-black hover:bg-white/40" onClick={() => void onPreview(schema, table.name)} type="button">
          {table.name}
        </button>
      </div>
      {open ? (
        <div className="pl-[72px]">
          {/* Columns */}
          <button className="flex w-full items-center gap-1 py-0.5 text-left text-[11px] text-gray-500 hover:text-black" onClick={() => toggleSection('columns')} type="button">
            <span className="w-3 text-center text-[9px] text-gray-400">{openSections.columns ? '\u25BE' : '\u25B8'}</span>
            <span>Columns</span>
            <span className="text-gray-400">({table.columns.length})</span>
          </button>
          {openSections.columns ? (
            <div className="pl-4">
              {table.columns.map((col) => (
                <div key={col.name} className="flex items-center gap-2 py-[1px] text-[11px]">
                  <span className="text-gray-400">&#9702;</span>
                  <span className="text-black">{col.name}</span>
                  <span className="text-gray-400">{col.dataType}</span>
                  {!col.nullable && <span className="text-[9px] text-red-400">NN</span>}
                </div>
              ))}
            </div>
          ) : null}

          {/* Keys */}
          <button className="flex w-full items-center gap-1 py-0.5 text-left text-[11px] text-gray-500 hover:text-black" onClick={() => toggleSection('keys')} type="button">
            <span className="w-3 text-center text-[9px] text-gray-400">{openSections.keys ? '\u25BE' : '\u25B8'}</span>
            <span>Keys</span>
            <span className="text-gray-400">({table.keys.length})</span>
          </button>
          {openSections.keys ? (
            <div className="pl-4">
              {table.keys.length > 0 ? table.keys.map((k) => (
                <div key={k.name} className="flex items-center gap-2 py-[1px] text-[11px]">
                  <span className={k.type === 'PRIMARY KEY' ? 'text-amber-500' : k.type === 'FOREIGN KEY' ? 'text-blue-500' : 'text-gray-400'}>&#9670;</span>
                  <span className="text-black">{k.name}</span>
                  <span className="text-gray-400">{k.columns.join(', ')}</span>
                  {k.referencedTable && <span className="text-[9px] text-blue-400">&rarr; {k.referencedTable}</span>}
                </div>
              )) : (
                <div className="py-[1px] text-[11px] text-gray-400">None</div>
              )}
            </div>
          ) : null}

          {/* Indexes */}
          <button className="flex w-full items-center gap-1 py-0.5 text-left text-[11px] text-gray-500 hover:text-black" onClick={() => toggleSection('indexes')} type="button">
            <span className="w-3 text-center text-[9px] text-gray-400">{openSections.indexes ? '\u25BE' : '\u25B8'}</span>
            <span>Indexes</span>
            <span className="text-gray-400">({table.indexes.length})</span>
          </button>
          {openSections.indexes ? (
            <div className="pl-4">
              {table.indexes.length > 0 ? table.indexes.map((idx) => (
                <div key={idx.name} className="flex items-center gap-2 py-[1px] text-[11px]">
                  <span className="text-gray-400">&#9656;</span>
                  <span className="text-black">{idx.name}</span>
                  <span className="text-gray-400">{idx.columns.join(', ')}</span>
                  {idx.isUnique && <span className="text-[9px] text-amber-500">UQ</span>}
                </div>
              )) : (
                <div className="py-[1px] text-[11px] text-gray-400">None</div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DatabaseTree({ connection, tree, onPreview, onTableContextMenu }: { connection: ActiveConnectionSummary; tree: SchemaNode[]; onPreview: (schema: string, table: string) => Promise<void>; onTableContextMenu: (event: React.MouseEvent, schema: string, table: string) => void; }) {
  const [dbOpen, setDbOpen] = useState(true);
  const [openSchemas, setOpenSchemas] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setOpenSchemas((current) => {
      const next = { ...current };
      for (const schema of tree) {
        if (!(schema.name in next)) {
          next[schema.name] = true;
        }
      }
      return next;
    });
  }, [tree]);

  return (
    <div className="overflow-auto">
      <button className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-white/40" onClick={() => setDbOpen((c) => !c)} type="button">
        <span className="w-4 shrink-0 text-center text-gray-500">{dbOpen ? '\u25BE' : '\u25B8'}</span>
        <ExplorerIcon><DatabaseIcon /></ExplorerIcon>
        <span className="flex-1 truncate text-black">{connection.database}@{connection.host}</span>
      </button>
      {dbOpen ? (
        <div>
          {tree.map((schema) => {
            const schemaOpen = openSchemas[schema.name] ?? true;
            return (
              <div key={schema.name}>
                <button className="flex w-full items-center gap-2 py-1 pl-8 pr-2 text-left hover:bg-white/40" onClick={() => setOpenSchemas((current) => ({ ...current, [schema.name]: !schemaOpen }))} type="button">
                  <span className="w-4 shrink-0 text-center text-gray-500">{schemaOpen ? '\u25BE' : '\u25B8'}</span>
                  <ExplorerIcon><FolderIcon /></ExplorerIcon>
                  <span className="flex-1 truncate text-black">{schema.name}</span>
                  <span className="shrink-0 text-gray-500">{schema.tables.length}</span>
                </button>
                {schemaOpen ? (
                  <div>
                    {schema.tables.map((table) => (
                      <TableTreeNode
                        key={`${schema.name}.${table.name}`}
                        schema={schema.name}
                        table={table}
                        onPreview={onPreview}
                        onContextMenu={onTableContextMenu}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ResultsTable({
  result,
  sortState,
  onSort,
  rowOffset = 0,
}: {
  result: QueryResult;
  sortState: SortState;
  onSort: (columnIndex: number) => void;
  rowOffset?: number;
}) {
  return (
    <div className="bg-transparent">
      {result.notice ? <div className="border-b border-black/5 bg-blue-50/60 px-4 py-2 text-sm text-blue-700">{result.notice}</div> : null}
      <div>
        <table className="min-w-full border-collapse font-sans text-[12px]">
          <thead className="sticky top-0 z-[1] bg-white/60 backdrop-blur-sm text-left text-black">
            <tr>
              <th className="w-12 border-b border-r border-black/8 px-2 py-1 font-medium text-right">#</th>
              {result.columns.map((column, index) => (
                <th className="relative border-b border-r border-black/8 px-2 py-1 font-medium" key={column}>
                  <div className="flex items-center gap-1">
                    <button className="flex-1 text-left" onClick={() => onSort(index)} type="button">
                      {column}
                    </button>
                    <span className="shrink-0 text-gray-400"><FilterIcon /></span>
                    <button className="inline-flex shrink-0 flex-col items-center gap-0 leading-[1] text-[7px]" onClick={() => onSort(index)} type="button">
                      <span className={classNames('-mb-[4px]', sortState?.columnIndex === index && sortState.direction === 'asc' ? 'text-black' : 'text-white')} style={{ WebkitTextStroke: '0.5px #888' }}>&#9650;</span>
                      <span className={classNames('-mt-[4px]', sortState?.columnIndex === index && sortState.direction === 'desc' ? 'text-black' : 'text-white')} style={{ WebkitTextStroke: '0.5px #888' }}>&#9660;</span>
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIndex) => (
              <tr key={`${rowIndex}-${row.join('|')}`}>
                <td className="border-b border-r border-black/8 px-2 py-0.5 text-right text-gray-400">{rowOffset + rowIndex + 1}</td>
                {row.map((cell, cellIndex) => (
                  <td className="max-w-[400px] border-b border-r border-black/8 px-2 py-0.5 text-black" key={`${rowIndex}-${cellIndex}`}>
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap">{cell}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IconBase({ children }: { children: ReactNode }) { return <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 16 16">{children}</svg>; }
function PlusIcon() { return <IconBase><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></IconBase>; }
function RefreshIcon() { return <IconBase><path d="M13 5V2.5H10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /><path d="M13 2.5A5.5 5.5 0 1 0 14 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></IconBase>; }
function PanelIcon() { return <IconBase><path d="M2.5 3.5h11v9h-11z" stroke="currentColor" strokeWidth="1.2" /><path d="M6 3.5v9" stroke="currentColor" strokeWidth="1.2" /></IconBase>; }
function ConnectionIcon({ active }: { active: boolean }) { return <IconBase><circle cx="8" cy="8" r="4.6" stroke="currentColor" strokeWidth="1.2" /><circle cx="8" cy="8" r="2" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.1" /></IconBase>; }
function DatabaseIcon() { return <IconBase><ellipse cx="8" cy="4" rx="4.5" ry="2" stroke="currentColor" strokeWidth="1.2" /><path d="M3.5 4v6c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V4" stroke="currentColor" strokeWidth="1.2" /></IconBase>; }
function FolderIcon() { return <IconBase><path d="M2.5 5h4l1.2-1.5h5.8v8H2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></IconBase>; }
function TableIcon() { return <IconBase><rect x="2.5" y="3" width="11" height="10" stroke="currentColor" strokeWidth="1.2" /><path d="M2.5 6.5h11M2.5 10h11M6 3v10M9.8 3v10" stroke="currentColor" strokeWidth="1" /></IconBase>; }
function QueryIcon() { return <IconBase><path d="M4 4.5h8M4 8h8M4 11.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></IconBase>; }
function ExportIcon() { return <IconBase><path d="M8 2.5v7M5.5 7l2.5 2.5L10.5 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /><path d="M3 12.5h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></IconBase>; }
function FilterIcon() { return <IconBase><path d="M2.5 3.5h11L9 8.5v4l-2 1.5v-5.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></IconBase>; }
function DdlIcon() { return <IconBase><path d="M4 3h5.5L12 5.5V13H4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M9.5 3v2.5H12" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M6 8h4M6 10h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></IconBase>; }

function summarizeSql(sql: string) {
  const line = sql.trim().replace(/\s+/g, ' ').slice(0, 56);
  return line || 'Untitled query';
}
