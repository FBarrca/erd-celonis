# Celonis ERD explorer

Explore a Celonis data model as an interactive entity-relationship diagram.
The CLI loads the same table, column, primary-key, and configured foreign-key
metadata as before, then starts a local web app instead of writing a static
image.

The explorer provides:

- relationship-aware top-to-bottom schema layout that places referenced
  tables above their dependants and spreads each rank across the canvas;
- drag or two-finger trackpad pan, pinch zoom, minimap, and draggable table cards;
- automatic saving of table positions, pan, zoom, and the last selected model scope;
- a resizable PQL console with syntax highlighting, schema autocomplete, per-model drafts, query results, and CSV export;
- typo-tolerant search powered by Fuse.js across table aliases, physical names,
  and individual columns in the selected model scope, with highlighted matches;
- table and relationship inspectors with exact column mappings;
- a relationship lens that fades unrelated parts of the model;
- a shortest-path finder between two tables, with intermediate tables and exact
  join columns (including composite keys); and
- a responsive inspector for desktop and mobile browsers.

## Install

Install the command as a standalone uv tool:

```bash
uv tool install git+https://github.com/FBarrca/erd-celonis
```

This checkout expects the sibling `celofast` package at `../celofast` (or an
equivalent local source configured in `pyproject.toml`).

This still creates the `erd-celonis` command in uv's isolated tool
environment. The compiled React app is included in the Python wheel, so Node.js
is **not** required to install or run the tool. If the command is not found,
run `uv tool update-shell` or add uv's tool bin directory to `PATH`.

Copy the credential template into the directory where you will run the command
and fill in its values:

```bash
cp .env.example .env
```

The template contains `CELONIS_URL`, `OAUTH_CLIENT_ID`,
`OAUTH_CLIENT_SECRET`, and `OAUTH_SCOPES`. The CLI uses CeloFast's
OAuth client factory and searches
for `.env` from the current directory, including its parent directories.
CeloFast expects OAuth client credentials. A `CELONIS_API_TOKEN` is no longer
used by this CLI because authentication is intentionally centralized in
CeloFast.

## Run the explorer

Load all data models (perspectives) in a data pool:

```bash
erd-celonis "<data-pool-id>"
```

The command opens the explorer at `http://127.0.0.1:8000` and keeps running
until you press `Ctrl+C`. Each model has its own tab in the **Scope** bar.
The last selected model opens when available; otherwise, the first model opens.

Export the selected data model as a compact SQL-like DDL description for use
with an LLM or other text-based tooling:

```bash
erd-celonis "<data-pool-id>" --ddl
```

DDL is written to stdout, while loading progress is written to stderr, so it
can be redirected directly to a file:

```bash
erd-celonis "<data-pool-id>" --ddl > schema.sql
```

The output describes tables, columns, primary keys, and configured foreign
keys. It is intentionally SQL-like rather than tied to a specific database
dialect; Celonis data types are preserved as provided by the API.

Select a particular data model with the second positional argument:

```bash
erd-celonis "<data-pool-id>" "<data-model-id>"
```

Useful options:

```bash
# Choose another port
erd-celonis "<data-pool-id>" --port=8123

# Pick any available port and print its URL
erd-celonis "<data-pool-id>" --port=0

# Do not open a browser automatically
erd-celonis "<data-pool-id>" --open_browser=False

# Load only table-level relationships
erd-celonis "<data-pool-id>" --include_columns=False
```

The server binds to `127.0.0.1` by default, so only the local machine can
access the schema. Use `--host=0.0.0.0` only when you intentionally want to
expose the explorer and its query access on your network. The graph is fetched
once by the CLI and served from memory. PQL queries use that CLI's authenticated
connection and permissions; Celonis credentials remain on the Python server.

Schema loading shares one pool of up to 10 workers across all selected models,
matching the SDK's default HTTP connection limit.
Table and foreign-key metadata requests run concurrently, followed by column
requests across models with one combined progress total. At most 10 requests
are submitted at a time; model, table, and relationship order stays stable.

### Run PQL queries

The **PQL console** at the bottom runs against the selected model tab. Write one
PQL script in the editor and view the resulting DataFrame below it. Use the
header's expand icon for a larger workspace, or **Load example** for a query
using the active model. The chevron collapses or reopens the console; icons have
tooltips and accessible labels.

```pql
FILTER "Orders"."AMOUNT" > 100;

TABLE(
  "Orders"."CUSTOMER_ID" AS "Customer",
  SUM("Orders"."AMOUNT") AS "Total amount"
);
```

Put output expressions inside `TABLE(...)`, separated by commas, and name them
with `AS "Name"`. Simple column references can omit the alias; other unnamed
expressions receive names such as `Column 1`. Write `FILTER ...;` statements before
or after `TABLE`, or use **+ Filter** to insert a filter template. Use
`TABLE(DISTINCT ...)` to remove duplicate result rows. The console supports one
TABLE query, up to 100 expressions and 20 filters, and optional `LIMIT` after
TABLE. It does not accept SQL SELECT, ORDER BY, OFFSET, or Python statements.

Use **Insert table or column** to search the selected model's schema and insert
a quoted reference at the cursor. Table aliases are used when present.

The editor uses **CodeMirror 6**, bundled with the app, with PQL
syntax highlighting, line numbers, bracket matching, and undo/redo. Suggestions
appear as you type; **Ctrl+Space** opens them explicitly. They include the active
model's tables and columns plus common PQL functions and snippets. After
`"Orders".`, only that table's columns are suggested. References use quoted aliases
and preserve the schema's spelling. Suggestions use metadata already loaded by
the explorer; they do not make additional Celonis requests.

Use **↑/↓** to choose a suggestion, **Enter** to insert it, and **Escape** to dismiss
the menu. **Tab** moves through active snippet arguments, or moves focus normally
when no snippet is active. Undo history and the cursor are retained when the
panel is collapsed. Scripts are limited to 65,536 characters, with at most 8,192
characters per expression or filter. Highlighting and the
curated function catalog assist editing; Celonis validates the query when it runs.

Choose **Run** or press **Ctrl+Enter** (**Cmd+Enter** on macOS). Results
show column types, elapsed time, and 100 rows per page. Click a column heading
to sort the returned rows. Queries default to 1,000 rows, with a maximum of
10,000; reaching the limit does not indicate the total number of matching rows.
An explicit `LIMIT 100;` after TABLE overrides the toolbar's row limit.

**Download CSV** exports the returned result set. Formula-like text is prefixed
with an apostrophe for spreadsheet safety.

Drag the panel's upper divider (or focus it and use the arrow keys) to resize it;
use the header chevron to collapse it. Drafts, including unfinished edits, save
automatically per pool and model in browser local storage. Existing drafts from
the expression/filter form are converted into scripts when opened. Results are
held only in memory and cleared on model
switches or reloads. Leaving the model stops waiting for its result, but does not
cancel work already submitted to Celonis. The server runs one query at a time.

Queries use the data model directly. Analysis/Knowledge Model variables and
saved KPIs that require a separate query environment are not resolved by this
editor. Large integer IDs and decimals are displayed as strings to preserve
precision; dates use ISO text and missing values display as `NULL`.

### Remember diagram views

Table positions, sticky notes, pan, and zoom are saved automatically in browser local storage.
Reopening the same data model restores its latest view, including after stopping
and restarting the server. Views are matched by Celonis pool and model IDs, so
renaming a model does not lose its layout. Each model tab has its own view,
and the last selected model is restored when reopening, if still available.

Use the yellow **Add sticky note** icon in the canvas to add a note. Click its title
to name it, type Markdown in the body, drag the dotted header grip to move it,
and use its × button to delete it. Titles, text, and positions
save automatically per model and return after a refresh. Notes are personal to
this browser and are not sent to Celonis or included in DDL exports.
Notes use CodeMirror with Markdown highlighting for headings, bold and italic
text, links, lists, and code. The Markdown source stays editable, with undo/redo;
notes are saved as plain text and do not render HTML.
Press **N** while the pointer is over the canvas to place a note centered on the pointer.
The shortcut is inactive while typing in a note, search field, or PQL editor.

Existing tables keep their saved positions when the schema changes. New tables
appear to the right of the saved arrangement. Search text, inspectors, selections,
and routes are not saved.

Use the same browser profile and server address (including port), normally
`http://127.0.0.1:8000`. A different port, `localhost` instead of `127.0.0.1`,
or a different browser has separate storage. Clearing the site's browser data
removes saved views. If storage is blocked or full, views remain available only
while the page is open.

### Find a path between tables

Select a table and choose **Find connection to…** in its inspector. The starting
table stays visible while you search for a destination or click another table
on the diagram. Destination search uses the same fuzzy matching, highlights,
and keyboard navigation as the main search; choosing a column connects to its table.
The explorer highlights one shortest route, fits it on the canvas, and lists
every table and join-column pair along the way. Relationships can be traversed
in either direction; all columns of a composite relationship are shown together.
The route describes schema connectivity, not a guarantee that a PQL join is valid.

Use **Change destination** to explore another connection, **Fit route** to
recenter it, or **Clear route** to return to the starting table's inspector.
Disconnected tables show a **No path found** explanation for the loaded scope.
Escape cancels destination selection and returns to the starting table.
Changing model scope clears the connection.

### Search tables and columns

Search accepts multiple words and treats spaces, underscores, hyphens, and dots
as equivalent separators. Exact names appear before approximate matches. Press
`/` to focus search, use the arrow keys and Enter to open a result, or Escape to
dismiss suggestions. Selecting a column reveals and highlights it in the table
inspector. Results include a count and a **Show more** control after the first 50.
Column search requires loaded column metadata.

## Develop

Set up the Python project and run its tests:

```bash
uv sync
uv run pytest
```

The React source lives in `frontend/`. Node is only needed when changing that
source:

```bash
cd frontend
npm install
npm test
npm run build
```

The production build is written to `erd_celonis/static/` and must be committed
because those files are packaged for `uv tool install`. For frontend hot
reload, start `npm run dev` while the Python server is available at port 8000;
Vite proxies `/api` requests to it.
