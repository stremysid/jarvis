"""The Linux home node assembles one foreground memory service and cleans up."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import os
import shlex
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
from email.message import Message
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.agent import CycleResult, open_stores
from jarvis_local.archive import store_permissions
from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.archive.database import SQLiteDirectoryError
from jarvis_local.archive.store_permissions import StoreDaclRefusedError
from jarvis_local.config import JarvisLocalConfig
from jarvis_local.crypto.device_keys import platform_device_key_store
from jarvis_local.crypto.signed_request import signature_text
from jarvis_local.memory.facts import FactOrigin, FactProposal, FactRepository, FactState
from jarvis_local.memory.promotion import PromotionEngine
from jarvis_local.node import (
    EXIT_NODE_AUTHENTICATION,
    NodeConfigurationError,
    NodeRuntime,
    NodeSettings,
    NodeStartupError,
    _safe_node_cycle,
    _validate_existing_device_key,
    _windows_control_endpoint,
    build_node,
    run_node,
    run_serve,
)
from jarvis_local.scheduler import STOP_AUTHENTICATION, SchedulerState
from jarvis_local.service import (
    LocalAgentService,
    RunLoop,
    ServiceState,
    control_handlers,
)
from jarvis_local.sync.cloud_client import CloudAuthError
from jarvis_local.sync.memory_projection import MemoryProjectionUploader
from jarvis_local.transport.cli_protocol import OK, CliCommand
from jarvis_local.transport.pipe_server import ControlServer
from jarvis_local.transport.unix_socket import UnixSocketInUseError, UnixSocketServer, send_unix_control_request

linux_only = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux node acceptance")

#: The mirror of `linux_only`, and it exists because its absence put two tests on
#: Linux CI that cannot run there: they build a Windows named-pipe endpoint, which
#: reaches `current_user_sid` and therefore `ctypes.WinDLL` -- a name that does not
#: exist on Linux, so they failed with AttributeError rather than skipping.
windows_only = pytest.mark.skipif(sys.platform != "win32", reason="named pipes are a Windows mechanism")


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
    config = JarvisLocalConfig.load(linux_environment(JARVIS_ARCHIVE_PATH=same, JARVIS_MEMORY_PATH=same))
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


def test_a_second_store_open_failure_closes_the_first_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    archive = FakeClosable()
    monkeypatch.setattr("jarvis_local.agent.ArchiveRepository.open", lambda _path, **_kwargs: archive)

    def fail_memory(_path: Path, **_kwargs: object) -> FactRepository:
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
                "fromSequence": 0,
                "toSequence": 1,
                "hasMore": False,
                "events": [
                    {
                        "eventSequence": 1,
                        "envelope": {
                            "eventId": "01k3w1t4000000000000000110",
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
                        "sourceEventIds": ["01k3w1t4000000000000000110"],
                    }
                ]
            },
        ]

    def __call__(self, request: Any, timeout: float | None = None) -> FakeResponse:
        self.requests.append(request)
        if request.full_url.endswith("/sync/memory/project"):
            body = json.loads(request.data.decode("utf-8"))
            is_page = body["operation"] == "page"
            return FakeResponse(
                json.dumps(
                    {
                        "schemaVersion": "1.0",
                        "projectionVersion": body["projectionVersion"],
                        "manifestHash": body["manifestHash"],
                        "pageIndex": body["pageIndex"] if is_page else None,
                        "pageHash": body["pageHash"] if is_page else None,
                        "published": body["operation"] == "commit",
                        "replayed": False,
                    }
                ).encode("utf-8")
            )
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return FakeResponse(json.dumps(response).encode("utf-8"))


class EmptyCycleOpener:
    def __init__(
        self,
        projection_actions: list[Any] | None = None,
        on_projection: Any = None,
        distill_action: BaseException | None = None,
    ) -> None:
        self.requests: list[Any] = []
        self.projection_actions = list(projection_actions or [])
        self.on_projection = on_projection
        self.distill_action = distill_action

    def __call__(self, request: Any, timeout: float | None = None) -> FakeResponse:
        self.requests.append(request)
        body = json.loads(request.data.decode("utf-8"))
        if request.full_url.endswith("/sync/pull"):
            after = body["afterSequence"]
            return FakeResponse(
                json.dumps(
                    {
                        "snapshotId": f"empty-{len(self.requests)}",
                        "snapshotToken": f"empty-token-{len(self.requests)}",
                        "fromSequence": after,
                        "toSequence": after,
                        "hasMore": False,
                        "events": [],
                    }
                ).encode("utf-8")
            )
        if request.full_url.endswith("/memory/distill"):
            if self.distill_action is not None:
                raise self.distill_action
            return FakeResponse(b'{"proposals":[]}')
        if request.full_url.endswith("/sync/memory/project"):
            if self.on_projection is not None:
                self.on_projection(body)
            if self.projection_actions:
                action = self.projection_actions.pop(0)
                if isinstance(action, BaseException):
                    raise action
                if action is not None:
                    return FakeResponse(json.dumps(action).encode("utf-8"))
            is_page = body["operation"] == "page"
            return FakeResponse(
                json.dumps(
                    {
                        "schemaVersion": "1.0",
                        "projectionVersion": body["projectionVersion"],
                        "manifestHash": body["manifestHash"],
                        "pageIndex": body["pageIndex"] if is_page else None,
                        "pageHash": body["pageHash"] if is_page else None,
                        "published": body["operation"] == "commit",
                        "replayed": False,
                    }
                ).encode("utf-8")
            )
        raise AssertionError(f"unexpected request: {request.full_url}")

    @property
    def paths(self) -> list[str]:
        return [request.full_url.removeprefix("https://gateway.example") for request in self.requests]

    @property
    def projection_bodies(self) -> list[dict[str, Any]]:
        return [
            json.loads(request.data.decode("utf-8"))
            for request in self.requests
            if request.full_url.endswith("/sync/memory/project")
        ]


class TransactionRecordingOpener:
    """Observe actual store transactions at the boundary of each HTTP call."""

    def __init__(self, delegate: Any) -> None:
        self.delegate = delegate
        self.runtime: NodeRuntime | None = None
        self.observed: list[tuple[str, str | None, bool, bool]] = []

    def __call__(self, request: Any, timeout: float | None = None) -> FakeResponse:
        assert self.runtime is not None
        assert isinstance(self.runtime.archive, ArchiveRepository)
        assert isinstance(self.runtime.facts, FactRepository)
        body = json.loads(request.data.decode("utf-8"))
        self.observed.append((
            request.full_url.removeprefix("https://gateway.example"),
            body.get("operation"),
            self.runtime.archive.connection.in_transaction,
            self.runtime.facts.connection.in_transaction,
        ))
        return self.delegate(request, timeout=timeout)

    def assert_no_open_transactions(self) -> None:
        # Assert after the cycle, too: intentionally failed recovery requests
        # can have their exceptions converted into a normal failure result.
        assert self.observed
        assert all(not archive and not memory for _, _, archive, memory in self.observed), self.observed


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
        control_endpoint_name=os.fspath(root / "control.sock"),
    )


def record_promotable_fact(runtime: NodeRuntime) -> str:
    assert isinstance(runtime.archive, ArchiveRepository)
    assert isinstance(runtime.facts, FactRepository)
    event_id = "01k3w1t4000000000000000220"
    runtime.archive.insert_event_if_absent(
        {
            "event_id": event_id,
            "event_sequence": 20,
            "event_type": "conversation.user_committed",
            "principal_id": "principal-1",
            "session_id": "session-projection",
            "canonical_text": "My favorite tea is jasmine",
            "occurred_at": "2026-09-11T12:00:00.000Z",
            "producer_version": "conversation-v1",
        }
    )
    fact = runtime.facts.record_proposal(
        FactProposal(
            principal_id="principal-1",
            text="Favorite tea is jasmine",
            origin=FactOrigin.AUTHENTICATED_FIRST_PERSON,
            source_event_ids=(event_id,),
        )
    )
    return fact.fact_id


def test_bootstrap_wires_signed_replication_then_distillation_on_real_stores(tmp_path: Path) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    opener = SignedFlowOpener()
    observed = TransactionRecordingOpener(opener)
    control = FakeControl()
    runtime = build_node(settings, opener=observed, control_factory=lambda *_: control)
    observed.runtime = runtime
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
        ["memory", "project"],
        ["memory", "project"],
    ]
    assert json.loads(opener.requests[3].data.decode("utf-8"))["facts"] == []
    signed = json.loads(opener.requests[0].headers["X-jarvis-signed-request"])
    assert signed["audience"] == "jarvis-local-agent"
    assert control.started == 1
    assert control.closed == 1
    observed.assert_no_open_transactions()


def test_node_projects_promoted_facts_once_across_two_cycles(tmp_path: Path) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    opener = EmptyCycleOpener()
    runtime = build_node(settings, opener=opener, control_factory=lambda *_: FakeControl())
    try:
        fact_id = record_promotable_fact(runtime)
        assert isinstance(runtime.loop, RunLoop)
        first = runtime.loop.run_cycle()
        second = runtime.loop.run_cycle()
    finally:
        runtime.close()

    assert first.facts_promoted == 1
    assert first.failure is None
    assert second.facts_promoted == 0
    assert second.failure is None
    assert len(opener.projection_bodies) == 2
    assert opener.projection_bodies[0]["operation"] == "page"
    assert opener.projection_bodies[0]["facts"][0]["factId"] == fact_id
    assert opener.projection_bodies[1]["operation"] == "commit"
    signing_key = platform_device_key_store(settings.device_key_path).load_existing()
    assert isinstance(signing_key, Ed25519PrivateKey)
    public_key = signing_key.public_key()
    for request in opener.requests:
        if request.full_url.endswith("/sync/memory/project"):
            signed = json.loads(request.headers["X-jarvis-signed-request"])
            assert signed["principalId"] == "principal-1"
            assert signed["deviceId"] == "device-1"
            assert signed["audience"] == "jarvis-local-agent"
            assert signed["bodyHash"] == hashlib.sha256(request.data).hexdigest()
            public_key.verify(
                base64.b64decode(signed["signatureBase64"]),
                signature_text(
                    method="POST",
                    path="/sync/memory/project",
                    device_id=signed["deviceId"],
                    principal_id=signed["principalId"],
                    audience=signed["audience"],
                    issued_at=signed["issuedAt"],
                    nonce=signed["nonce"],
                    body_hash=signed["bodyHash"],
                ),
            )


def test_pending_projection_is_retried_by_a_reconstructed_node_before_distillation(
    tmp_path: Path,
) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    first_opener = EmptyCycleOpener(projection_actions=[None, urllib.error.URLError("commit response lost")])
    first_observed = TransactionRecordingOpener(first_opener)
    first_runtime = build_node(settings, opener=first_observed, control_factory=lambda *_: FakeControl())
    first_observed.runtime = first_runtime
    try:
        record_promotable_fact(first_runtime)
        assert isinstance(first_runtime.loop, RunLoop)
        failed = first_runtime.loop.run_cycle()
        assert isinstance(first_runtime.facts, FactRepository)
        assert first_runtime.facts.connection.execute("SELECT COUNT(*) FROM memory_projection_pending").fetchone() == (
            1,
        )
        first_projection_bodies = first_opener.projection_bodies
    finally:
        first_runtime.close()

    second_opener = EmptyCycleOpener(distill_action=urllib.error.URLError("fresh model request unavailable"))
    second_observed = TransactionRecordingOpener(second_opener)
    second_runtime = build_node(settings, opener=second_observed, control_factory=lambda *_: FakeControl())
    second_observed.runtime = second_runtime
    try:
        assert isinstance(second_runtime.archive, ArchiveRepository)
        second_runtime.archive.insert_event_if_absent(
            {
                "event_id": "01k3w1t4000000000000000330",
                "event_sequence": 21,
                "event_type": "conversation.user_committed",
                "principal_id": "principal-1",
                "session_id": "session-recovery",
                "canonical_text": "A new event needs distillation",
                "occurred_at": "2026-09-11T12:01:00.000Z",
                "producer_version": "conversation-v1",
            }
        )
        assert isinstance(second_runtime.loop, RunLoop)
        recovered = second_runtime.loop.run_cycle()
        assert isinstance(second_runtime.facts, FactRepository)
        pending = second_runtime.facts.connection.execute("SELECT COUNT(*) FROM memory_projection_pending").fetchone()
        cursor = second_runtime.facts.connection.execute(
            "SELECT published_version FROM memory_projection_cursor"
        ).fetchone()
    finally:
        second_runtime.close()

    assert failed.failure == "projection: request failed"
    assert recovered.failure == "distillation: request failed"
    assert second_opener.paths[:4] == [
        "/sync/pull",
        "/sync/memory/project",
        "/sync/memory/project",
        "/memory/distill",
    ]
    assert second_opener.projection_bodies == first_projection_bodies
    assert pending == (0,)
    assert cursor == (1,)
    first_observed.assert_no_open_transactions()
    second_observed.assert_no_open_transactions()


@pytest.mark.parametrize("fact_count", [1, 32])
def test_the_node_reports_quarantine_count_and_keeps_publishing_later_cycles(
    tmp_path: Path, fact_count: int,
) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    rejected = urllib.error.HTTPError(
        "https://gateway.example",
        400,
        "rejected",
        Message(),
        io.BytesIO(b'{"error":"memory_projection_content_rejected"}'),
    )
    opener = EmptyCycleOpener(projection_actions=[rejected])
    observed = TransactionRecordingOpener(opener)
    runtime = build_node(settings, opener=observed, control_factory=lambda *_: FakeControl())
    observed.runtime = runtime
    try:
        record_promotable_fact(runtime)
        assert isinstance(runtime.loop, RunLoop)
        assert isinstance(runtime.facts, FactRepository)
        for index in range(1, fact_count):
            runtime.facts.record_proposal(FactProposal(
                principal_id="principal-1",
                text=f"Healthy preference {index}",
                origin=FactOrigin.AUTHENTICATED_FIRST_PERSON,
                source_event_ids=("01k3w1t4000000000000000220",),
            ))
        def stop_after_two_cycles(_seconds: float) -> None:
            if len(runtime.state.recent()) == 2:
                runtime.state.request_stop()

        runtime.loop.sleep = stop_after_two_cycles
        assert runtime.loop.run() == "stopped"
        report = control_handlers(runtime.state)["status"](CliCommand("status"))
        cycle_lines = [line for line in report.lines if line.startswith("cycle ")]
        assert len(cycle_lines) == 2
        assert all(f"quarantined={fact_count}" in line for line in cycle_lines)
        assert all(line.endswith(" ok") for line in cycle_lines)
        assert len(opener.projection_bodies[0]["facts"]) == fact_count
        assert [body["operation"] for body in opener.projection_bodies] == ["page", "abandon", "page", "commit"]
        assert opener.projection_bodies[-2]["facts"] == []
        assert runtime.facts.connection.execute(
            "SELECT published_version FROM memory_projection_cursor"
        ).fetchone() == (1,)
    finally:
        runtime.close()

    observed.assert_no_open_transactions()


def test_built_node_executes_quarantine_retry_on_the_cycle_thread(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    retry_threads: list[int] = []
    real_retry = MemoryProjectionUploader.retry_quarantined

    def record_retry_thread(uploader: MemoryProjectionUploader, fact_id: str) -> bool:
        retry_threads.append(threading.get_ident())
        return real_retry(uploader, fact_id)

    monkeypatch.setattr(MemoryProjectionUploader, "retry_quarantined", record_retry_thread)

    class RetryControl(FakeControl):
        def __init__(self, server: ControlServer) -> None:
            super().__init__()
            self.server = server
            self.response: object | None = None
            self.finished: Any = lambda: None

        def serve_forever(self, _should_continue: Any) -> None:
            try:
                self.response = self.server.dispatcher.handle(CliCommand(
                    "retry-quarantined", {"fact_id": fact_id},
                ))
            finally:
                self.finished()

    controls: list[RetryControl] = []

    def capture(server: ControlServer, _path: Path) -> RetryControl:
        control = RetryControl(server)
        controls.append(control)
        return control

    runtime = build_node(settings, opener=EmptyCycleOpener(), control_factory=capture)
    assert isinstance(runtime.facts, FactRepository)
    fact_id = record_promotable_fact(runtime)
    PromotionEngine(runtime.facts).promote(runtime.facts.get(fact_id))
    runtime.facts.connection.execute(
        "INSERT INTO memory_projection_quarantine VALUES (?, ?, ?, ?, 'gateway_rejected', ?)",
        (settings.cloud_base_url, settings.principal_id, settings.device_id, fact_id, "2026-09-11T12:00:00.000Z"),
    )
    controls[0].finished = runtime.state.request_stop

    assert runtime.run(install_signal_handlers=False) == "stopped"
    assert getattr(controls[0].response, "code", None) == OK
    assert retry_threads == [threading.get_ident()]
    with sqlite3.connect(settings.memory_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM memory_projection_quarantine").fetchone() == (0,)


def test_the_node_distinguishes_pending_recovery_from_transient_projection_failure(tmp_path: Path) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    rejected = urllib.error.HTTPError(
        "https://gateway.example",
        400,
        "rejected",
        Message(),
        io.BytesIO(b'{"error":"memory_projection_content_rejected"}'),
    )
    opener = EmptyCycleOpener(projection_actions=[rejected, urllib.error.URLError("unavailable")])
    runtime = build_node(settings, opener=opener, control_factory=lambda *_: FakeControl())
    try:
        record_promotable_fact(runtime)
        assert isinstance(runtime.loop, RunLoop)
        assert runtime.loop.run_cycle().failure == "projection: permanent rejection; recovery pending"
    finally:
        runtime.close()


def test_pending_projection_authentication_rejection_stops_before_distillation(
    tmp_path: Path,
) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    first_opener = EmptyCycleOpener(projection_actions=[None, urllib.error.URLError("commit response lost")])
    first_runtime = build_node(settings, opener=first_opener, control_factory=lambda *_: FakeControl())
    try:
        record_promotable_fact(first_runtime)
        assert isinstance(first_runtime.loop, RunLoop)
        assert first_runtime.loop.run_cycle().failure == "projection: request failed"
    finally:
        first_runtime.close()

    rejected = urllib.error.HTTPError("https://gateway.example/sync/memory/project", 403, "forbidden", Message(), None)
    second_opener = EmptyCycleOpener(projection_actions=[rejected])
    second_runtime = build_node(settings, opener=second_opener, control_factory=lambda *_: FakeControl())
    try:
        assert isinstance(second_runtime.loop, RunLoop)
        result = second_runtime.loop.run_cycle()
        decision = second_runtime.loop.scheduler.after(SchedulerState(), result)
        assert isinstance(second_runtime.facts, FactRepository)
        pending = second_runtime.facts.connection.execute("SELECT COUNT(*) FROM memory_projection_pending").fetchone()
    finally:
        second_runtime.close()

    assert result.failure == "authentication: device rejected"
    assert decision.keep_running is False
    assert decision.reason == STOP_AUTHENTICATION
    assert second_opener.paths == ["/sync/pull", "/sync/memory/project"]
    assert pending == (1,)


def test_node_stop_between_projection_page_and_commit_leaves_pending_snapshot(
    tmp_path: Path,
) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    runtime_holder: list[NodeRuntime] = []

    def stop_after_page(body: dict[str, Any]) -> None:
        if body["operation"] == "page":
            runtime_holder[0].state.request_stop()

    opener = EmptyCycleOpener(on_projection=stop_after_page)
    runtime = build_node(settings, opener=opener, control_factory=lambda *_: FakeControl())
    runtime_holder.append(runtime)
    try:
        record_promotable_fact(runtime)
        assert isinstance(runtime.loop, RunLoop)
        result = runtime.loop.run_cycle()
        assert isinstance(runtime.facts, FactRepository)
        pending = runtime.facts.connection.execute("SELECT COUNT(*) FROM memory_projection_pending").fetchone()
    finally:
        runtime.close()

    assert result.failure is None
    assert [body["operation"] for body in opener.projection_bodies] == ["page"]
    assert pending == (1,)


def test_projection_authentication_failure_stops_the_real_node(tmp_path: Path) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    rejected = urllib.error.HTTPError("https://gateway.example/sync/memory/project", 403, "forbidden", Message(), None)
    opener = EmptyCycleOpener(projection_actions=[rejected])
    runtime = build_node(settings, opener=opener, control_factory=lambda *_: FakeControl())
    try:
        record_promotable_fact(runtime)
        assert isinstance(runtime.loop, RunLoop)
        reason = runtime.loop.run()
        report = "\n".join(runtime.state.report())
        assert isinstance(runtime.facts, FactRepository)
        pending = runtime.facts.connection.execute("SELECT COUNT(*) FROM memory_projection_pending").fetchone()
    finally:
        runtime.close()

    assert reason == STOP_AUTHENTICATION
    assert "authentication: device rejected" in report
    assert pending == (1,)


def test_bootstrap_gives_replication_a_live_stop_check(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    captured: list[Any] = []
    real_replicator = __import__("jarvis_local.sync.event_replicator", fromlist=["EventReplicator"]).EventReplicator

    def build_replicator(*args: object, **kwargs: Any) -> Any:
        built = real_replicator(*args, **kwargs)
        captured.append(built)
        return built

    monkeypatch.setattr("jarvis_local.node.EventReplicator", build_replicator)
    runtime = build_node(settings, opener=SignedFlowOpener(), control_factory=lambda *_: FakeControl())
    try:
        assert len(captured) == 1
        runtime.state.request_stop()
        assert captured[0]._should_stop() is True
    finally:
        runtime.close()


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


def test_safe_node_cycle_leaves_authentication_for_the_run_loop_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def rejected(*_args: object, **_kwargs: object) -> CycleResult:
        raise CloudAuthError("device revoked")

    monkeypatch.setattr("jarvis_local.node.run_cycle", rejected)

    with pytest.raises(CloudAuthError, match="device revoked"):
        _safe_node_cycle(*([object()] * 5), should_stop=lambda: False)  # type: ignore[arg-type]


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
def test_real_socket_retry_clears_quarantine_without_stopping_the_node(tmp_path: Path) -> None:
    root = tmp_path / "private"
    root.mkdir(mode=0o700)
    settings = settings_at(root)
    platform_device_key_store(settings.device_key_path).load_or_create()
    runtime = build_node(settings, opener=EmptyCycleOpener())
    assert isinstance(runtime.facts, FactRepository)
    fact_id = record_promotable_fact(runtime)
    PromotionEngine(runtime.facts).promote(runtime.facts.get(fact_id))
    runtime.facts.connection.execute(
        "INSERT INTO memory_projection_quarantine VALUES (?, ?, ?, ?, 'gateway_rejected', ?)",
        (settings.cloud_base_url, settings.principal_id, settings.device_id, fact_id, "2026-09-11T12:00:00.000Z"),
    )
    responses: list[object] = []
    errors: list[BaseException] = []

    def drive_control_socket() -> None:
        try:
            responses.append(send_unix_control_request(
                CliCommand("retry-quarantined", {"fact_id": fact_id}),
                settings.control_endpoint_name,
            ))
            responses.append(send_unix_control_request(CliCommand("status"), settings.control_endpoint_name))
            responses.append(send_unix_control_request(CliCommand("stop"), settings.control_endpoint_name))
        except BaseException as error:
            errors.append(error)

    client = threading.Thread(target=drive_control_socket)
    client.start()
    reason = runtime.run(install_signal_handlers=False)
    client.join(timeout=3)

    assert not client.is_alive()
    assert errors == []
    assert reason == "stopped"
    assert [getattr(response, "code", None) for response in responses] == [OK, OK, OK]
    with sqlite3.connect(settings.memory_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM memory_projection_quarantine").fetchone() == (0,)


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
    monkeypatch.setattr("jarvis_local.node.build_node", lambda _settings, **_kwargs: AuthRuntime())
    code = run_node(JarvisLocalConfig.load(linux_environment()))

    assert code == EXIT_NODE_AUTHENTICATION
    printed = capsys.readouterr().out
    assert "authentication failed" in printed
    assert "secret" not in printed


def test_startup_failure_is_nonzero_and_sanitized(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fail(_settings: NodeSettings, **_kwargs: object) -> NodeRuntime:
        raise NodeStartupError("secret path and exception")

    monkeypatch.setattr("jarvis_local.node.sys.platform", "linux")
    monkeypatch.setattr("jarvis_local.node.build_node", fail)
    code = run_node(JarvisLocalConfig.load(linux_environment()))

    assert code != 0
    assert "secret path and exception" not in capsys.readouterr().out


def test_an_existing_socket_reports_its_configured_path_and_conditional_recovery(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    endpoint = "/run/jarvis/owner's control.sock"

    def fail(_settings: NodeSettings, **_kwargs: object) -> NodeRuntime:
        raise UnixSocketInUseError("synthetic private exception detail")

    monkeypatch.setattr("jarvis_local.node.sys.platform", "linux")
    monkeypatch.setattr("jarvis_local.node.build_node", fail)
    assert run_node(JarvisLocalConfig.load(linux_environment(JARVIS_CONTROL_SOCKET=endpoint))) == 4
    output = capsys.readouterr().out
    # The endpoint is a string, not a `Path`: a `Path` rewrites a POSIX
    # separator on Windows, and the recovery command has to name the file the
    # person would actually type.
    assert endpoint in output
    assert "stop" in output.lower() and "stale socket" in output
    assert "rm -- " + shlex.quote(endpoint) in output
    assert "synthetic private" not in output


def test_an_unsafe_store_parent_reports_the_path_and_required_mode(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    def fail(_settings: NodeSettings, **_kwargs: object) -> NodeRuntime:
        raise SQLiteDirectoryError("SQLite store parent /srv/shared requires owner-only permissions (0700)")

    monkeypatch.setattr("jarvis_local.node.sys.platform", "linux")
    monkeypatch.setattr("jarvis_local.node.build_node", fail)
    assert run_node(JarvisLocalConfig.load(linux_environment())) == 3
    output = capsys.readouterr().out
    assert "/srv/shared" in output
    assert "0700" in output


# --- the same assembly, bound to the Windows control channel ----------------
#
# `node` and `serve` are one assembly and two platform bindings. These run the
# Windows binding on the Linux boxes the suite actually executes on, which is
# the only way the Windows half is covered at all: the exit test for it is by
# hand, on one machine, once.


def windows_environment(**overrides: str) -> dict[str, str]:
    values = {
        "JARVIS_CLOUD_BASE_URL": "https://gateway.example",
        "JARVIS_DEVICE_ID": "device-1",
        "JARVIS_PRINCIPAL_ID": "principal-1",
        "JARVIS_DEVICE_KEY_PATH": r"C:\Users\Sid\AppData\Local\Jarvis\keys\device.key",
        "JARVIS_ARCHIVE_PATH": r"C:\Users\Sid\AppData\Local\Jarvis\archive.sqlite3",
        "JARVIS_MEMORY_PATH": r"C:\Users\Sid\AppData\Local\Jarvis\memory.sqlite3",
    }
    values.update(overrides)
    return values


def windows_settings(tmp_path: Path) -> NodeSettings:
    return NodeSettings(
        cloud_base_url="https://gateway.example",
        device_id="device-1",
        principal_id="principal-1",
        device_key_path=tmp_path / "device.key",
        archive_path=tmp_path / "archive.sqlite3",
        memory_path=tmp_path / "memory.sqlite3",
        control_endpoint_name=r"\\.\pipe\jarvis-local-agent",
    )


def test_the_windows_assembly_defaults_to_the_pipe_the_cli_already_speaks_to() -> None:
    settings = NodeSettings.from_config(JarvisLocalConfig.load(windows_environment()), platform="win32")

    assert settings.control_endpoint_name == r"\\.\pipe\jarvis-local-agent"


def test_a_control_socket_named_on_windows_is_not_where_the_agent_binds() -> None:
    """`JARVIS_CONTROL_SOCKET` is documented as the Linux equivalent, so on
    Windows it is not consulted at all -- not read, not validated, and not
    bound. The CLI sends to the pipe name unless it is told otherwise."""
    environment = windows_environment(JARVIS_CONTROL_SOCKET=r"C:\Jarvis\control.sock")

    settings = NodeSettings.from_config(JarvisLocalConfig.load(environment), platform="win32")

    assert settings.control_endpoint_name == r"\\.\pipe\jarvis-local-agent"


def test_a_posix_control_socket_on_windows_is_ignored_rather_than_refused() -> None:
    """A POSIX path is not absolute to Windows, so validating it there would
    refuse a `.env` a Windows host cannot use anyway -- and refusing it would
    stop a boot over a value nothing reads."""
    environment = windows_environment(JARVIS_CONTROL_SOCKET="/run/jarvis/control.sock")

    settings = NodeSettings.from_config(JarvisLocalConfig.load(environment), platform="win32")

    assert settings.control_endpoint_name == r"\\.\pipe\jarvis-local-agent"


def test_an_unsupported_platform_is_refused_rather_than_assembled() -> None:
    with pytest.raises(NodeConfigurationError, match="Linux or Windows"):
        NodeSettings.from_config(JarvisLocalConfig.load(windows_environment()), platform="darwin")


def test_the_linux_assembly_still_takes_the_socket_the_environment_named() -> None:
    settings = NodeSettings.from_config(JarvisLocalConfig.load(linux_environment()), platform="linux")

    assert settings.control_endpoint_name == "/run/jarvis/control.sock"


def test_the_posix_owner_and_mode_checks_are_not_applied_to_a_windows_assembly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`os.geteuid` does not exist on Windows and `st_mode` there is synthesized,
    so a key Windows accepts must not be refused by a check only POSIX has.

    `geteuid` is patched in because Windows has none: without it the Linux
    assertion below would skip for the very reason this test exists to
    distinguish itself from, and it would pass on the machine it is written
    for while proving nothing."""
    key = tmp_path / "device.key"
    key.write_bytes(b"x")
    key.chmod(0o644)
    monkeypatch.setattr(os, "geteuid", (lambda: key.stat().st_uid), raising=False)

    with pytest.raises(NodeStartupError, match="group or world"):
        _validate_existing_device_key(key, platform="linux")
    _validate_existing_device_key(key, platform="win32")


def test_serve_logs_the_store_roots_it_will_change_permissions_inside(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, tmp_path: Path,
) -> None:
    """Which boundary applies must be visible in the log, not inferred.

    The guard refuses a store outside these roots, so a support read of the log
    needs the resolved roots -- including when they came from the fallback
    rather than from configuration, which is the part nobody can reconstruct
    from the environment afterwards.

    `_default_store_root` is patched to `tmp_path` because the allowlist
    `serve` now applies permits one location -- the default -- and a store in
    the test's own temporary directory is only legitimate once that directory
    *is* the default. Doing it this way keeps the test running the real
    `permit_store_roots` rather than stepping around it.
    """
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: tmp_path)
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(tmp_path / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(tmp_path / "memory.sqlite3"))
    monkeypatch.setattr("jarvis_local.node._running_on_windows", lambda: True)
    state = ServiceState()
    monkeypatch.setattr(
        "jarvis_local.node.build_node",
        lambda *_args, **_kwargs: NodeRuntime(
            StoppingLoop(state), state, FakeControl(), FakeClosable(), FakeClosable()
        ),
    )

    from jarvis_local.node import _serve

    with caplog.at_level(logging.INFO, logger="jarvis_local.node"):
        _serve(JarvisLocalConfig.load(windows_environment()), command="serve")

    logged = [record.getMessage() for record in caplog.records if "store root" in record.getMessage()]
    assert logged, "the serve path logged no store root"
    assert os.fspath(tmp_path) in logged[0], logged


def test_serve_refuses_a_store_outside_the_permitted_location_before_assembling(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str],
) -> None:
    """The allowlist is checked before anything is opened, and it is its own exit code.

    Exit 4 would be indistinguishable from a busy pipe, and this failure's whole
    value is the sentence naming the repair -- so it gets 6, and the caller can
    branch on it without parsing text.
    """
    permitted = tmp_path / "Jarvis"
    permitted.mkdir()
    elsewhere = tmp_path / "Documents"
    elsewhere.mkdir()
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: permitted)
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(elsewhere / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(elsewhere / "memory.sqlite3"))
    monkeypatch.setattr("jarvis_local.node._running_on_windows", lambda: True)

    def never_called(*_args: Any, **_kwargs: Any) -> NodeRuntime:
        raise AssertionError("the service was assembled for a store outside the permitted location")

    monkeypatch.setattr("jarvis_local.node.build_node", never_called)

    from jarvis_local.node import EXIT_NODE_STORE_PERMISSIONS, _serve

    assert _serve(JarvisLocalConfig.load(windows_environment()), command="serve") == EXIT_NODE_STORE_PERMISSIONS
    assert "outside the only permitted store location" in capsys.readouterr().out


def test_serve_reports_a_refused_store_dacl_as_a_store_permission_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str],
) -> None:
    """The mapped exit code, over the branch that actually carries the repair sentence.

    `store_root_summary` is the start-up call that reads the real owner, so an
    Administrators-owned store raises here -- before `permit_store_roots` is
    reached. Raised through the same call the service makes, so what is under
    test is the mapping from that exception to exit 6 rather than a mock of it.
    """
    monkeypatch.setattr(store_permissions, "_default_store_root", lambda: tmp_path)
    monkeypatch.setenv("JARVIS_ARCHIVE_PATH", os.fspath(tmp_path / "archive.sqlite3"))
    monkeypatch.setenv("JARVIS_MEMORY_PATH", os.fspath(tmp_path / "memory.sqlite3"))
    monkeypatch.setattr("jarvis_local.node._running_on_windows", lambda: True)

    def refuse() -> str:
        raise StoreDaclRefusedError(
            "cannot set the permissions of the store. One-time fix, either: run `jarvis serve` "
            "once from an elevated shell"
        )

    monkeypatch.setattr("jarvis_local.node.store_root_summary", refuse)

    from jarvis_local.node import EXIT_NODE_STORE_PERMISSIONS, _serve

    assert _serve(JarvisLocalConfig.load(windows_environment()), command="serve") == EXIT_NODE_STORE_PERMISSIONS
    # The repair is printed, not swallowed: this exit code exists so the caller
    # sees which failure it is, and the sentence is what makes it actionable.
    assert "One-time fix" in capsys.readouterr().out


def test_serve_refuses_a_host_that_cannot_bind_the_pipe(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr("jarvis_local.node.sys.platform", "linux")

    assert run_serve(JarvisLocalConfig.load(windows_environment())) == 3
    assert "requires Windows" in capsys.readouterr().out


@windows_only
def test_a_second_agent_on_the_pipe_is_refused_by_name_rather_than_serving_beside_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """FILE_FLAG_FIRST_PIPE_INSTANCE is what makes a second launcher fail here.
    Neutering it lets two processes serve one name, and clients then reach
    whichever instance Windows hands them."""
    settings = windows_settings(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()

    def refused(*_: object, **__: object) -> int:
        raise OSError(5, "Access is denied.", None, 5)

    monkeypatch.setattr("jarvis_local.transport.pipe_server.create_pipe_instance", refused)

    with pytest.raises(UnixSocketInUseError, match=r"jarvis-local-agent"):
        build_node(settings, control_factory=_windows_control_endpoint, platform="win32")


@windows_only
def test_an_unexpected_pipe_failure_is_not_reported_as_a_name_already_in_use(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only the two "that name is taken" errno values mean another agent. Every
    other failure to create the pipe is a real one and keeps its own face."""
    settings = windows_settings(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()

    def failed(*_: object, **__: object) -> int:
        raise OSError(87, "The parameter is incorrect.", None, 87)

    monkeypatch.setattr("jarvis_local.transport.pipe_server.create_pipe_instance", failed)

    with pytest.raises(OSError, match="parameter is incorrect"):
        build_node(settings, control_factory=_windows_control_endpoint, platform="win32")
