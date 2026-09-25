"""The control channel is reachable by one person, or it is a hole.

Three things are checked here, and each is a claim that would otherwise be
made in prose and believed.

That the pipe is actually access-restricted. Windows gives a named pipe
created with a null security descriptor a default DACL granting read to
Everyone and to the anonymous account, so "we created a named pipe" is not
"we created a private channel". The descriptor is read back off the live
handle, and the default form is created alongside it and shown to grant what
the restricted one refuses -- because an assertion that a string is absent
proves nothing until the same instrument has seen it present.

That a request is treated as data. Nothing is dispatched on a string that
merely arrived, and the instrument for that is the dispatcher's own call log:
a refusal that still reached the handler is not a refusal.

That the read is bounded. The bound is checked by watching what the reader was
asked for, not by watching memory. A server that reads an oversized body and
then refuses it has already lost.
"""

from __future__ import annotations

import io
import os
import sys
import threading
import uuid
from typing import cast

import pytest

from jarvis_local.service import LocalAgentService, ServiceState, control_handlers
from jarvis_local.transport.cli_protocol import OK, UNKNOWN_COMMAND, CliCommand, CliResponse
from jarvis_local.transport.pipe_server import (
    MALFORMED_REQUEST,
    MAX_REQUEST_BYTES,
    REQUEST_TOO_LARGE,
    ControlServer,
    NamedPipeServer,
    RequestTooLargeError,
    ServiceNotRunningError,
    TruncatedFrameError,
    connect_to_pipe,
    current_user_sid,
    decode_request,
    decode_response,
    encode_frame,
    encode_request,
    encode_response,
    owner_only_sddl,
    pipe_sddl,
    read_frame,
    send_control_request,
)

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="named pipes are a Windows mechanism")


class RecordingReader:
    """A reader that remembers what it was asked for, not just what it gave.

    The size bound is a claim about reads that never happened, and only the
    request log can tell a refusal-before-reading from a refusal-after.
    """

    def __init__(self, data: bytes) -> None:
        self.stream = io.BytesIO(data)
        self.requests: list[int] = []

    def read(self, size: int, /) -> bytes:
        self.requests.append(size)
        return self.stream.read(size)


class RecordingDispatcher:
    """Stands in for the service, and counts every command that reaches it."""

    def __init__(self, response: CliResponse | None = None) -> None:
        self.received: list[CliCommand] = []
        self.response = response or CliResponse(OK, ("dispatched",))

    def handle(self, command: CliCommand) -> CliResponse:
        self.received.append(command)
        return self.response


def request_bytes(payload: bytes) -> bytes:
    return encode_frame(payload)


def served(payload: bytes, limit: int = MAX_REQUEST_BYTES) -> tuple[CliResponse, RecordingDispatcher, bytes]:
    dispatcher = RecordingDispatcher()
    sink = io.BytesIO()
    response = ControlServer(dispatcher, limit=limit).serve_one(RecordingReader(payload), sink)
    return response, dispatcher, sink.getvalue()


# --- the size bound ---------------------------------------------------------


def test_a_raising_handler_gets_a_fixed_failure_and_the_next_command_still_works() -> None:
    def fail(_command: CliCommand) -> CliResponse:
        raise RuntimeError("synthetic private exception text")

    service = LocalAgentService({"run-once": fail, **control_handlers(ServiceState())})
    service.handlers["run-once"] = fail
    server = ControlServer(service)
    sink = io.BytesIO()

    failed = server.serve_one(io.BytesIO(encode_frame(encode_request(CliCommand("run-once")))), sink)
    assert failed == CliResponse("command_failed")
    assert decode_response(read_frame(io.BytesIO(sink.getvalue()))) == failed
    assert b"private" not in sink.getvalue()
    response = server.serve_one(io.BytesIO(encode_frame(encode_request(CliCommand("status")))), io.BytesIO())
    assert response.code == OK


@pytest.mark.parametrize("field,value", [
    ("lines", {"synthetic_private": "detail"}), ("lines", object()), ("code", 42),
])
def test_an_invalid_handler_response_is_refused_without_stopping_control_service(field: str, value: object) -> None:
    invalid = CliResponse(cast(str, value), ()) if field == "code" else CliResponse(OK, (cast(str, value),))
    service = LocalAgentService(control_handlers(ServiceState()))
    service.handlers["run-once"] = lambda _: invalid
    server = ControlServer(service)
    sink = io.BytesIO()
    response = server.serve_one(io.BytesIO(encode_frame(encode_request(CliCommand("run-once")))), sink)
    assert response == CliResponse("command_failed")
    assert decode_response(read_frame(io.BytesIO(sink.getvalue()))) == response
    assert b"synthetic_private" not in sink.getvalue()
    next_sink = io.BytesIO()
    status = server.serve_one(io.BytesIO(encode_frame(encode_request(CliCommand("status")))), next_sink)
    assert status.code == OK
    assert decode_response(read_frame(io.BytesIO(next_sink.getvalue()))) == status


def test_an_oversized_request_is_refused_before_its_body_is_read() -> None:
    """An unbounded read on a local pipe is a one-line memory exhaustion, and a
    bound applied after the read is not a bound."""
    limit = 32
    reader = RecordingReader(encode_frame(b"x" * (limit + 1)))
    dispatcher = RecordingDispatcher()

    response = ControlServer(dispatcher, limit=limit).serve_one(reader, io.BytesIO())

    assert response.code == REQUEST_TOO_LARGE
    assert dispatcher.received == []
    # Only the four-byte header. The body was never pulled off the channel.
    assert reader.requests == [4]


def test_the_frame_reader_refuses_an_oversized_declaration_on_its_own() -> None:
    reader = RecordingReader((MAX_REQUEST_BYTES + 1).to_bytes(4, "big"))
    with pytest.raises(RequestTooLargeError):
        read_frame(reader)
    assert reader.requests == [4]


def test_a_frame_declaring_four_gigabytes_is_refused_rather_than_allocated() -> None:
    """The header is four bytes wide, so the largest number a peer can put in
    it is the one worth naming explicitly."""
    reader = RecordingReader(b"\xff\xff\xff\xff")
    with pytest.raises(RequestTooLargeError):
        read_frame(reader)
    assert reader.requests == [4]


def test_a_request_at_the_limit_is_still_served() -> None:
    """The bound refuses what is over it, not what merely approaches it."""
    payload = encode_request(CliCommand("status"))
    response, dispatcher, _ = served(encode_frame(payload), limit=len(payload))
    assert response.code == OK
    assert len(dispatcher.received) == 1


def test_a_truncated_frame_is_not_answered() -> None:
    """The peer went away mid-frame. There is nobody left to refuse to."""
    _, dispatcher, written = served(b"\x00\x00\x00\x40" + b"partial")
    assert dispatcher.received == []
    assert written == b""


def test_a_frame_with_no_header_at_all_raises_rather_than_hangs() -> None:
    with pytest.raises(TruncatedFrameError):
        read_frame(RecordingReader(b""))


# --- requests are data ------------------------------------------------------


@pytest.mark.parametrize(
    ("description", "payload"),
    [
        ("not json", b"status"),
        ("not an object", b'["status"]'),
        ("a bare string", b'"status"'),
        ("null", b"null"),
        ("no command", b"{}"),
        ("a command that is not a string", b'{"command": 7}'),
        ("a command that is a list", b'{"command": ["status"]}'),
        ("a command we do not serve", b'{"command": "call-me"}'),
        ("a command that does not exist", b'{"command": "rm-rf"}'),
        ("an unknown key", b'{"command": "status", "sudo": true}'),
        ("arguments that are not an object", b'{"command": "status", "arguments": []}'),
        ("invalid utf-8", b'{"command": "\xff\xfestatus"}'),
    ],
)
def test_a_malformed_control_request_is_rejected_without_dispatching(description: str, payload: bytes) -> None:
    response, dispatcher, written = served(encode_frame(payload))

    assert response.code == MALFORMED_REQUEST, description
    # The instrument that matters: nothing reached the handler. A refusal that
    # dispatched first is not a refusal.
    assert dispatcher.received == [], description
    # And the refusal was actually sent, rather than the peer left waiting.
    assert written != b""


def test_call_me_is_not_served_on_this_channel() -> None:
    """Session evidence arriving inside a request proves only that the sender
    can type it, so the one command that turns on evidence is not reachable
    here at all -- not merely refused after being parsed."""
    with pytest.raises(Exception, match="not served on this channel"):
        decode_request(b'{"command": "call-me", "arguments": {"confirm": true}}')


def test_claimed_session_evidence_is_not_carried_off_the_wire() -> None:
    """A caller cannot promote itself by describing its own Windows session."""
    command = decode_request(b'{"command": "status", "arguments": {"confirm": true}}')

    assert command.evidence.is_interactive is False
    assert command.evidence.windows_sid == ""
    assert command.evidence.stdin_redirected is True


def test_a_valid_request_is_dispatched_and_answered() -> None:
    response, dispatcher, written = served(encode_frame(encode_request(CliCommand("status"))))

    assert response.code == OK
    assert [command.name for command in dispatcher.received] == ["status"]
    assert decode_response(read_frame(io.BytesIO(written))) == CliResponse(OK, ("dispatched",))


def test_every_command_this_channel_advertises_is_actually_reachable() -> None:
    """Otherwise the allowlist and the handler set could drift apart and the
    only symptom would be a command that quietly stopped working."""
    state = ServiceState()
    service = LocalAgentService(control_handlers(state))
    for name in ("status", "run-once", "stop"):
        payload = encode_frame(encode_request(CliCommand(name)))
        response = ControlServer(service).serve_one(RecordingReader(payload), io.BytesIO())
        assert response.code == OK, name


def test_the_service_refuses_a_command_the_transport_would_have_passed() -> None:
    """Defence in depth, checked rather than assumed: the service's own gate
    still refuses a name the transport allowlist did not filter."""
    service = LocalAgentService(control_handlers(ServiceState()))
    assert service.handle(CliCommand("rm-rf")).code == UNKNOWN_COMMAND


# --- the security descriptor ------------------------------------------------


def test_the_owner_sddl_names_the_owner_system_and_administrators_only() -> None:
    sddl = owner_only_sddl("S-1-5-21-1-2-3-1001")
    assert sddl == "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;S-1-5-21-1-2-3-1001)"
    assert "WD" not in sddl
    assert "AN" not in sddl


@pytest.mark.parametrize(
    "candidate",
    ["", "everyone", "S-1", "S-1-5-21-1-2-3-1001)(A;;GA;;;WD", "D:P(A;;GA;;;WD)", "S-1-x-y"],
)
def test_a_sid_that_could_rewrite_the_descriptor_is_refused(candidate: str) -> None:
    """The SID comes from an OS call today. A string spliced into a security
    descriptor is exactly the parameter that acquires a caller later."""
    with pytest.raises(ValueError, match="well-formed SID"):
        owner_only_sddl(candidate)


def windows_sddl_token_for_sid(sid: str) -> str:
    """Windows may render a trustee as an alias, including LA for Administrator."""
    server = NamedPipeServer(
        ControlServer(RecordingDispatcher()),
        pipe_name=unique_pipe_name(),
        sddl=f"D:P(A;;GA;;;{sid})",
    )
    handle = server.create_instance(first=True)
    try:
        rendered = pipe_sddl(handle)
    finally:
        close(handle)

    token = rendered.rsplit(";;;", maxsplit=1)[1]
    assert token.endswith(")"), rendered
    return token[:-1]


@windows_only
@pytest.mark.parametrize(
    ("sid", "expected"),
    [("S-1-5-18", "SY"), ("S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1001")],
)
def test_windows_sddl_normalization_keeps_the_same_trustee(sid: str, expected: str) -> None:
    assert windows_sddl_token_for_sid(sid) == expected


@windows_only
@pytest.mark.parametrize("owner_sid", [None, "S-1-5-18"], ids=["current-user", "system-alias"])
def test_the_pipe_is_not_readable_by_everyone(owner_sid: str | None, monkeypatch: pytest.MonkeyPatch) -> None:
    """The claim the whole module rests on, read back off the live object.

    A descriptor that was passed to `CreateNamedPipe` but not applied looks
    exactly like one that was, so this asks Windows what the pipe actually
    carries rather than what it was handed.
    """
    sid = owner_sid or current_user_sid()
    monkeypatch.setattr("jarvis_local.transport.pipe_server.current_user_sid", lambda: sid)
    server = NamedPipeServer(ControlServer(RecordingDispatcher()), pipe_name=unique_pipe_name())
    handle = server.create_instance(first=True)
    try:
        applied = pipe_sddl(handle)
    finally:
        close(handle)

    assert "P" in applied.split("(")[0], applied  # protected: nothing inherited in
    assert ";;;WD)" not in applied, applied  # Everyone
    assert ";;;AN)" not in applied, applied  # anonymous
    assert f";;;{windows_sddl_token_for_sid(sid)})" in applied, applied


@windows_only
def test_the_default_descriptor_would_have_granted_everyone_read() -> None:
    """The control for the test above.

    Without this, `"WD" not in sddl` could be passing because SDDL never says
    WD, because the readback returns something else entirely, or because the
    handle was wrong. Here the same instrument, on the same kind of object,
    sees exactly what the restricted pipe refuses.
    """
    import _winapi

    handle = _winapi.CreateNamedPipe(
        unique_pipe_name(),
        _winapi.PIPE_ACCESS_DUPLEX | 0x00080000,
        0,
        1,
        4096,
        4096,
        0,
        _winapi.NULL,
    )
    try:
        default = pipe_sddl(handle)
    finally:
        close(handle)

    assert ";;;WD)" in default, default
    assert ";;;AN)" in default, default


def open_as_anonymous(pipe_name: str) -> str:
    """Try to open `pipe_name` while impersonating the anonymous token.

    Runs on its own thread because impersonation is a property of a thread,
    and a failure part-way through must not be able to leave the thread that
    runs the rest of the suite wearing somebody else's identity.
    """
    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentThread.restype = wintypes.HANDLE
    advapi32.ImpersonateAnonymousToken.argtypes = [wintypes.HANDLE]
    advapi32.ImpersonateAnonymousToken.restype = wintypes.BOOL
    advapi32.RevertToSelf.restype = wintypes.BOOL

    outcome: list[str] = []

    def body() -> None:
        if not advapi32.ImpersonateAnonymousToken(kernel32.GetCurrentThread()):
            outcome.append("impersonation-unavailable")
            return
        try:
            try:
                with open(pipe_name, "rb", buffering=0):
                    outcome.append("opened")
            except OSError:
                outcome.append("refused")
        finally:
            advapi32.RevertToSelf()

    thread = threading.Thread(target=body)
    thread.start()
    thread.join(timeout=15)
    return outcome[0] if outcome else "no-result"


@windows_only
def test_the_restricted_pipe_actually_refuses_a_caller_the_default_one_admits() -> None:
    """Enforcement, not just descriptor content.

    Reading the DACL back proves it was applied. It does not prove Windows
    consults it, and the two are different claims. So this knocks on both
    pipes as the anonymous account -- the weakest principal available without
    creating a user -- and asks for the read access the default DACL grants.

    The default pipe lets it in. The restricted one does not. That difference
    is the access check running, on this machine, against this code's
    descriptor.

    What it does not establish: that a *different logged-in user* is refused.
    That principal cannot be created here without changing the machine. It is
    denied by the same DACL through the same check, but it was not measured.
    """
    sid = current_user_sid()
    restricted = NamedPipeServer(ControlServer(RecordingDispatcher()), pipe_name=unique_pipe_name())
    restricted_handle = restricted.create_instance(first=True)
    default_handle = _default_descriptor_pipe(default_name := unique_pipe_name())
    try:
        as_anonymous_restricted = open_as_anonymous(restricted.pipe_name)
        as_anonymous_default = open_as_anonymous(default_name)
    finally:
        close(restricted_handle)
        close(default_handle)

    # The control first: if this is not "opened", the knock is not measuring
    # access at all and the refusal below would mean nothing.
    assert as_anonymous_default == "opened"
    assert as_anonymous_restricted == "refused"
    # And the owner, who must still get in, is named in the descriptor.
    assert f";;;{sid})" in owner_only_sddl(sid)


def _default_descriptor_pipe(pipe_name: str) -> int:
    """A pipe created the easy way, for contrast. Not used by the service."""
    import _winapi

    return int(
        _winapi.CreateNamedPipe(
            pipe_name, _winapi.PIPE_ACCESS_DUPLEX | 0x00080000, 0, 1, 4096, 4096, 0, _winapi.NULL
        )
    )


@windows_only
def test_a_second_server_cannot_squat_the_same_pipe_name() -> None:
    """Otherwise an impostor could serve alongside us on the same name and
    clients would reach whichever instance Windows handed them."""
    name = unique_pipe_name()
    server = NamedPipeServer(ControlServer(RecordingDispatcher()), pipe_name=name)
    first = server.create_instance(first=True)
    try:
        with pytest.raises(OSError, match="Access is denied"):
            NamedPipeServer(ControlServer(RecordingDispatcher()), pipe_name=name).create_instance(first=True)
    finally:
        close(first)


# --- the real pipe, end to end ----------------------------------------------


@windows_only
def test_a_status_request_round_trips_over_a_real_named_pipe() -> None:
    """The in-process tests above are only evidence about the pipe if the pipe
    runs the same code. This is the run that says it does."""
    state = ServiceState()
    server = NamedPipeServer(ControlServer(LocalAgentService(control_handlers(state))), pipe_name=unique_pipe_name())
    handle = server.create_instance(first=True)

    # Created before the thread starts, so the pipe is already listening and
    # the client needs no retry -- and so nothing in this test waits on time.
    thread = threading.Thread(target=server.serve_connection, args=(handle,))
    thread.start()
    try:
        response = send_control_request(CliCommand("status"), server.pipe_name)
    finally:
        thread.join(timeout=15)

    assert not thread.is_alive()
    assert response.code == OK
    assert any(line.startswith("status ") for line in response.lines)


@windows_only
def test_stop_travels_over_the_pipe_and_reaches_the_loops_state() -> None:
    """The command's whole purpose is the flag it sets on the other side."""
    state = ServiceState()
    server = NamedPipeServer(ControlServer(LocalAgentService(control_handlers(state))), pipe_name=unique_pipe_name())
    handle = server.create_instance(first=True)
    thread = threading.Thread(target=server.serve_connection, args=(handle,))
    thread.start()
    try:
        response = send_control_request(CliCommand("stop"), server.pipe_name)
    finally:
        thread.join(timeout=15)

    assert response.code == OK
    assert state.stop_requested() is True


@windows_only
def test_an_oversized_request_over_a_real_pipe_is_refused_not_buffered() -> None:
    """The bound has to hold on the transport that can actually be attacked."""
    dispatcher = RecordingDispatcher()
    server = NamedPipeServer(ControlServer(dispatcher, limit=64), pipe_name=unique_pipe_name())
    handle = server.create_instance(first=True)
    thread = threading.Thread(target=server.serve_connection, args=(handle,))
    thread.start()
    try:
        stream = connect_to_pipe(server.pipe_name)
        try:
            stream.write(encode_frame(b"x" * 4096)[:4])
            reply = decode_response(read_frame(stream))
        finally:
            stream.close()
    finally:
        thread.join(timeout=15)

    assert reply.code == REQUEST_TOO_LARGE
    assert dispatcher.received == []


@windows_only
def test_serve_forever_accepts_a_connection_and_then_honours_its_predicate() -> None:
    state = ServiceState()
    server = NamedPipeServer(ControlServer(LocalAgentService(control_handlers(state))), pipe_name=unique_pipe_name())

    def should_continue() -> bool:
        # One pass: accept a single connection, then leave the accept loop.
        return not state.stop_requested()

    # Created here rather than inside the thread, so the pipe is listening
    # before the client connects and this test waits on nothing.
    listening = server.create_instance(first=True)
    thread = threading.Thread(target=server.serve_forever, args=(should_continue, listening))
    thread.start()
    try:
        response = send_control_request(CliCommand("stop"), server.pipe_name)
    finally:
        thread.join(timeout=15)

    assert not thread.is_alive()
    assert response.code == OK
    assert state.stop_requested() is True


# --- the client's side of a service that is not there -----------------------


def test_a_missing_service_is_reported_as_missing_not_as_an_os_error() -> None:
    """`jarvis status` printing "No such file or directory" tells the person
    who typed it nothing about what to do next."""

    def refuse(pipe_name: str) -> None:
        raise FileNotFoundError(2, "The system cannot find the file specified", pipe_name)

    with pytest.raises(ServiceNotRunningError):
        send_control_request(CliCommand("status"), "pipe", connect=refuse)  # type: ignore[arg-type]


def test_the_client_refuses_to_send_a_command_this_channel_does_not_serve() -> None:
    def unreachable(pipe_name: str) -> None:
        raise AssertionError("must not connect for a command the channel does not serve")

    response = send_control_request(CliCommand("call-me"), "pipe", connect=unreachable)  # type: ignore[arg-type]
    assert response.code == UNKNOWN_COMMAND


def test_the_request_the_client_sends_is_the_one_the_server_accepts() -> None:
    """Two codecs that drifted apart would fail only over a real pipe."""
    payload = encode_request(CliCommand("run-once", {"reason": "by hand"}))
    assert decode_request(payload).name == "run-once"
    assert decode_request(payload).arguments == {"reason": "by hand"}


def test_a_response_survives_the_round_trip_through_its_own_codec() -> None:
    original = CliResponse(OK, ("status running", "cycles_recorded 3"))
    assert decode_response(encode_response(original)) == original


def unique_pipe_name() -> str:
    return rf"\\.\pipe\jarvis-test-{os.getpid()}-{uuid.uuid4().hex}"


def close(handle: int) -> None:
    import _winapi

    _winapi.CloseHandle(handle)


@windows_only
def test_close_wakes_a_listener_blocked_on_connect_and_frees_the_name() -> None:
    """Stopping for any reason other than `stop` on the channel must exit.

    The service stops when its run loop ends, which is not the same event as a
    `stop` command arriving: a signal, a failed cycle, an authentication
    refusal. In every one of those the control thread is parked inside
    `ConnectNamedPipe`, and `close` is the only thing that can wake it.

    This is the case no test covered, and it was a live hang, not a theoretical
    one. `close` closed the spare instance -- the one `create_instance`
    publishes -- while the blocked call was on the *previous* handle. So the
    service stopped accepting, never exited, and kept the pipe name: a fresh
    `jarvis serve` was refused as "already in use" and the logon task could not
    restart it.

    Hence three assertions, not one. A test that only checked the thread would
    pass against a `close` that leaked the name.
    """
    name = unique_pipe_name()
    server = NamedPipeServer(ControlServer(RecordingDispatcher()), pipe_name=name)
    finished = threading.Event()

    def listen() -> None:
        try:
            # Blocks in ConnectNamedPipe, as the service does, with no client
            # ever arriving.
            server.serve_forever(lambda: True)
        finally:
            finished.set()

    thread = threading.Thread(target=listen, name="pipe-close-test")
    thread.start()
    try:
        # Let it reach the blocking connect and publish its spare instance.
        assert not finished.wait(timeout=2), "the listener exited before close was called"
        server.close()
        assert finished.wait(timeout=10), (
            "close did not wake the listener: it is still parked in ConnectNamedPipe, "
            "which is the hang that keeps the pipe name and blocks a restart"
        )
    finally:
        thread.join(timeout=5)
        # Idempotent: a second close must not raise and must not close a number
        # Windows has since reused.
        server.close()

    # The name has to be free, or the logon task's next start is refused.
    # Binding it is the check: `create_instance(first=True)` fails when the name
    # is still claimed, and that is exactly what the hang produced. The
    # descriptor itself is not compared -- it is built from the live token and
    # the fallback principal differs between a service and an interactive one,
    # so comparing it here would assert something this test is not about.
    replacement = NamedPipeServer(ControlServer(RecordingDispatcher()), pipe_name=name)
    handle = replacement.create_instance(first=True)
    try:
        assert replacement.pipe_name == name
    finally:
        close(handle)
