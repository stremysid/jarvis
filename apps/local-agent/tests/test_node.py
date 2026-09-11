"""The Linux home node assembles one foreground memory service and cleans up."""

from __future__ import annotations

import io
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
from pathlib import Path
from typing import Any

import pytest

from jarvis_local.agent import CycleResult, open_stores
from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.config import JarvisLocalConfig
from jarvis_local.crypto.device_keys import platform_device_key_store
from jarvis_local.memory.facts import FactRepository, FactState
from jarvis_local.node import (
    EXIT_NODE_AUTHENTICATION,
    NodeConfigurationError,
    NodeRuntime,
    NodeSettings,
    NodeStartupError,
    build_node,
    run_node,
)
from jarvis_local.scheduler import STOP_AUTHENTICATION
from jarvis_local.service import LocalAgentService, RunLoop, ServiceState, control_handlers
from jarvis_local.transport.cli_protocol import OK, CliCommand
from jarvis_local.transport.pipe_server import ControlServer
from jarvis_local.transport.unix_socket import UnixSocketServer, send_unix_control_request

linux_only = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux node acceptance")


def linux_environment(**overrides: str) -> dict[str, str]:
    values = {
        "JARVIS_CLOUD_BASE_URL": "https://gateway.example",
        "JARVIS_DEVICE_ID": "device-1",
        "JARVIS_PRINCIPAL_ID": "principal-1",
        "JARVIS_DEVICE_KEY_PATH": "/var/lib/jarvis/device.key",
        "JARVIS_ARCHIVE_PATH": "/var/lib/jarvis/archive.sqlite3",
        "JARVIS_MEMORY_PATH": "/var/lib/jarvis/memory.sqlite3",
        "JARVIS_CONTROL_SOCKET": "/run/jarvis/control.sock",
    }
    values.update(overrides)
    return values


def test_node_configuration_rejects_a_windows_path_on_linux() -> None:
    config = JarvisLocalConfig.load(linux_environment(JARVIS_ARCHIVE_PATH=r"C:\Jarvis\archive.sqlite3"))
    with pytest.raises(NodeConfigurationError, match="JARVIS_ARCHIVE_PATH"):
        NodeSettings.from_config(config, platform="linux")


def test_archive_and_memory_must_be_different_before_they_are_opened() -> None:
    same = "/var/lib/jarvis/data.sqlite3"
    config = JarvisLocalConfig.load(
        linux_environment(JARVIS_ARCHIVE_PATH=same, JARVIS_MEMORY_PATH=same)
    )
    with pytest.raises(NodeConfigurationError, match="separate"):
        NodeSettings.from_config(config, platform="linux")


def test_existing_hard_links_cannot_make_the_two_stores_one_file(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite3"
    memory = tmp_path / "memory.sqlite3"
    archive.write_bytes(b"")
    os.link(archive, memory)
    settings = settings_at(tmp_path, archive=archive, memory=memory)

    with pytest.raises(NodeConfigurationError, match="separate"):
        build_node(settings, control_factory=lambda *_: FakeControl())


@pytest.mark.skipif(os.name == "nt", reason="creating directory symlinks requires Windows privileges")
def test_nonexistent_store_names_through_a_symlinked_parent_are_refused(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(real, target_is_directory=True)
    settings = settings_at(
        tmp_path,
        archive=real / "data.sqlite3",
        memory=alias / "data.sqlite3",
    )

    with pytest.raises(NodeConfigurationError, match="separate"):
        build_node(settings, control_factory=lambda *_: FakeControl())


class FakeControl:
    def __init__(self, *, start_error: Exception | None = None) -> None:
        self.start_error = start_error
        self.started = 0
        self.closed = 0

    def start(self) -> None:
        self.started += 1
        if self.start_error is not None:
            raise self.start_error

    def serve_forever(self, should_continue: Any) -> None:
        while should_continue():
            time.sleep(0.001)

    def close(self) -> None:
        self.closed += 1


class FakeClosable:
    def __init__(self) -> None:
        self.closed = 0

    def close(self) -> None:
        self.closed += 1


class StoppingLoop:
    def __init__(self, state: ServiceState, result: str = "stopped") -> None:
        self.state = state
        self.result = result
        self.thread_id: int | None = None

    def run(self) -> str:
        self.thread_id = threading.get_ident()
        self.state.request_stop()
        return self.result


def test_the_run_loop_stays_on_the_calling_thread_and_everything_closes() -> None:
    state = ServiceState()
    loop = StoppingLoop(state)
    control = FakeControl()
    archive = FakeClosable()
    facts = FakeClosable()
    runtime = NodeRuntime(loop, state, control, archive, facts)
    calling_thread = threading.get_ident()

    assert runtime.run(install_signal_handlers=False) == "stopped"
    assert loop.thread_id == calling_thread
    assert control.started == 1
    assert control.closed == 1
    assert archive.closed == facts.closed == 1


def test_the_signal_handler_does_not_reenter_the_service_state_lock() -> None:
    code = """
import signal
from jarvis_local.node import NodeRuntime
from jarvis_local.service import ServiceState

class Closing:
    def close(self):
        pass

class Loop:
    def run(self):
        return "stopped"

class Control:
    def start(self):
        pass
    def serve_forever(self, predicate):
        pass
    def close(self):
        pass

state = ServiceState()
runtime = NodeRuntime(Loop(), state, Control(), Closing(), Closing())
previous = runtime._install_signal_handlers()
try:
    handler = signal.getsignal(signal.SIGINT)
    with state._lock:
        handler(signal.SIGINT, None)
    assert runtime._control_should_continue() is False
    assert state.stop_requested()
finally:
    runtime._restore_signal_handlers(previous)
"""
    process = subprocess.Popen(  # noqa: S603 - fixed interpreter and in-test source
        [sys.executable, "-c", code],
        cwd=Path(__file__).resolve().parents[1],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate(timeout=3)
        pytest.fail("the signal handler re-entered the service-state lock")
    assert process.returncode == 0, (stdout, stderr)


def test_a_duplicate_instance_failure_closes_acquired_stores() -> None:
    state = ServiceState()
    control = FakeControl(start_error=NodeStartupError("already running"))
    archive = FakeClosable()
    facts = FakeClosable()
    runtime = NodeRuntime(StoppingLoop(state), state, control, archive, facts)

    with pytest.raises(NodeStartupError):
        runtime.run(install_signal_handlers=False)

    assert control.closed == 1
    assert archive.closed == facts.closed == 1


def test_duplicate_socket_refusal_happens_before_any_store_is_opened(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    control = FakeControl(start_error=NodeStartupError("already running"))
    store_opened = False

    def open_forbidden(*_: object) -> tuple[ArchiveRepository, FactRepository]:
        nonlocal store_opened
        store_opened = True
        raise AssertionError("duplicate instance touched the stores")

    monkeypatch.setattr("jarvis_local.node.open_stores", open_forbidden)
    with pytest.raises(NodeStartupError, match="already running"):
        build_node(settings, control_factory=lambda *_: control)

    assert store_opened is False
    assert control.started == 1


def test_a_second_store_open_failure_closes_the_first_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = FakeClosable()
    monkeypatch.setattr("jarvis_local.agent.ArchiveRepository.open", lambda _: archive)

    def fail_memory(_: Path) -> FactRepository:
        raise RuntimeError("memory open failed")

    monkeypatch.setattr("jarvis_local.agent.FactRepository.open", fail_memory)
    with pytest.raises(RuntimeError, match="memory open failed"):
        open_stores(tmp_path / "archive.sqlite3", tmp_path / "memory.sqlite3")
    assert archive.closed == 1


def test_signal_setup_failure_unwinds_the_control_thread_and_stores(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = ServiceState()
    control = FakeControl()
    archive = FakeClosable()
    facts = FakeClosable()
    runtime = NodeRuntime(StoppingLoop(state), state, control, archive, facts)

    def fail_signals(self: NodeRuntime) -> dict[signal.Signals, Any]:
        raise RuntimeError("signal setup failed")

    monkeypatch.setattr(NodeRuntime, "_install_signal_handlers", fail_signals)
    with pytest.raises(RuntimeError, match="signal setup failed"):
        runtime.run()

    assert control.closed == 1
    assert archive.closed == facts.closed == 1


class FakeResponse(io.BytesIO):
    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_: object) -> None:
        return None


class SignedFlowOpener:
    def __init__(self) -> None:
        self.requests: list[Any] = []
        self.responses = [
            {
                "snapshotId": "snapshot-1",
                "snapshotToken": "token-1",
                "fromSequence": 1,
                "toSequence": 1,
                "hasMore": False,
                "events": [
                    {
                        "eventSequence": 1,
                        "envelope": {
                            "eventId": "event_00000000000000000000000001",
                            "eventType": "conversation.user_committed",
                            "subjectId": "principal-1",
                            "correlationId": "session-1",
                            "occurredAt": "2026-09-11T12:00:00.000Z",
                            "producerVersion": "conversation-v1",
                            "payload": {"text": "I like coffee"},
                        },
                    }
                ],
            },
            {"schemaVersion": "1.0", "currentSequence": 1, "replayed": False},
            {
                "proposals": [
                    {
                        "text": "Likes coffee",
                        "sourceEventIds": ["event_00000000000000000000000001"],
                    }
                ]
            },
        ]

    def __call__(self, request: Any, timeout: float | None = None) -> FakeResponse:
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return FakeResponse(json.dumps(response).encode("utf-8"))


def settings_at(
    root: Path,
    *,
    archive: Path | None = None,
    memory: Path | None = None,
) -> NodeSettings:
    return NodeSettings(
        cloud_base_url="https://gateway.example",
        device_id="device-1",
        principal_id="principal-1",
        device_key_path=root / "device.key",
        archive_path=archive or root / "archive.sqlite3",
        memory_path=memory or root / "memory.sqlite3",
        control_socket_path=root / "control.sock",
    )


def test_bootstrap_wires_signed_replication_then_distillation_on_real_stores(tmp_path: Path) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    opener = SignedFlowOpener()
    control = FakeControl()
    runtime = build_node(settings, opener=opener, control_factory=lambda *_: control)
    try:
        assert isinstance(runtime.loop, RunLoop)
        result = runtime.loop.run_cycle()
        rows = runtime.facts.connection.execute("SELECT state FROM fact").fetchall()  # type: ignore[attr-defined]
    finally:
        runtime.close()

    assert result.events_replicated == 1
    assert result.excerpts_distilled == 1
    assert result.proposals_recorded == 1
    assert result.facts_promoted == 0
    assert rows == [(FactState.PROPOSED.value,)]
    assert [request.full_url.rsplit("/", 2)[-2:] for request in opener.requests] == [
        ["sync", "pull"],
        ["sync", "ack"],
        ["memory", "distill"],
    ]
    signed = json.loads(opener.requests[0].headers["X-jarvis-signed-request"])
    assert signed["audience"] == "jarvis-local-agent"
    assert control.started == 1
    assert control.closed == 1


def test_cycle_failures_exposed_by_status_do_not_include_remote_error_text(tmp_path: Path) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    opener = SignedFlowOpener()
    opener.responses = [urllib.error.URLError("secret remote response and path")]
    runtime = build_node(settings, opener=opener, control_factory=lambda *_: FakeControl())
    try:
        assert isinstance(runtime.loop, RunLoop)
        runtime.loop._run_one("startup")
        report = "\n".join(runtime.state.report())
    finally:
        runtime.close()

    assert "sync: request failed" in report
    assert "secret remote response and path" not in report


@linux_only
def test_real_runtime_serves_status_run_once_and_stop_over_its_unix_socket(tmp_path: Path) -> None:
    parent = tmp_path / "private"
    parent.mkdir(mode=0o700)
    path = parent / "control.sock"
    state = ServiceState()
    cycles = 0

    def cycle() -> CycleResult:
        nonlocal cycles
        cycles += 1
        return CycleResult(0, 0, 0, 0)

    loop = RunLoop(cycle, state=state)
    control = UnixSocketServer(
        ControlServer(LocalAgentService(control_handlers(state))),
        path,
        accept_timeout=0.02,
        io_timeout=0.2,
    )
    runtime = NodeRuntime(loop, state, control, FakeClosable(), FakeClosable())
    outcome: list[str] = []
    control.start()
    thread = threading.Thread(target=lambda: outcome.append(runtime.run(install_signal_handlers=False)))
    thread.start()
    try:
        deadline = time.monotonic() + 2
        while not path.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert send_unix_control_request(CliCommand("status"), path).code == OK
        deadline = time.monotonic() + 2
        while cycles < 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert cycles == 1
        assert send_unix_control_request(CliCommand("run-once"), path).code == OK
        deadline = time.monotonic() + 2
        while cycles < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert cycles == 2
        assert send_unix_control_request(CliCommand("stop"), path).code == OK
    finally:
        state.request_stop()
        thread.join(timeout=3)
        runtime.close()

    assert not thread.is_alive()
    assert outcome == ["stopped"]
    assert not path.exists()


@linux_only
def test_sigterm_stops_the_foreground_node_and_cleans_its_socket(tmp_path: Path) -> None:
    parent = tmp_path / "private"
    parent.mkdir(mode=0o700)
    path = parent / "control.sock"
    code = """
import sys
from pathlib import Path
from jarvis_local.agent import CycleResult
from jarvis_local.node import NodeRuntime
from jarvis_local.service import LocalAgentService, RunLoop, ServiceState, control_handlers
from jarvis_local.transport.pipe_server import ControlServer
from jarvis_local.transport.unix_socket import UnixSocketServer

class Closing:
    def close(self):
        pass

state = ServiceState()
loop = RunLoop(lambda: CycleResult(0, 0, 0, 0), state=state)
control = UnixSocketServer(ControlServer(LocalAgentService(control_handlers(state))), Path(sys.argv[1]))
reason = NodeRuntime(loop, state, control, Closing(), Closing()).run()
raise SystemExit(0 if reason == "stopped" else 1)
"""
    process = subprocess.Popen(  # noqa: S603 - fixed interpreter and in-test source
        [sys.executable, "-c", code, os.fspath(path)],
        cwd=Path(__file__).resolve().parents[1],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout = ""
    stderr = ""
    try:
        deadline = time.monotonic() + 5
        ready = False
        while process.poll() is None and time.monotonic() < deadline:
            try:
                response = send_unix_control_request(CliCommand("status"), path)
            except Exception:
                time.sleep(0.02)
                continue
            ready = "cycles_recorded 1" in response.lines
            if ready:
                break
            time.sleep(0.02)
        assert ready
        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=5)
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)

    assert process.returncode == 0, (stdout, stderr)
    assert not path.exists()


def test_bootstrap_does_not_create_a_new_identity_when_enrollment_is_missing(tmp_path: Path) -> None:
    settings = settings_at(tmp_path)
    control = FakeControl()

    with pytest.raises(NodeStartupError, match="enrolled device key is missing"):
        build_node(settings, control_factory=lambda *_: control)

    assert not settings.device_key_path.exists()
    assert control.started == 0


def test_authentication_exit_is_nonzero_and_does_not_print_the_raw_error(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class AuthRuntime:
        def run(self) -> str:
            return STOP_AUTHENTICATION

    monkeypatch.setattr("jarvis_local.node.sys.platform", "linux")
    monkeypatch.setattr("jarvis_local.node.build_node", lambda _: AuthRuntime())
    code = run_node(JarvisLocalConfig.load(linux_environment()))

    assert code == EXIT_NODE_AUTHENTICATION
    printed = capsys.readouterr().out
    assert "authentication failed" in printed
    assert "secret" not in printed


def test_startup_failure_is_nonzero_and_sanitized(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fail(_: NodeSettings) -> NodeRuntime:
        raise NodeStartupError("secret path and exception")

    monkeypatch.setattr("jarvis_local.node.sys.platform", "linux")
    monkeypatch.setattr("jarvis_local.node.build_node", fail)
    code = run_node(JarvisLocalConfig.load(linux_environment()))

    assert code != 0
    assert "secret path and exception" not in capsys.readouterr().out
