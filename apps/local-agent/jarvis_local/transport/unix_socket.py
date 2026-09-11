"""Private Unix-socket binding for the local control protocol.

The wire protocol remains in :mod:`pipe_server`; only the operating-system
binding differs.  The path is security-sensitive state, not a disposable
filename: an existing entry is never removed at startup, and shutdown removes
it only when it is still the socket this server created.
"""

from __future__ import annotations

import contextlib
import errno
import os
import socket
import stat
import struct
import sys
import tempfile
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from types import TracebackType

from jarvis_local.transport.cli_protocol import UNKNOWN_COMMAND, CliCommand, CliResponse
from jarvis_local.transport.pipe_server import (
    CONTROL_COMMANDS,
    MAX_REQUEST_BYTES,
    ByteStream,
    ControlServer,
    ServiceNotRunningError,
    decode_response,
    encode_frame,
    encode_request,
    read_frame,
)

DEFAULT_ACCEPT_TIMEOUT_SECONDS = 0.25
DEFAULT_IO_TIMEOUT_SECONDS = 2.0
CONTROL_SOCKET_ENVIRONMENT = "JARVIS_CONTROL_SOCKET"
_SO_PEERCRED_BYTES = struct.calcsize("3i")
_AF_UNIX = int(getattr(socket, "AF_UNIX", -1))


def _is_linux() -> bool:
    # Behind a function so mypy cannot erase the branch on a win32 run.
    return sys.platform.startswith("linux")


class UnixSocketSecurityError(RuntimeError):
    """The configured local endpoint does not meet the private-channel policy."""


class UnixSocketInUseError(RuntimeError):
    """Another filesystem entry already owns the configured endpoint name."""


def default_unix_socket_path(
    environment: Mapping[str, str] | None = None,
    uid: int | None = None,
) -> Path:
    """Return an absolute endpoint inside a private, per-user directory."""
    values = os.environ if environment is None else environment
    configured = values.get(CONTROL_SOCKET_ENVIRONMENT, "").strip()
    if configured:
        return Path(configured)
    runtime = values.get("XDG_RUNTIME_DIR", "").strip()
    owner = _effective_uid() if uid is None else uid
    base = Path(runtime) if runtime else Path(tempfile.gettempdir()) / f"jarvis-{owner}"
    return base / "jarvis" / "control.sock" if runtime else base / "control.sock"


def _effective_uid() -> int:
    getter = getattr(os, "geteuid", None)
    return int(getter()) if getter is not None else 0


def _reject_abstract_or_relative(path: Path) -> None:
    rendered = os.fspath(path)
    if not rendered or "\0" in rendered:
        raise UnixSocketSecurityError("the control socket path must be a filesystem path")
    if not path.is_absolute():
        raise UnixSocketSecurityError("the control socket path must be absolute")


def _reject_symlink_ancestors(path: Path) -> None:
    """Reject symlinks above the endpoint so validation names the path opened."""
    current = path.parent
    while current != current.parent:
        try:
            info = current.lstat()
        except FileNotFoundError:
            current = current.parent
            continue
        if stat.S_ISLNK(info.st_mode):
            raise UnixSocketSecurityError("a control socket path ancestor is a symlink")
        current = current.parent


def _validate_private_parent(parent: Path, expected_uid: int) -> None:
    try:
        info = parent.lstat()
    except FileNotFoundError as error:
        raise UnixSocketSecurityError("the control socket parent does not exist") from error
    if stat.S_ISLNK(info.st_mode):
        raise UnixSocketSecurityError("the control socket parent is a symlink")
    if not stat.S_ISDIR(info.st_mode):
        raise UnixSocketSecurityError("the control socket parent is not a real directory")
    if _is_linux() and info.st_uid != expected_uid:
        raise UnixSocketSecurityError("the control socket parent has an unexpected owner")
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise UnixSocketSecurityError("the control socket parent must have mode 0700")


def _ensure_private_parent(parent: Path, expected_uid: int) -> None:
    _reject_symlink_ancestors(parent)
    try:
        parent.mkdir(mode=0o700)
    except FileExistsError:
        pass
    except FileNotFoundError as error:
        raise UnixSocketSecurityError("the control socket parent base does not exist") from error
    _validate_private_parent(parent, expected_uid)


def _socket_identity(path: Path, expected_uid: int) -> tuple[int, int]:
    try:
        info = path.lstat()
    except FileNotFoundError as error:
        raise UnixSocketSecurityError("the control socket endpoint is missing") from error
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISSOCK(info.st_mode):
        raise UnixSocketSecurityError("the control socket endpoint is not a socket")
    if _is_linux() and info.st_uid != expected_uid:
        raise UnixSocketSecurityError("the control socket endpoint has an unexpected owner")
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise UnixSocketSecurityError("the control socket endpoint must have mode 0600")
    return (int(info.st_dev), int(info.st_ino))


def _linux_peer_uid(connection: socket.socket) -> int:
    if not hasattr(socket, "SO_PEERCRED"):
        raise UnixSocketSecurityError("kernel peer credentials are unavailable")
    credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, _SO_PEERCRED_BYTES)
    _, uid, _ = struct.unpack("3i", credentials)
    return int(uid)


class SocketStream(ByteStream):
    """A connected socket behind the exact byte-stream operations framing uses."""

    def __init__(self, connection: socket.socket, timeout: float) -> None:
        self.connection = connection
        self.deadline = time.monotonic() + timeout

    def _arm_deadline(self) -> None:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("the control socket exchange deadline expired")
        self.connection.settimeout(remaining)

    def read(self, size: int, /) -> bytes:
        self._arm_deadline()
        return self.connection.recv(size)

    def write(self, data: bytes, /) -> int:
        self._arm_deadline()
        self.connection.sendall(data)
        return len(data)

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> SocketStream:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()


class UnixSocketServer:
    """Serve one bounded control request at a time on a private local socket."""

    def __init__(
        self,
        server: ControlServer,
        socket_path: Path | str | None = None,
        *,
        expected_uid: int | None = None,
        accept_timeout: float = DEFAULT_ACCEPT_TIMEOUT_SECONDS,
        io_timeout: float = DEFAULT_IO_TIMEOUT_SECONDS,
        peer_uid: Callable[[socket.socket], int] | None = None,
    ) -> None:
        self.server = server
        self.socket_path = Path(socket_path) if socket_path is not None else default_unix_socket_path()
        self.expected_uid = _effective_uid() if expected_uid is None else expected_uid
        self.accept_timeout = accept_timeout
        self.io_timeout = io_timeout
        self.peer_uid = peer_uid or (_linux_peer_uid if _is_linux() else None)
        self._listener: socket.socket | None = None
        self._identity: tuple[int, int] | None = None

    def start(self) -> None:
        if self._listener is not None:
            return
        _reject_abstract_or_relative(self.socket_path)
        _ensure_private_parent(self.socket_path.parent, self.expected_uid)
        if self.socket_path.exists() or self.socket_path.is_symlink():
            raise UnixSocketInUseError("the control socket endpoint already exists")

        listener = socket.socket(_AF_UNIX, socket.SOCK_STREAM)
        try:
            # The packaged unit's UMask=0077 closes the bind-to-chmod window.
            # For manual runs, the validated 0700 parent protects the endpoint
            # until chmod applies its final mode.
            listener.bind(os.fspath(self.socket_path))
            initial = self.socket_path.lstat()
            self._identity = (int(initial.st_dev), int(initial.st_ino))
            self.socket_path.chmod(0o600)
            if _socket_identity(self.socket_path, self.expected_uid) != self._identity:
                raise UnixSocketSecurityError("the control socket endpoint changed during startup")
            listener.listen(1)
            listener.settimeout(self.accept_timeout)
        except OSError as error:
            listener.close()
            self._cleanup_owned_endpoint()
            if error.errno in {errno.EADDRINUSE, 10048}:
                raise UnixSocketInUseError("the control socket endpoint is already in use") from error
            raise UnixSocketSecurityError("the control socket could not be created safely") from error
        except BaseException:
            listener.close()
            self._cleanup_owned_endpoint()
            raise
        self._listener = listener

    def serve_connection(self, connection: socket.socket) -> CliResponse:
        with SocketStream(connection, self.io_timeout) as stream:
            if self.peer_uid is not None and self.peer_uid(connection) != self.expected_uid:
                raise UnixSocketSecurityError("the control socket peer has an unexpected owner")
            return self.server.serve_one(stream, stream)

    def serve_forever(self, should_continue: Callable[[], bool]) -> None:
        self.start()
        listener = self._listener
        if listener is None:
            raise AssertionError("the listener was not created")
        try:
            while should_continue():
                try:
                    connection, _ = listener.accept()
                except TimeoutError:
                    continue
                try:
                    self.serve_connection(connection)
                except (OSError, UnixSocketSecurityError):
                    # An idle or foreign local client gets no detail about the
                    # channel and cannot hold the service beyond `io_timeout`.
                    with contextlib.suppress(OSError):
                        connection.close()
        finally:
            self.close()

    def close(self) -> None:
        listener, self._listener = self._listener, None
        if listener is not None:
            with contextlib.suppress(OSError):
                listener.close()
        self._cleanup_owned_endpoint()

    def _cleanup_owned_endpoint(self) -> None:
        identity, self._identity = self._identity, None
        if identity is None:
            return
        try:
            current = self.socket_path.lstat()
        except FileNotFoundError:
            return
        if stat.S_ISSOCK(current.st_mode) and (int(current.st_dev), int(current.st_ino)) == identity:
            with contextlib.suppress(OSError):
                self.socket_path.unlink()


def connect_to_unix_socket(
    socket_path: Path | str,
    *,
    expected_uid: int | None = None,
    timeout: float = DEFAULT_IO_TIMEOUT_SECONDS,
) -> SocketStream:
    """Connect only after the endpoint and its private parent pass validation."""
    path = Path(socket_path)
    owner = _effective_uid() if expected_uid is None else expected_uid
    _reject_abstract_or_relative(path)
    _reject_symlink_ancestors(path)
    _validate_private_parent(path.parent, owner)
    before = _socket_identity(path, owner)

    connection = socket.socket(_AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(timeout)
    try:
        connection.connect(os.fspath(path))
        if _is_linux() and _linux_peer_uid(connection) != owner:
            raise UnixSocketSecurityError("the control socket server has an unexpected owner")
        if _socket_identity(path, owner) != before:
            raise UnixSocketSecurityError("the control socket endpoint changed while connecting")
    except BaseException:
        connection.close()
        raise
    return SocketStream(connection, timeout)


def send_unix_control_request(
    command: CliCommand,
    socket_path: Path | str | None = None,
    *,
    connect: Callable[[Path | str], ByteStream] | None = None,
) -> CliResponse:
    """Ask the node one question without exposing transport failure details."""
    if command.name not in CONTROL_COMMANDS:
        return CliResponse(UNKNOWN_COMMAND)
    path = default_unix_socket_path() if socket_path is None else socket_path
    connector = connect_to_unix_socket if connect is None else connect
    try:
        stream = connector(path)
    except (OSError, UnixSocketSecurityError) as error:
        raise ServiceNotRunningError("the local control socket is unavailable") from error
    try:
        stream.write(encode_frame(encode_request(command)))
        return decode_response(read_frame(stream, MAX_REQUEST_BYTES))
    except OSError as error:
        raise ServiceNotRunningError("the local control socket exchange failed") from error
    finally:
        stream.close()
