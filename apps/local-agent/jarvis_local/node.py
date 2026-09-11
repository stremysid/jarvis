"""Foreground bootstrap for the Linux home node.

This module only assembles components that already own the work: signed cloud
replication, distillation, promotion policy, fact projection, scheduling, and
the local control socket.  The run loop stays on the main thread.  The control thread can only
read status or set the loop's wake/stop flags, so it cannot open a second
database transaction beside an active cycle.
"""

from __future__ import annotations

import os
import posixpath
import signal
import stat
import sys
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path, PurePosixPath
from types import FrameType
from typing import Any, Protocol
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.agent import CycleResult, open_stores, run_cycle
from jarvis_local.config import JarvisLocalConfig
from jarvis_local.crypto.device_keys import platform_device_key_store
from jarvis_local.memory.distillation import DistillationCoordinator
from jarvis_local.memory.facts import FactRepository
from jarvis_local.scheduler import STOP_AUTHENTICATION
from jarvis_local.service import LocalAgentService, RunLoop, ServiceState, control_handlers
from jarvis_local.sync.cloud_client import HttpCloudClient
from jarvis_local.sync.distill_client import HttpDistillationClient
from jarvis_local.sync.event_replicator import EventReplicator
from jarvis_local.sync.memory_projection import MemoryProjectionUploader
from jarvis_local.transport.pipe_server import ControlServer
from jarvis_local.transport.unix_socket import (
    CONTROL_SOCKET_ENVIRONMENT,
    UnixSocketServer,
    default_unix_socket_path,
)

SYNC_AUDIENCE = "jarvis-local-agent"
CONTROL_SOCKET_CONFIG = CONTROL_SOCKET_ENVIRONMENT

EXIT_NODE_OK = 0
EXIT_NODE_CONFIGURATION = 3
EXIT_NODE_STARTUP = 4
EXIT_NODE_AUTHENTICATION = 5


def _is_linux() -> bool:
    # Behind a function so mypy cannot erase the branch on a win32 run.
    return sys.platform.startswith("linux")


class NodeConfigurationError(RuntimeError):
    """The node environment is absent, malformed, or unsafe for Linux."""


class NodeStartupError(RuntimeError):
    """The node could not acquire or construct a required local dependency."""


class LoopRunner(Protocol):
    def run(self) -> str: ...


class ControlEndpoint(Protocol):
    def start(self) -> None: ...

    def serve_forever(self, should_continue: Callable[[], bool]) -> None: ...

    def close(self) -> None: ...


class Closable(Protocol):
    def close(self) -> None: ...


ControlFactory = Callable[[ControlServer, Path], ControlEndpoint]


@dataclass(frozen=True, slots=True)
class NodeSettings:
    cloud_base_url: str
    device_id: str
    principal_id: str
    device_key_path: Path
    archive_path: Path
    memory_path: Path
    control_socket_path: Path

    @classmethod
    def from_config(
        cls,
        config: JarvisLocalConfig,
        *,
        platform: str | None = None,
    ) -> NodeSettings:
        missing = config.missing_names()
        if missing:
            raise NodeConfigurationError("missing configuration: " + ", ".join(missing))
        current_platform = sys.platform if platform is None else platform
        if not current_platform.startswith("linux"):
            raise NodeConfigurationError("jarvis node requires Linux")

        values = config.environment
        cloud_base_url = values["JARVIS_CLOUD_BASE_URL"].strip()
        if not _is_https_origin(cloud_base_url):
            raise NodeConfigurationError("invalid configuration: JARVIS_CLOUD_BASE_URL")

        configured_paths = {
            name: values[name].strip()
            for name in ("JARVIS_DEVICE_KEY_PATH", "JARVIS_ARCHIVE_PATH", "JARVIS_MEMORY_PATH")
        }
        socket_value = values.get(CONTROL_SOCKET_CONFIG, "").strip()
        if socket_value:
            configured_paths[CONTROL_SOCKET_CONFIG] = socket_value
        invalid_paths = [name for name, value in configured_paths.items() if not _is_absolute_linux_path(value)]
        if invalid_paths:
            raise NodeConfigurationError("Linux paths must be absolute: " + ", ".join(invalid_paths))

        archive = Path(configured_paths["JARVIS_ARCHIVE_PATH"])
        memory = Path(configured_paths["JARVIS_MEMORY_PATH"])
        _validate_distinct_store_paths(archive, memory)
        return cls(
            cloud_base_url=cloud_base_url,
            device_id=values["JARVIS_DEVICE_ID"].strip(),
            principal_id=values["JARVIS_PRINCIPAL_ID"].strip(),
            device_key_path=Path(configured_paths["JARVIS_DEVICE_KEY_PATH"]),
            archive_path=archive,
            memory_path=memory,
            control_socket_path=Path(socket_value) if socket_value else default_unix_socket_path(values),
        )


def _is_https_origin(value: str) -> bool:
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    return (
        parts.scheme == "https"
        and bool(parts.hostname)
        and parts.username is None
        and parts.password is None
        and parts.path in ("", "/")
        and not parts.query
        and not parts.fragment
    )


def _is_absolute_linux_path(value: str) -> bool:
    return "\0" not in value and PurePosixPath(value).is_absolute()


def _validate_distinct_store_paths(archive_path: Path, memory_path: Path) -> None:
    archive = posixpath.normpath(os.fspath(archive_path))
    memory = posixpath.normpath(os.fspath(memory_path))
    if archive == memory:
        raise NodeConfigurationError("archive and memory must use separate files")
    if archive_path.resolve(strict=False) == memory_path.resolve(strict=False):
        raise NodeConfigurationError("archive and memory must use separate files")
    if archive_path.exists() and memory_path.exists() and os.path.samefile(archive_path, memory_path):
        raise NodeConfigurationError("archive and memory must use separate files")


def _validate_existing_device_key(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise NodeStartupError("the enrolled device key is missing") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise NodeStartupError("the enrolled device key is not a regular file")
    if _is_linux():
        if metadata.st_uid != os.geteuid():  # type: ignore[attr-defined,unused-ignore]
            raise NodeStartupError("the enrolled device key has an unexpected owner")
        if metadata.st_mode & 0o077:
            raise NodeStartupError("the enrolled device key is accessible to group or world")


@dataclass(slots=True)
class NodeRuntime:
    loop: LoopRunner
    state: ServiceState
    control: ControlEndpoint
    archive: Closable
    facts: Closable
    _closed: bool = field(init=False, default=False)
    _control_failed: threading.Event = field(init=False, default_factory=threading.Event)
    _signal_pending: bool = field(init=False, default=False)

    def run(self, *, install_signal_handlers: bool = True) -> str:
        """Run cycles on this thread and the flag-only control server beside it."""
        control_thread: threading.Thread | None = None
        control_thread_started = False
        previous: dict[signal.Signals, Any] = {}
        try:
            self.control.start()
            control_thread = threading.Thread(target=self._serve_control, name="jarvis-control")
            control_thread.start()
            control_thread_started = True
            previous = self._install_signal_handlers() if install_signal_handlers else {}
            reason = self.loop.run()
        finally:
            self.state.request_stop()
            try:
                if control_thread_started and control_thread is not None:
                    control_thread.join(timeout=5)
            finally:
                try:
                    self._restore_signal_handlers(previous)
                finally:
                    self.close()
        if control_thread_started and control_thread is not None and control_thread.is_alive():
            raise NodeStartupError("the control socket did not stop")
        if self._control_failed.is_set():
            raise NodeStartupError("the control socket stopped unexpectedly")
        return reason

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self.control.close()
        finally:
            try:
                self.facts.close()
            finally:
                self.archive.close()

    def _serve_control(self) -> None:
        try:
            self.control.serve_forever(self._control_should_continue)
        except BaseException:
            self._control_failed.set()
            self.state.request_stop()

    def _control_should_continue(self) -> bool:
        if self._signal_pending:
            self.state.request_stop()
        return not self.state.stop_requested()

    def _install_signal_handlers(self) -> dict[signal.Signals, Any]:
        if threading.current_thread() is not threading.main_thread():
            raise NodeStartupError("signal handlers require the main thread")
        previous: dict[signal.Signals, Any] = {}

        def request_stop(signum: int, frame: FrameType | None) -> None:
            # A Python signal can interrupt the main thread while it holds the
            # service-state lock. Taking that lock again here would deadlock.
            # This assignment is drained by the control thread's bounded poll.
            self._signal_pending = True

        try:
            for name in ("SIGINT", "SIGTERM"):
                signum = signal.Signals(getattr(signal, name))
                previous[signum] = signal.getsignal(signum)
                signal.signal(signum, request_stop)
        except BaseException:
            self._restore_signal_handlers(previous)
            raise
        return previous

    @staticmethod
    def _restore_signal_handlers(previous: Mapping[signal.Signals, Any]) -> None:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def _control_endpoint(server: ControlServer, path: Path) -> ControlEndpoint:
    return UnixSocketServer(server, path)


def _safe_node_cycle(
    replicator: EventReplicator,
    distiller: DistillationCoordinator,
    facts: FactRepository,
    principal_id: str,
    projector: MemoryProjectionUploader,
    should_stop: Callable[[], bool],
) -> CycleResult:
    """Keep exception text out of the status channel while preserving its class."""
    try:
        result = run_cycle(
            replicator,
            distiller,
            facts,
            principal_id,
            projector=projector,
            should_stop=should_stop,
        )
    except Exception:
        return CycleResult(0, 0, 0, 0, failure="cycle: failed")
    failure = result.failure
    if failure is None:
        return result
    if failure.startswith("authentication:"):
        safe = "authentication: device rejected"
    elif failure.startswith("sync:"):
        safe = "sync: request failed"
    elif failure.startswith("distillation:"):
        safe = "distillation: request failed"
    elif failure.startswith("projection_quarantined:"):
        safe = f"projection: {result.facts_quarantined} active facts quarantined"
    elif failure.startswith("projection_recovery:"):
        safe = "projection: permanent rejection; recovery pending"
    elif failure.startswith("projection:"):
        safe = "projection: request failed"
    else:
        safe = "cycle: failed"
    return replace(result, failure=safe)


def build_node(
    settings: NodeSettings,
    *,
    opener: Any = None,  # noqa: ANN401
    control_factory: ControlFactory = _control_endpoint,
) -> NodeRuntime:
    """Open stores and assemble the signed replication, distillation, and projection cycle."""
    _validate_distinct_store_paths(settings.archive_path, settings.memory_path)
    _validate_existing_device_key(settings.device_key_path)
    try:
        key = platform_device_key_store(settings.device_key_path).load_existing()
        if not isinstance(key, Ed25519PrivateKey):
            raise NodeStartupError("the node requires an Ed25519 device key")
    except NodeStartupError:
        raise
    except Exception as error:
        raise NodeStartupError("the enrolled device key could not be opened") from error

    state = ServiceState()
    control = control_factory(
        ControlServer(LocalAgentService(control_handlers(state))), settings.control_socket_path
    )
    # Claim the singleton endpoint before migrations touch either database. A
    # duplicate process must fail without doing any store work at all.
    control.start()
    try:
        archive, facts = open_stores(settings.archive_path, settings.memory_path)
        try:
            cloud = HttpCloudClient(
                base_url=settings.cloud_base_url,
                device_id=settings.device_id,
                principal_id=settings.principal_id,
                audience=SYNC_AUDIENCE,
                key=key,
                opener=opener,
            )
            replicator = EventReplicator(cloud, archive, should_stop=state.stop_requested)
            distiller = DistillationCoordinator(
                archive,
                facts,
                HttpDistillationClient(cloud),
                principal_id=settings.principal_id,
            )
            projector = MemoryProjectionUploader(
                facts,
                archive,
                cloud,
                should_stop=state.stop_requested,
            )
            loop = RunLoop(
                lambda: _safe_node_cycle(
                    replicator,
                    distiller,
                    facts,
                    settings.principal_id,
                    projector,
                    state.stop_requested,
                ),
                state=state,
            )
            return NodeRuntime(loop, state, control, archive, facts)
        except BaseException:
            try:
                facts.close()
            finally:
                archive.close()
            raise
    except BaseException:
        control.close()
        raise


def run_node(config: JarvisLocalConfig, *, socket_path: Path | None = None) -> int:
    """CLI boundary: emit stable diagnoses without printing exception values."""
    try:
        settings = NodeSettings.from_config(config)
        if socket_path is not None:
            if not _is_absolute_linux_path(os.fspath(socket_path)):
                raise NodeConfigurationError("Linux paths must be absolute: --socket-path")
            settings = replace(settings, control_socket_path=socket_path)
        runtime = build_node(settings)
        reason = runtime.run()
    except NodeConfigurationError as error:
        print(str(error))
        return EXIT_NODE_CONFIGURATION
    except Exception:
        print("the Jarvis node could not start or stopped unexpectedly")
        return EXIT_NODE_STARTUP
    if reason == STOP_AUTHENTICATION:
        print("the Jarvis node stopped because device authentication failed")
        return EXIT_NODE_AUTHENTICATION
    return EXIT_NODE_OK
