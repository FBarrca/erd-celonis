"""Bounded PQL execution using the CLI's authenticated data pool."""

from __future__ import annotations

import math
import re
from datetime import date, datetime
from decimal import Decimal
from threading import Lock
from time import perf_counter
from typing import Any

MAX_ROWS = 10_000


class QueryError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def validate_query(payload: Any, model_ids: set[str]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise QueryError("Expected a query object.")
    model_id = payload.get("model_id")
    if not isinstance(model_id, str) or model_id not in model_ids:
        raise QueryError("Select a model loaded in this explorer.")
    columns = payload.get("columns")
    if not isinstance(columns, list) or not 1 <= len(columns) <= 100:
        raise QueryError("Add between 1 and 100 named expressions.")
    cleaned = []
    names = set()
    for column in columns:
        if not isinstance(column, dict):
            raise QueryError("Each expression needs a name and PQL expression.")
        name, query = column.get("name"), column.get("query")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 200:
            raise QueryError("Column names must contain 1–200 characters.")
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 8192:
            raise QueryError("PQL expressions must contain 1–8192 characters.")
        name = name.strip()
        if name in names:
            raise QueryError("Give each expression a unique column name.")
        names.add(name)
        cleaned.append({"name": name, "query": query.strip()})
    filters = payload.get("filters", [])
    if not isinstance(filters, list) or len(filters) > 20:
        raise QueryError("Use at most 20 filters.")
    for value in filters:
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= 8192:
            raise QueryError("Each filter must contain 1–8192 characters.")
        if not re.fullmatch(r"FILTER\s+\S[\s\S]*;", value.strip(), flags=re.IGNORECASE):
            raise QueryError("Write each filter as FILTER condition;")
    limit = payload.get("limit", 1000)
    if type(limit) is not int or not 1 <= limit <= MAX_ROWS:
        raise QueryError(f"Row limit must be between 1 and {MAX_ROWS:,}.")
    distinct = payload.get("distinct", False)
    if type(distinct) is not bool:
        raise QueryError("Distinct must be true or false.")
    return {"model_id": model_id, "columns": cleaned, "filters": [f.strip() for f in filters], "limit": limit, "distinct": distinct}


def cell_value(value: Any) -> Any:
    """Keep nulls, dates, decimals, and large IDs usable in a JavaScript grid."""
    import pandas as pd

    if value is None or value is pd.NA or value is pd.NaT:
        return None
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value) if value.is_finite() else None
    if isinstance(value, int) and abs(value) > 2**53 - 1:
        return str(value)
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


class QueryRunner:
    def __init__(self, data_pool: Any, model_ids: set[str]) -> None:
        self.data_pool = data_pool
        self.model_ids = model_ids
        self._lock = Lock()

    def __call__(self, payload: Any) -> dict[str, Any]:
        request = validate_query(payload, self.model_ids)
        if not self._lock.acquire(blocking=False):
            raise QueryError("A query is still running. Wait for it to finish before running another.", 409)
        try:
            from pycelonis import pql
            from saolapy.pandas.index import Index

            started = perf_counter()
            model = self.data_pool.get_data_model(request["model_id"])
            query = pql.PQL()
            for column in request["columns"]:
                query += pql.PQLColumn(**column)
            for filter_ in request["filters"]:
                query += pql.PQLFilter(query=filter_)
            index_name = "__erd_index"
            names = {column["name"] for column in request["columns"]}
            while index_name in names:
                index_name += "_"
            # from_pql does not retain PQL.limit/distinct: apply them at export.
            # A constant index preserves DISTINCT and aggregate semantics; the
            # default RangeIndex adds a RUNNING_TOTAL expression to the query.
            try:
                frame = pql.DataFrame.from_pql(query, data_model=model, index=Index("0", name=index_name)).to_pandas(
                    limit=request["limit"], distinct=request["distinct"],
                ).iloc[:request["limit"]]
            except ValueError as exc:
                # PQLDebugger does not understand aliases on some custom
                # perspectives, although the Process Mining Engine does. In
                # that case, let the server validate the complete query.
                if "Table not found:" not in str(exc) and "Column not found:" not in str(exc):
                    raise
                raw_query = pql.PQL()
                raw_query += pql.PQLColumn(name=index_name, query="0")
                for column in request["columns"]:
                    raw_query += pql.PQLColumn(**column)
                for filter_ in request["filters"]:
                    raw_query += pql.PQLFilter(query=filter_)
                raw_query.limit = request["limit"]
                raw_query.distinct = request["distinct"]
                frame = model._export_data_frame(raw_query).drop(columns=[index_name], errors="ignore").iloc[:request["limit"]]
            return {
                "model_id": request["model_id"],
                "columns": [{"name": str(name), "dtype": str(dtype)} for name, dtype in zip(frame.columns, frame.dtypes)],
                "rows": [[cell_value(value) for value in row] for row in frame.itertuples(index=False, name=None)],
                "row_count": len(frame),
                "limit": request["limit"],
                "limit_reached": len(frame) >= request["limit"],
                "elapsed_ms": round((perf_counter() - started) * 1000),
            }
        except QueryError:
            raise
        except Exception as exc:
            message = str(exc)
            if "Could not connect to Process Mining Engine" in message:
                message = (
                    "The selected data model is not queryable because its Process Mining Engine "
                    "is not loaded. Load or activate the model in Celonis, then run the query again."
                )
            raise QueryError(f"PQL execution failed: {message[:4000]}", 422) from exc
        finally:
            self._lock.release()
