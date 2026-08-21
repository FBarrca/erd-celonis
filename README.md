# Celonis data-pool ERD

This project creates an Entity Relationship Diagram from Celonis Data
Integration metadata with Pycelonis and NetworkX. Each data-model table is a
graph node. Its columns and primary keys are shown inside the node, and each
configured Celonis foreign key is a directed edge labeled with its source and
target columns.



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
`OAUTH_CLIENT_SECRET`, and `OAUTH_SCOPES`. The CLI searches for `.env` from the
directory where you run the command, including its parent directories. If
your tenant uses an API token instead, replace the OAuth settings with
`CELONIS_API_TOKEN` as supported by Pycelonis.

For development inside this repository, `uv sync` and `uv run erd-celonis`
remain available.

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
column fetching, and rendering. Fire also exposes the command help with
`erd-celonis --help`.

Relationships are taken from Celonis' configured foreign keys. The tool does
not infer relationships merely because two columns have the same name.

## Tests

```bash
uv run pytest
```
