"""Local HTTP server for the interactive ERD explorer.

The React production bundle is packaged with :mod:`erd_celonis`, so running
the installed CLI does not require Node.js or a separate frontend process.
"""

from __future__ import annotations

import json
import mimetypes
import webbrowser
from dataclasses import fields, is_dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

from .erd import ERDGraph


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

    class ERDRequestHandler(BaseHTTPRequestHandler):
        server_version = "erd-celonis/0.2"

        def do_GET(self) -> None:  # noqa: N802 - method name is defined by BaseHTTPRequestHandler
            path = unquote(urlsplit(self.path).path)
            if path == "/api/graph":
                self._send_bytes(graph_payload, "application/json; charset=utf-8", cache="no-store")
                return
            if path == "/api/graph.json":
                self._send_bytes(
                    graph_payload,
                    "application/json; charset=utf-8",
                    cache="no-store",
                    content_disposition='attachment; filename="erd-celonis.json"',
                )
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
            content_disposition: str | None = None,
        ) -> None:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", cache)
            if content_disposition is not None:
                self.send_header("Content-Disposition", content_disposition)
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
) -> None:
    """Serve an ERD graph until interrupted by the user."""

    server = make_server(graph, host=host, port=port)
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
