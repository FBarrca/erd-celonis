"""Parse the PQL console's query envelope, mirroring ``frontend/src/pqlScript.js``."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

MAX_SCRIPT_LENGTH = 65536
MAX_EXPRESSION_LENGTH = 8192
KEYWORDS = {"TABLE", "AS", "LIMIT", "FILTER", "CASE", "WHEN", "THEN", "ELSE", "END", "AND", "OR", "NOT", "NULL",
            "DISTINCT", "IN", "LIKE", "IS"}

_SPACE = re.compile(r"\s+")
_NUMBER = re.compile(r"(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")
_WORD = re.compile(r"(?:[^\W\d]|\$)[\w$]*")
_CALL = re.compile(r"\s*\(")


class PqlScriptError(ValueError):
    pass


@dataclass
class Token:
    type: str | None
    text: str
    start: int
    end: int
    closed: bool = True
    depth: int = 0


def tokenize_pql(text: str) -> list[Token]:
    """Split text like the editor's highlighter; double quotes are identifiers, single quotes strings."""
    tokens = []
    position = 0
    while position < len(text):
        start, kind, closed = position, None, True
        if space := _SPACE.match(text, position):
            position = space.end()
        elif text.startswith("--", position):
            newline = text.find("\n", position)
            position, kind = len(text) if newline < 0 else newline, "comment"
        elif text.startswith("/*", position):
            close = text.find("*/", position + 2)
            position, kind, closed = (len(text), "comment", False) if close < 0 else (close + 2, "comment", True)
        elif text[position] in "\"'":
            quote, position, closed = text[position], position + 1, False
            while position < len(text):
                if quote == "'" and text[position] == "\\":
                    position = min(position + 2, len(text))
                    continue
                position += 1
                if text[position - 1] == quote:
                    if quote == '"' and text[position:position + 1] == '"':
                        position += 1
                        continue
                    closed = True
                    break
            kind = "variableName" if quote == '"' else "string"
        elif number := _NUMBER.match(text, position):
            position, kind = number.end(), "number"
        elif word := _WORD.match(text, position):
            position = word.end()
            if word.group().upper() in KEYWORDS:
                kind = "keyword"
            else:
                kind = "function" if _CALL.match(text, position) else "variableName"
        else:
            position += 1
            kind = "operator" if text[start] in "+*/%=<>!|&^-" else "punctuation"
        tokens.append(Token(kind, text[start:position], start, position, closed))
    return tokens


def _keyword(token: Token | None, word: str) -> bool:
    return token is not None and token.type == "keyword" and token.text.upper() == word


def _unquote(value: str) -> str:
    return value[1:-1].replace('""', '"') if value.startswith('"') else value


def is_bare_expression(script: str) -> bool:
    """True when a script has no TABLE/FILTER/LIMIT envelope, e.g. ``COUNT_TABLE("T")``."""
    for token in tokenize_pql(script):
        if token.type and token.type != "comment":
            return not any(_keyword(token, word) for word in ("TABLE", "FILTER", "LIMIT"))
    return False


def parse_pql_script(script: str, row_limit: int = 1000) -> dict[str, Any]:
    """Return the query API payload fields for a ``FILTER ...; TABLE(...) LIMIT n;`` script."""

    def fail(message: str, position: int = 0) -> None:
        raise PqlScriptError(f"Line {script[:position].count(chr(10)) + 1}: {message}")

    if len(script) > MAX_SCRIPT_LENGTH:
        fail(f"Queries are limited to {MAX_SCRIPT_LENGTH:,} characters.")
    raw = tokenize_pql(script)
    if unclosed := next((token for token in raw if not token.closed), None):
        fail("Close the quoted identifier, string, or comment.", unclosed.start)
    tokens = [token for token in raw if token.type and token.type != "comment"]
    stack: list[Token] = []
    for token in tokens:
        token.depth = len(stack)
        if token.type != "punctuation":
            continue
        if token.text in "([{":
            stack.append(token)
        elif token.text in ")]}":
            opening = stack.pop() if stack else None
            if opening is None or "([{".index(opening.text) != ")]}".index(token.text):
                fail("Mismatched brackets.", token.start)
            token.depth = len(stack)
    if stack:
        fail("Close the bracket.", stack[-1].start)

    columns: list[dict[str, str]] = []
    filters: list[str] = []
    limit, distinct, limit_from_script, has_table = row_limit, False, False, False

    def expression(parts: list[Token]) -> str:
        return script[parts[0].start:parts[-1].end].strip() if parts else ""

    def add_column(parts: list[Token]) -> None:
        if not parts:
            fail("Add an expression between commas.")
        alias_at = next((i for i in range(len(parts) - 1, -1, -1)
                         if parts[i].depth == 1 and _keyword(parts[i], "AS")), -1)
        query = expression(parts)
        if alias_at >= 0:
            alias = parts[alias_at + 1:]
            if len(alias) != 1 or alias[0].type != "variableName":
                fail('Use AS "Result column name" after each expression.', parts[alias_at].start)
            name = _unquote(alias[0].text)
            query = expression(parts[:alias_at])
        else:
            simple = len(parts) == 3 and parts[1].text == "." and parts[2].type == "variableName"
            name = _unquote(parts[2].text) if simple else f"Column {len(columns) + 1}"
        if len(query) > MAX_EXPRESSION_LENGTH:
            fail("Each expression is limited to 8,192 characters.", parts[0].start)
        if len(name) > 200:
            fail("Column names are limited to 200 characters.", parts[0].start)
        columns.append({"name": name, "query": query})

    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token.text == ";":
            i += 1
        elif _keyword(token, "FILTER"):
            start = i
            i += 1
            while i < len(tokens) and not (tokens[i].depth == 0 and tokens[i].text == ";"):
                i += 1
            if i == len(tokens):
                fail("End each FILTER statement with a semicolon.", token.start)
            i += 1
            filter_ = expression(tokens[start:i])
            if len(filter_) > MAX_EXPRESSION_LENGTH:
                fail("Each filter is limited to 8,192 characters.", token.start)
            filters.append(filter_)
        elif _keyword(token, "TABLE"):
            if has_table:
                fail("Run one TABLE query at a time.", token.start)
            has_table = True
            i += 1
            if i >= len(tokens) or tokens[i].text != "(":
                fail('Write TABLE(expression AS "Name", ...).', token.start)
            i += 1
            if i < len(tokens) and _keyword(tokens[i], "DISTINCT"):
                distinct = True
                i += 1
            start = i
            while i < len(tokens) and not (tokens[i].depth == 0 and tokens[i].text == ")"):
                if tokens[i].depth == 1 and tokens[i].text == ",":
                    add_column(tokens[start:i])
                    start = i + 1
                i += 1
            if start == i:
                fail("Add at least one expression to TABLE, without a trailing comma.",
                     tokens[i].start if i < len(tokens) else token.start)
            add_column(tokens[start:i])
            i += 1
        elif _keyword(token, "LIMIT"):
            if limit_from_script or not has_table:
                fail("Use a single LIMIT after TABLE.", token.start)
            i += 1
            if i >= len(tokens) or not re.fullmatch(r"\d+", tokens[i].text):
                fail("LIMIT requires an integer between 1 and 10,000.", token.start)
            limit, limit_from_script = int(tokens[i].text), True
            i += 1
        else:
            fail("Use TABLE(...) and FILTER ...; statements. Set row limits with LIMIT or --limit.", token.start)

    if not has_table:
        fail("Add a TABLE(...) query.")
    if len(columns) > 100 or len(filters) > 20:
        fail("Use at most 100 expressions and 20 filters.")
    if any(not c["name"].strip() or not c["query"].strip() for c in columns):
        fail("Give every expression a name and PQL expression.")
    if len({c["name"].strip() for c in columns}) != len(columns):
        fail("Give each expression a unique column name.")
    if any(not re.fullmatch(r"FILTER\s+\S[\s\S]*;", f.strip(), flags=re.IGNORECASE) for f in filters):
        fail("Write each filter as FILTER condition; or remove the unused filter.")
    if not 1 <= limit <= 10_000:
        fail("Choose a row limit between 1 and 10,000.")
    return {"columns": columns, "filters": filters, "limit": limit, "distinct": distinct,
            "limit_from_script": limit_from_script}
