# PostGrip User Guide

## Getting Started

### Connecting to a Database

1. Click the **+** button in the Connections panel or use **File > New Connection**
2. Enter your PostgreSQL connection details:
   - **Host** -- the server address (default: 127.0.0.1)
   - **Port** -- the PostgreSQL port (default: 5432)
   - **User** -- your database username (default: postgres)
   - **Password** -- your password, or select **pgpass** auth to use ~/.pgpass
   - **Database** -- the database name (default: postgres)
3. Click **Test Connection** to verify, then **Connect** to save and connect

PostGrip remembers your last used database and automatically reconnects on startup.

### Using ~/.pgpass

PostGrip automatically detects entries in your `~/.pgpass` file and displays them in the Connections panel under the **.pgpass** section. Click any entry to pre-fill the connection form.

The pgpass format is: `hostname:port:database:username:password`

### SSH Tunneling

To connect through a bastion host:

1. Open the **SSH / SSL** tab in the connection dialog
2. Enable **SSH Tunnel**
3. Enter the SSH host, port, user, and authentication method (password or private key)
4. PostGrip routes your database connection through the SSH tunnel automatically

---

## Data View

The Data view is the default view when you open PostGrip. It provides the schema explorer, table preview, and all table management operations.

### Schema Explorer

The **Database** tab in the Explorer panel shows your database structure:

- **Schemas** -- expand to see tables and views
- **Tables** -- expand to see columns, keys, and indexes (empty tables are shown too)
- **Columns** -- shows data type, nullability, and default values
- **Keys** -- primary keys, unique constraints, and foreign keys
- **Indexes** -- index names, columns, and uniqueness

Empty schemas (with no tables) are also visible in the tree.

### Table Preview

Click any table in the Schema Explorer to instantly preview its data. Results display in a sortable, paginated grid with resizable columns.

### Schema Operations

Right-click any **schema** in the Explorer:

| Operation | Description |
|-----------|-------------|
| **Create Schema** | Create a new schema in the database |
| **Create Table** | Open the full table builder to create a new table in the schema |

### Table Operations

Right-click any **table** in the Explorer:

| Operation | Description |
|-----------|-------------|
| **Modify Table** | Rename, add/drop columns, add foreign keys and indexes |
| **Edit Data** | Open the inline data editor |
| **Export CSV** | Export full table data to a CSV file |
| **Export Parquet** | Export table data to Apache Parquet format |
| **Export pg_dump** | Export using pg_dump (SQL, custom, or tar format) |
| **Truncate** | Remove all rows (with optional CASCADE) |
| **Drop** | Permanently delete the table (with optional CASCADE) |

### Create Table

The Create Table dialog provides a full table builder:

- **Columns** -- define name, type (dropdown with common PostgreSQL types), primary key flag, nullability, and default value
- **Foreign Keys** -- add constraints with dropdowns for source column, reference table, and reference column (populated from the database tree)
- **Indexes** -- add indexes with a multi-column picker and unique flag
- **SQL Preview** -- live preview updates as you build the table, showing the exact CREATE TABLE and CREATE INDEX statements

### Modify Table

The Modify Table dialog lets you:

- Rename the table
- Add new columns with type (dropdown), nullability, and default value
- Drop existing columns
- Rename columns
- Change column data types
- Toggle NOT NULL constraints
- Set or remove default values
- Add foreign key constraints to existing or new columns (with dropdowns populated from the database tree)
- Add indexes with a multi-column picker and unique flag

A live DDL preview shows the full table structure, foreign keys, indexes, and pending ALTER statements. All changes are applied in a single transaction.

### Editing Table Data

1. Right-click a table in the Explorer and select **Edit Data**
2. **Double-click** any cell to edit its value
3. Use **Tab** / **Shift+Tab** to navigate between cells
4. Click **+ Row** to add a new row
5. Click the delete icon to mark rows for deletion
6. Review pending changes in the toolbar, then click **Apply** to commit or **Discard** to cancel

All changes are applied in a single database transaction.

### Export Options

- **CSV** -- right-click a table and select **Export CSV**, or use **View > Export CSV** for query results
- **Parquet** -- right-click a table and select **Export Parquet** for columnar format ideal for analytics (DuckDB, Spark, Pandas)
- **Excel** -- export query results to Excel format via the View menu
- **pg_dump** -- right-click a table and select **Export pg_dump** (SQL, Custom, or Tar format)

### File Explorer & Git

The **Files** tab lets you browse the local filesystem. The **Git** tab shows discovered repositories with branch info, changed files, recent commits, and diff viewing.

---

## SQL Editor

Click **SQL Editor** in the menu bar to open the editor. Write and run queries with a full-featured editor, then explore results in an interactive grid.

### Writing Queries

- The editor provides **SQL syntax highlighting** and **schema-aware autocomplete**
- Type table or column names to see suggestions from your connected database
- Use the query presets dropdown for common queries (Session info, Tables, Activity)

### Running Queries

- Click **Run** or press the run button to execute your query
- Results appear in the Data pane below with sortable, paginated columns
- Click column headers to sort ascending/descending

### Multiple Tabs

- Click **+** to open new query tabs
- Each tab maintains its own SQL and results independently
- Close tabs with the **x** button

### Saving and Exporting

- Save query text to `.sql` files
- Export results to CSV or Excel from the View menu

---

## Monitoring

Click **Monitoring** in the menu bar to open the full monitoring panel. This provides comprehensive PostgreSQL server metrics in a dedicated view, updated in real time.

### Dashboard

When connected, the Dashboard panel in the sidebar shows real-time sparkline graphs for CPU, RAM, cache hit ratio, TPS, and connection saturation. Metrics update every 10 seconds and polling pauses when the window is hidden.

### Server Overview

Nine graphical metric cards with sparkline graphs:

- **Server CPU** -- CPU utilization percentage
- **Server RAM** -- memory usage with MB breakdown
- **Cache Hit** -- buffer cache hit ratio
- **TXN Throughput** -- transactions per second
- **Conn Saturation** -- active connections vs max
- **Uptime** -- server uptime in days/hours/minutes
- **DB Size** -- database size in GB/MB
- **Deadlocks** -- total deadlock count (highlights red if > 0)
- **Temp Files** -- temporary file count and total size

### Checkpoints & Buffers

Five stat cards showing timed and requested checkpoints, and buffers written by checkpoint, background writer, and backend processes.

### Connections

Two tables showing connection breakdown by state (active, idle, idle in transaction) and by user.

### Locks

- **By Type** -- current locks grouped by lock type and mode
- **Blocked Queries** -- queries waiting on locks with PID, blocking PID, wait duration, and query text

### Additional Sections

- **Long Running Transactions** -- queries running for more than 1 minute with PID, user, duration, state, and query
- **Table Statistics** -- top 50 tables by activity: sequential/index scans, rows inserted/updated/deleted, dead tuples, table size, last vacuum
- **Unused Indexes** -- indexes with zero scans, sorted by size -- candidates for removal
- **Replication** -- replica lag monitoring (write lag, flush lag, replay lag per client)

Click **Refresh** to reload all metrics, or **Close** to return to the Data pane.

---

## Backup & Restore

Click **Backup & Restore** in the menu bar to open the backup panel. Full database backup management is built into the app -- back up on demand or on a schedule, browse history, and restore with one click.

### Backup Now

Click **Backup Now** to open the backup configuration modal:

- **Format** -- Tar Archive, Custom (pg_restore compatible), Plain SQL, or Directory
- **Scope** -- Back up the entire database, or select specific schemas and tables using a tree view with checkboxes
- **Content** -- Schema + Data, Schema Only, or Data Only
- **Options** -- No owner, no privileges, clean (DROP before CREATE), CREATE DATABASE, IF EXISTS
- **Compression** -- Level 0-9 (available for Custom and Directory formats)
- **Output File** -- Editable path with Browse button

During backup, an animated progress bar shows in the toolbar and the backup appears in the history table with "In Progress" status.

### Schedule Backup

Click **Schedule Backup** to set up recurring automated backups:

- **Days** -- Select which days of the week to run (Sunday through Saturday)
- **Start Time** -- Pick the time to start the backup
- **Format, Scope, Content, Options** -- Same options as Backup Now

Scheduled backups only run while PostGrip is open with an active database connection. The Backup Schedules table shows all schedules with their run days, start time, and last run timestamp.

### Backup History

The backup history table shows all backups with:

- **Created Date** -- when the backup was created
- **Status** -- In Progress, Successful, or Failed
- **Size** -- file size
- **Duration** -- how long the backup took
- **Path** -- full file path
- **Actions** -- Delete and Restore buttons

Click any row to expand it and see full backup details: format, scope, content, options, schemas, and tables.

### Restoring a Backup

Click **Restore** next to any backup in the history:

- `.sql` files are executed directly as SQL
- `.dump` and `.tar` files are restored via `pg_restore`

### Backup Directory

The default backup directory is `~/PostGrip_Backups`. Click **Change** to select a different directory. The preference persists across sessions.

---

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Navigate cells (Edit Data) | Tab / Shift+Tab |
| Confirm cell edit | Enter |
| Cancel cell edit | Escape |

---

## Tips

- **Auto-reconnect**: PostGrip remembers your last database and reconnects automatically on startup
- **Quick connect**: If your credentials are in ~/.pgpass, PostGrip shows them in the sidebar for one-click connection setup
- **Multiple connections**: Save multiple connections and switch between them instantly from the sidebar
- **Query history**: The Dashboard panel tracks your recent queries with execution times
- **Column resize**: Drag column borders in the results grid to adjust widths
- **Create tables visually**: Right-click a schema to build tables with primary keys, foreign keys, and indexes -- no SQL needed
- **Export for analytics**: Use Parquet export for large datasets destined for data pipelines or tools like DuckDB, Spark, or Pandas
