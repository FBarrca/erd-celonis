import inspect
import json
import re
from dataclasses import dataclass
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import Mock

import pytest

from erd_celonis.cli import erd
from erd_celonis.erd import ERDGraph, Relationship, TableNode
from erd_celonis.web import graph_to_dict, make_server
from erd_celonis.query import QueryError


@dataclass
class EnumLike:
    value: str


@pytest.fixture
def sample_graph():
    return ERDGraph(
        tables=[
            TableNode(
                id="model/table:orders",
                table_id="orders",
                name="ORDERS",
                alias="Orders",
                primary_keys=["ORDER_ID"],
                columns=[
                    {"name": "ORDER_ID", "type": EnumLike("INTEGER"), "primary_key": True},
                    {"name": "CUSTOMER_ID", "type": "STRING", "primary_key": False},
                ],
                namespace="model",
                data_model_id="model",
                data_model_name="Sales",
            ),
            TableNode(
                id="model/table:customers",
                table_id="customers",
                name="CUSTOMERS",
                alias="Customers",
                primary_keys=["CUSTOMER_ID"],
                columns=[{"name": "CUSTOMER_ID", "type": "STRING", "primary_key": True}],
                namespace="model",
                data_model_id="model",
                data_model_name="Sales",
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
        metadata={"title": "Sales ERD", "kind": EnumLike("celonis")},
    )


def test_graph_to_dict_is_stable_and_json_safe(sample_graph):
    payload = graph_to_dict(sample_graph)

    assert payload["metadata"] == {"title": "Sales ERD", "kind": "celonis"}
    assert payload["tables"][0]["columns"][0]["type"] == "INTEGER"
    assert payload["relationships"][0]["columns"] == [["CUSTOMER_ID", "CUSTOMER_ID"]]
    assert "CUSTOMER_ID → CUSTOMER_ID" in json.dumps(payload, ensure_ascii=False)


def test_empty_graph_cannot_start_server():
    with pytest.raises(ValueError, match="no data-model tables"):
        make_server(ERDGraph(), port=0)


def test_server_serves_ui_json_and_hashed_assets(sample_graph):
    server = make_server(sample_graph, port=0)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urlopen(base_url, timeout=5) as response:
            html = response.read().decode("utf-8")
            assert response.headers["Content-Type"].startswith("text/html")
            assert "Celonis ERD Explorer" in html
            assert "default-src 'self'" in response.headers["Content-Security-Policy"]

        with urlopen(f"{base_url}/api/graph", timeout=5) as response:
            payload = json.loads(response.read())
            assert response.headers["Cache-Control"] == "no-store"
            assert payload["tables"][0]["alias"] == "Orders"

        with urlopen(f"{base_url}/api/graph.json", timeout=5) as response:
            assert json.loads(response.read()) == payload
            assert response.headers["Content-Disposition"] == 'attachment; filename="erd-celonis.json"'

        asset_path = re.search(r'(?:src|href)="(/static/assets/[^"]+\.js)"', html).group(1)
        with urlopen(f"{base_url}{asset_path}", timeout=5) as response:
            assert response.headers["Content-Type"].startswith(("text/javascript", "application/javascript"))
            assert len(response.read()) > 100_000

        with pytest.raises(HTTPError) as error:
            urlopen(f"{base_url}/missing", timeout=5)
        assert error.value.code == 404
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_cli_defaults_to_local_interactive_server():
    parameters = inspect.signature(erd).parameters

    assert parameters["host"].default == "127.0.0.1"
    assert parameters["port"].default == 8000
    assert parameters["open_browser"].default is True
    assert parameters["ddl"].default is False
    assert "output" not in parameters


def test_query_api_requires_session_and_returns_results_and_errors(sample_graph):
    runner = Mock(return_value={"columns": [{"name": "ID", "dtype": "int64"}], "rows": [[1]], "model_id": "model"})
    server = make_server(sample_graph, port=0, query_runner=runner)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urlopen(f"{base}/api/query-config") as response:
            config = json.load(response)
            assert response.headers["Cache-Control"] == "no-store"
        assert config["enabled"] is True
        headers = {"Content-Type": "application/json", "X-Query-Token": config["token"], "Origin": base}
        payload = b'{"model_id":"model","columns":[{"name":"ID","query":"1"}]}'
        with urlopen(Request(f"{base}/api/query", data=payload, headers=headers)) as response:
            assert json.load(response)["rows"] == [[1]]
        runner.assert_called_once_with(json.loads(payload))
        for override, expected in [({"X-Query-Token": "bad"}, 403), ({"Origin": "https://other.example"}, 403),
                                   ({"Host": "attacker.example"}, 403), ({"Content-Type": "text/plain"}, 415)]:
            with pytest.raises(HTTPError) as failure:
                urlopen(Request(f"{base}/api/query", data=payload, headers={**headers, **override}))
            assert failure.value.code == expected
        assert runner.call_count == 1
        with pytest.raises(HTTPError) as failure:
            urlopen(Request(f"{base}/api/query-config", headers={"Host": "attacker.example"}))
        assert failure.value.code == 403
        for body, expected in [(b"{broken", 400), (b"x" * 131073, 413)]:
            with pytest.raises(HTTPError) as failure:
                urlopen(Request(f"{base}/api/query", data=body, headers=headers))
            assert failure.value.code == expected
        runner.side_effect = QueryError("Invalid column", 422)
        with pytest.raises(HTTPError) as failure:
            urlopen(Request(f"{base}/api/query", data=payload, headers=headers))
        assert failure.value.code == 422
        assert json.load(failure.value)["error"] == "Invalid column"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_graph_only_server_reports_queries_unavailable(sample_graph):
    server = make_server(sample_graph, port=0)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urlopen(f"{base}/api/query-config") as response:
            config = json.load(response)
        assert config["enabled"] is False
        with pytest.raises(HTTPError) as failure:
            urlopen(Request(f"{base}/api/query", data=b'{}', headers={"Content-Type": "application/json", "X-Query-Token": config["token"]}))
        assert failure.value.code == 503
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
