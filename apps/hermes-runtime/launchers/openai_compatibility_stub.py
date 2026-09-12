"""Deterministic OpenAI-compatible stub for the Jarvis H1 pinned runtime.

This process exists so that `pinned_runtime` mode can exercise the full Hermes
gateway path without reaching any external model provider. Every response is
frozen by ``contracts/openai-compatibility-stub-v1.json``; request values are
validated and then deliberately discarded, so output never varies.

Constraints enforced here (Task 10, Step 1 policy tests assert each one):

* binds only the fixed loopback host/port -- never a routable interface
* opens no outbound sockets and performs no DNS resolution
* reads and writes no files; holds no mutable state across requests
* serves exactly two routes, both requiring the fixed non-secret bearer token
* emits byte-exact bodies taken from the frozen contract

Targets CPython 3.11 (the pinned toolchain version); avoid newer syntax.
"""

from __future__ import annotations

import argparse
import hmac
import json
import socket
import socketserver
import sys
import threading
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

CONTRACT_PATH = (
    Path(__file__).resolve().parent.parent / "contracts" / "openai-compatibility-stub-v1.json"
)

# The contract is read exactly once, at startup, before the listener opens, and
# is then held immutably in memory. The contract's `state.filesystemReads: []`
# describes request handling: no handler touches the filesystem.
_CONTRACT_CACHE: Optional[Dict[str, Any]] = None


def load_contract(path: Path = CONTRACT_PATH) -> Dict[str, Any]:
    """Load the frozen contract. Called once at startup, never while serving."""
    global _CONTRACT_CACHE
    if _CONTRACT_CACHE is None:
        with path.open("rb") as handle:
            _CONTRACT_CACHE = json.loads(handle.read().decode("utf-8"))
    return _CONTRACT_CACHE


class StubPolicy:
    """Immutable view over the contract, resolved once before the server starts."""

    def __init__(self, contract: Dict[str, Any]) -> None:
        self.schema_version = contract["schemaVersion"]
        self.host = contract["bind"]["host"]
        self.port = int(contract["bind"]["port"])

        auth = contract["authorization"]
        self.auth_header = auth["header"]
        self.auth_scheme = auth["scheme"]
        self.auth_value = auth["fixedPublicValue"]

        readiness = contract["readiness"]
        self.readiness_route = readiness["route"]
        self.readiness_method = readiness["method"]
        self.readiness_status = int(readiness["status"])
        self.readiness_type = readiness["contentType"]
        self.readiness_body = readiness["utf8"].encode("utf-8")

        request = contract["request"]
        self.chat_route = request["route"]
        self.chat_method = request["method"]
        self.request_fields = request["fields"]
        self.request_required = tuple(request["required"])

        limits = contract["limits"]
        self.max_body_bytes = int(limits["maxBodyBytes"])
        self.max_messages = int(limits["maxMessages"])
        self.max_message_content_bytes = int(limits["maxMessageContentBytes"])
        self.max_total_content_bytes = int(limits["maxTotalContentBytes"])
        self.max_concurrent = int(limits["maxConcurrentRequests"])

        self.request_type = contract["contentTypes"]["request"]

        responses = contract["responses"]
        self.nonstreaming_status = int(responses["nonstreaming"]["status"])
        self.nonstreaming_type = responses["nonstreaming"]["contentType"]
        self.nonstreaming_body = responses["nonstreaming"]["utf8"].encode("utf-8")
        self.streaming_status = int(responses["streaming"]["status"])
        self.streaming_type = responses["streaming"]["contentType"]
        self.streaming_body = responses["streaming"]["utf8"].encode("utf-8")

        self.errors = {
            name: (
                int(spec["status"]),
                spec["contentType"],
                spec["utf8"].encode("utf-8"),
            )
            for name, spec in contract["errors"].items()
        }

        self.model_const = self.request_fields["model"]["const"]
        self.allowed_roles = frozenset(
            self.request_fields["messages"]["items"]["properties"]["role"]["enum"]
        )
        self.allowed_request_keys = frozenset(self.request_fields)


class ConcurrencyGate:
    """Admits at most ``limit`` in-flight chat requests; never blocks."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._active = 0
        self._lock = threading.Lock()

    def try_acquire(self) -> bool:
        with self._lock:
            if self._active >= self._limit:
                return False
            self._active += 1
            return True

    def release(self) -> None:
        with self._lock:
            if self._active > 0:
                self._active -= 1


def _utf8_len(value: str) -> int:
    return len(value.encode("utf-8"))


def validate_chat_request(policy: StubPolicy, payload: Any) -> Optional[str]:
    """Return an error key, or None when the payload satisfies the contract.

    Values are validated strictly and then discarded -- the response is fixed.
    """
    if not isinstance(payload, dict):
        return "invalid_request"

    keys = set(payload)
    if not keys.issubset(policy.allowed_request_keys):
        return "invalid_request"
    for required in policy.request_required:
        if required not in keys:
            return "invalid_request"

    if payload["model"] != policy.model_const:
        return "invalid_request"
    # bool is a subclass of int; require an exact bool for `stream`.
    if not isinstance(payload["stream"], bool):
        return "invalid_request"

    messages = payload["messages"]
    if not isinstance(messages, list):
        return "invalid_request"
    if not 1 <= len(messages) <= policy.max_messages:
        return "invalid_request"

    total_content = 0
    for message in messages:
        if not isinstance(message, dict) or set(message) != {"role", "content"}:
            return "invalid_request"
        role = message["role"]
        content = message["content"]
        if role not in policy.allowed_roles or not isinstance(content, str):
            return "invalid_request"
        if unicodedata.normalize("NFC", content) != content:
            return "invalid_request"
        size = _utf8_len(content)
        if not 1 <= size <= policy.max_message_content_bytes:
            return "invalid_request"
        total_content += size
    if total_content > policy.max_total_content_bytes:
        return "invalid_request"

    checks = (
        ("temperature", (int, float), 0, 2, False),
        ("top_p", (int, float), 0, 1, True),
        ("max_tokens", (int,), 1, 393216, False),
    )
    for name, types, low, high, exclusive_low in checks:
        if name not in payload:
            continue
        value = payload[name]
        if isinstance(value, bool) or not isinstance(value, types):
            return "invalid_request"
        if exclusive_low and not low < value <= high:
            return "invalid_request"
        if not exclusive_low and not low <= value <= high:
            return "invalid_request"

    if "reasoning_effort" in payload:
        allowed = policy.request_fields["reasoning_effort"]["enum"]
        if payload["reasoning_effort"] not in allowed:
            return "invalid_request"

    if "stream_options" in payload:
        options = payload["stream_options"]
        if not isinstance(options, dict) or set(options) != {"include_usage"}:
            return "invalid_request"
        if options["include_usage"] is not True:
            return "invalid_request"

    return None


class StubHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "JarvisCompatibilityStub/1"
    sys_version = ""

    policy: StubPolicy
    gate: ConcurrencyGate

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        """Silence request logging; the stub must not emit request content."""

    # -- response helpers -------------------------------------------------

    def _respond(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, key: str) -> None:
        status, content_type, body = self.policy.errors[key]
        self._respond(status, content_type, body)
        if key == "payload_too_large":
            # The request body remains unread by design. On Windows, closing a
            # socket with unread inbound data can reset the connection and
            # discard the 413 already written. Half-close the write side first
            # so the response and FIN are ordered before the final close.
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_WR)
            except OSError:
                # The peer may already have closed; the response path is done.
                pass

    def _authorized(self) -> bool:
        header = self.headers.get(self.policy.auth_header)
        if header is None:
            return False
        prefix = self.policy.auth_scheme + " "
        if not header.startswith(prefix):
            return False
        presented = header[len(prefix):]
        return hmac.compare_digest(presented, self.policy.auth_value)

    def _read_body(self) -> Tuple[Optional[bytes], Optional[str]]:
        """Consume the request body before any validation runs.

        On a keep-alive connection an undrained body is parsed as the next
        request line, so every rejection path must either consume the body or
        close the connection. Reading first keeps the two in one place; the
        read is bounded by the contract's maxBodyBytes.
        """
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            # No Content-Length and no chunked encoding means no body at all.
            return b"", None
        try:
            length = int(raw_length)
        except ValueError:
            return None, "invalid_request"
        if length < 0:
            return None, "invalid_request"
        if length > self.policy.max_body_bytes:
            # Too large to drain safely: the response path half-closes the
            # write side after emitting 413, then closes without reading it.
            self.close_connection = True
            return None, "payload_too_large"
        return self.rfile.read(length), None

    def _select_chat_response(self, body: bytes) -> Tuple[int, str, bytes]:
        """Validate one admitted request and select its immutable response."""
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self.policy.errors["invalid_json"]

        failure = validate_chat_request(self.policy, payload)
        if failure is not None:
            return self.policy.errors[failure]

        if payload["stream"]:
            return (
                self.policy.streaming_status,
                self.policy.streaming_type,
                self.policy.streaming_body,
            )
        return (
            self.policy.nonstreaming_status,
            self.policy.nonstreaming_type,
            self.policy.nonstreaming_body,
        )

    # -- routes -----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        if self.path != self.policy.readiness_route:
            self._error("not_found")
            return
        if not self._authorized():
            self._error("unauthorized")
            return
        self._respond(
            self.policy.readiness_status,
            self.policy.readiness_type,
            self.policy.readiness_body,
        )

    def do_POST(self) -> None:  # noqa: N802
        # Drain the body first so that every rejection below leaves the
        # keep-alive connection framed correctly for the next request.
        body, read_error = self._read_body()
        if read_error is not None:
            self._error(read_error)
            return

        if self.path == self.policy.readiness_route:
            self._error("method_not_allowed")
            return
        if self.path != self.policy.chat_route:
            self._error("not_found")
            return
        if not self._authorized():
            self._error("unauthorized")
            return

        media_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if media_type != self.policy.request_type:
            self._error("unsupported_media_type")
            return

        if not self.gate.try_acquire():
            self._error("concurrency_limit")
            return
        try:
            response = self._select_chat_response(body)
        finally:
            self.gate.release()
        self._respond(*response)

    def _reject_method(self) -> None:
        # Drain first for the same keep-alive framing reason as do_POST.
        _, read_error = self._read_body()
        if read_error is not None:
            self._error(read_error)
            return
        if self.path in (self.policy.readiness_route, self.policy.chat_route):
            self._error("method_not_allowed")
        else:
            self._error("not_found")

    do_PUT = _reject_method
    do_PATCH = _reject_method
    do_DELETE = _reject_method
    do_HEAD = _reject_method
    do_OPTIONS = _reject_method


class LoopbackStubServer(ThreadingHTTPServer):
    daemon_threads = True
    # Do not reuse addresses: a bind collision must fail loudly rather than
    # silently share the fixed contract port with another process.
    allow_reuse_address = False

    def server_bind(self) -> None:
        # HTTPServer.server_bind performs a blocking reverse-DNS lookup via
        # socket.getfqdn(). Bind directly because this stub neither resolves
        # names nor uses the server_name value populated by that lookup.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def build_server(policy: StubPolicy, port: Optional[int] = None) -> LoopbackStubServer:
    bind_port = policy.port if port is None else port
    address = (policy.host, bind_port)
    if address[0] not in ("127.0.0.1", "::1"):
        raise ValueError("compatibility stub may bind loopback only")

    handler = type(
        "BoundStubHandler",
        (StubHandler,),
        {"policy": policy, "gate": ConcurrencyGate(policy.max_concurrent)},
    )
    server = LoopbackStubServer(address, handler)
    server.address_family = socket.AF_INET
    return server


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Deterministic OpenAI-compatible stub (Jarvis H1 pinned runtime)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Override the contract port. Test-only; production uses the fixed port.",
    )
    parser.add_argument(
        "--print-port",
        action="store_true",
        help="Print the bound port to stdout once listening, then continue serving.",
    )
    args = parser.parse_args(argv)

    policy = StubPolicy(load_contract())
    server = build_server(policy, args.port)

    if args.print_port:
        sys.stdout.write("{0}\n".format(server.server_address[1]))
        sys.stdout.flush()

    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
