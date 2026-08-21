# Celonis ERD explorer

Explore a Celonis data model as an interactive entity-relationship diagram.
The CLI loads the same table, column, primary-key, and configured foreign-key
metadata as before, then starts a local web app instead of writing a static
image.

The explorer provides:

- relationship-aware top-to-bottom schema layout that places referenced
  tables above their dependants and spreads each rank across the canvas;
- drag or two-finger trackpad pan, pinch zoom, minimap, and draggable table cards;
- search across table and column names;
- table and relationship inspectors with exact column mappings;
- a relationship lens that fades unrelated parts of the model; and
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

Serve the first data model in a data pool:

```bash
erd-celonis "<data-pool-id>"
```

The command opens the explorer at `http://127.0.0.1:8000` and keeps running
until you press `Ctrl+C`.

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
npm run build
```

The production build is written to `erd_celonis/static/` and must be committed
because those files are packaged for `uv tool install`. For frontend hot
reload, start `npm run dev` while the Python server is available at port 8000;
Vite proxies `/api` requests to it.
