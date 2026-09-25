"""ERD helpers for Pycelonis data models.

The data model is represented with small typed containers rather than a graph
library. Each table contains its columns, while each configured Celonis
foreign key is represented by a relationship containing the source/target
column mapping.

This module does not import :mod:`pycelonis` at import time.  That keeps the
graph-building functions easy to test with small metadata doubles and lets a
caller import the package without creating a Celonis connection.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import html
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence


@dataclass
class TableNode:
    """A table and the metadata needed to render it."""

    id: str
    table_id: Any
    name: Any
    alias: Any
    primary_keys: list[str]
    columns: list[dict[str, Any]]
    namespace: str
    data_model_id: Any = None
    data_model_name: Any = None


@dataclass
class Relationship:
    """A configured foreign-key relationship between two table nodes."""

    source: str
    target: str
    key: str
    foreign_key_id: Any
    columns: list[tuple[str, str]]
    label: str


@dataclass
class ERDGraph:
    """A lightweight ERD model consumed by the web and Graphviz renderers."""

    tables: list[TableNode] = field(default_factory=list)
    relationships: list[Relationship] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def number_of_nodes(self) -> int:
        """Return the number of tables, preserving the old graph API helper."""

        return len(self.tables)

    def number_of_edges(self) -> int:
        """Return the number of configured relationships."""

        return len(self.relationships)


def build_data_model_graph(
    data_model: Any,
    *,
    include_columns: bool = True,
    progress: Callable[[str], None] | None = None,
) -> ERDGraph:
    """Build an ERD graph for one Pycelonis ``DataModel``.

    Args:
        data_model: A Pycelonis ``DataModel`` object exposing ``get_tables()``
            and ``get_foreign_keys()``.
        include_columns: If true, fetch table columns and include them in
            table node attributes and labels.
        progress: Optional callback for status messages.

    Returns:
        An :class:`ERDGraph` containing tables and foreign-key relationships.

    Notes:
        Relationships are read from Celonis foreign-key metadata; columns with
        matching names are not treated as a relationship unless Celonis has
        configured the foreign key.
    """

    if progress is not None:
        progress("Fetching table metadata...")
    tables = data_model.get_tables()
    if progress is not None:
        progress(f"Found {len(tables)} table(s).")
        progress("Fetching foreign-key metadata...")
    foreign_keys = data_model.get_foreign_keys()
    if progress is not None:
        progress(f"Found {len(foreign_keys)} foreign-key relationship(s).")

    return _build_graph(
        data_model,
        tables=tables,
        foreign_keys=foreign_keys,
        include_columns=include_columns,
        namespace=str(data_model.id),
        progress=progress,
    )


def build_data_pool_graph(
    data_pool: Any,
    *,
    data_model_id: str | None = None,
    include_columns: bool = True,
    progress: Callable[[str], None] | None = None,
) -> ERDGraph:
    """Build one ERD graph from one data pool.

    If ``data_model_id`` is supplied, only that model is included.  Otherwise
    all data models in the pool are merged into one graph.  Table node IDs are
    namespaced by data model so similarly named tables remain distinct.

    Args:
        progress: Optional callback for status messages.
    """

    if data_model_id is not None:
        if progress is not None:
            progress(f"Loading data model {data_model_id}...")
        data_models = [data_pool.get_data_model(data_model_id)]
    else:
        if progress is not None:
            progress("Fetching data-model metadata...")
        data_models = list(data_pool.get_data_models())
        if not data_models:
            raise ValueError("The Celonis data pool contains no data models.")
    if progress is not None:
        progress(f"Processing {len(data_models)} data model(s)...")

    graph = ERDGraph(
        metadata={
            "data_pool_id": data_pool.id,
            "data_pool_name": data_pool.name,
            "graph_type": "celonis_data_pool_erd",
        }
    )

    for model in data_models:
        model_graph = build_data_model_graph(
            model,
            include_columns=include_columns,
            progress=progress,
        )
        namespace = str(model.id)
        node_ids: dict[str, str] = {}
        for table in model_graph.tables:
            namespaced_id = f"{namespace}/{table.id}"
            node_ids[table.id] = namespaced_id
            graph.tables.append(
                TableNode(
                    id=namespaced_id,
                    table_id=table.table_id,
                    name=table.name,
                    alias=table.alias,
                    primary_keys=table.primary_keys,
                    columns=table.columns,
                    namespace=table.namespace,
                    data_model_id=model.id,
                    data_model_name=model.name,
                )
            )
        graph.relationships.extend(
            Relationship(
                source=node_ids[relationship.source],
                target=node_ids[relationship.target],
                key=f"{namespace}/{relationship.key}",
                foreign_key_id=relationship.foreign_key_id,
                columns=relationship.columns,
                label=relationship.label,
            )
            for relationship in model_graph.relationships
        )

    return graph


def render_erd(
    graph: ERDGraph,
    output_path: str | Path,
    *,
    title: str | None = None,
    seed: int = 42,
    dpi: int = 180,
    progress: Callable[[str], None] | None = None,
) -> Path:
    """Render an ERD model with Graphviz.

    Graphviz is imported lazily so graph construction does not require the
    rendering dependency.  The output format is selected by the extension.
    The Graphviz ``dot`` executable must be installed separately on the host.
    """

    if not graph.number_of_nodes():
        raise ValueError("Cannot render an ERD with no data-model tables.")

    output = Path(output_path)
    output_format = output.suffix.lower().lstrip(".")
    if output_format not in {"png", "svg", "pdf"}:
        raise ValueError("ERD output must use a .png, .svg, or .pdf extension.")

    try:
        from graphviz.backend.execute import CalledProcessError, ExecutableNotFound
    except ImportError as exc:  # pragma: no cover - depends on environment
        raise RuntimeError(
            "Rendering an ERD requires the graphviz Python package. Install the project dependencies "
            "with `uv sync`."
        ) from exc

    output.parent.mkdir(parents=True, exist_ok=True)
    if progress is not None:
        progress("Preparing Graphviz diagram layout...")
    dot = _graphviz_diagram(graph, title=title, seed=seed, dpi=dpi)
    if progress is not None:
        progress(f"Writing ERD to {output}...")

    try:
        output.write_bytes(dot.pipe(format=output_format))
    except ExecutableNotFound as exc:  # pragma: no cover - depends on host setup
        raise RuntimeError(
            "Rendering an ERD requires the Graphviz `dot` executable. "
            "Install Graphviz with `brew install graphviz` (macOS) or your "
            "system package manager, then retry."
        ) from exc
    except CalledProcessError as exc:  # pragma: no cover - depends on Graphviz output
        raise RuntimeError(f"Graphviz failed to render the ERD: {exc}") from exc
    return output


def _graphviz_diagram(
    graph: ERDGraph,
    *,
    title: str | None,
    seed: int,
    dpi: int = 180,
):
    """Build a Graphviz diagram with schema-style table nodes.

    ``seed`` is retained in the renderer API for compatibility.  The DOT
    layout is deterministic for a given Graphviz version, so Graphviz—not a
    force-directed layout—now controls the placement.
    """

    del seed
    from graphviz import Digraph

    dot = Digraph(name="celonis_erd", engine="dot", format="png")
    dot.attr(
        "graph",
        rankdir="TB",
        splines="ortho",
        nodesep="0.65",
        ranksep="0.9",
        pad="0.25",
        bgcolor="white",
        outputorder="edgesfirst",
        labelloc="t",
        label=title or _default_title(graph),
        dpi=str(dpi),
        fontname="Arial",
        fontsize="18",
        fontcolor="#202124",
    )
    dot.attr("node", shape="plain", margin="0")
    dot.attr(
        "edge",
        color="#68736A",
        penwidth="1.0",
        arrowsize="0.7",
        fontname="Arial",
        fontsize="8",
        fontcolor="#4B5563",
    )

    dot_nodes = {table.id: f"n{index}" for index, table in enumerate(graph.tables)}
    port_maps: dict[str, dict[str, str]] = {}
    foreign_key_columns: dict[str, set[str]] = {table.id: set() for table in graph.tables}
    for relationship in graph.relationships:
        foreign_key_columns[relationship.source].update(
            str(source_column).casefold()
            for source_column, _target_column in relationship.columns
        )

    for table in graph.tables:
        columns = table.columns
        port_maps[table.id] = _column_port_map(columns)
        dot.node(
            dot_nodes[table.id],
            label=_html_table_label(
                str(table.alias or table.name or table.id),
                columns,
                table.primary_keys,
                port_maps[table.id],
                foreign_key_columns[table.id],
            ),
        )

    for relationship in graph.relationships:
        edge_attrs: dict[str, str] = {
            "dir": "both",
            # A Celonis FK conventionally describes zero or more source rows
            # referencing one target row.  Graphviz's compound arrow shapes
            # make those cardinalities visible as crow-foot notation without
            # adding noisy cardinality text to the connector.
            "arrowtail": "crowodot",
            "arrowhead": "teetee",
        }
        relationship_label = relationship.label
        if relationship_label:
            # Graphviz's orthogonal router does not support ordinary edge
            # labels reliably.  An xlabel keeps the relationship text while
            # allowing the connector itself to remain orthogonal.
            edge_attrs.update(xlabel=relationship_label)

        columns = relationship.columns
        if columns:
            source_column, target_column = columns[0]
            source_port = _lookup_port(port_maps.get(relationship.source, {}), source_column)
            target_port = _lookup_port(port_maps.get(relationship.target, {}), target_column)
            if source_port:
                edge_attrs["tailport"] = source_port
            if target_port:
                edge_attrs["headport"] = target_port

        dot.edge(dot_nodes[relationship.source], dot_nodes[relationship.target], **edge_attrs)

    return dot


def _column_port_map(columns: Sequence[Mapping[str, Any]]) -> dict[str, str]:
    """Return stable Graphviz port names for a table's columns."""

    return {str(column["name"]): f"column_{index}" for index, column in enumerate(columns)}


def _lookup_port(ports: Mapping[str, str], column_name: Any) -> str | None:
    """Find a column port, allowing metadata casing to differ."""

    name = str(column_name)
    if name in ports:
        return ports[name]
    folded = name.casefold()
    return next((port for column, port in ports.items() if column.casefold() == folded), None)


def _html_table_label(
    name: str,
    columns: Sequence[Mapping[str, Any]],
    primary_keys: Sequence[str],
    ports: Mapping[str, str],
    foreign_key_columns: Sequence[str] = (),
) -> str:
    """Create a Graphviz HTML label styled as a database table card."""

    primary_key_set = {str(key).casefold() for key in primary_keys}
    foreign_key_set = {str(key).casefold() for key in foreign_key_columns}
    rows = [
        '<TR><TD COLSPAN="3" BGCOLOR="#CBE8A0" ALIGN="LEFT" CELLPADDING="7">'
        f'<FONT FACE="Arial"><B>{html.escape(name, quote=True)}</B></FONT></TD></TR>'
    ]
    for column in columns:
        column_name = str(column.get("name", ""))
        column_type = str(column.get("type") or "")
        key_markers = []
        if column_name.casefold() in primary_key_set:
            key_markers.append("PK")
        if column_name.casefold() in foreign_key_set:
            key_markers.append("FK")
        key_marker = "/".join(key_markers)
        port = ports.get(column_name, "")
        port_attribute = f' PORT="{html.escape(port, quote=True)}"' if port else ""
        rows.append(
            "<TR>"
            f'<TD ALIGN="LEFT" BGCOLOR="#F5F8EC" CELLPADDING="5">{html.escape(column_type, quote=True)}</TD>'
            f'<TD ALIGN="LEFT" BGCOLOR="#F5F8EC" CELLPADDING="5"{port_attribute}>'
            f'{html.escape(column_name, quote=True)}</TD>'
            f'<TD ALIGN="CENTER" BGCOLOR="#F5F8EC" CELLPADDING="5">{key_marker}</TD>'
            "</TR>"
        )
    if not columns:
        rows.append(
            '<TR><TD COLSPAN="3" ALIGN="LEFT" CELLPADDING="5">'
            '<FONT COLOR="#6B7280">No columns loaded</FONT></TD></TR>'
        )

    return (
        '<<TABLE BORDER="1" COLOR="#5C7D4E" CELLBORDER="1" CELLSPACING="0" CELLPADDING="0">'
        + "".join(rows)
        + "</TABLE>>"
    )


def _build_graph(
    data_model: Any,
    *,
    tables: Iterable[Any],
    foreign_keys: Iterable[Any],
    include_columns: bool,
    namespace: str,
    progress: Callable[[str], None] | None,
) -> ERDGraph:
    graph = ERDGraph(
        metadata={
            "data_model_id": data_model.id,
            "data_model_name": data_model.name,
            "graph_type": "celonis_data_model_erd",
        }
    )
    table_items = [table for table in tables if table is not None]
    table_nodes: dict[str, str] = {}
    table_primary_keys: dict[str, set[str]] = {}

    if progress is not None:
        progress(f"Preparing {len(table_items)} table(s)...")
    table_records: list[tuple[Any, str, str, str]] = []
    for table in table_items:
        table_id = str(table.id)
        node_id = f"table:{table_id}"
        table_nodes[table_id] = node_id
        table_records.append((table, table_id, node_id, str(table.alias or table.name or table.id)))

    columns_by_node = _fetch_table_columns_parallel(
        table_records,
        include_columns=include_columns,
        progress=progress,
    )

    for table, _table_id, node_id, _display_name in table_records:
        columns = columns_by_node[node_id]
        primary_keys = _primary_keys(table, columns)
        table_primary_keys[node_id] = {key.casefold() for key in primary_keys}
        graph.tables.append(
            TableNode(
                id=node_id,
                table_id=table.id,
                name=table.name,
                alias=table.alias,
                primary_keys=primary_keys,
                columns=columns,
                namespace=namespace,
            )
        )

    for index, foreign_key in enumerate(foreign_keys):
        if foreign_key is None:
            continue
        source_id = foreign_key.source_table_id
        target_id = foreign_key.target_table_id
        source_node = table_nodes.get(str(source_id)) if source_id is not None else None
        target_node = table_nodes.get(str(target_id)) if target_id is not None else None
        if source_node is None or target_node is None:
            message = (
                "Skipping Celonis foreign key %r because its source or target table "
                "is not present in the data model."
            )
            warnings.warn(message % getattr(foreign_key, "id", None), RuntimeWarning, stacklevel=2)
            continue

        columns = _foreign_key_columns(foreign_key)
        source_node, target_node, columns = _orient_relationship(
            source_node,
            target_node,
            columns,
            table_primary_keys,
        )
        relationship_label = ", ".join(f"{source} → {target}" for source, target in columns)
        edge_key = getattr(foreign_key, "id", None) or f"foreign-key-{index}"
        graph.relationships.append(
            Relationship(
                source=source_node,
                target=target_node,
                key=str(edge_key),
                foreign_key_id=getattr(foreign_key, "id", None),
                columns=columns,
                label=relationship_label or "foreign key",
            )
        )

    return graph


def _fetch_table_columns_parallel(
    table_records: Sequence[tuple[Any, str, str, str]],
    *,
    include_columns: bool,
    progress: Callable[[str], None] | None,
    max_workers: int = 16,
) -> dict[str, list[dict[str, Any]]]:
    """Fetch table columns concurrently while preserving deterministic output order."""

    columns_by_node = {node_id: [] for _table, _table_id, node_id, _display_name in table_records}
    if not include_columns or not table_records:
        return columns_by_node

    total = len(table_records)
    _columns_started(progress, total)
    worker_count = min(max_workers, total)
    with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="erd-columns") as executor:
        futures = {
            executor.submit(_table_columns, table, include_columns=True, progress=None): (table_name, node_id)
            for table, _table_id, node_id, table_name in table_records
        }
        completed = 0
        for future in as_completed(futures):
            table_name, node_id = futures[future]
            columns_by_node[node_id] = future.result()
            completed += 1
            _columns_updated(progress, completed, total, table_name)

    _columns_finished(progress)
    return columns_by_node


def _columns_started(progress: Callable[[str], None] | None, total: int) -> None:
    """Notify a rich-aware reporter that concurrent column work started."""

    method = getattr(progress, "start_columns", None)
    if callable(method):
        method(total)
    else:
        if progress is not None:
            progress(f"Fetching columns (0/{total})...")


def _columns_updated(
    progress: Callable[[str], None] | None,
    completed: int,
    total: int,
    table_name: str,
) -> None:
    """Notify a rich-aware reporter about one completed column request."""

    method = getattr(progress, "update_columns", None)
    if callable(method):
        method(completed, table_name)
    else:
        if progress is not None:
            progress(f"Fetched columns ({completed}/{total}): {table_name}")


def _columns_finished(progress: Callable[[str], None] | None) -> None:
    """Close a rich-aware column progress display."""

    method = getattr(progress, "finish_columns", None)
    if callable(method):
        method()


def _table_columns(
    table: Any,
    *,
    include_columns: bool,
    progress: Callable[[str], None] | None,
) -> list[dict[str, Any]]:
    """Load complete columns, using embedded metadata only as a fallback.

    Pycelonis exposes ``table.columns`` as partial information and emits a
    warning when it is accessed. ``get_columns()`` calls the table-column
    endpoint and returns the complete schema, so it must be preferred even
    when the table object already has an embedded ``columns`` attribute.
    """

    if not include_columns:
        return []
    method = getattr(table, "get_columns", None)
    if callable(method):
        return _normalise_columns(method() or [])

    columns = getattr(table, "columns", None)
    return _normalise_columns(column for column in (columns or []) if column is not None)


def _normalise_columns(raw_columns: Iterable[Any]) -> list[dict[str, Any]]:
    """Convert Pycelonis column objects into stable graph metadata."""

    columns: list[dict[str, Any]] = []
    for column in raw_columns:
        if column is None:
            continue
        if isinstance(column, Mapping):
            name = column.get("name")
            type_value = column.get("type_") or column.get("type")
            primary_key = column.get("primary_key", False)
        else:
            name = column.name
            type_value = getattr(column, "type_", None) or getattr(column, "type", None)
            primary_key = getattr(column, "primary_key", False)
        if name is None:
            continue
        columns.append(
            {
                "name": str(name),
                "type": None if type_value is None else str(getattr(type_value, "value", type_value)),
                "primary_key": bool(primary_key),
            }
        )
    return columns


def _primary_keys(table: Any, columns: Sequence[Mapping[str, Any]]) -> list[str]:
    configured = getattr(table, "primary_keys", None) or []
    keys = {str(key) for key in configured if key is not None}
    keys.update(str(column["name"]) for column in columns if column.get("primary_key"))
    return [str(column["name"]) for column in columns if str(column["name"]) in keys] + [
        key for key in sorted(keys) if key not in {str(column["name"]) for column in columns}
    ]


def _foreign_key_columns(foreign_key: Any) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for column in getattr(foreign_key, "columns", None) or []:
        if column is None:
            continue
        source = getattr(column, "source_column_name", None)
        target = getattr(column, "target_column_name", None)
        if source is not None and target is not None:
            pairs.append((str(source), str(target)))
    return pairs


def _orient_relationship(
    source_node: str,
    target_node: str,
    columns: list[tuple[str, str]],
    table_primary_keys: Mapping[str, set[str]],
) -> tuple[str, str, list[tuple[str, str]]]:
    """Orient a relationship from the FK column to the referenced column.

    Celonis provides source/target table IDs, but some models expose that
    pair in the reverse direction relative to the relational FK convention.
    When one endpoint is a primary key and the other is not, the non-primary
    endpoint is the FK side. This keeps the FK marker and Graphviz ports
    aligned with the actual child column (for example ``Vendor_ID``).
    """

    if not columns:
        return source_node, target_node, columns

    source_keys = table_primary_keys.get(source_node, set())
    target_keys = table_primary_keys.get(target_node, set())
    source_is_primary = all(column.casefold() in source_keys for column, _ in columns)
    target_is_primary = all(column.casefold() in target_keys for _, column in columns)
    if source_is_primary and not target_is_primary:
        return target_node, source_node, [(target, source) for source, target in columns]
    return source_node, target_node, columns


def _default_title(graph: ERDGraph) -> str:
    pool_name = graph.metadata.get("data_pool_name")
    model_name = graph.metadata.get("data_model_name")
    if pool_name and model_name:
        return f"{pool_name} / {model_name} ERD"
    if pool_name:
        return f"{pool_name} ERD"
    if model_name:
        return f"{model_name} ERD"
    return "Celonis Data Model ERD"
