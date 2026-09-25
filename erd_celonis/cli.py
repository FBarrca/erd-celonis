"""Command-line interface for the Celonis ERD generator."""

from __future__ import annotations

import os
import time
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
from .query import QueryRunner
from .web import serve_graph


def _configured_key_type(key_type: str | None) -> str:
    """Resolve the explicit Pycelonis token type used by the CLI."""

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


def erd(
    pool_id: str,
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
        pool_id: Celonis data pool ID.
        data_model_id: Optional data model ID. If omitted, all data models
            in the pool are loaded.
        include_columns: Fetch and render table columns when true.
        key_type: Celonis token type, such as ``USER_KEY`` or ``APP_KEY``.
            If omitted, ``CELONIS_KEY_TYPE`` is read from the environment and
            defaults to ``USER_KEY``.  Setting this explicitly avoids
            Pycelonis probing both token types during authentication.
        host: Address on which to serve the explorer. Defaults to local-only.
        port: HTTP port. Use 0 to select an available port automatically.
        open_browser: Open the explorer in the default browser when ready.
        ddl: Write a compact SQL-like schema description to stdout instead of
            starting the interactive explorer.
    """

    # DDL is intended to be piped into another process, so keep stdout pure.
    status = _StatusLine(stderr=ddl)
    # Pass the reporter object, not only its report method, so the ERD builder
    # can activate Rich's ETA-enabled progress task for column fetching.
    report = status

    try:
        report("Loading environment configuration...")

        # Import lazily so importing the CLI does not create a network connection.
        from dotenv import find_dotenv, load_dotenv
        from pycelonis import get_celonis

        dotenv_path = find_dotenv(usecwd=True)
        if dotenv_path:
            report(f"Loading environment from {dotenv_path}")
        else:
            report("No .env file found; using existing shell environment variables.")
        load_dotenv(dotenv_path)
        configured_key_type = _configured_key_type(key_type)

        report("Connecting to Celonis...")
        celonis = get_celonis(key_type=configured_key_type, check_if_outdated=False)
        report(f"Loading data pool {pool_id}...")
        data_pool = celonis.data_integration.get_data_pool(pool_id)
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


def main() -> None:
    """Run the root Fire command."""
    Fire(erd)
