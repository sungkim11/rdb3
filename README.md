# PostGrip

**The PostgreSQL client that gets out of your way.**

PostGrip is a fast, lightweight desktop client for PostgreSQL. Browse schemas, write queries, edit data, and monitor your server — all from a clean, modern interface that feels native on macOS, Windows, and Linux.

![PostGrip Screenshot](img/screenshot.png)

## Why PostGrip?

- **Zero config** — Reads your `~/.pgpass` automatically and offers one-click connections
- **Fast startup** — Opens in under a second, no splash screens or loading spinners
- **Built for daily use** — Schema explorer, SQL editor with autocomplete, inline data editing, and real-time server metrics in one window
- **SSH tunnel support** — Connect through bastion hosts with password or private key auth
- **Cross-platform** — Ships as a universal macOS DMG, Windows installer, and Linux AppImage/deb

## Features

### Connection Management
- Save, edit, and manage multiple PostgreSQL connections
- Auto-import connections from `~/.pgpass`
- Test connections before saving
- Quick-switch between saved connections
- Password auth or `~/.pgpass`-based auth
- SSH tunneling with password or private key authentication

### Schema Explorer
- Hierarchical database tree: Schema > Tables > Columns / Keys / Indexes
- Column details with data types, nullability, and defaults
- Primary key, unique, and foreign key display with referenced tables
- Index listing with uniqueness indicators
- Right-click context menu with full table operations

### File Explorer & Git Integration
- Browse the local filesystem directly from the sidebar
- View git status, changed files, and recent commits
- Click changed files to view diffs

### SQL Editor
- CodeMirror-based editor with SQL syntax highlighting
- Schema-aware SQL autocompletion from the loaded database tree
- Multiple query tabs
- Query presets (Session, Tables, Activity)
- Save queries to `.sql` files
- Sortable, paginated result grid with resizable columns
- Query history with execution timing
- Result export to CSV and Excel

### Dashboard
- Real-time server monitoring with sparkline graphs
  - CPU usage, RAM usage, cache hit ratio
  - Transaction throughput (TPS), connection saturation
- Server uptime, database size, active connections
- Active query list from PostgreSQL activity views

### Table Operations (right-click context menu)
- **Show DDL** — view the `CREATE TABLE` statement
- **Edit Data** — inline-editable data grid with cell editing, row add/delete, NULL handling, and pending change tracking
- **Export CSV** — export table data to CSV
- **Export with pg_dump** — export via `pg_dump` (SQL, custom, or tar format)
- **Modify Table** — rename table, add/drop/rename columns, change types and defaults with live DDL preview
- **Truncate / Drop Table** — with confirmation dialog and optional CASCADE

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Electron 41 |
| Frontend | React 19, Tailwind CSS 4.2, CodeMirror 6 |
| Backend | Node.js (pg), TypeScript 5 |
| Build | Vite 6, electron-builder |
| Package Manager | bun |

## Getting Started

### Prerequisites

- [bun](https://bun.sh/) (v1.0+)
- [Node.js](https://nodejs.org/) (v18+)
- A running PostgreSQL instance to connect to
- `pg_dump` installed if you want to use the pg_dump export option

### Install Dependencies

```bash
bun install
```

### Development

```bash
bun run dev
```

### Production (local run)

```bash
bun run start
```

## Testing

```bash
# Unit/integration tests
bun run test

# Watch mode
bun run test:watch

# Coverage
bun run test:coverage

# Live PostgreSQL tests
bun run test:live

# Electron E2E tests
bun run test:e2e

# Electron E2E tests with a visible browser window
bun run test:e2e:headed

# Full suite
bun run test:all
```

`test:live` expects `DB_HOST`, `DB_PORT`, `DB_NAME`, and `DB_USER`. Password can come from `DB_PASSWORD` or from a matching entry in `~/.pgpass`.

`test:e2e` builds the app and runs Playwright against the packaged Electron entrypoint. The E2E helper uses an isolated temporary `userData` directory, so test runs do not read or overwrite your real saved connections.

The connected E2E flow also requires `DB_HOST`, `DB_PORT`, `DB_NAME`, and `DB_USER`, plus a matching `~/.pgpass` or `PGPASSFILE` entry. If that entry is missing, the connected specs are skipped.

## Building Installers

Build distributable installers for your platform:

```bash
# Current platform
bun run dist

# macOS (universal DMG -- arm64 + x64)
bun run dist:mac

# Windows (NSIS installer)
bun run dist:win

# Linux (AppImage + .deb)
bun run dist:linux
```

Output is written to the `release/` directory.

### Regenerate App Icons

```bash
node scripts/generate-icons.mjs
```

Generates `build/icon.icns` (macOS), `build/icon.png` (1024x1024), and `build/icon_256x256.png` (Windows/Linux).

## Project Structure

```
src/
  main/           Electron main process
    index.ts        Window creation, app lifecycle
    ipc.ts          IPC handlers
    postgres.ts     PostgreSQL operations
    pgpass.ts       ~/.pgpass parsing and lookup
    ssh-tunnel.ts   SSH tunnel lifecycle and forwarding
    types.ts        Shared type definitions
    state.ts        App state
    storage.ts      Connection persistence
  renderer/       React frontend
    App.tsx         Root component
    components/
      AppShell.tsx    Main UI shell
      SqlEditor.tsx   CodeMirror SQL editor
    lib/
      api.ts        IPC client API
      types.ts      Frontend type definitions
  preload/        Electron preload (context bridge)
build/            App icons
scripts/          Build scripts
tests/            Unit, integration, and live tests
```

## License

MIT
