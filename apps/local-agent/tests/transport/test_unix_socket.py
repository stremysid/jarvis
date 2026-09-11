"""The Linux node's control socket is private, bounded, and removable safely."""

from __future__ import annotations

import os
import socket
import stat
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Never, cast

import pytest

from jarvis_local.service import LocalAgentService, ServiceState, control_handlers
from jarvis_local.transport.cli_protocol import OK, CliCommand, CliResponse
from jarvis_local.transport.pipe_server import ControlServer, ServiceNotRunningError
from jarvis_local.transport.unix_socket import (
    SocketStream,
    UnixSocketInUseError,
    UnixSocketSecurityError,
    UnixSocketServer,
    default_unix_socket_path,
    send_unix_control_request,
)

linux_only = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux security acceptance")
af_unix = int(getattr(socket, "AF_UNIX", -1))


def effective_uid() -> int:
    getter = getattr(os, "geteuid", None)
    return int(getter()) if getter is not None else 0


class RecordingDispatcher:
    def __init__(self) -> None:
        self.received: list[CliCommand] = []

    def handle(self, command: CliCommand) -> CliResponse:
        self.received.append(command)
        return CliResponse(OK, ("dispatched",))


class TrickleSocket:
    def __init__(self) -> None:
        self.timeouts: list[float] = []
        self.receive_sizes: list[int] = []

    def settimeout(self, timeout: float) -> None:
        self.timeouts.append(timeout)

    def recv(self, size: int) -> bytes:
        self.receive_sizes.append(size)
        return b"x"

    def sendall(self, data: bytes) -> None:
        raise AssertionError(f"unexpected write of {len(data)} bytes")

    def close(self) -> None:
        pass


def test_each_read_consumes_one_whole_exchange_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    moments = iter((10.0, 10.02, 10.07, 10.081))
    monkeypatch.setattr("jarvis_local.transport.unix_socket.time.monotonic", lambda: next(moments))
    raw = TrickleSocket()
    stream = SocketStream(cast(socket.socket, raw), timeout=0.08)

    assert stream.read(1) == b"x"
    assert stream.read(1) == b"x"
    with pytest.raises(TimeoutError, match="deadline"):
        stream.read(1)

    assert raw.receive_sizes == [1, 1]
    assert raw.timeouts[0] == pytest.approx(0.06)
    assert raw.timeouts[1] == pytest.approx(0.01)


def private_socket_path() -> tuple[tempfile.TemporaryDirectory[str], Path]:
    temporary = tempfile.TemporaryDirectory(prefix="jarvis-sock-")
    parent = Path(temporary.name) / "private"
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)
    return temporary, parent / "control.sock"


def test_the_default_socket_uses_the_callers_runtime_directory() -> None:
    assert default_unix_socket_path({"XDG_RUNTIME_DIR": "/run/user/123"}, uid=123) == Path(
        "/run/user/123/jarvis/control.sock"
    )


@linux_only
def test_an_existing_endpoint_is_refused_and_preserved() -> None:
    temporary, path = private_socket_path()
    try:
        path.write_text("belongs to somebody else", encoding="utf-8")
        server = UnixSocketServer(ControlServer(RecordingDispatcher()), path)

        with pytest.raises(UnixSocketInUseError, match="already exists"):
            server.start()

        assert path.read_text(encoding="utf-8") == "belongs to somebody else"
    finally:
        temporary.cleanup()


@linux_only
def test_a_parent_other_users_can_enter_is_refused() -> None:
    temporary, path = private_socket_path()
    try:
        path.parent.chmod(0o755)
        server = UnixSocketServer(ControlServer(RecordingDispatcher()), path)

        with pytest.raises(UnixSocketSecurityError, match="0700"):
            server.start()
        assert not path.exists()
    finally:
        path.parent.chmod(0o700)
        temporary.cleanup()


@linux_only
def test_a_symlink_in_the_endpoint_path_is_refused() -> None:
    temporary = tempfile.TemporaryDirectory(prefix="jarvis-sock-")
    root = Path(temporary.name)
    real = root / "real"
    real.mkdir(mode=0o700)
    alias = root / "alias"
    alias.symlink_to(real, target_is_directory=True)
    try:
        server = UnixSocketServer(ControlServer(RecordingDispatcher()), alias / "control.sock")
        with pytest.raises(UnixSocketSecurityError, match="symlink"):
            server.start()
    finally:
        temporary.cleanup()


@linux_only
def test_a_real_status_request_round_trips_over_the_unix_socket() -> None:
    temporary, path = private_socket_path()
    state = ServiceState()
    server = UnixSocketServer(ControlServer(LocalAgentService(control_handlers(state))), path)
    server.start()
    thread = threading.Thread(target=server.serve_forever, args=(lambda: not state.stop_requested(),))
    thread.start()
    try:
        response = send_unix_control_request(CliCommand("status"), path)
        stopped = send_unix_control_request(CliCommand("stop"), path)
    finally:
        thread.join(timeout=5)
        server.close()
        temporary.cleanup()

    assert not thread.is_alive()
    assert response.code == OK
    assert any(line.startswith("status ") for line in response.lines)
    assert stopped.code == OK


@linux_only
def test_a_second_server_cannot_claim_the_same_socket() -> None:
    temporary, path = private_socket_path()
    first = UnixSocketServer(ControlServer(RecordingDispatcher()), path)
    first.start()
    try:
        with pytest.raises(UnixSocketInUseError):
            UnixSocketServer(ControlServer(RecordingDispatcher()), path).start()
    finally:
        first.close()
        temporary.cleanup()


@linux_only
def test_shutdown_removes_only_the_endpoint_this_server_created() -> None:
    temporary, path = private_socket_path()
    server = UnixSocketServer(ControlServer(RecordingDispatcher()), path)
    server.start()
    path.unlink()
    path.write_text("replacement", encoding="utf-8")

    server.close()
    try:
        assert path.read_text(encoding="utf-8") == "replacement"
    finally:
        temporary.cleanup()


@linux_only
def test_an_idle_client_cannot_block_shutdown_indefinitely() -> None:
    temporary, path = private_socket_path()
    keep_running = True
    server = UnixSocketServer(
        ControlServer(RecordingDispatcher()),
        path,
        accept_timeout=0.02,
        io_timeout=0.05,
    )
    server.start()
    thread = threading.Thread(target=server.serve_forever, args=(lambda: keep_running,))
    thread.start()
    client = socket.socket(af_unix, socket.SOCK_STREAM)
    client.connect(os.fspath(path))
    try:
        time.sleep(0.02)
        keep_running = False
        thread.join(timeout=1)
    finally:
        client.close()
        server.close()
        temporary.cleanup()

    assert not thread.is_alive()


@linux_only
def test_a_slow_drip_cannot_restart_the_whole_exchange_deadline() -> None:
    temporary, path = private_socket_path()
    keep_running = True
    server = UnixSocketServer(
        ControlServer(RecordingDispatcher()),
        path,
        accept_timeout=0.02,
        io_timeout=0.08,
    )
    server.start()
    thread = threading.Thread(target=server.serve_forever, args=(lambda: keep_running,))
    thread.start()
    client = socket.socket(af_unix, socket.SOCK_STREAM)
    client.connect(os.fspath(path))
    stop_dripping = threading.Event()

    def drip() -> None:
        while not stop_dripping.is_set():
            try:
                client.send(b"\x00")
            except OSError:
                return
            time.sleep(0.02)

    dripper = threading.Thread(target=drip)
    dripper.start()
    try:
        time.sleep(0.03)
        keep_running = False
        # The sender continues beyond this bound. A timeout restarted by each
        # byte would keep the server alive and make this assertion fail.
        thread.join(timeout=0.2)
        stopped_while_bytes_still_arrived = not thread.is_alive()
    finally:
        stop_dripping.set()
        dripper.join(timeout=1)
        client.close()
        server.close()
        temporary.cleanup()

    assert stopped_while_bytes_still_arrived


@linux_only
def test_a_connection_os_error_does_not_kill_the_listener(monkeypatch: pytest.MonkeyPatch) -> None:
    temporary, path = private_socket_path()
    state = ServiceState()
    server = UnixSocketServer(ControlServer(LocalAgentService(control_handlers(state))), path)
    server.start()
    original = server.serve_connection
    failed = threading.Event()

    def fail_first(connection: socket.socket) -> CliResponse:
        if not failed.is_set():
            failed.set()
            raise ConnectionResetError("peer reset with untrusted details")
        return original(connection)

    monkeypatch.setattr(server, "serve_connection", fail_first)
    thread = threading.Thread(target=server.serve_forever, args=(lambda: not state.stop_requested(),))
    thread.start()
    abandoned = socket.socket(af_unix, socket.SOCK_STREAM)
    abandoned.connect(os.fspath(path))
    assert failed.wait(timeout=1)
    abandoned.close()
    try:
        response = send_unix_control_request(CliCommand("status"), path)
        stopped = send_unix_control_request(CliCommand("stop"), path)
    finally:
        thread.join(timeout=5)
        server.close()
        temporary.cleanup()

    assert response.code == OK
    assert stopped.code == OK
    assert not thread.is_alive()


@linux_only
def test_linux_checks_the_connecting_process_uid_before_dispatch() -> None:
    temporary, path = private_socket_path()
    dispatcher = RecordingDispatcher()
    server = UnixSocketServer(
        ControlServer(dispatcher),
        path,
        expected_uid=effective_uid(),
        peer_uid=lambda _: effective_uid() + 1,
    )
    server.start()
    left, right = socket.socketpair()
    try:
        with pytest.raises(UnixSocketSecurityError, match="unexpected owner"):
            server.serve_connection(left)
    finally:
        right.close()
        server.close()
        temporary.cleanup()
    assert dispatcher.received == []


def test_transport_failures_do_not_disclose_the_socket_path() -> None:
    secret_path = Path(tempfile.gettempdir()) / "secret-name" / "control.sock"

    def refuse(_: Path | str) -> Never:
        raise UnixSocketSecurityError(f"unsafe: {secret_path}")

    with pytest.raises(ServiceNotRunningError) as raised:
        send_unix_control_request(CliCommand("status"), secret_path, connect=refuse)
    assert os.fspath(secret_path) not in str(raised.value)


@linux_only
def test_the_created_socket_and_parent_are_owner_only() -> None:
    temporary = tempfile.TemporaryDirectory(prefix="jarvis-sock-")
    path = Path(temporary.name) / "created" / "control.sock"
    server = UnixSocketServer(ControlServer(RecordingDispatcher()), path)
    server.start()
    try:
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
        assert stat.S_IMODE(path.lstat().st_mode) == 0o600
        assert path.parent.stat().st_uid == effective_uid()
        assert path.lstat().st_uid == effective_uid()
    finally:
        server.close()
        temporary.cleanup()
