from erd_celonis.ddl import graph_to_ddl
from erd_celonis.erd import ERDGraph, Relationship, TableNode


def test_graph_to_ddl_describes_tables_keys_and_relationships():
    graph = ERDGraph(
        metadata={
            "data_pool_name": "Sales Pool",
            "data_model_name": "Sales",
        },
        tables=[
            TableNode(
                id="model/table:orders",
                table_id="orders-id",
                name="ORDERS",
                alias="Orders",
                primary_keys=["ORDER_ID"],
                columns=[
                    {"name": "ORDER_ID", "type": "INTEGER", "primary_key": True},
                    {"name": "CUSTOMER_ID", "type": "INTEGER", "primary_key": False},
                ],
                namespace="model",
            ),
            TableNode(
                id="model/table:customers",
                table_id="customers-id",
                name="CUSTOMERS",
                alias=None,
                primary_keys=["CUSTOMER_ID"],
                columns=[{"name": "CUSTOMER_ID", "type": "INTEGER", "primary_key": True}],
                namespace="model",
            ),
        ],
        relationships=[
            Relationship(
                source="model/table:orders",
                target="model/table:customers",
                key="model/orders-customers",
                foreign_key_id="orders-customers",
                columns=[("CUSTOMER_ID", "CUSTOMER_ID")],
                label="CUSTOMER_ID → CUSTOMER_ID",
            )
        ],
    )

    ddl = graph_to_ddl(graph)

    assert 'CREATE TABLE "ORDERS" (' in ddl
    assert '"ORDER_ID" INTEGER,\n  "CUSTOMER_ID" INTEGER,\n  PRIMARY KEY ("ORDER_ID")' in ddl
    assert 'CREATE TABLE "CUSTOMERS" (' in ddl
    assert 'ALTER TABLE "ORDERS"\n  ADD FOREIGN KEY ("CUSTOMER_ID")\n  REFERENCES "CUSTOMERS" ("CUSTOMER_ID");' in ddl


def test_graph_to_ddl_preserves_composite_keys_and_quotes_identifiers():
    graph = ERDGraph(
        tables=[
            TableNode(
                id="table/id",
                table_id="table-id",
                name='ORDER "LINES"',
                alias=None,
                primary_keys=["ORDER_ID", "LINE_NUMBER"],
                columns=[
                    {"name": "ORDER_ID", "type": "INTEGER", "primary_key": False},
                    {"name": "LINE_NUMBER", "type": "INTEGER", "primary_key": False},
                ],
                namespace="model",
            )
        ]
    )

    ddl = graph_to_ddl(graph)

    assert 'CREATE TABLE "ORDER ""LINES""" (' in ddl
    assert 'PRIMARY KEY ("ORDER_ID", "LINE_NUMBER")' in ddl


def test_graph_to_ddl_requires_column_metadata():
    graph = ERDGraph(
        tables=[
            TableNode(
                id="table-id",
                table_id="table-id",
                name="ORDERS",
                alias=None,
                primary_keys=[],
                columns=[],
                namespace="model",
            )
        ]
    )

    try:
        graph_to_ddl(graph)
    except ValueError as error:
        assert "column metadata was not loaded" in str(error)
    else:
        raise AssertionError("Expected DDL serialization to reject missing columns")
