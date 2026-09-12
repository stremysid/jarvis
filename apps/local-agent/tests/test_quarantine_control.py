"""Owner retries remain responsive while the cycle thread owns the stores."""

from __future__ import annotations

import sqlite3
import threading
import time
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from jarvis_local.agent import CycleResult
from jarvis_local.crypto.device_keys import platform_device_key_store
from jarvis_local.memory.facts import FactRepository
from jarvis_local.memory.promotion import PromotionEngine
from jarvis_local.node import NodeRuntime, _QuarantineRetryCoordinator, build_node
from jarvis_local.service import LocalAgentService, RunLoop, ServiceState, control_handlers
from jarvis_local.sync.memory_projection import MemoryProjectionUploader
from jarvis_local.sync.quarantine_retry import QuarantineRetryJournal
from jarvis_local.transport.cli_protocol import CliCommand, CliResponse
from jarvis_local.transport.unix_socket import DEFAULT_IO_TIMEOUT_SECONDS, send_unix_control_request
from tests.test_node import EmptyCycleOpener, FakeControl, linux_only, record_promotable_fact, settings_at

FACT_ID = "fact_" + "a" * 32


def retry_status(lines: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(line.split(" request_id=")[0] for line in lines)


def quarantined_fact(runtime: NodeRuntime) -> str:
    assert isinstance(runtime.facts, FactRepository)
    fact_id = record_promotable_fact(runtime)
    PromotionEngine(runtime.facts).promote(runtime.facts.get(fact_id))
    runtime.facts.connection.execute(
        "INSERT INTO memory_projection_quarantine VALUES (?, ?, ?, ?, 'gateway_rejected', ?)",
        ("https://gateway.example", "principal-1", "device-1", fact_id, "2026-09-11T12:00:00.000Z"),
    )
    return fact_id


@pytest.mark.parametrize("quarantined", [False, True])
def test_the_sleeping_built_node_only_runs_cloud_work_after_a_successful_retry(
    tmp_path: Path, quarantined: bool,
) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    opener = EmptyCycleOpener()
    runtime = build_node(settings, opener=opener, control_factory=lambda *_: FakeControl())
    assert isinstance(runtime.loop, RunLoop)
    assert runtime.retry_coordinator is not None
    fact_id = quarantined_fact(runtime) if quarantined else FACT_ID
    service = LocalAgentService(control_handlers(runtime.state, retry_quarantined=runtime.retry_coordinator.submit))
    sleeping = threading.Event()
    finished = threading.Event()
    errors: list[BaseException] = []
    initial_requests: list[int] = []

    def wait(seconds: float) -> None:
        if seconds:
            if not initial_requests:
                initial_requests.append(len(opener.requests))
            sleeping.set()
        runtime.state.wait(seconds)

    runtime.loop.sleep = wait

    def client() -> None:
        try:
            assert sleeping.wait(2)
            response = service.handle(CliCommand("retry-quarantined", {"fact_id": fact_id}))
            assert response.code == ("ok" if quarantined else "fact_not_quarantined")
            if quarantined:
                deadline = time.monotonic() + 1
                while len(runtime.state.recent()) < 2 and time.monotonic() < deadline:
                    time.sleep(0.001)
                assert len(runtime.state.recent()) == 2
                assert len(opener.requests) > initial_requests[0]
            else:
                # Let the loop consume its local wake and return to sleep.
                time.sleep(0.05)
                assert len(runtime.state.recent()) == 1
                assert len(opener.requests) == initial_requests[0]
                assert runtime.state.take_cycle_request() is False
                assert f"projection_retry {fact_id} not_quarantined" in retry_status(runtime.state.report())
        except BaseException as error:
            errors.append(error)
        finally:
            runtime.state.request_stop()
            finished.set()

    thread = threading.Thread(target=client, daemon=True)
    thread.start()
    try:
        assert runtime.run(install_signal_handlers=False) == "stopped"
        assert finished.wait(1)
        assert errors == []
    finally:
        runtime.state.request_stop()
        runtime.close()
        thread.join(timeout=1)


@linux_only
@pytest.mark.parametrize("fail_retry", [False, True])
def test_real_socket_retry_and_status_stay_responsive_during_a_slow_cloud_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fail_retry: bool,
) -> None:
    root = tmp_path / "private"
    root.mkdir(mode=0o700)
    settings = settings_at(root)
    platform_device_key_store(settings.device_key_path).load_or_create()
    cloud_started = threading.Event()
    release_cloud = threading.Event()
    applied = threading.Event()
    cloud_seconds: list[float] = []
    original_retry = MemoryProjectionUploader.retry_quarantined

    def retry(uploader: MemoryProjectionUploader, fact_id: str) -> bool:
        try:
            if fail_retry:
                raise RuntimeError("synthetic store failure")
            return original_retry(uploader, fact_id)
        finally:
            applied.set()

    monkeypatch.setattr(MemoryProjectionUploader, "retry_quarantined", retry)

    class SlowOpener(EmptyCycleOpener):
        def __call__(self, request: Any, timeout: float | None = None) -> Any:
            if not cloud_started.is_set():
                started = time.monotonic()
                cloud_started.set()
                assert release_cloud.wait(10)
                cloud_seconds.append(time.monotonic() - started)
            return super().__call__(request, timeout)

    runtime = build_node(settings, opener=SlowOpener())
    fact_id = quarantined_fact(runtime)
    errors: list[BaseException] = []

    def client() -> None:
        try:
            assert cloud_started.wait(2)
            response = send_unix_control_request(
                CliCommand("retry-quarantined", {"fact_id": fact_id}), settings.control_socket_path,
            )
            assert response.code == "queued"
            status = send_unix_control_request(CliCommand("status"), settings.control_socket_path)
            assert status.code == "ok"
            assert f"projection_retry {fact_id} queued" in retry_status(status.lines)
            assert not applied.is_set()
            time.sleep(DEFAULT_IO_TIMEOUT_SECONDS + 0.1)
            release_cloud.set()
            assert applied.wait(2)
            expected = "failed" if fail_retry else "applied"
            deadline = time.monotonic() + 2
            while True:
                status = send_unix_control_request(CliCommand("status"), settings.control_socket_path)
                if f"projection_retry {fact_id} {expected}" in retry_status(status.lines):
                    break
                assert time.monotonic() < deadline
                time.sleep(0.001)
            assert send_unix_control_request(CliCommand("stop"), settings.control_socket_path).code == "ok"
        except BaseException as error:
            errors.append(error)
        finally:
            release_cloud.set()
            runtime.state.request_stop()

    thread = threading.Thread(target=client, daemon=True)
    thread.start()
    assert runtime.run(install_signal_handlers=False) == "stopped"
    thread.join(timeout=2)
    assert not thread.is_alive()
    assert errors == []
    assert cloud_seconds[0] > DEFAULT_IO_TIMEOUT_SECONDS
    with sqlite3.connect(settings.memory_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM memory_projection_quarantine").fetchone() == (int(fail_retry),)


def test_a_busy_cycle_returns_queued_and_reports_the_later_result(
    retry_factory: Callable[[ServiceState], _QuarantineRetryCoordinator],
) -> None:
    state = ServiceState()
    coordinator = retry_factory(state)
    service = LocalAgentService(control_handlers(state, retry_quarantined=coordinator.submit))
    responses: list[CliResponse] = []
    finished = threading.Event()

    def submit() -> None:
        try:
            responses.append(service.handle(CliCommand("retry-quarantined", {"fact_id": FACT_ID})))
        finally:
            finished.set()

    client = threading.Thread(target=submit, daemon=True)
    client.start()
    try:
        assert finished.wait(0.5), "retry blocked waiting for the busy cycle thread"
        assert responses[0].code == "queued"
        assert "not yet applied" in " ".join(responses[0].lines)
        assert state.take_cycle_request() is False
        assert f"projection_retry {FACT_ID} queued" in retry_status(state.report())
        coordinator.drain(lambda _fact_id: True)
        assert f"projection_retry {FACT_ID} applied" in retry_status(state.report())
        assert state.take_cycle_request() is True
    finally:
        coordinator.close()
        client.join(timeout=1)


def test_a_retry_after_close_is_refused_without_queuing_or_waiting(
    retry_factory: Callable[[ServiceState], _QuarantineRetryCoordinator],
) -> None:
    state = ServiceState()
    coordinator = retry_factory(state)
    coordinator.close()
    service = LocalAgentService(control_handlers(state, retry_quarantined=coordinator.submit))
    responses: list[CliResponse] = []
    client = threading.Thread(
        target=lambda: responses.append(service.handle(CliCommand("retry-quarantined", {"fact_id": FACT_ID}))),
        daemon=True,
    )
    client.start()
    try:
        client.join(timeout=0.5)
        assert not client.is_alive()
        assert responses[0].code == "retry_failed"
        assert state.take_cycle_request() is False
        deleted: list[str] = []
        coordinator.drain(lambda fact_id: deleted.append(fact_id) is None)
        assert deleted == []
    finally:
        coordinator.close()
        client.join(timeout=1)


def test_stopping_cancels_a_queued_retry_without_deleting_the_quarantine(
    retry_factory: Callable[[ServiceState], _QuarantineRetryCoordinator],
) -> None:
    state = ServiceState()
    coordinator = retry_factory(state)
    service = LocalAgentService(control_handlers(state, retry_quarantined=coordinator.submit))
    client = threading.Thread(
        target=lambda: service.handle(CliCommand("retry-quarantined", {"fact_id": FACT_ID})), daemon=True,
    )
    client.start()
    try:
        # Wait for the request itself, not for a scheduling guess.
        deadline = time.monotonic() + 1
        while not coordinator._pending and time.monotonic() < deadline:
            time.sleep(0.001)
        assert coordinator._pending
        state.request_stop()
        deleted: list[str] = []
        coordinator.drain(lambda fact_id: deleted.append(fact_id) is None)
        assert deleted == []
        assert f"projection_retry {FACT_ID} cancelled" in retry_status(state.report())
        assert state.take_cycle_request() is False
    finally:
        coordinator.close()
        client.join(timeout=1)


def test_a_process_interrupt_cannot_report_fact_not_quarantined(
    retry_factory: Callable[[ServiceState], _QuarantineRetryCoordinator],
) -> None:
    state = ServiceState()
    coordinator = retry_factory(state)
    service = LocalAgentService(control_handlers(state, retry_quarantined=coordinator.submit))
    responses: list[CliResponse] = []
    client = threading.Thread(
        target=lambda: responses.append(service.handle(CliCommand("retry-quarantined", {"fact_id": FACT_ID}))),
        daemon=True,
    )
    client.start()
    try:
        deadline = time.monotonic() + 1
        while not coordinator._pending and time.monotonic() < deadline:
            time.sleep(0.001)
        assert coordinator._pending

        def interrupted(_fact_id: str) -> bool:
            raise KeyboardInterrupt

        with pytest.raises(KeyboardInterrupt):
            coordinator.drain(interrupted)
        client.join(timeout=1)
        assert responses[0].code == "retry_failed"
        assert f"projection_retry {FACT_ID} failed" in retry_status(state.report())
    finally:
        coordinator.close()
        client.join(timeout=1)


def test_status_keeps_all_pending_retries_and_only_the_latest_completed_results(
    retry_factory: Callable[[ServiceState], _QuarantineRetryCoordinator],
) -> None:
    state = ServiceState(recent_limit=2)
    coordinator = retry_factory(state)
    ids = ["fact_" + f"{number:032x}" for number in range(5)]
    try:
        for fact_id in ids[:3]:
            assert coordinator.submit(fact_id) is None
            coordinator.drain(lambda _: True)
        for fact_id in ids[3:]:
            assert coordinator.submit(fact_id) is None
        lines = LocalAgentService(control_handlers(state)).handle(CliCommand("status")).lines
        assert f"projection_retry {ids[0]} applied" not in retry_status(lines)
        assert all(f"projection_retry {fact_id} applied" in retry_status(lines) for fact_id in ids[1:3])
        assert all(f"projection_retry {fact_id} queued" in retry_status(lines) for fact_id in ids[3:])
        assert len([line for line in retry_status(lines) if line.startswith("projection_retry ")]) == 4
    finally:
        coordinator.close()


def test_pre_cycle_retry_is_applied_before_the_snapshot_is_captured(tmp_path: Path) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    opener = EmptyCycleOpener()
    runtime = build_node(settings, opener=opener, control_factory=lambda *_: FakeControl())
    assert isinstance(runtime.loop, RunLoop)
    assert runtime.retry_coordinator is not None
    fact_id = quarantined_fact(runtime)
    try:
        assert runtime.retry_coordinator.submit(fact_id) is None
        result = runtime.loop.run_cycle()
        assert result.failure is None
        assert result.facts_quarantined == 0
        page = next(body for body in opener.projection_bodies if body["operation"] == "page")
        assert [fact["factId"] for fact in page["facts"]] == [fact_id]
    finally:
        runtime.close()


@pytest.mark.parametrize("stop", [False, True])
def test_a_mid_cycle_retry_is_resolved_after_commit_or_cancelled_on_stop(tmp_path: Path, stop: bool) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    runtime = build_node(settings, opener=EmptyCycleOpener(), control_factory=lambda *_: FakeControl())
    assert isinstance(runtime.loop, RunLoop)
    assert isinstance(runtime.facts, FactRepository)
    assert runtime.retry_coordinator is not None
    fact_id = quarantined_fact(runtime)
    # Queue after the pre-cycle drain, inside the actual signed cloud call.
    def queue_at_commit(body: dict[str, Any]) -> None:
        if body["operation"] == "commit":
            assert runtime.retry_coordinator is not None
            assert runtime.retry_coordinator.submit(fact_id) is None
            if stop:
                runtime.state.request_stop()

    # The signed clients share this opener instance.
    cloud_opener = EmptyCycleOpener(on_projection=queue_at_commit)
    runtime.close()
    runtime = build_node(settings, opener=cloud_opener, control_factory=lambda *_: FakeControl())
    assert isinstance(runtime.loop, RunLoop)
    assert isinstance(runtime.facts, FactRepository)
    try:
        result = runtime.loop.run_cycle()
        assert result.failure is None
        count = runtime.facts.connection.execute("SELECT COUNT(*) FROM memory_projection_quarantine").fetchone()
        assert count == (int(stop),)
        outcome = "cancelled" if stop else "applied"
        assert f"projection_retry {fact_id} {outcome}" in retry_status(runtime.state.report())
        assert runtime.state.take_cycle_request() is not stop
    finally:
        runtime.close()


def test_runtime_cancels_inflight_retry_before_joining_control(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    queued = threading.Event()
    answered = threading.Event()
    responses: list[CliResponse] = []
    # Still bounded below the client deadline; gives shutdown time to answer
    # cancelled before submit's queued fallback can finish the control thread.
    monkeypatch.setattr("jarvis_local.node.QUARANTINE_RETRY_WAIT_SECONDS", 1.0)

    class RetryingControl(FakeControl):
        def serve_forever(self, _should_continue: Any) -> None:
            try:
                responses.append(service.handle(CliCommand("retry-quarantined", {"fact_id": FACT_ID})))
            finally:
                answered.set()

    runtime = build_node(settings, opener=EmptyCycleOpener(), control_factory=lambda *_: RetryingControl())
    assert runtime.retry_coordinator is not None
    service = LocalAgentService(control_handlers(runtime.state, retry_quarantined=runtime.retry_coordinator.submit))
    original_wake = runtime.state.request_control_work

    def wake() -> None:
        original_wake()
        queued.set()

    monkeypatch.setattr(runtime.state, "request_control_work", wake)

    class HaltWithoutCycle:
        def run(self) -> str:
            assert queued.wait(1)
            return "stopped"

    runtime.loop = HaltWithoutCycle()
    assert runtime.run(install_signal_handlers=False) == "stopped"
    assert answered.is_set()
    assert responses == [CliResponse("retry_failed")]
    assert f"projection_retry {FACT_ID} cancelled" in retry_status(runtime.state.report())


def test_refused_control_work_preserves_the_original_backoff_deadline(
    retry_factory: Callable[[ServiceState], _QuarantineRetryCoordinator],
) -> None:
    state = ServiceState()
    coordinator = retry_factory(state)
    moment = [0.0]
    delays: list[float] = []
    cycles: list[int] = []

    def cycle() -> CycleResult:
        cycles.append(1)
        if len(cycles) == 2:
            state.request_stop()
        return CycleResult(0, 0, 0, 0, failure="sync: offline")

    def sleep(seconds: float) -> None:
        delays.append(seconds)
        if len(delays) == 2:
            moment[0] += 10
            assert coordinator.submit(FACT_ID) is None
        else:
            moment[0] += seconds

    loop = RunLoop(cycle, state=state, sleep=sleep, monotonic=lambda: moment[0],
                   process_control_work=lambda: coordinator.drain(lambda _: False))
    try:
        assert loop.run() == "stopped"
        assert len(delays) == 3
        assert delays[2] == pytest.approx(delays[1] - 10)
        assert [record.trigger for record in state.recent()] == ["startup", "backoff"]
    finally:
        coordinator.close()


def test_a_restart_recovers_accepted_retries_and_their_completed_history(tmp_path: Path) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    first = build_node(settings, opener=EmptyCycleOpener(), control_factory=lambda *_: FakeControl())
    fact_id = quarantined_fact(first)
    assert first.retry_coordinator is not None
    assert isinstance(first.facts, FactRepository)
    assert first.retry_coordinator.submit(fact_id) is None
    # Simulate process death: stores close without coordinator shutdown cleanup.
    first.facts.close()
    first.archive.close()
    first.control.close()

    second = build_node(settings, opener=EmptyCycleOpener(), control_factory=lambda *_: FakeControl())
    assert isinstance(second.loop, RunLoop)
    assert isinstance(second.facts, FactRepository)
    try:
        assert any(f"{fact_id} queued" in line for line in second.state.report())
        second.loop.run_cycle()
        assert second.facts.connection.execute("SELECT COUNT(*) FROM memory_projection_quarantine").fetchone() == (0,)
        assert any(f"{fact_id} applied" in line for line in second.state.report())
    finally:
        second.close()

    third = build_node(settings, opener=EmptyCycleOpener(), control_factory=lambda *_: FakeControl())
    try:
        assert any(f"{fact_id} applied" in line for line in third.state.report())
        assert not any(f"{fact_id} queued" in line for line in third.state.report())
    finally:
        third.close()


@pytest.mark.parametrize("outcome", ["not_quarantined", "failed", "cancelled"])
def test_terminal_retry_outcomes_survive_reconstruction(tmp_path: Path, outcome: str) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    first = build_node(settings, opener=EmptyCycleOpener(), control_factory=lambda *_: FakeControl())
    assert first.retry_coordinator is not None
    assert first.retry_coordinator.submit(FACT_ID) is None
    try:
        if outcome == "not_quarantined":
            first.retry_coordinator.drain(lambda _: False)
        elif outcome == "failed":
            def fail(_: str) -> bool:
                raise RuntimeError("synthetic store error")
            first.retry_coordinator.drain(fail)
    finally:
        first.close()
    second = build_node(settings, opener=EmptyCycleOpener(), control_factory=lambda *_: FakeControl())
    try:
        assert f"projection_retry {FACT_ID} {outcome}" in retry_status(second.state.report())
        assert not any("queued" in line for line in second.state.report())
    finally:
        second.close()


@pytest.mark.parametrize("fail_commit", [False, True])
def test_a_failed_retry_receipt_rolls_back_the_delete_and_records_failure(
    tmp_path: Path, fail_commit: bool,
) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    runtime = build_node(settings, opener=EmptyCycleOpener(), control_factory=lambda *_: FakeControl())
    assert isinstance(runtime.facts, FactRepository)
    assert runtime.retry_coordinator is not None
    fact_id = quarantined_fact(runtime)
    assert runtime.retry_coordinator.submit(fact_id) is None
    connection = runtime.facts.connection
    denied: list[int] = []
    if fail_commit:
        def authorizer(action: int, arg: str | None, _arg2: str | None, _db: str | None, _source: str | None) -> int:
            if action == sqlite3.SQLITE_TRANSACTION and arg == "COMMIT" and not denied:
                denied.append(1)
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        connection.set_authorizer(authorizer)
    else:
        connection.execute("""CREATE TRIGGER reject_applied_receipt BEFORE UPDATE ON memory_projection_retry
            WHEN NEW.outcome = 'applied' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END""")

    def clear(_: str) -> bool:
        return connection.execute("DELETE FROM memory_projection_quarantine").rowcount == 1

    try:
        runtime.retry_coordinator.drain(clear)
        assert not connection.in_transaction
        assert connection.execute("SELECT COUNT(*) FROM memory_projection_quarantine").fetchone() == (1,)
        assert connection.execute("SELECT outcome FROM memory_projection_retry").fetchone() == ("failed",)
        assert f"projection_retry {fact_id} failed" in retry_status(runtime.state.report())
        assert runtime.state.take_cycle_request() is False
    finally:
        connection.set_authorizer(None)
        runtime.close()


def test_enqueue_lock_contention_returns_a_definite_failure_without_accepting_work(tmp_path: Path) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    runtime = build_node(settings, opener=EmptyCycleOpener(), control_factory=lambda *_: FakeControl())
    assert isinstance(runtime.facts, FactRepository)
    assert runtime.retry_coordinator is not None
    service = LocalAgentService(control_handlers(runtime.state, retry_quarantined=runtime.retry_coordinator.submit))
    responses: list[CliResponse] = []
    runtime.facts.connection.execute("BEGIN IMMEDIATE")
    thread = threading.Thread(
        target=lambda: responses.append(service.handle(CliCommand("retry-quarantined", {"fact_id": FACT_ID}))),
        daemon=True,
    )
    thread.start()
    try:
        thread.join(timeout=0.5)
        assert not thread.is_alive(), "enqueue inherited SQLite's five-second lock timeout"
        assert responses == [CliResponse("retry_failed")]
        assert service.handle(CliCommand("status")).code == "ok"
        assert runtime.facts.connection.execute("SELECT COUNT(*) FROM memory_projection_retry").fetchone() == (0,)
        assert runtime.state.take_cycle_request() is False
    finally:
        runtime.facts.connection.execute("ROLLBACK")
        thread.join(timeout=1)
        runtime.close()


def test_cancellation_storage_failure_preserves_queued_work_and_still_closes_the_node(tmp_path: Path) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    control = FakeControl()
    runtime = build_node(settings, opener=EmptyCycleOpener(), control_factory=lambda *_: control)
    assert isinstance(runtime.facts, FactRepository)
    assert runtime.retry_coordinator is not None
    assert runtime.retry_coordinator.submit(FACT_ID) is None
    runtime.facts.connection.execute("""CREATE TRIGGER reject_cancel BEFORE UPDATE ON memory_projection_retry
        WHEN NEW.outcome = 'cancelled' BEGIN SELECT RAISE(ABORT, 'synthetic cancel failure'); END""")
    runtime.state.request_stop()

    assert runtime.run(install_signal_handlers=False) == "stopped"
    assert control.closed == 1
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        runtime.facts.connection.execute("SELECT 1")
    with sqlite3.connect(settings.memory_path) as connection:
        assert connection.execute("SELECT outcome FROM memory_projection_retry").fetchone() == ("queued",)
    assert "projection_retry_storage unavailable; queued requests remain durable" in runtime.state.report()


@pytest.mark.parametrize("foreign_column", [0, 1, 2])
def test_retry_recovery_remains_scoped_to_the_normalized_owner(tmp_path: Path, foreign_column: int) -> None:
    settings = replace(settings_at(tmp_path), cloud_base_url="https://gateway.example/")
    platform_device_key_store(settings.device_key_path).load_or_create()
    first = build_node(settings, opener=EmptyCycleOpener(), control_factory=lambda *_: FakeControl())
    assert isinstance(first.facts, FactRepository)
    assert first.retry_coordinator is not None
    fact_id = quarantined_fact(first)
    foreign_owner = ["https://gateway.example", "principal-1", "device-1"]
    foreign_owner[foreign_column] += "-foreign"
    foreign = QuarantineRetryJournal(first.facts.connection, settings.memory_path, tuple(foreign_owner))
    foreign.enqueue(FACT_ID)
    assert first.retry_coordinator.submit(fact_id) is None
    first.facts.close()
    first.archive.close()
    first.control.close()

    second = build_node(
        replace(settings, cloud_base_url="https://gateway.example"),
        opener=EmptyCycleOpener(), control_factory=lambda *_: FakeControl(),
    )
    assert isinstance(second.loop, RunLoop)
    assert isinstance(second.facts, FactRepository)
    try:
        assert not any(FACT_ID in line for line in second.state.report())
        assert f"projection_retry {fact_id} queued" in retry_status(second.state.report())
        second.loop.run_cycle()
        assert second.facts.connection.execute("SELECT COUNT(*) FROM memory_projection_quarantine").fetchone() == (0,)
        assert second.facts.connection.execute(
            "SELECT outcome FROM memory_projection_retry WHERE fact_id = ?", (FACT_ID,),
        ).fetchone() == ("queued",)
    finally:
        second.close()


def test_a_new_retry_for_the_same_fact_cannot_be_hidden_by_an_older_completion() -> None:
    state = ServiceState()
    state.record_retry(1, FACT_ID, "queued")
    state.record_retry(2, FACT_ID, "queued")
    state.record_retry(1, FACT_ID, "applied")
    assert f"projection_retry {FACT_ID} queued request_id=2" in state.report()
    assert f"projection_retry {FACT_ID} applied request_id=1" in state.report()


def test_the_durable_journal_bounds_completed_history_without_dropping_pending_or_foreign_work(tmp_path: Path) -> None:
    path = tmp_path / "memory.sqlite3"
    facts = FactRepository.open(path)
    owner = ("https://gateway.example", "principal-1", "device-1")
    journal = QuarantineRetryJournal(facts.connection, path, owner)
    foreign = QuarantineRetryJournal(facts.connection, path, (owner[0], "foreign", owner[2]))
    try:
        foreign_id = foreign.enqueue(FACT_ID)
        foreign.finish(foreign_id, "failed")
        pending_id = journal.enqueue(FACT_ID)
        for number in range(21):
            retry_id = journal.enqueue("fact_" + f"{number:032x}")
            journal.finish(retry_id, "not_quarantined")
        records = journal.records()
        assert len(records) == 21
        assert (pending_id, FACT_ID, "queued") in records
        assert foreign.records() == [(foreign_id, FACT_ID, "failed")]
        assert facts.connection.execute("SELECT COUNT(*) FROM memory_projection_retry").fetchone() == (22,)
        with pytest.raises(RuntimeError, match="no longer pending"):
            journal.finish(foreign_id, "cancelled")
        assert not facts.connection.in_transaction
        assert foreign.records() == [(foreign_id, FACT_ID, "failed")]
    finally:
        facts.close()


def test_enqueue_deduplicates_a_retry_while_its_cycle_transaction_is_about_to_run(tmp_path: Path) -> None:
    path = tmp_path / "memory.sqlite3"
    facts = FactRepository.open(path)
    journal = QuarantineRetryJournal(facts.connection, path, ("https://gateway.example", "principal-1", "device-1"))
    try:
        first = journal.enqueue(FACT_ID)
        assert journal.enqueue(FACT_ID) == first
        assert journal.records() == [(first, FACT_ID, "queued")]
        journal.finish(first, "not_quarantined")
        second = journal.enqueue(FACT_ID)
        assert second != first
        assert journal.records() == [(first, FACT_ID, "not_quarantined"), (second, FACT_ID, "queued")]
    finally:
        facts.close()


@pytest.mark.parametrize("fact_id", ["fact_" + "a" * 31, "fact_" + "a" * 31 + "g", "other" + "a" * 32])
def test_retry_journal_rejects_malformed_fact_identifiers(tmp_path: Path, fact_id: str) -> None:
    path = tmp_path / "memory.sqlite3"
    facts = FactRepository.open(path)
    journal = QuarantineRetryJournal(facts.connection, path, ("https://gateway.example", "principal-1", "device-1"))
    try:
        with pytest.raises(sqlite3.IntegrityError):
            journal.enqueue(fact_id)
        assert journal.records() == []
    finally:
        facts.close()


@pytest.mark.parametrize("foreign_column", [0, 1, 2])
def test_a_journal_cannot_finish_another_owners_pending_retry(tmp_path: Path, foreign_column: int) -> None:
    path = tmp_path / "memory.sqlite3"
    facts = FactRepository.open(path)
    owner = ["https://gateway.example", "principal-1", "device-1"]
    journal = QuarantineRetryJournal(facts.connection, path, tuple(owner))
    owner[foreign_column] += "-foreign"
    foreign = QuarantineRetryJournal(facts.connection, path, tuple(owner))
    try:
        retry_id = foreign.enqueue(FACT_ID)
        with pytest.raises(RuntimeError, match="no longer pending"):
            journal.finish(retry_id, "cancelled")
        assert foreign.records() == [(retry_id, FACT_ID, "queued")]
    finally:
        facts.close()


def test_a_retry_receipt_is_bound_to_the_fact_before_any_delete(tmp_path: Path) -> None:
    path = tmp_path / "memory.sqlite3"
    facts = FactRepository.open(path)
    journal = QuarantineRetryJournal(facts.connection, path, ("https://gateway.example", "principal-1", "device-1"))
    deleted: list[str] = []
    try:
        retry_id = journal.enqueue(FACT_ID)
        with pytest.raises(RuntimeError, match="binding"):
            journal.apply(retry_id, "fact_" + "b" * 32, lambda fact_id: deleted.append(fact_id) is None)
        assert deleted == []
        assert journal.records() == [(retry_id, FACT_ID, "queued")]
    finally:
        facts.close()


def test_queued_work_recovers_on_a_later_boundary_after_receipt_storage_recovers(tmp_path: Path) -> None:
    settings = settings_at(tmp_path)
    platform_device_key_store(settings.device_key_path).load_or_create()
    runtime = build_node(settings, opener=EmptyCycleOpener(), control_factory=lambda *_: FakeControl())
    assert isinstance(runtime.facts, FactRepository)
    assert runtime.retry_coordinator is not None
    coordinator = runtime.retry_coordinator
    attempts: list[str] = []
    assert coordinator.submit(FACT_ID) is None
    connection = runtime.facts.connection
    connection.execute("""CREATE TRIGGER reject_receipts BEFORE UPDATE ON memory_projection_retry
        WHEN NEW.outcome <> 'queued' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END""")

    def refused(fact_id: str) -> bool:
        attempts.append(fact_id)
        return False

    try:
        coordinator.drain(refused)
        assert attempts == [FACT_ID]
        assert connection.execute("SELECT outcome FROM memory_projection_retry").fetchone() == ("queued",)
        assert "projection_retry_storage unavailable; queued requests remain durable" in runtime.state.report()
        # Unrelated success cannot hide a still-pending storage failure.
        runtime.state.record_retry(999, "fact_" + "b" * 32, "applied")
        assert "projection_retry_storage unavailable; queued requests remain durable" in runtime.state.report()
        connection.execute("DROP TRIGGER reject_receipts")
        coordinator.drain(refused)
        assert attempts == [FACT_ID, FACT_ID]
        assert connection.execute("SELECT outcome FROM memory_projection_retry").fetchone() == ("not_quarantined",)
        assert not any(line.startswith("projection_retry_storage") for line in runtime.state.report())
        assert runtime.state.take_cycle_request() is False
    finally:
        runtime.close()


def test_history_retention_uses_completion_order_when_an_old_request_finishes_late(tmp_path: Path) -> None:
    path = tmp_path / "memory.sqlite3"
    facts = FactRepository.open(path)
    journal = QuarantineRetryJournal(facts.connection, path, ("https://gateway.example", "principal-1", "device-1"))
    try:
        old_id = journal.enqueue(FACT_ID)
        for number in range(21):
            retry_id = journal.enqueue("fact_" + f"{number:032x}")
            journal.finish(retry_id, "failed")
        journal.finish(old_id, "not_quarantined")
        records = journal.records()
        assert len(records) == 20
        assert records[-1] == (old_id, FACT_ID, "not_quarantined")
        assert facts.connection.execute(
            "SELECT outcome FROM memory_projection_retry WHERE retry_id = ?", (old_id,),
        ).fetchone() == ("not_quarantined",)
    finally:
        facts.close()
