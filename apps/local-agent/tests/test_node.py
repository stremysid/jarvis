"""The Linux home node assembles one foreground memory service and cleans up."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import signal
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
from jarvis_local.archive.archive_repository import ArchiveRepository
from jarvis_local.config import JarvisLocalConfig
from jarvis_local.crypto.device_keys import platform_device_key_store
from jarvis_local.crypto.signed_request import signature_text
from jarvis_local.memory.facts import FactOrigin, FactProposal, FactRepository, FactState
from jarvis_local.node import (
    EXIT_NODE_AUTHENTICATION,
    NodeConfigurationError,
    NodeRuntime,
    NodeSettings,
    NodeStartupError,
    _safe_node_cycle,
    build_node,
    run_node,
)
from jarvis_local.scheduler import STOP_AUTHENTICATION, SchedulerState
from jarvis_local.service import (
    FACT_NOT_QUARANTINED,
    LocalAgentService,
    RunLoop,
    ServiceState,
    control_handlers,
)
from jarvis_local.sync.cloud_client import CloudAuthError
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
        ["memory", "project"],
        ["memory", "project"],
    ]
    assert json.loads(opener.requests[3].data.decode("utf-8"))["facts"] == []
    signed = json.loads(opener.requests[0].headers["X-jarvis-signed-request"])
    assert signed["audience"] == "jarvis-local-agent"
    assert control.started == 1
    assert control.closed == 1


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
    first_runtime = build_node(settings, opener=first_opener, control_factory=lambda *_: FakeControl())
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
    second_runtime = build_node(settings, opener=second_opener, control_factory=lambda *_: FakeControl())
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
    runtime = build_node(settings, opener=opener, control_factory=lambda *_: FakeControl())
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


def test_built_node_exposes_the_owner_quarantine_retry_handler(tmp_path: Path) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    captured: list[ControlServer] = []

    def capture(server: ControlServer, _path: Path) -> FakeControl:
        captured.append(server)
        return FakeControl()

    runtime = build_node(settings, opener=EmptyCycleOpener(), control_factory=capture)
    try:
        response = captured[0].dispatcher.handle(CliCommand(
            "retry-quarantined", {"fact_id": "fact_" + "a" * 32},
        ))
    finally:
        runtime.close()

    assert response.code == FACT_NOT_QUARANTINED


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
