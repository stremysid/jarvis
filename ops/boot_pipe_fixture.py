r"""A stand-in for the local agent's control channel, for `ops/jarvis-boot.ps1`.

This is a test fixture, not an agent. It exists because the Windows half of the
control channel has a real server (`jarvis_local/transport/pipe_server.py`) and
no caller, so the only way to check that the boot script's client speaks the
same wire format is to run a server that uses the *real* framing functions
rather than a hand-written copy of them. It drives
`NamedPipeServer.serve_forever` -- the same accept loop
`jarvis node` drives on Linux -- and answers through `ControlServer`, so a
drift on either side of the wire fails the acceptance run.

Two modes:

    status   serve until one connection carries a well-formed request, answer it
             with a fixed `status` response, and exit. Connections that carry no
             request -- the acceptance script's readiness probe, and the boot
             script's own probe when the spare instance is busy -- are served
             and discarded by `ControlServer`, exactly as the real agent would.
             It is deliberately not a hand-rolled accept/close loop: the first
             version was one, and closing an instance the loop had not finished
             with produced `BrokenPipeError` on the second probe.
    maxframe read one complete request, then answer with a header declaring a
             frame ten times `MAX_REQUEST_BYTES` and nothing else. A client that
             checks the declaration before reading refuses and exits; one that
             reads the body blocks until its own timeout. That difference is the
             guard this mode pins.

usage: JARVIS_FIXTURE_PIPE=\\.\pipe\<name> python ops/boot_pipe_fixture.py <status|maxframe>

The name is the full `\\.\pipe\<name>` path -- what `_winapi.CreateNamedPipe`
takes and what `pipe_server.DEFAULT_PIPE_NAME` holds. It comes from the
environment rather than the command line because a name passed as an argument
arrives through `uv.exe` with its backslashes eaten.

Run from the repository root with the local agent's own environment on the import
path:

    $env:PYTHONPATH = 'apps/local-agent'
    $env:JARVIS_FIXTURE_PIPE = '\\.\pipe\jarvis-pc-controls-live'
    uv run --project apps/local-agent python ops/boot_pipe_fixture.py status

`ops/test-pc-controls.ps1` does exactly that. It is not a pytest module: it is a
subprocess the acceptance script starts, so it has no test functions and imports
nothing from `tests/`.
"""

from __future__ import annotations

import os
import sys
import threading
from collections.abc import Callable
from typing import Any

from jarvis_local.transport.cli_protocol import CliCommand, CliResponse
from jarvis_local.transport.pipe_server import (
    MAX_REQUEST_BYTES,
    ControlServer,
    NamedPipeServer,
)

#: How long the accept loop runs before giving up. Bounded so a client that
#: connects and vanishes cannot keep this process alive forever; the acceptance
#: script's readiness probe and the boot script's own probe both fit inside it.
LISTEN_SECONDS = 30.0

STATUS_LINES = (
    "status running",
    "started_at 2026-09-21T08:00:00.000Z",
    "cycles_recorded 1",
    "cycle 2026-09-21T08:00:04.000Z cadence replicated=3 distilled=1 proposed=1 promoted=0 quarantined=0 ok",
)


class StatusDispatcher:
    """Answers `status` and nothing else. It is not a service; it has no state."""

    def __init__(self) -> None:
        self.requests: list[str] = []
        self.served = threading.Event()

    def handle(self, command: CliCommand) -> CliResponse:
        self.requests.append(command.name)
        self.served.set()
        return CliResponse("ok", STATUS_LINES)


class OversizedDispatcher:
    """Hands the transport an over-limit declaration and then writes nothing.

    A `CliResponse` always carries its true length in the prefix, so the frame
    under test has to go out through the stream itself -- which is what makes
    this a dispatcher rather than an ordinary answer.
    """

    def __init__(self) -> None:
        self.served = threading.Event()
        self.writer: Any = None

    def handle(self, command: CliCommand) -> CliResponse:
        if self.writer is not None:
            self.writer.write((MAX_REQUEST_BYTES * 10).to_bytes(4, "big"))
        self.served.set()
        # An empty response follows the declaration on the wire. The client
        # refuses on the declaration and never reads far enough to see it.
        return CliResponse("oversized_header_sent", ())


class OversizedHeaderServer:
    """Accepts until one connection carries a complete request, then answers it.

    Built on `ControlServer` rather than hand-rolling the accept loop, for the
    reason the first version of this fixture learned the hard way: a hand-rolled
    loop that closes an instance before the next one is ready produces
    `BrokenPipeError`, which is indistinguishable from a client that cannot
    connect. Here the real server serves the probes and discards them, and the
    dispatcher only speaks to a connection that carried a request.
    """

    def __init__(self, pipe_name: str) -> None:
        self.pipe_name = pipe_name
        self.dispatcher = OversizedDispatcher()

    @property
    def served(self) -> threading.Event:
        return self.dispatcher.served

    def serve_forever(self, should_continue: Callable[[], bool], listening: int = 0) -> None:
        class _Witness(ControlServer):
            def serve_one(inner_self, reader: Any, writer: Any) -> CliResponse:  # noqa: N805
                self.dispatcher.writer = writer
                try:
                    return super(_Witness, inner_self).serve_one(reader, writer)
                finally:
                    self.dispatcher.writer = None

        server = NamedPipeServer(_Witness(self.dispatcher, limit=MAX_REQUEST_BYTES), pipe_name=self.pipe_name)
        handle = listening or server.create_instance(first=True)
        server.serve_forever(should_continue, handle)


def _serve(pipe_name: str, dispatcher: object, stop: threading.Event) -> None:
    try:
        if isinstance(dispatcher, OversizedHeaderServer):
            dispatcher.serve_forever(lambda: not stop.is_set())
            return
        server = NamedPipeServer(ControlServer(dispatcher), pipe_name=pipe_name)  # type: ignore[arg-type]
        listening = server.create_instance(first=True)
        server.serve_forever(lambda: not stop.is_set(), listening)
    except BaseException as error:  # noqa: BLE001 -- reported, not swallowed
        # A daemon thread's exception reaches nobody, and a fixture that stops
        # serving without saying so looks exactly like a client that cannot
        # connect. Both were observed before this handler existed.
        import traceback

        traceback.print_exc()
        print(f"the fixture's accept loop stopped: {error!r}", file=sys.stderr)


def _run(pipe_name: str, dispatcher: object, deadline_seconds: float) -> int:
    served = getattr(dispatcher, "served")
    stop = threading.Event()
    thread = threading.Thread(target=_serve, args=(pipe_name, dispatcher, stop), daemon=True)
    thread.start()
    if not served.wait(timeout=deadline_seconds):
        stop.set()
        print("the fixture never received a request it could act on", file=sys.stderr)
        return 1
    stop.set()
    # `serve_forever` leaves the client's connection to `ControlServer`, which
    # has already answered by now.
    thread.join(timeout=5.0)
    return 0


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    pipe_name = os.environ.get("JARVIS_FIXTURE_PIPE", "")
    if not pipe_name:
        print("JARVIS_FIXTURE_PIPE is unset", file=sys.stderr)
        return 2
    mode = argv[1]
    if mode == "status":
        dispatcher: object = StatusDispatcher()
    elif mode == "maxframe":
        dispatcher = OversizedHeaderServer(pipe_name)
    else:
        print(f"unknown mode: {mode}", file=sys.stderr)
        return 2
    return _run(pipe_name, dispatcher, LISTEN_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
