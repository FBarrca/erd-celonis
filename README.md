# Celonis data-pool ERD

This project creates an Entity Relationship Diagram from Celonis Data
Integration metadata with Pycelonis. A small typed internal model stores the
tables and relationships, while Graphviz renders schema-style table cards with
column ports and routed foreign-key relationships. Each data-model table shows its
columns and primary keys, and each configured Celonis foreign key is rendered
with its source and target columns. Relationships show the conventional
foreign-key cardinality with crow-foot notation, without adding cardinality
text to the connector. Source columns participating in a foreign key are
marked `FK`; a column that is both a primary key and foreign key is marked
`PK/FK`. Relationship direction is normalized from primary-key metadata, so
if Celonis returns the table pair reversed, the non-primary column is still
shown and marked as the FK column.



## Setup

Install the CLI as a standalone uv tool:

```bash
uv tool install git+https://github.com/FBarrca/erd-celonis
```

This creates the `erd-celonis` command in your uv tool environment. If the
command is not found afterward, run `uv tool update-shell` or add uv's tool
bin directory to your `PATH`.

Then copy the repository's credential template and fill in the OAuth values:

```bash
cp .env.example .env
```

The template contains `CELONIS_URL`, `OAUTH_CLIENT_ID`,
`OAUTH_CLIENT_SECRET`, `OAUTH_SCOPES`, and `CELONIS_KEY_TYPE`. The CLI searches
for `.env` from the directory where you run the command, including its parent
directories. `USER_KEY` is the default and uses the Bearer authorization
scheme; set `CELONIS_KEY_TYPE=APP_KEY` when using an application key. If your
tenant uses an API token instead, replace the OAuth settings with
`CELONIS_API_TOKEN` as supported by Pycelonis.

For development inside this repository, `uv sync` and `uv run erd-celonis`
remain available. In an interactive terminal, the CLI updates one status line
in place; when output is redirected, it falls back to one status message per
line. Rich provides the terminal display, while `tqdm` is only retained as a
transitive dependency of Pycelonis and is not used by this project.

Graphviz also needs its native `dot` executable. On macOS, install it with:

```bash
brew install graphviz
```

On Linux, install the `graphviz` package through your distribution's package
manager.

## Generate an ERD

Generate an ERD for the first data model in a data pool:

```bash
uv run erd-celonis "<data-pool-id>" \
  --output="artifacts/data_model_erd.png"
```

Specify a particular data model by passing its ID as the second positional
argument:

```bash
uv run erd-celonis "<data-pool-id>" "<data-model-id>" \
  --output="artifacts/data_model_erd.svg"
```

Use `--include_columns=False` when only the table-level relationship graph is
needed. The CLI prints progress for authentication, Celonis metadata calls,
column fetching, and rendering. When Pycelonis includes columns in the table
metadata response, the complete table-column endpoint is still used because
the embedded `columns` attribute can be partial. Fire also exposes the command
help with `erd-celonis --help`. Complete column metadata is fetched in parallel
with a bounded pool of workers, and the live progress line reports completed
tables out of the total, elapsed time, and estimated remaining time.

## Tests

```bash
uv run pytest
```
