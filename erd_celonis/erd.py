"""NetworkX ERD helpers for Pycelonis data models.

The graph deliberately contains one node per data-model table.  Columns are
stored on the table node and rendered inside the table label, while each
configured Celonis foreign key is represented by a directed edge containing
the source/target column mapping.

This module does not import :mod:`pycelonis` at import time.  That keeps the
graph-building functions easy to test with small metadata doubles and lets a
caller import the package without creating a Celonis connection.
"""

from __future__ import annotations

import logging
import warnings
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

import networkx as nx

logger = logging.getLogger(__name__)


def build_data_model_graph(
    data_model: Any,
    *,
    include_columns: bool = True,
    progress: Callable[[str], None] | None = None,
) -> nx.MultiDiGraph:
    """Build an ERD graph for one Pycelonis ``DataModel``.

    Args:
        data_model: A Pycelonis ``DataModel`` object.  The object is expected
            to expose ``get_tables()`` and ``get_foreign_keys()``.  Its
            ``tables`` and ``foreign_keys`` attributes are accepted as a
            fallback, which is useful for already-loaded metadata and tests.
        include_columns: If true, fetch table columns and include them in
            table node attributes and labels.
        progress: Optional callback for status messages.

    Returns:
        A ``networkx.MultiDiGraph`` with table nodes and foreign-key edges.

    Notes:
        Relationships are read from Celonis foreign-key metadata; columns with
        matching names are not treated as a relationship unless Celonis has
        configured the foreign key.
    """

    _report(progress, "Fetching table metadata...")
    tables = _collection(data_model, "get_tables", "tables")
    _report(progress, f"Found {len(tables)} table(s).")
    _report(progress, "Fetching foreign-key metadata...")
    foreign_keys = _collection(data_model, "get_foreign_keys", "foreign_keys")
    _report(progress, f"Found {len(foreign_keys)} foreign-key relationship(s).")

    return _build_graph(
        data_model,
        tables=tables,
        foreign_keys=foreign_keys,
        include_columns=include_columns,
        namespace=_model_namespace(data_model),
        progress=progress,
    )


def build_data_pool_graph(
    data_pool: Any,
    *,
    data_model_id: str | None = None,
    include_columns: bool = True,
    progress: Callable[[str], None] | None = None,
) -> nx.MultiDiGraph:
    """Build one ERD graph from one data pool.

    If ``data_model_id`` is supplied, only that model is included.  Otherwise
    all data models in the pool are merged into one graph.  Table node IDs are
    namespaced by data model so similarly named tables remain distinct.
        progress: Optional callback for status messages.
    """

    if data_model_id is not None:
        _report(progress, f"Loading data model {data_model_id}...")
        data_models = [_call_or_attribute(data_pool, "get_data_model", "data_model", data_model_id)]
    else:
        _report(progress, "Fetching data-model metadata...")
        data_models = _collection(data_pool, "get_data_models", "data_models")
    _report(progress, f"Processing {len(data_models)} data model(s)...")

    graph = nx.MultiDiGraph(graph_type="celonis_data_pool_erd")
    graph.graph["data_pool_id"] = _value(data_pool, "id")
    graph.graph["data_pool_name"] = _value(data_pool, "name")

    for model in data_models:
        model_graph = build_data_model_graph(model, include_columns=include_columns, progress=progress)
        namespace = _model_namespace(model)
        for node, attrs in model_graph.nodes(data=True):
            graph.add_node(
                f"{namespace}/{node}",
                **attrs,
                data_model_id=_value(model, "id"),
                data_model_name=_value(model, "name"),
            )
        for source, target, key, attrs in model_graph.edges(keys=True, data=True):
            graph.add_edge(f"{namespace}/{source}", f"{namespace}/{target}", key=key, **attrs)

    return graph


def render_erd(
    graph: nx.MultiDiGraph,
    output_path: str | Path,
    *,
    title: str | None = None,
    seed: int = 42,
    dpi: int = 180,
    progress: Callable[[str], None] | None = None,
) -> Path:
    """Render a NetworkX ERD graph to a PNG/SVG/PDF image.

    Matplotlib is imported lazily so graph construction does not require the
    rendering dependency.  The output format is selected by the extension.
    """

    if not graph.number_of_nodes():
        raise ValueError("Cannot render an ERD with no data-model tables.")

    _report(progress, "Preparing diagram layout...")

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError as exc:  # pragma: no cover - depends on environment
        raise RuntimeError(
            "Rendering an ERD requires matplotlib. Install the project dependencies "
            "with `uv sync`."
        ) from exc

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    # A spring layout works for arbitrary FK topologies and remains useful for
    # data models that do not have a single root table.
    layout_graph = nx.Graph(graph)
    positions = nx.spring_layout(layout_graph, seed=seed, k=1.8 / max(graph.number_of_nodes() ** 0.5, 1))
    figure_width = max(10.0, min(24.0, 7.0 + 1.5 * graph.number_of_nodes()))
    figure_height = max(7.0, min(18.0, 5.5 + 1.0 * graph.number_of_nodes()))
    figure, axis = plt.subplots(figsize=(figure_width, figure_height), constrained_layout=True)

    nx.draw_networkx_edges(
        graph,
        positions,
        ax=axis,
        arrows=True,
        arrowstyle="-|>",
        arrowsize=16,
        edge_color="#64748b",
        connectionstyle="arc3,rad=0.08",
        min_source_margin=18,
        min_target_margin=18,
    )
    nx.draw_networkx_nodes(
        graph,
        positions,
        ax=axis,
        node_shape="s",
        node_size=5200,
        node_color="#fff7ed",
        edgecolors="#c2410c",
        linewidths=1.5,
    )
    nx.draw_networkx_labels(
        graph,
        positions,
        labels={node: attrs.get("label", str(node)) for node, attrs in graph.nodes(data=True)},
        ax=axis,
        font_size=8,
        font_color="#1e293b",
        verticalalignment="center",
        horizontalalignment="center",
    )

    # Combine parallel edge labels by endpoint so MultiDiGraph relationships
    # remain readable without relying on Graphviz.
    edge_label_groups: dict[tuple[str, str], list[str]] = {}
    for source, target, attrs in graph.edges(data=True):
        label = str(attrs.get("label", ""))
        if label:
            edge_label_groups.setdefault((source, target), []).append(label)
    nx.draw_networkx_edge_labels(
        graph,
        positions,
        edge_labels={key: "\n".join(labels) for key, labels in edge_label_groups.items()},
        ax=axis,
        font_size=7,
        font_color="#334155",
        label_pos=0.5,
        rotate=False,
        bbox={"alpha": 0.8, "color": "white", "pad": 0.2, "lw": 0},
    )

    axis.set_title(title or _default_title(graph), fontsize=14, color="#0f172a", pad=18)
    axis.axis("off")
    _report(progress, f"Writing ERD to {output}...")
    figure.savefig(output, dpi=dpi, bbox_inches="tight")
    plt.close(figure)
    return output


def _build_graph(
    data_model: Any,
    *,
    tables: Iterable[Any],
    foreign_keys: Iterable[Any],
    include_columns: bool,
    namespace: str,
    progress: Callable[[str], None] | None,
) -> nx.MultiDiGraph:
    graph = nx.MultiDiGraph(
        data_model_id=_value(data_model, "id"),
        data_model_name=_value(data_model, "name"),
        graph_type="celonis_data_model_erd",
    )
    table_items = [table for table in tables if table is not None]
    table_nodes: dict[str, str] = {}

    for table in _progress_tables(table_items, progress=progress, include_columns=include_columns):
        table_id = _identifier(table, "table")
        node_id = f"table:{table_id}"
        table_nodes[table_id] = node_id
        columns = _table_columns(table) if include_columns else []
        primary_keys = _primary_keys(table, columns)
        display_name = _display_table_name(table)
        graph.add_node(
            node_id,
            kind="table",
            table_id=_value(table, "id"),
            name=_value(table, "name"),
            alias=_value(table, "alias"),
            primary_keys=primary_keys,
            columns=columns,
            label=_table_label(display_name, columns, primary_keys),
            namespace=namespace,
        )

    for index, foreign_key in enumerate(foreign_keys):
        if foreign_key is None:
            continue
        source_id = _value(foreign_key, "source_table_id")
        target_id = _value(foreign_key, "target_table_id")
        source_node = table_nodes.get(str(source_id)) if source_id is not None else None
        target_node = table_nodes.get(str(target_id)) if target_id is not None else None
        if source_node is None or target_node is None:
            message = (
                "Skipping Celonis foreign key %r because its source or target table "
                "is not present in the data model."
            )
            warnings.warn(message % _value(foreign_key, "id"), RuntimeWarning, stacklevel=2)
            continue

        columns = _foreign_key_columns(foreign_key)
        relationship_label = ", ".join(f"{source} → {target}" for source, target in columns)
        edge_key = _value(foreign_key, "id") or f"foreign-key-{index}"
        graph.add_edge(
            source_node,
            target_node,
            key=str(edge_key),
            foreign_key_id=_value(foreign_key, "id"),
            columns=columns,
            label=relationship_label or "foreign key",
        )

    return graph


def _progress_tables(
    tables: list[Any],
    *,
    progress: Callable[[str], None] | None,
    include_columns: bool,
) -> Iterable[Any]:
    if progress is None:
        return tables

    from tqdm.auto import tqdm

    description = "Fetching columns" if include_columns else "Processing tables"
    return tqdm(tables, desc=description, unit="table")


def _report(progress: Callable[[str], None] | None, message: str) -> None:
    if progress is not None:
        progress(message)


def _collection(obj: Any, method_name: str, attribute_name: str) -> list[Any]:
    method = getattr(obj, method_name, None)
    if callable(method):
        return [item for item in method() if item is not None]
    value = getattr(obj, attribute_name, None)
    return [] if value is None else [item for item in value if item is not None]


def _call_or_attribute(obj: Any, method_name: str, attribute_name: str, argument: Any) -> Any:
    method = getattr(obj, method_name, None)
    if callable(method):
        return method(argument)
    value = getattr(obj, attribute_name, None)
    if value is None:
        raise AttributeError(f"Object has neither {method_name}() nor {attribute_name!r}.")
    return value


def _value(obj: Any, name: str, default: Any = None) -> Any:
    return getattr(obj, name, default)


def _identifier(obj: Any, prefix: str) -> str:
    value = _value(obj, "id") or _value(obj, "name")
    if value is None:
        raise ValueError(f"{prefix.capitalize()} metadata must have an id or name.")
    return str(value)


def _model_namespace(data_model: Any) -> str:
    return _identifier(data_model, "data model")


def _table_columns(table: Any) -> list[dict[str, Any]]:
    method = getattr(table, "get_columns", None)
    raw_columns = method() if callable(method) else getattr(table, "columns", None)
    columns: list[dict[str, Any]] = []
    for column in raw_columns or []:
        if column is None:
            continue
        name = _value(column, "name")
        if name is None:
            continue
        type_value = _value(column, "type_")
        if type_value is None:
            type_value = _value(column, "type")
        columns.append(
            {
                "name": str(name),
                "type": _enum_value(type_value),
                "primary_key": bool(_value(column, "primary_key", False)),
            }
        )
    return columns


def _primary_keys(table: Any, columns: Sequence[Mapping[str, Any]]) -> list[str]:
    configured = _value(table, "primary_keys") or []
    keys = {str(key) for key in configured if key is not None}
    keys.update(str(column["name"]) for column in columns if column.get("primary_key"))
    return [str(column["name"]) for column in columns if str(column["name"]) in keys] + [
        key for key in sorted(keys) if key not in {str(column["name"]) for column in columns}
    ]


def _foreign_key_columns(foreign_key: Any) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for column in _value(foreign_key, "columns") or []:
        if column is None:
            continue
        source = _value(column, "source_column_name")
        target = _value(column, "target_column_name")
        if source is not None and target is not None:
            pairs.append((str(source), str(target)))
    return pairs


def _display_table_name(table: Any) -> str:
    return str(_value(table, "alias") or _value(table, "name") or _identifier(table, "table"))


def _table_label(name: str, columns: Sequence[Mapping[str, Any]], primary_keys: Sequence[str]) -> str:
    lines = [name]
    primary_key_set = set(primary_keys)
    for column in columns:
        marker = "PK " if column["name"] in primary_key_set else "   "
        type_name = f" : {column['type']}" if column.get("type") else ""
        lines.append(f"{marker}{column['name']}{type_name}")
    return "\n".join(lines)


def _enum_value(value: Any) -> str | None:
    if value is None:
        return None
    return str(getattr(value, "value", value))


def _default_title(graph: nx.MultiDiGraph) -> str:
    pool_name = graph.graph.get("data_pool_name")
    model_name = graph.graph.get("data_model_name")
    if pool_name and model_name:
        return f"{pool_name} / {model_name} ERD"
    if pool_name:
        return f"{pool_name} ERD"
    if model_name:
        return f"{model_name} ERD"
    return "Celonis Data Model ERD"
