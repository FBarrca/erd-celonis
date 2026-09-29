import pytest

from erd_celonis.pql_script import (
    MAX_SCRIPT_LENGTH, PqlScriptError, is_bare_expression, parse_pql_script, tokenize_pql,
)


def test_tokens_distinguish_identifiers_strings_functions_keywords_numbers_and_operators():
    tokens = tokenize_pql("CASE WHEN \"Orders\".\"ID\" >= 1.2e3 THEN SUM(\"Orders\".\"Order Value\") ELSE 'it\\'s fine' END")
    kind = {token.text: token.type for token in tokens}
    assert kind["CASE"] == "keyword"
    assert kind['"Orders"'] == "variableName"
    assert kind["1.2e3"] == "number"
    assert kind["SUM"] == "function"
    assert kind["'it\\'s fine'"] == "string"
    assert "operator" in kind.values()


def test_script_produces_the_query_payload_preserving_nested_expressions_and_filters():
    result = parse_pql_script("""FILTER "Orders"."Value" > 10;
TABLE(DISTINCT
  "Orders"."ID" AS "Order ID",
  PU_SUM("Customers", "Orders"."Value", "Orders"."Value" > 20) AS "Total",
  CASE WHEN "Orders"."ID" IN (1, 2) THEN 'yes,;ok' ELSE 'no' END AS "Flag"
);
FILTER "Orders"."ID" != 0;
LIMIT 50;""")
    assert len(result["columns"]) == 3
    assert result["columns"][0] == {"name": "Order ID", "query": '"Orders"."ID"'}
    assert result["columns"][1]["query"] == 'PU_SUM("Customers", "Orders"."Value", "Orders"."Value" > 20)'
    assert "'yes,;ok'" in result["columns"][2]["query"]
    assert len(result["filters"]) == 2
    assert result["distinct"] is True
    assert result["limit"] == 50 and result["limit_from_script"] is True


def test_cast_aliases_are_not_column_aliases_and_references_get_default_names():
    result = parse_pql_script('TABLE(CAST("T"."Value" AS INT) AS "Count", "T"."ID", SUM("T"."Value"))', 300)
    assert [c["name"] for c in result["columns"]] == ["Count", "ID", "Column 3"]
    assert result["limit"] == 300 and result["limit_from_script"] is False


def test_quoted_punctuation_escaped_quotes_and_comments_do_not_split_the_envelope():
    result = parse_pql_script('''-- TABLE(ignored)
FILTER "T"."x" = 'it\\'s;,fine';
TABLE(/* comma , */ "T"."A,;" AS "Quote ""me""", 'x;,)') /* tail */;''')
    assert result["columns"][0]["name"] == 'Quote "me"'
    assert result["columns"][1]["query"] == "'x;,)'"
    assert result["filters"][0] == "FILTER \"T\".\"x\" = 'it\\'s;,fine';"


@pytest.mark.parametrize(("script", "message"), [
    ("", "Add a TABLE"), ("TABLE()", "at least one"), ("TABLE(1,)", "trailing comma"),
    ("TABLE(1,,2)", "between commas"), ("TABLE(1", "Close the bracket"), ("TABLE([1))", "Mismatched"),
    ("TABLE(1 AS)", "Result column name"), ('TABLE(1 AS "")', "name and PQL"),
    ('TABLE(1 AS "A", 2 AS "A")', "unique"), ("TABLE(1); TABLE(2)", "one TABLE"),
    ("SELECT * FROM Orders", "Use TABLE"), ("FILTER x", "semicolon"), ("TABLE(1); FILTER ;", "condition"),
    ("TABLE(1); LIMIT 0", "row limit"), ("TABLE(1); LIMIT 10001", "row limit"),
    ("TABLE(1); LIMIT 1.5", "integer"), ("TABLE(1); LIMIT 1; LIMIT 2", "single LIMIT"),
    ("TABLE('unfinished)", "Close the quoted"), ("TABLE(1); /* unfinished", "comment"),
])
def test_reports_useful_errors_for_malformed_envelopes(script, message):
    with pytest.raises(PqlScriptError, match=message):
        parse_pql_script(script)


def test_errors_include_line_numbers():
    with pytest.raises(PqlScriptError, match="^Line 2:"):
        parse_pql_script("TABLE(1);\nBOGUS")


@pytest.mark.parametrize(("script", "message"), [
    (f"TABLE({','.join(str(i) for i in range(101))})", "100 expressions"),
    ("FILTER x;\n" * 21 + "TABLE(1)", "20 filters"),
    (f"TABLE('{'x' * 8192}')", "8,192"),
    (f'TABLE(1 AS "{"x" * 201}")', "200 characters"),
    ("x" * (MAX_SCRIPT_LENGTH + 1), "65,536"),
])
def test_preserves_api_bounds(script, message):
    with pytest.raises(PqlScriptError, match=message):
        parse_pql_script(script)


@pytest.mark.parametrize(("script", "bare"), [
    ('COUNT_TABLE("ORDERS")', True), ('-- note\n"T"."ID"', True),
    ("TABLE(1)", False), ("filter 1 = 1; table(1)", False), ("", False),
])
def test_bare_expression_detection(script, bare):
    assert is_bare_expression(script) is bare
