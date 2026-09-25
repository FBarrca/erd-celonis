from datetime import datetime
from decimal import Decimal
import json
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pandas as pd
import pytest

from erd_celonis.query import QueryError, QueryRunner, cell_value, validate_query


def request(**changes):
    return {"model_id": "model", "columns": [{"name": "ID", "query": '"ORDERS"."ID"'}],
            "filters": [], "limit": 1000, "distinct": False, **changes}


@pytest.mark.parametrize("changes", [
    {"model_id": "other"}, {"model_id": []}, {"columns": []}, {"columns": [None]},
    {"columns": [{"name": "", "query": "1"}]},
    {"columns": [{"name": "x", "query": ""}]},
    {"columns": [{"name": "x", "query": "1"}, {"name": " x ", "query": "2"}]},
    {"columns": [{"name": "x", "query": "x" * 8193}]},
    {"limit": 0}, {"limit": 10001}, {"limit": True}, {"limit": 1.5},
    {"distinct": "false"}, {"filters": "FILTER 1=1;"}, {"filters": ["1=1"]},
    {"filters": ["FILTER 1=1"]}, {"filters": [None]}, {"filters": ["FILTER ;"]},
])
def test_invalid_requests_do_not_execute(changes):
    pool = Mock()
    with pytest.raises(QueryError):
        QueryRunner(pool, {"model"})(request(**changes))
    pool.get_data_model.assert_not_called()


def test_validation_trims_fields_and_defaults_limit():
    payload = {"model_id": "model", "columns": [{"name": " count ", "query": " COUNT_TABLE(\"ORDERS\") "}],
               "filters": [' FILTER "ORDERS"."ID" > 1; ']}
    clean = validate_query(payload, {"model"})
    assert clean["columns"][0]["name"] == "count"
    assert clean["filters"] == ['FILTER "ORDERS"."ID" > 1;']
    assert clean["limit"] == 1000
    assert clean["distinct"] is False
    assert validate_query(request(filters=['FILTER\n 1=1;']), {"model"})["filters"] == ['FILTER\n 1=1;']


def test_cells_preserve_dates_nulls_decimals_and_large_identifiers():
    values = [None, pd.NA, pd.NaT, float("nan"), float("inf"), datetime(2026, 9, 25),
              Decimal("123.4567890123456789"), 2**60, True, 42, "<script>"]
    converted = [cell_value(value) for value in values]
    assert converted == [None, None, None, None, None, "2026-09-25T00:00:00",
                         "123.4567890123456789", str(2**60), True, 42, "<script>"]
    json.dumps(converted, allow_nan=False)


def test_runner_builds_pql_and_enforces_limit_at_export(monkeypatch):
    # Use the actual PQL builder but replace the network export.
    from saolapy.pql.base import PQL, PQLColumn, PQLFilter

    frame = pd.DataFrame({"ID": [1, 2, 3]})
    export = Mock(return_value=frame)
    from_pql = Mock(return_value=SimpleNamespace(to_pandas=export))
    fake = SimpleNamespace(PQL=PQL, PQLColumn=PQLColumn, PQLFilter=PQLFilter,
                           DataFrame=SimpleNamespace(from_pql=from_pql))
    monkeypatch.setitem(sys.modules, "pycelonis", SimpleNamespace(pql=fake))
    pool = Mock()
    runner = QueryRunner(pool, {"model"})
    output = runner(request(limit=2, distinct=True, filters=['FILTER "ORDERS"."ID" > 0;']))
    pool.get_data_model.assert_called_once_with("model")
    query = from_pql.call_args.args[0]
    assert query.columns[0].query == '"ORDERS"."ID"'
    assert query.filters[0].query == 'FILTER "ORDERS"."ID" > 0;'
    assert from_pql.call_args.kwargs["data_model"] is pool.get_data_model.return_value
    export.assert_called_once_with(limit=2, distinct=True)
    assert output["rows"] == [[1], [2]]
    assert output["columns"] == [{"name": "ID", "dtype": "int64"}]
    assert output["row_count"] == 2 and output["limit_reached"] is True
    assert output["model_id"] == "model"
    export.return_value = frame.iloc[:0]
    assert runner(request())["rows"] == []
    export.side_effect = RuntimeError("Invalid PQL expression")
    with pytest.raises(QueryError, match="Invalid PQL expression") as failure:
        runner(request())
    assert failure.value.status == 422
    export.side_effect = None
    assert runner(request())["rows"] == []  # Failure must release the execution slot.


def test_runner_rejects_concurrent_execution():
    runner = QueryRunner(Mock(), {"model"})
    with runner._lock:
        with pytest.raises(QueryError) as failure:
            runner(request())
        assert failure.value.status == 409


@pytest.mark.parametrize("column_name", ["ID", "Index", "__erd_index"])
def test_runner_with_installed_pycelonis_dataframe(monkeypatch, column_name):
    # Exercise the actual DataFrame/connector pipeline without contacting Celonis.
    from pycelonis.pql.pql_debugger import PQLDebugger

    monkeypatch.setattr(PQLDebugger, "debug", Mock(return_value=[]))
    exported = Mock(side_effect=lambda query, **kwargs: pd.DataFrame({
        query.columns[0].name: [0, 0, 0], column_name: [1, 2, 3],
    }))
    model = SimpleNamespace(id="model", client=object(), _export_data_frame=exported)
    pool = SimpleNamespace(get_data_model=lambda model_id: model)
    result = QueryRunner(pool, {"model"})(request(limit=2, distinct=True, columns=[{"name": column_name, "query": '"ORDERS"."ID"'}]))
    assert result["rows"] == [[1], [2]]
    assert result["columns"][0]["name"] == column_name
    query = exported.call_args.args[0]
    assert query.limit == 2 and query.distinct is True
    assert query.columns[0].query == "0"
    assert query.columns[0].name != column_name
