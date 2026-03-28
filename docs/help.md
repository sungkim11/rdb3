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

## Schema Explorer

The **Database** tab in the Explorer panel shows your database structure:

- **Schemas** -- expand to see tables and views
- **Tables** -- expand to see columns, keys, and indexes (empty tables are shown too)
- **Columns** -- shows data type, nullability, and default values
- **Keys** -- primary keys, unique constraints, and foreign keys
- **Indexes** -- index names, columns, and uniqueness

Empty schemas (with no tables) are also visible in the tree.

Right-click a **schema** to create a new schema or table. Right-click a **table** for a context menu with additional operations.

---

## SQL Editor

Click **SQL Editor** in the menu bar or press the editor icon in the toolbar.

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

### Saving Queries

Use **File > Save** or the export options to save your query text to a `.sql` file.

---

## Data Pane

The Data pane shows query results and table data.

### Viewing Results

- Results display in a grid with column headers
- **Resize columns** by dragging the right edge of any column header
- **Sort** by clicking column headers
- **Paginate** using the navigation controls at the bottom

### Editing Table Data

1. Right-click a table in the Explorer and select **Edit Data**
2. **Double-click** any cell to edit its value
3. Use **Tab** / **Shift+Tab** to navigate between cells
4. Click **+ Row** to add a new row
5. Click the delete icon to mark rows for deletion
6. Review pending changes in the toolbar, then click **Apply** to commit or **Discard** to cancel

All changes are applied in a single database transaction.

---

## Schema Operations

Right-click any schema in the Schema Explorer:

| Operation | Description |
|-----------|-------------|
| **Create Schema** | Create a new schema in the database |
| **Create Table** | Open the full table builder to create a new table in the schema |

## Table Operations

Right-click any table in the Schema Explorer for these operations:

| Operation | Description |
|-----------|-------------|
| **Preview** | View the first rows of the table |
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

---

## Dashboard

When connected to a database, the Dashboard panel shows real-time server metrics:

- **CPU Usage** -- server CPU utilization (Linux servers with superuser access)
- **RAM Usage** -- server memory utilization (Linux servers with superuser access)
- **Cache Hit Ratio** -- database buffer cache effectiveness
- **Transaction Throughput** -- transactions per second (TPS)
- **Connection Saturation** -- active connections vs. max_connections

Metrics update every 10 seconds and display sparkline graphs for trend visualization. Polling automatically pauses when the app window is not visible.

---

## Monitoring

Click **Monitoring** in the menu bar to open the full monitoring panel. This provides comprehensive PostgreSQL server metrics in a dedicated view.

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

Five stat cards showing:

- Timed checkpoints and requested checkpoints
- Buffers written by checkpoint, background writer, and backend processes

### Connections

Two tables showing connection breakdown:

- **By State** -- active, idle, idle in transaction, etc.
- **By User** -- connection count per database user

### Locks

- **By Type** -- current locks grouped by lock type and mode
- **Blocked Queries** -- queries waiting on locks with PID, blocking PID, wait duration, and query text

### Long Running Transactions

Lists all transactions running for more than 1 minute with PID, user, duration, state, and query.

### Query History

Recent queries from the current session with their results.

### Table Statistics

Top 50 tables sorted by activity:

| Column | Description |
|--------|-------------|
| Seq Scan | Number of sequential scans |
| Idx Scan | Number of index scans |
| Ins/Upd/Del | Rows inserted, updated, deleted |
| Dead | Dead tuples (candidates for vacuum) |
| Size | Total table size |
| Last Vacuum | When the table was last vacuumed |

### Unused Indexes

Indexes with zero scans, sorted by size. These are candidates for removal to save disk space and improve write performance.

### Replication

If the server has replicas, shows replication status including write lag, flush lag, and replay lag per client.

Click **Refresh** to reload all metrics, or **Close** to return to the Data pane.

---

## Backup & Restore

Click **Backup & Restore** in the menu bar to open the backup panel.

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

## File Explorer

The **Files** tab in the Explorer panel lets you browse your local filesystem:

- Click folders to expand/collapse them
- Double-click folders to navigate into them
- Click the **up arrow** to go to the parent directory
- Click any file to open it -- `.sql` files open in the SQL Editor

---

## Git Integration

The **Git** tab in the Explorer panel shows git repositories found in your developer directories:

### Repository List

Repositories are automatically discovered from common directories (~/Developer, ~/Projects, ~/repos, etc.). Click a repository to:

- View its current **branch**
- See **changed files** with status indicators (M=Modified, A=Added, D=Deleted)
- Browse **recent commits**
- Expand the repository as a **file tree**

### Working with Changes

- Click a **modified file** to view its diff
- Click an **untracked file** to open it in the editor
- `.sql` files always open in the SQL Editor

---

## Export Options

### CSV Export

- From results: Use **View > Export CSV** to export the current query results
- From tables: Right-click a table and select **Export CSV** to export the full table

### Parquet Export

Right-click a table and select **Export Parquet** to export data in Apache Parquet format. Parquet is a columnar storage format ideal for analytics and data engineering workflows. PostgreSQL types are automatically mapped to Parquet types (integers, floats, booleans, and strings).

### Excel Export

Query results can be exported to Excel format via the View menu.

### pg_dump Export

Right-click a table and select **Export pg_dump** to export using PostgreSQL's native dump tool. Supported formats:

- **SQL** -- plain SQL statements
- **Custom** -- compressed binary format (restorable with pg_restore)
- **Tar** -- tar archive format

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
