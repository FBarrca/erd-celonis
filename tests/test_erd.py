from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor
import sys
from threading import Barrier, Event, get_ident
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import erd_celonis.cli as cli
import erd_celonis.erd as erd_module
from erd_celonis.cli import _StatusLine, _configured_key_type
from erd_celonis.erd import (
    ERDGraph,
    _column_port_map,
    _graphviz_diagram,
    _html_table_label,
    build_data_model_graph,
    build_data_pool_graph,
)


@dataclass
class Column:
    name: str
    type_: str = "STRING"
    primary_key: bool = False


@dataclass
class Table:
    id: str
    name: str
    alias: str | None = None
    primary_keys: list[str] = field(default_factory=list)
    columns: list[Column] = field(default_factory=list)

    def get_columns(self):
        return self.columns


@dataclass
class ForeignKeyColumn:
    source_column_name: str
    target_column_name: str


@dataclass
class ForeignKey:
    id: str
    source_table_id: str
    target_table_id: str
    columns: list[ForeignKeyColumn]


@dataclass
class DataModel:
    id: str
    name: str
    tables: list[Table]
    foreign_keys: list[ForeignKey]

    def get_tables(self):
        return self.tables

    def get_foreign_keys(self):
        return self.foreign_keys


def test_build_data_model_graph_adds_tables_columns_and_relationships():
    orders = Table(
        id="orders-id",
        name="ORDERS",
        alias="Orders",
        primary_keys=["ORDER_ID"],
        columns=[Column("ORDER_ID", "INTEGER"), Column("CUSTOMER_ID")],
    )
    customers = Table(
        id="customers-id",
        name="CUSTOMERS",
        primary_keys=["CUSTOMER_ID"],
        columns=[Column("CUSTOMER_ID", "INTEGER")],
    )
    foreign_key = ForeignKey(
        id="orders-customers",
        source_table_id=orders.id,
        target_table_id=customers.id,
        columns=[ForeignKeyColumn("CUSTOMER_ID", "CUSTOMER_ID")],
    )

    graph = build_data_model_graph(DataModel("model-id", "Sales", [orders, customers], [foreign_key]))

    assert isinstance(graph, ERDGraph)
    assert graph.metadata["data_model_name"] == "Sales"
    assert {table.id for table in graph.tables} == {"table:orders-id", "table:customers-id"}
    orders_node = next(table for table in graph.tables if table.id == "table:orders-id")
    assert orders_node.primary_keys == ["ORDER_ID"]
    assert orders_node.columns[0]["name"] == "ORDER_ID"
    assert orders_node.alias == "Orders"
    assert graph.number_of_edges() == 1
    edge = graph.relationships[0]
    assert edge.columns == [("CUSTOMER_ID", "CUSTOMER_ID")]
    assert edge.label == "CUSTOMER_ID → CUSTOMER_ID"


def test_build_data_model_graph_orients_reversed_fk_to_non_primary_column():
    vendor = Table(
        id="vendor-id",
        name="VENDOR",
        primary_keys=["ID"],
        columns=[Column("ID", "INTEGER")],
    )
    purchase_document = Table(
        id="purchase-document-id",
        name="PURCHASE_DOCUMENT",
        columns=[Column("VENDOR_ID", "INTEGER")],
    )
    reversed_foreign_key = ForeignKey(
        id="vendor-purchase-document",
        source_table_id=vendor.id,
        target_table_id=purchase_document.id,
        columns=[ForeignKeyColumn("ID", "VENDOR_ID")],
    )

    graph = build_data_model_graph(
        DataModel("model-id", "Purchasing", [vendor, purchase_document], [reversed_foreign_key])
    )

    relationship = graph.relationships[0]
    assert relationship.source == "table:purchase-document-id"
    assert relationship.target == "table:vendor-id"
    assert relationship.columns == [("VENDOR_ID", "ID")]
    dot = _graphviz_diagram(graph, title="Purchasing ERD", seed=42)
    assert 'PORT="column_0">VENDOR_ID' in dot.source
    assert ">FK<" in dot.source


def test_build_data_model_graph_reports_metadata_progress():
    model = DataModel("model-id", "Sales", [Table("table-id", "ORDERS")], [])
    messages = []

    build_data_model_graph(model, progress=messages.append)

    assert messages == [
        "Fetching table and foreign-key metadata for 1 data model(s)...",
        "Found 1 table(s).",
        "Found 0 foreign-key relationship(s).",
        "Fetching columns (0/1)...",
        "Fetched columns (1/1): ORDERS",
    ]


def test_build_data_model_graph_prefers_complete_columns_endpoint_over_partial_metadata():
    class TableWithPartialEmbeddedColumns:
        id = "table-id"
        name = "ORDERS"
        alias = None
        primary_keys = ["ID"]
        columns = [Column("ID", "INTEGER", primary_key=True)]

        def get_columns(self):
            return [
                Column("ID", "INTEGER", primary_key=True),
                Column("MaterialName", "STRING"),
            ]

    model = DataModel("model-id", "Sales", [TableWithPartialEmbeddedColumns()], [])
    graph = build_data_model_graph(model)

    assert graph.tables[0].columns == [
        {"name": "ID", "type": "INTEGER", "primary_key": True},
        {"name": "MaterialName", "type": "STRING", "primary_key": False},
    ]


def test_build_data_model_graph_uses_embedded_columns_without_endpoint():
    class MetadataOnlyTable:
        id = "table-id"
        name = "ORDERS"
        alias = None
        primary_keys = ["ID"]
        columns = [Column("ID", "INTEGER", primary_key=True)]

    graph = build_data_model_graph(DataModel("model-id", "Sales", [MetadataOnlyTable()], []))

    assert graph.tables[0].columns == [
        {"name": "ID", "type": "INTEGER", "primary_key": True}
    ]


def test_build_data_model_graph_fetches_columns_only_when_missing():
    class TableWithoutEmbeddedColumns:
        id = "table-id"
        name = "ORDERS"
        alias = None
        primary_keys = ["ID"]
        columns = None

        def __init__(self):
            self.column_requests = 0

        def get_columns(self):
            self.column_requests += 1
            return [Column("ID", "INTEGER", primary_key=True)]

    table = TableWithoutEmbeddedColumns()
    model = DataModel("model-id", "Sales", [table], [])
    graph = build_data_model_graph(model)

    assert table.column_requests == 1
    assert graph.tables[0].columns[0]["name"] == "ID"


def test_build_data_pool_graph_namespaces_models_and_can_select_one_model():
    model_a = DataModel("model-a", "A", [Table("table-a", "A_TABLE")], [])
    model_b = DataModel("model-b", "B", [Table("table-b", "B_TABLE")], [])

    class Pool:
        id = "pool-id"
        name = "Pool"

        def get_data_models(self):
            return [model_a, model_b]

        def get_data_model(self, model_id):
            return {model_a.id: model_a, model_b.id: model_b}[model_id]

    all_models = build_data_pool_graph(Pool())
    selected = build_data_pool_graph(Pool(), data_model_id="model-b")

    assert {table.id for table in all_models.tables} == {
        "model-a/table:table-a",
        "model-b/table:table-b",
    }
    model_b_table = next(table for table in all_models.tables if table.id == "model-b/table:table-b")
    assert model_b_table.data_model_name == "B"
    assert {table.id for table in selected.tables} == {"model-b/table:table-b"}


class SchemaProgress:
    def __init__(self):
        self.thread_id = get_ident()
        self.events = []

    def record(self, *event):
        assert get_ident() == self.thread_id
        self.events.append(event)

    def __call__(self, message):
        self.record("message", message)

    def start_columns(self, total):
        self.record("start", total)

    def update_columns(self, completed, table_name):
        self.record("update", completed, table_name)

    def finish_columns(self):
        self.record("finish")


def test_pool_overlaps_metadata_and_columns_across_models_in_source_order():
    metadata_barrier = Barrier(4, timeout=5)
    columns_barrier = Barrier(4, timeout=5)
    last_table_started = Event()

    class ConcurrentTable(Table):
        def get_columns(self):
            columns_barrier.wait()
            if self.name == "model-a-orders":
                assert last_table_started.wait(5)
            if self.name == "model-b-items":
                last_table_started.set()
            return [Column(self.name)]

    class ConcurrentModel(DataModel):
        def get_tables(self):
            metadata_barrier.wait()
            return self.tables

        def get_foreign_keys(self):
            metadata_barrier.wait()
            return self.foreign_keys

    models = [ConcurrentModel(model_id, model_id, [
        ConcurrentTable("orders", f"{model_id}-orders"),
        ConcurrentTable("items", f"{model_id}-items"),
    ], [ForeignKey("join", "items", "orders", [ForeignKeyColumn("ORDER_ID", "ID")])])
        for model_id in ["model-a", "model-b"]]
    progress = SchemaProgress()
    pool = SimpleNamespace(id="pool", name="Pool", get_data_models=lambda: models)

    graph = build_data_pool_graph(pool, progress=progress)

    assert [table.id for table in graph.tables] == [
        f"{model}/table:{table}" for model in ["model-a", "model-b"] for table in ["orders", "items"]
    ]
    assert [table.columns[0]["name"] for table in graph.tables] == [
        "model-a-orders", "model-a-items", "model-b-orders", "model-b-items",
    ]
    assert [(edge.key, edge.source, edge.target) for edge in graph.relationships] == [
        (f"{model}/join", f"{model}/table:items", f"{model}/table:orders")
        for model in ["model-a", "model-b"]
    ]
    assert [event for event in progress.events if event[0] == "start"] == [("start", 4)]
    assert [event[1] for event in progress.events if event[0] == "update"] == [1, 2, 3, 4]
    assert progress.events[-1] == ("finish",)


def test_pool_uses_one_executor_with_at_most_10_outstanding_requests(monkeypatch):
    executors = []
    barrier = Barrier(10, timeout=5)

    class RecordingExecutor(ThreadPoolExecutor):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.submitted = []
            self.peak_pending = 0
            executors.append(self)

        def submit(self, *args, **kwargs):
            pending = sum(not future.done() for future in self.submitted)
            future = super().submit(*args, **kwargs)
            self.submitted.append(future)
            self.peak_pending = max(self.peak_pending, pending + 1)
            return future

    class ConcurrentTable(Table):
        def get_columns(self):
            barrier.wait()
            return [Column("ID")]

    class ConcurrentModel(DataModel):
        def get_tables(self):
            barrier.wait()
            return self.tables

        def get_foreign_keys(self):
            barrier.wait()
            return []

    models = [ConcurrentModel(str(i), str(i), [
        ConcurrentTable("orders", "Orders"), ConcurrentTable("items", "Items"),
    ], []) for i in range(20)]
    monkeypatch.setattr(erd_module, "ThreadPoolExecutor", RecordingExecutor)

    graph = build_data_pool_graph(SimpleNamespace(id="pool", name="Pool", get_data_models=lambda: models))

    assert len(graph.tables) == 40
    assert len(executors) == 1
    assert len(executors[0].submitted) == 80  # 40 metadata and 40 column requests.
    assert executors[0].peak_pending == 10


def test_table_only_loading_overlaps_metadata_and_skips_columns():
    barrier = Barrier(2, timeout=5)
    table = Table("orders", "Orders")
    table.get_columns = Mock(side_effect=AssertionError("Columns must not be fetched"))

    class ConcurrentModel(DataModel):
        def get_tables(self):
            barrier.wait()
            return [None, table]

        def get_foreign_keys(self):
            barrier.wait()
            return [None]

    progress = SchemaProgress()
    graph = build_data_model_graph(ConcurrentModel("model", "Model", [], []), include_columns=False, progress=progress)

    assert len(graph.tables) == 1
    assert graph.tables[0].columns == []
    table.get_columns.assert_not_called()
    assert all(event[0] == "message" for event in progress.events)


@pytest.mark.parametrize("failing_method", ["get_tables", "get_foreign_keys", "get_columns"])
def test_schema_request_errors_propagate_and_close_column_progress(failing_method):
    table = Table("orders", "Orders")
    model = DataModel("model", "Model", [table], [])
    error = RuntimeError("Schema unavailable")
    target = table if failing_method == "get_columns" else model
    setattr(target, failing_method, Mock(side_effect=error))
    progress = SchemaProgress()

    with pytest.raises(RuntimeError, match="Schema unavailable") as caught:
        build_data_model_graph(model, progress=progress)

    assert caught.value is error
    if failing_method == "get_columns":
        assert progress.events[-1] == ("finish",)


def test_empty_model_has_no_column_progress():
    progress = SchemaProgress()
    graph = build_data_model_graph(DataModel("model", "Model", [], []), progress=progress)
    assert graph.tables == []
    assert graph.relationships == []
    assert all(event[0] == "message" for event in progress.events)


def stub_cli_pool(monkeypatch, models):
    pool = SimpleNamespace(
        id="pool-id", name="Pool",
        get_data_models=Mock(return_value=models),
        get_data_model=Mock(side_effect=lambda model_id: next(model for model in models if model.id == model_id)),
    )
    get_pool = Mock(return_value=pool)
    monkeypatch.setitem(sys.modules, "celofast", SimpleNamespace(
        get_celonis=lambda **kwargs: SimpleNamespace(data_integration=SimpleNamespace(get_data_pool=get_pool)),
    ))
    monkeypatch.setitem(sys.modules, "dotenv", SimpleNamespace(
        find_dotenv=lambda **kwargs: "", load_dotenv=lambda path: None,
    ))
    serve = Mock()
    monkeypatch.setattr(cli, "serve_graph", serve)
    return pool, get_pool, serve


@pytest.mark.parametrize("model_count,selected_model,include_columns", [
    (2, None, True), (2, None, False), (2, "model-1", True), (1, None, True),
])
def test_cli_loads_all_pool_models_unless_one_is_selected(monkeypatch, model_count, selected_model, include_columns):
    models = [DataModel(f"model-{i}", f"Model {i}", [
        Table("orders", "ORDERS", columns=[Column("ID")]),
        Table("items", "ITEMS", columns=[Column("ORDER_ID")]),
    ], [ForeignKey("join", "items", "orders", [ForeignKeyColumn("ORDER_ID", "ID")])]) for i in range(model_count)]
    pool, get_pool, serve = stub_cli_pool(monkeypatch, models)
    args = ["pool-id"] if selected_model is None else ["pool-id", selected_model]

    cli.erd(*args, include_columns=include_columns, host="127.0.0.1", port=8123, open_browser=False)

    get_pool.assert_called_once_with("pool-id")
    serve.assert_called_once()
    graph = serve.call_args.args[0]
    expected_ids = {selected_model} if selected_model else {model.id for model in models}
    assert {table.data_model_id for table in graph.tables} == expected_ids
    assert {table.id for table in graph.tables} == {f"{model}/table:{table}" for model in expected_ids for table in ["orders", "items"]}
    assert {edge.key for edge in graph.relationships} == {f"{model}/join" for model in expected_ids}
    assert all(bool(table.columns) == include_columns for table in graph.tables)
    options = serve.call_args.kwargs
    assert {key: options[key] for key in ["host", "port", "open_browser"]} == {"host": "127.0.0.1", "port": 8123, "open_browser": False}
    assert options["query_runner"].data_pool is pool
    assert options["query_runner"].model_ids == expected_ids
    if selected_model is None:
        pool.get_data_models.assert_called_once_with()
        pool.get_data_model.assert_not_called()
    else:
        pool.get_data_model.assert_called_once_with(selected_model)
        pool.get_data_models.assert_not_called()


def test_cli_rejects_empty_pool_before_starting_server(monkeypatch):
    _, _, serve = stub_cli_pool(monkeypatch, [])
    with pytest.raises(ValueError, match="contains no data models"):
        cli.erd("pool-id")
    serve.assert_not_called()


def test_configured_key_type_is_explicit_and_can_be_overridden(monkeypatch):
    monkeypatch.delenv("CELONIS_KEY_TYPE", raising=False)

    assert _configured_key_type(None) == "USER_KEY"

    monkeypatch.setenv("CELONIS_KEY_TYPE", "APP_KEY")
    assert _configured_key_type(None) == "APP_KEY"
    assert _configured_key_type("BEARER") == "BEARER"


def test_status_line_falls_back_to_lines_for_non_interactive_stream():
    from io import StringIO
    from rich.console import Console

    stream = StringIO()
    status = _StatusLine(Console(file=stream, force_terminal=False))
    status.report("Loading...")
    status.report("Done.")
    status.close()

    assert stream.getvalue() == "[erd-celonis] Loading...\n[erd-celonis] Done.\n"


def test_status_line_rewrites_one_line_for_interactive_stream():
    class FakeStatus:
        def __init__(self, initial):
            self.updates = [initial]
            self.started = False
            self.stopped = False

        def start(self):
            self.started = True

        def update(self, message):
            self.updates.append(message)

        def stop(self):
            self.stopped = True

    class FakeConsole:
        is_terminal = True

        def __init__(self):
            self.status_instance = None

        def status(self, message, **_kwargs):
            self.status_instance = FakeStatus(message)
            return self.status_instance

    console = FakeConsole()
    status = _StatusLine(console)
    status.report("Loading...")
    status.report("Done.")
    status.close()

    assert console.status_instance.updates == [
        "[erd-celonis] Loading...",
        "[erd-celonis] Done.",
    ]
    assert console.status_instance.started
    assert console.status_instance.stopped


def test_status_line_reports_column_progress_with_eta_fallback():
    from io import StringIO
    from rich.console import Console

    stream = StringIO()
    status = _StatusLine(Console(file=stream, force_terminal=False))
    status.start_columns(4)
    status.update_columns(2, "MATERIAL")
    status.finish_columns()

    output = stream.getvalue()
    assert "Fetching columns (0/4)" in output
    assert "Fetched columns (2/4): MATERIAL" in output
    assert "ETA" in output


def test_status_line_uses_rich_progress_for_terminal_column_fetches():
    class FakeProgress:
        def __init__(self):
            self.started = False
            self.stopped = False
            self.updates = []

        def add_task(self, *_args, **_kwargs):
            return 1

        def start(self):
            self.started = True

        def update(self, task_id, **kwargs):
            self.updates.append((task_id, kwargs))

        def stop(self):
            self.stopped = True

    class FakeConsole:
        is_terminal = True

    from unittest.mock import patch

    fake_progress = FakeProgress()
    with patch("erd_celonis.cli.Progress", return_value=fake_progress):
        status = _StatusLine(FakeConsole())
        status.start_columns(3)
        status.update_columns(1, "MATERIAL")
        status.finish_columns()

    assert fake_progress.started
    assert fake_progress.updates == [
        (1, {"completed": 1, "description": "[erd-celonis] Fetching columns: MATERIAL"})
    ]
    assert fake_progress.stopped


def test_status_line_is_callable_for_erd_progress_callbacks():
    class FakeConsole:
        is_terminal = False

        def print(self, *_args, **_kwargs):
            pass

    status = _StatusLine(FakeConsole())

    assert callable(status)
    status("Loading...")


def test_dotenv_search_uses_the_command_working_directory(tmp_path, monkeypatch):
    from dotenv import find_dotenv

    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text("CELONIS_URL=https://example.celonis.cloud\n")
    monkeypatch.chdir(tmp_path)

    assert find_dotenv(usecwd=True) == str(dotenv_path)


def test_graphviz_diagram_uses_table_cards_and_column_ports():
    orders = Table(
        id="orders-id",
        name="ORDERS",
        primary_keys=["ORDER_ID"],
        columns=[Column("ORDER_ID", "INTEGER"), Column("CUSTOMER_ID")],
    )
    customers = Table(
        id="customers-id",
        name="CUSTOMERS",
        primary_keys=["CUSTOMER_ID"],
        columns=[Column("CUSTOMER_ID", "INTEGER")],
    )
    model = DataModel(
        "model-id",
        "Sales",
        [orders, customers],
        [
            ForeignKey(
                "orders-customers",
                orders.id,
                customers.id,
                [ForeignKeyColumn("CUSTOMER_ID", "CUSTOMER_ID")],
            )
        ],
    )

    graph = build_data_model_graph(model)
    dot = _graphviz_diagram(graph, title="Sales ERD", seed=42)

    assert "shape=plain" in dot.source
    assert "splines=ortho" in dot.source
    assert 'BGCOLOR="#CBE8A0"' in dot.source
    assert 'PORT="column_1"' in dot.source
    assert "arrowtail=crowodot" in dot.source
    assert "arrowhead=teetee" in dot.source
    assert "taillabel" not in dot.source
    assert "headlabel" not in dot.source
    assert "tailport=column_1" in dot.source
    assert "headport=column_0" in dot.source
    assert ">FK<" in dot.source


def test_html_table_label_escapes_metadata_and_marks_primary_keys():
    columns = [{"name": "user<id>", "type": "VARCHAR", "primary_key": True}]
    ports = _column_port_map(columns)

    label = _html_table_label(
        "users & accounts",
        columns,
        ["user<id>"],
        ports,
        ["user<id>"],
    )

    assert "users &amp; accounts" in label
    assert "user&lt;id&gt;" in label
    assert ">PK/FK<" in label
