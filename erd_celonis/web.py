"""Local HTTP server for the interactive ERD explorer.

The React production bundle is packaged with :mod:`erd_celonis`, so running
the installed CLI does not require Node.js or a separate frontend process.
"""

from __future__ import annotations

import json
import mimetypes
import secrets
import webbrowser
from collections.abc import Callable
from dataclasses import fields, is_dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

from .erd import ERDGraph
from .query import QueryError


class _ERDHTTPServer(ThreadingHTTPServer):
    """Reusable threaded server so repeated local runs do not fight TIME_WAIT."""

    daemon_threads = True
    allow_reuse_address = True


def graph_to_dict(graph: ERDGraph) -> dict[str, Any]:
    """Convert an ERD graph into stable, JSON-safe browser data."""

    return {
        "metadata": _json_safe(graph.metadata),
        "tables": [_json_safe(table) for table in graph.tables],
        "relationships": [_json_safe(relationship) for relationship in graph.relationships],
    }


def make_server(
    graph: ERDGraph,
    *,
    host: str = "127.0.0.1",
    port: int = 8000,
    query_runner: Callable[[Any], dict[str, Any]] | None = None,
) -> ThreadingHTTPServer:
    """Create, but do not start, an HTTP server for ``graph``."""

    if not graph.number_of_nodes():
        raise ValueError("Cannot serve an ERD with no data-model tables.")

    graph_payload = json.dumps(
        graph_to_dict(graph),
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    static_root = files("erd_celonis").joinpath("static")
    query_token = secrets.token_urlsafe(32)

    class ERDRequestHandler(BaseHTTPRequestHandler):
        server_version = "erd-celonis/0.2"

        def do_GET(self) -> None:  # noqa: N802 - method name is defined by BaseHTTPRequestHandler
            path = unquote(urlsplit(self.path).path)
            if path == "/api/query-config":
                if not self._query_origin_allowed():
                    self._send_json({"error": "Query access requires the local explorer origin."}, 403)
                    return
                self._send_json({"enabled": query_runner is not None, "token": query_token})
                return
            if path == "/api/graph":
                self._send_bytes(graph_payload, "application/json; charset=utf-8", cache="no-store")
                return
            if path == "/api/health":
                self._send_bytes(b'{"status":"ok"}', "application/json; charset=utf-8", cache="no-store")
                return
            if path in {"/", "/index.html", "/static", "/static/"}:
                self._send_resource(static_root.joinpath("index.html"), "no-cache")
                return
            if path.startswith("/static/"):
                relative = PurePosixPath(path.removeprefix("/static/"))
                if not relative.parts or ".." in relative.parts:
                    self.send_error(404, "Not found")
                    return
                self._send_resource(static_root.joinpath(*relative.parts), "public, max-age=31536000, immutable")
                return
            self.send_error(404, "Not found")

        def _query_origin_allowed(self) -> bool:
            authority = self.headers.get("Host", "")
            try:
                hostname = urlsplit(f"http://{authority}").hostname
            except ValueError:
                return False
            # Do not let a third-party DNS name rebind to the local query server.
            if hostname not in {host, self.connection.getsockname()[0], "localhost", "127.0.0.1", "::1"}:
                return False
            origin = self.headers.get("Origin")
            return origin is None or origin == f"http://{authority}"

        def do_POST(self) -> None:  # noqa: N802
            if urlsplit(self.path).path != "/api/query":
                self._send_json({"error": "Not found."}, 404)
                return
            if not self._query_origin_allowed() or not secrets.compare_digest(self.headers.get("X-Query-Token", "").encode(), query_token.encode()):
                self._send_json({"error": "Query session expired. Run the query again."}, 403)
                return
            if query_runner is None:
                self._send_json({"error": "Query execution is unavailable. Start the explorer with the Celonis CLI."}, 503)
                return
            if self.headers.get_content_type() != "application/json":
                self._send_json({"error": "Expected application/json."}, 415)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 131_072:
                    raise QueryError("Query request must be between 1 byte and 128 KB.", 413)
                payload = json.loads(self.rfile.read(length))
                result = query_runner(payload)
                self._send_json(result)
            except (ValueError, UnicodeDecodeError):
                self._send_json({"error": "Invalid JSON query request."}, 400)
            except QueryError as exc:
                self._send_json({"error": str(exc)}, exc.status)
            except (BrokenPipeError, ConnectionResetError):
                pass  # Browser left while Celonis was executing.
            except Exception:
                self._send_json({"error": "Query execution failed unexpectedly."}, 500)

        def _send_json(self, value: Any, status: int = 200) -> None:
            self._send_bytes(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"),
                             "application/json; charset=utf-8", cache="no-store", status=status)

        def _send_resource(self, resource: Any, cache: str) -> None:
            try:
                payload = resource.read_bytes()
            except (FileNotFoundError, IsADirectoryError):
                self.send_error(404, "Not found")
                return
            content_type = mimetypes.guess_type(resource.name)[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
                content_type += "; charset=utf-8"
            self._send_bytes(payload, content_type, cache=cache)

        def _send_bytes(
            self,
            payload: bytes,
            content_type: str,
            *,
            cache: str,
            status: int = 200,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; style-src 'self' 'unsafe-inline'; "
                "script-src 'self'; connect-src 'self'; img-src 'self' data:",
            )
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format: str, *_args: Any) -> None:
            """Keep browser asset requests out of the command-line status."""

    try:
        return _ERDHTTPServer((host, port), ERDRequestHandler)
    except OSError as exc:
        raise RuntimeError(f"Could not start the ERD server on {host}:{port}: {exc}") from exc


def serve_graph(
    graph: ERDGraph,
    *,
    host: str = "127.0.0.1",
    port: int = 8000,
    open_browser: bool = True,
    query_runner: Callable[[Any], dict[str, Any]] | None = None,
) -> None:
    """Serve an ERD graph until interrupted by the user."""

    server = make_server(graph, host=host, port=port, query_runner=query_runner)
    actual_port = int(server.server_address[1])
    display_host = "localhost" if host in {"0.0.0.0", "::"} else host
    url = f"http://{display_host}:{actual_port}"
    print(f"Serving interactive ERD at {url}")
    print("Press Ctrl+C to stop the server.")
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping ERD server.")
    finally:
        server.server_close()


def _json_safe(value: Any) -> Any:
    """Recursively reduce metadata values to JSON primitives."""

    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    enum_value = getattr(value, "value", None)
    if enum_value is not None and enum_value is not value:
        return _json_safe(enum_value)
    if is_dataclass(value) and not isinstance(value, type):
        return {item.name: _json_safe(getattr(value, item.name)) for item in fields(value)}
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return str(value)
