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
- typo-tolerant search powered by Fuse.js across table aliases, physical names,
  and individual columns in the selected model scope, with highlighted matches;
- export the loaded data model as a JSON file;
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
`OAUTH_CLIENT_SECRET`, `OAUTH_SCOPES`, and `CELONIS_KEY_TYPE`. The CLI searches
for `.env` from the current directory, including its parent directories.
`USER_KEY` is the default; set `CELONIS_KEY_TYPE=APP_KEY` when using an
application key. A `CELONIS_API_TOKEN` can be used instead when supported by
your tenant and Pycelonis.

## Run the explorer

Load all data models (perspectives) in a data pool:

```bash
erd-celonis "<data-pool-id>"
```

The command opens the explorer at `http://127.0.0.1:8000` and keeps running
until you press `Ctrl+C`. Use the **Scope** buttons to view **All models** or
select an individual model. A previously saved scope is restored when available.

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
expose the explorer on your network. The server is read-only and makes no
browser-side Celonis requests; the graph is fetched once by the CLI and served
from memory.

### Remember diagram views

Table positions, pan, and zoom are saved automatically in browser local storage.
Reopening the same data model restores its latest view, including after stopping
and restarting the server. Views are matched by Celonis pool and model IDs, so
renaming a model does not lose its layout. Each model scope and **All models**
has its own view, and the last valid scope is restored when reopening.

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
