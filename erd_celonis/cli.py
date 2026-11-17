"""Command-line interface for the Celonis ERD generator."""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from collections.abc import Callable
from typing import Any

from fire import Fire
from rich.console import Console
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)
from rich.status import Status

from .ddl import graph_to_ddl
from .erd import build_data_pool_graph
from .pql_script import PqlScriptError, is_bare_expression, parse_pql_script
from .query import QueryError, QueryRunner
from .web import serve_graph


def _configured_key_type(key_type: str | None) -> str:
    """Keep the legacy resolver available for callers of older releases."""

    return key_type or os.getenv("CELONIS_KEY_TYPE") or "USER_KEY"


class _StatusLine:
    """Display progress with Rich's live one-line status renderer."""

    def __init__(self, console: Console | None = None, *, stderr: bool = False) -> None:
        self.console = console or Console(stderr=stderr)
        self._status: Status | None = None
        self._progress: Progress | None = None
        self._progress_task_id: int | None = None
        self._columns_started_at: float | None = None
        self._columns_total = 0

    def __call__(self, message: str) -> None:
        """Allow this reporter to be passed directly as a callback."""

        self.report(message)

    def report(self, message: str) -> None:
        """Update the live status or print a fallback line when redirected."""

        text = f"[erd-celonis] {message}"
        if self.console.is_terminal:
            if self._status is None:
                self._status = self.console.status(text, spinner="dots", spinner_style="green")
                self._status.start()
            else:
                self._status.update(text)
        else:
            self.console.print(text, markup=False)

    def close(self) -> None:
        """Stop Rich's live display so subsequent output starts on a new line."""

        self.finish_columns()
        if self._status is not None:
            self._status.stop()
            self._status = None

    def start_columns(self, total: int) -> None:
        """Start the live column-fetch progress display."""

        self.finish_status()
        self._columns_started_at = time.monotonic()
        self._columns_total = total
        if self.console.is_terminal:
            self._progress = Progress(
                TextColumn("[progress.description]{task.description}"),
                BarColumn(),
                MofNCompleteColumn(),
                TimeElapsedColumn(),
                TimeRemainingColumn(),
                console=self.console,
                transient=True,
            )
            self._progress_task_id = self._progress.add_task(
                "[erd-celonis] Fetching columns",
                total=total,
            )
            self._progress.start()
        else:
            self.console.print(f"[erd-celonis] Fetching columns (0/{total})...", markup=False)

    def update_columns(self, completed: int, table_name: str) -> None:
        """Update completed column requests and the live ETA."""

        if self._progress is not None and self._progress_task_id is not None:
            self._progress.update(
                self._progress_task_id,
                completed=completed,
                description=f"[erd-celonis] Fetching columns: {table_name}",
            )
            return

        elapsed = time.monotonic() - (self._columns_started_at or time.monotonic())
        remaining = (elapsed / completed) * (self._columns_total - completed) if completed else 0
        self.console.print(
            f"[erd-celonis] Fetched columns ({completed}/{self._columns_total}): "
            f"{table_name} (ETA {remaining:.1f}s)",
            markup=False,
        )

    def finish_columns(self) -> None:
        """Stop and clear the column progress display."""

        if self._progress is not None:
            self._progress.stop()
            self._progress = None
            self._progress_task_id = None
        self._columns_started_at = None
        self._columns_total = 0

    def finish_status(self) -> None:
        """Stop the ordinary status display before starting a progress task."""

        if self._status is not None:
            self._status.stop()
            self._status = None


OAUTH_ENV_VARS = ("OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "OAUTH_SCOPES")


def _get_celonis() -> Any:
    """Return a PyCelonis client authenticated with OAuth client credentials from the environment."""

    # Import lazily so importing the CLI does not load PyCelonis or connect.
    from pycelonis import get_celonis, oauth2
    from pycelonis_core.client import KeyType

    base_url = os.environ.get("CELONIS_URL", "").rstrip("/")
    if not base_url:
        raise RuntimeError("CELONIS_URL must be set to connect to Celonis.")
    missing = [name for name in OAUTH_ENV_VARS if not os.environ.get(name)]
    if missing:
        raise RuntimeError(f"{', '.join(missing)} must be set to connect to Celonis.")
    client_id, client_secret, scopes = (os.environ[name] for name in OAUTH_ENV_VARS)

    return get_celonis(
        base_url=base_url,
        api_token=oauth2(client_id, client_secret, scopes),
        key_type=KeyType.BEARER
    )


def _connect_data_pool(pool_id: str, report: Callable[[str], None]) -> Any:
    """Authenticate with PyCelonis using .env or shell variables and load a data pool."""

    report("Loading environment configuration...")

    # Import lazily so offline mode never reads credentials.
    from dotenv import find_dotenv, load_dotenv

    dotenv_path = find_dotenv(usecwd=True)
    if dotenv_path:
        report(f"Loading environment from {dotenv_path}")
    else:
        report("No .env file found; using existing shell environment variables.")
    load_dotenv(dotenv_path)
    report("Connecting to Celonis...")
    celonis = _get_celonis()
    report(f"Loading data pool {pool_id}...")
    return celonis.data_integration.get_data_pool(pool_id)


def erd(
    pool_id: str | None = None,
    data_model_id: str | None = None,
    include_columns: bool = True,
    key_type: str | None = None,
    host: str = "127.0.0.1",
    port: int = 8000,
    open_browser: bool = True,
    ddl: bool = False,
) -> None:
    """Serve an interactive ERD or export SQL-like DDL from a Celonis data pool.

    Args:
        pool_id: Celonis data pool ID. Omit to open an offline workspace
            and import a previously exported datapool state.
        data_model_id: Optional data model ID. If omitted, all data models
            in the pool are loaded.
        include_columns: Fetch and render table columns when true.
        key_type: Deprecated compatibility argument. Authentication is
            handled by OAuth client credentials (see README).
        host: Address on which to serve the explorer. Defaults to local-only.
        port: HTTP port. Use 0 to select an available port automatically.
        open_browser: Open the explorer in the default browser when ready.
        ddl: Write a compact SQL-like schema description to stdout instead of
            starting the interactive explorer.
    """

    if not pool_id:
        if ddl or data_model_id:
            raise ValueError("A data pool ID is required for --ddl or a data model ID.")
        serve_graph(None, host=host, port=port, open_browser=open_browser)
        return

    # DDL is intended to be piped into another process, so keep stdout pure.
    status = _StatusLine(stderr=ddl)
    # Pass the reporter object, not only its report method, so the ERD builder
    # can activate Rich's ETA-enabled progress task for column fetching.
    report = status

    try:
        data_pool = _connect_data_pool(pool_id, report)
        graph = build_data_pool_graph(
            data_pool,
            data_model_id=data_model_id,
            include_columns=include_columns,
            progress=report,
        )
        report("Preparing DDL schema..." if ddl else "Preparing interactive explorer...")
    finally:
        status.close()

    if ddl:
        print(graph_to_ddl(graph), end="")
        return

    print(f"Loaded {graph.number_of_nodes()} tables and {graph.number_of_edges()} relationships.")
    query_runner = QueryRunner(data_pool, {str(table.data_model_id) for table in graph.tables})
    serve_graph(graph, host=host, port=port, open_browser=open_browser, query_runner=query_runner)


PQL_EPILOG = """\
Examples:
  erd-celonis pql POOL MODEL 'COUNT_TABLE("ORDERS")'
  erd-celonis pql POOL MODEL - --format csv <<'EOF'
  FILTER "ORDERS"."VALUE" > 100;
  TABLE("ORDERS"."ID" AS "Order", "ORDERS"."VALUE") LIMIT 20;
  EOF

Scripts use the PQL console syntax: FILTER ...; TABLE([DISTINCT] expr AS "Name", ...) LIMIT n;
A bare expression is wrapped in TABLE(...). Discover tables with: erd-celonis POOL MODEL --ddl

Output: the result on stdout, progress on stderr.
Exit codes: 0 success, 1 connection or PQL failure, 2 invalid arguments or script."""


def _pql_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="erd-celonis pql",
        description="Run a PQL query against a Celonis data model using OAuth credentials from .env.",
        epilog=PQL_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("pool_id", help="Celonis data pool ID.")
    parser.add_argument("data_model_id", help="Data model ID within the pool.")
    parser.add_argument("query", nargs="?", help="PQL script, or - to read it from stdin.")
    parser.add_argument("-f", "--file", help="Read the PQL script from a file.")
    parser.add_argument("--format", choices=("json", "csv"), default="json", help="Output format (default: json).")
    parser.add_argument("--limit", type=int, help="Row limit, 1-10,000. Overrides LIMIT in the script (default: 1000).")
    parser.add_argument("--distinct", action="store_true", help="Return distinct rows only.")
    return parser


def _write_csv(result: dict[str, Any]) -> None:
    writer = csv.writer(sys.stdout, lineterminator="\n")
    writer.writerow(column["name"] for column in result["columns"])
    writer.writerows(result["rows"])


def pql(argv: list[str]) -> int:
    """Run one PQL script and write its result to stdout. Returns the exit code."""

    parser = _pql_parser()
    args = parser.parse_args(argv)
    if (args.query is None) == (args.file is None):
        parser.error("Pass the PQL script as an argument, as - for stdin, or with --file.")
    if args.limit is not None and not 1 <= args.limit <= 10_000:
        parser.error("--limit must be between 1 and 10,000.")
    if args.file is not None:
        try:
            with open(args.file, encoding="utf-8") as handle:
                script = handle.read()
        except OSError as exc:
            parser.error(f"Could not read {args.file}: {exc.strerror}")
    else:
        script = sys.stdin.read() if args.query == "-" else args.query
    if is_bare_expression(script):
        script = f"TABLE({script.strip().rstrip(';')})"

    try:
        request = parse_pql_script(script)
    except PqlScriptError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.limit is not None:
        request["limit"] = args.limit
    request["distinct"] = request["distinct"] or args.distinct
    payload = {"model_id": args.data_model_id, "columns": request["columns"], "filters": request["filters"],
               "limit": request["limit"], "distinct": request["distinct"]}

    status = _StatusLine(stderr=True)
    error, code = None, 0
    try:
        data_pool = _connect_data_pool(args.pool_id, status)
        status(f"Running PQL on data model {args.data_model_id}...")
        result = QueryRunner(data_pool, {args.data_model_id})(payload)
    except QueryError as exc:
        error, code = exc, 1 if exc.status >= 409 else 2
    except Exception as exc:  # Authentication and connection failures from PyCelonis.
        error, code = exc, 1
    finally:
        status.close()
    if error is not None:
        print(f"error: {error}", file=sys.stderr)
        return code

    if args.format == "csv":
        _write_csv(result)
    else:
        print(json.dumps(result, ensure_ascii=False))
    if result["limit_reached"]:
        print(f"[erd-celonis] Row limit {result['limit']:,} reached; results may be truncated.", file=sys.stderr)
    return 0


def main() -> None:
    """Run the pql subcommand, or the root Fire command for the explorer."""
    if sys.argv[1:2] == ["pql"]:
        sys.exit(pql(sys.argv[2:]))
    Fire(erd)
