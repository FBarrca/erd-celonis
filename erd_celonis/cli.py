"""Command-line interface for the Celonis ERD generator."""

from __future__ import annotations

import os
from pathlib import Path

from fire import Fire
from tqdm.auto import tqdm

from .erd import build_data_pool_graph, render_erd


def _configured_key_type(key_type: str | None) -> str:
    """Resolve the explicit Pycelonis token type used by the CLI."""

    return key_type or os.getenv("CELONIS_KEY_TYPE") or "USER_KEY"


def erd(
    pool_id: str,
    data_model_id: str | None = None,
    output: str | Path = "datapool_erd.png",
    include_columns: bool = True,
    key_type: str | None = None,
) -> Path:
    """Render a NetworkX ERD from a Celonis data pool.

    Args:
        pool_id: Celonis data pool ID.
        data_model_id: Optional data model ID. If omitted, the first data
            model in the pool is used.
        output: Output image path. The extension selects PNG, SVG, or PDF.
        include_columns: Fetch and render table columns when true.
        key_type: Celonis token type, such as ``USER_KEY`` or ``APP_KEY``.
            If omitted, ``CELONIS_KEY_TYPE`` is read from the environment and
            defaults to ``USER_KEY``.  Setting this explicitly avoids
            Pycelonis probing both token types during authentication.

    Returns:
        The path of the generated ERD image.
    """

    def report(message: str) -> None:
        tqdm.write(f"[erd-celonis] {message}")

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
    if data_model_id:
        selected_data_model_id = data_model_id
    else:
        report("Finding the first data model...")
        selected_data_model_id = first_data_model_id(data_pool)
    report(f"Using data model {selected_data_model_id}.")
    graph = build_data_pool_graph(
        data_pool,
        data_model_id=selected_data_model_id,
        include_columns=include_columns,
        progress=report,
    )
    report("Rendering ERD...")
    output_path = render_erd(graph, output, progress=report)
    print(f"Created {output_path} ({graph.number_of_nodes()} tables, {graph.number_of_edges()} relationships).")
    return output_path


def first_data_model_id(data_pool: object) -> str:
    """Return the first data-model ID in a pool, or explain why none exists."""

    get_data_models = getattr(data_pool, "get_data_models", None)
    if not callable(get_data_models):
        raise TypeError("The Celonis data pool does not expose get_data_models().")

    data_models = list(get_data_models())
    if not data_models:
        raise ValueError("The Celonis data pool contains no data models.")

    data_model_id = getattr(data_models[0], "id", None)
    if not data_model_id:
        raise ValueError("The first Celonis data model does not have an ID.")
    return str(data_model_id)


def main() -> None:
    """Run the root Fire command."""
    Fire(erd)
