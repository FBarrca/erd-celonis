import io
import json
from unittest.mock import Mock

import pytest

from erd_celonis import cli
from erd_celonis.query import QueryError

RESULT = {"model_id": "model", "columns": [{"name": "Rows", "dtype": "int64"}, {"name": "Label", "dtype": "object"}],
          "rows": [[3, 'a,"b"'], [4, None]], "row_count": 2, "limit": 1000, "limit_reached": False, "elapsed_ms": 5}


@pytest.fixture
def runner(monkeypatch):
    """Replace the Celonis connection and query execution, recording the payload."""
    connect, calls = Mock(return_value="pool"), []

    class FakeRunner:
        def __init__(self, data_pool, model_ids):
            assert data_pool == "pool"
            self.model_ids = model_ids

        def __call__(self, payload):
            calls.append((self.model_ids, payload))
            if isinstance(FakeRunner.outcome, Exception):
                raise FakeRunner.outcome
            return FakeRunner.outcome

    FakeRunner.outcome = RESULT
    monkeypatch.setattr(cli, "_connect_data_pool", connect)
    monkeypatch.setattr(cli, "QueryRunner", FakeRunner)
    return FakeRunner, connect, calls


def test_inline_script_prints_json_and_keeps_status_off_stdout(runner, capsys):
    _, connect, calls = runner
    assert cli.pql(["pool-id", "model", 'TABLE("T"."ID" AS "Id") LIMIT 5']) == 0
    out = capsys.readouterr().out
    assert json.loads(out) == RESULT
    connect.assert_called_once()
    assert connect.call_args.args[0] == "pool-id"
    assert calls == [({"model"}, {"model_id": "model", "columns": [{"name": "Id", "query": '"T"."ID"'}],
                                  "filters": [], "limit": 5, "distinct": False})]


def test_bare_expression_from_stdin_is_wrapped_and_flags_override(runner, monkeypatch, capsys):
    _, _, calls = runner
    monkeypatch.setattr("sys.stdin", io.StringIO('COUNT_TABLE("T");\n'))
    assert cli.pql(["pool", "model", "-", "--limit", "7", "--distinct"]) == 0
    payload = calls[0][1]
    assert payload["columns"] == [{"name": "Column 1", "query": 'COUNT_TABLE("T")'}]
    assert payload["limit"] == 7 and payload["distinct"] is True


def test_file_script_prints_csv(runner, tmp_path, capsys):
    script = tmp_path / "query.pql"
    script.write_text('FILTER "T"."X" > 1;\nTABLE("T"."X");', encoding="utf-8")
    assert cli.pql(["pool", "model", "--file", str(script), "--format", "csv"]) == 0
    assert capsys.readouterr().out == 'Rows,Label\n3,"a,""b"""\n4,\n'
    assert runner[2][0][1]["filters"] == ['FILTER "T"."X" > 1;']


def test_invalid_script_exits_2_without_connecting(runner, capsys):
    _, connect, _ = runner
    assert cli.pql(["pool", "model", "TABLE(1,)"]) == 2
    captured = capsys.readouterr()
    assert captured.out == "" and "trailing comma" in captured.err
    connect.assert_not_called()


@pytest.mark.parametrize("argv", [
    ["pool", "model"], ["pool", "model", "TABLE(1)", "--file", "x.pql"],
    ["pool", "model", "--file", "/missing/query.pql"], ["pool", "model", "TABLE(1)", "--limit", "0"],
])
def test_bad_arguments_exit_2(runner, argv):
    with pytest.raises(SystemExit) as exit_info:
        cli.pql(argv)
    assert exit_info.value.code == 2
    runner[1].assert_not_called()


@pytest.mark.parametrize(("error", "code"), [
    (QueryError("PQL execution failed: bad column", 422), 1), (RuntimeError("401 Unauthorized"), 1),
])
def test_execution_failures_exit_1_with_message_on_stderr(runner, capsys, error, code):
    runner[0].outcome = error
    assert cli.pql(["pool", "model", "TABLE(1)"]) == code
    captured = capsys.readouterr()
    assert captured.out == "" and str(error) in captured.err


def test_main_dispatches_pql_and_keeps_the_root_command(monkeypatch):
    pql, fire = Mock(return_value=0), Mock()
    monkeypatch.setattr(cli, "pql", pql)
    monkeypatch.setattr(cli, "Fire", fire)
    monkeypatch.setattr("sys.argv", ["erd-celonis", "pql", "p", "m", "TABLE(1)"])
    with pytest.raises(SystemExit) as exit_info:
        cli.main()
    assert exit_info.value.code == 0
    pql.assert_called_once_with(["p", "m", "TABLE(1)"])
    monkeypatch.setattr("sys.argv", ["erd-celonis", "pool-id"])
    cli.main()
    fire.assert_called_once_with(cli.erd)
