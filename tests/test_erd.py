from dataclasses import dataclass, field

import networkx as nx

from erd_celonis.cli import first_data_model_id
from erd_celonis.erd import build_data_model_graph, build_data_pool_graph


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

    assert isinstance(graph, nx.MultiDiGraph)
    assert set(graph.nodes) == {"table:orders-id", "table:customers-id"}
    assert graph.nodes["table:orders-id"]["primary_keys"] == ["ORDER_ID"]
    assert graph.nodes["table:orders-id"]["columns"][0]["name"] == "ORDER_ID"
    assert graph.nodes["table:orders-id"]["label"].startswith("Orders\nPK ORDER_ID")
    assert graph.number_of_edges() == 1
    edge = next(iter(graph.edges(data=True)))[2]
    assert edge["columns"] == [("CUSTOMER_ID", "CUSTOMER_ID")]
    assert edge["label"] == "CUSTOMER_ID → CUSTOMER_ID"


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

    assert set(all_models.nodes) == {"model-a/table:table-a", "model-b/table:table-b"}
    assert all_models.nodes["model-b/table:table-b"]["data_model_name"] == "B"
    assert set(selected.nodes) == {"model-b/table:table-b"}


def test_first_data_model_id_returns_the_first_model():
    class Pool:
        def get_data_models(self):
            return [DataModel("first", "First", [], []), DataModel("second", "Second", [], [])]

    assert first_data_model_id(Pool()) == "first"


def test_first_data_model_id_rejects_an_empty_pool():
    class Pool:
        def get_data_models(self):
            return []

    import pytest

    with pytest.raises(ValueError, match="contains no data models"):
        first_data_model_id(Pool())


def test_dotenv_search_uses_the_command_working_directory(tmp_path, monkeypatch):
    from dotenv import find_dotenv

    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text("CELONIS_URL=https://example.celonis.cloud\n")
    monkeypatch.chdir(tmp_path)

    assert find_dotenv(usecwd=True) == str(dotenv_path)
