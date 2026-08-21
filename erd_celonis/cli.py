"""Command-line interface for the Celonis ERD generator."""

from __future__ import annotations

from pathlib import Path

from fire import Fire

from .erd import build_data_pool_graph, render_erd


def erd(
    pool_id: str,
    data_model_id: str | None = None,
    output: str | Path = "datapool_erd.png",
    include_columns: bool = True,
) -> Path:
    """Render a NetworkX ERD from a Celonis data pool.

    Args:
        pool_id: Celonis data pool ID.
        data_model_id: Optional data model ID. If omitted, the first data
            model in the pool is used.
        output: Output image path. The extension selects PNG, SVG, or PDF.
        include_columns: Fetch and render table columns when true.

    Returns:
        The path of the generated ERD image.
    """

    # Import lazily so importing the CLI does not create a network connection.
    from dotenv import find_dotenv, load_dotenv
    from pycelonis import get_celonis

    load_dotenv(find_dotenv(usecwd=True))
    celonis = get_celonis(check_if_outdated=False)
    data_pool = celonis.data_integration.get_data_pool(pool_id)
    selected_data_model_id = data_model_id or first_data_model_id(data_pool)
    graph = build_data_pool_graph(
        data_pool,
        data_model_id=selected_data_model_id,
        include_columns=include_columns,
    )
    output_path = render_erd(graph, output)
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
