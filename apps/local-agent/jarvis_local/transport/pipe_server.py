"""The local control channel: how `jarvis <command>` reaches the running service.

Three pressures shape this module, and each one has a way of being quietly
skipped.

The first is reach. A background service with no window can only be asked how
it is going over a channel, and on Windows the channel is a named pipe. A
named pipe created the easy way -- `CreateNamedPipe` with a null security
descriptor -- is *not* private. Windows gives it a default DACL that grants
FILE_GENERIC_READ to Everyone and to the anonymous account, which was measured
here rather than assumed: such a pipe reads back as
`D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<owner>)(A;;FR;;;WD)(A;;FR;;;AN)`. So this
module builds an explicit descriptor granting the owner, SYSTEM and the
administrators group and nobody else.

Two separate things are then checked, because they are two separate claims.
That the descriptor was *applied*: `test_the_pipe_is_not_readable_by_everyone`
reads it back off the live handle, and its companion asserts the default form
does grant Everyone -- an assertion that a string is absent proves nothing
until the same instrument has seen it present. And that the descriptor is
*enforced*: `test_the_restricted_pipe_actually_refuses_a_caller_the_default_
one_admits` impersonates the anonymous account and knocks on both pipes. The
default one opens. This one refuses. A DACL that is present but never consulted
would pass the first pair of tests and fail that one.

What none of them establish is that a second logged-in *user* is refused, since
that principal cannot be created without changing the machine. It is denied by
the same DACL through the same access check that demonstrably refuses anonymous
-- but it was reasoned, not measured.

One trap is worth naming: the obvious SDDL for "the owner" is `OW`, and it
does not work. `OW` is CREATOR OWNER, a placeholder that is only substituted
when a descriptor is inherited; applied directly it stays literal and matches
nobody at access-check time, producing a pipe its owner cannot open. The
resolved user SID is used instead.

The second pressure is trust. A request that arrives on the channel is data.
It is not a method name, and it must not be used as one -- the command is
checked against an allowlist before anything is constructed from it, and the
shape is checked field by field, so an unrecognised key is a refusal rather
than an argument someone downstream might read. For the same reason this
channel does not serve `call-me`: that command turns on session evidence, and
evidence that arrives inside the request proves only that the sender can type.

The third is size. The service reads whatever the channel hands it, so an
unbounded read is a one-line memory exhaustion available to anyone who can
open the pipe. Every frame declares its length first and an oversized
declaration is refused before the body is read at all. Draining it politely so
the client could hear the refusal cleanly would be the same bug wearing
manners.
"""

from __future__ import annotations

import contextlib
import json
import re
from collections.abc import Callable
from typing import IO, Any, Protocol

from jarvis_local.transport.cli_protocol import (
    UNKNOWN_COMMAND,
    CliCommand,
    CliResponse,
    SessionEvidence,
)

DEFAULT_PIPE_NAME = r"\\.\pipe\jarvis-local-agent"

#: A control request is three short strings. 64 KiB is already generous by
#: three orders of magnitude; the number exists to be small, not to fit
#: anything in particular.
MAX_REQUEST_BYTES = 64 * 1024
FRAME_HEADER_BYTES = 4

#: What this channel serves. Narrower than the CLI's full command surface on
#: purpose -- see the module docstring on `call-me`.
CONTROL_COMMANDS: frozenset[str] = frozenset({"status", "run-once", "stop"})

_REQUEST_KEYS: frozenset[str] = frozenset({"command", "arguments"})

MALFORMED_REQUEST = "malformed_request"
REQUEST_TOO_LARGE = "request_too_large"

_SID_PATTERN = re.compile(r"S-1-\d{1,10}(-\d{1,10}){1,15}\Z")


class ControlProtocolError(RuntimeError):
    """A request could not be understood well enough to dispatch."""


class MalformedRequestError(ControlProtocolError):
    """The bytes were not a well-formed request for a command we serve."""


class RequestTooLargeError(ControlProtocolError):
    """The frame declared more bytes than the channel will read."""


class TruncatedFrameError(ControlProtocolError):
    """The peer stopped sending mid-frame. There is nobody left to answer."""


class ServiceNotRunningError(RuntimeError):
    """The service is not listening. Distinct from a refusal by the service."""


class ByteReader(Protocol):
    def read(self, size: int, /) -> bytes: ...


class ByteWriter(Protocol):
    def write(self, data: bytes, /) -> int: ...


class ByteStream(ByteReader, ByteWriter, Protocol):
    def close(self) -> None: ...


class RequestDispatcher(Protocol):
    """What the transport needs from the service, and nothing more."""

    def handle(self, command: CliCommand) -> CliResponse: ...


def encode_frame(payload: bytes) -> bytes:
    return len(payload).to_bytes(FRAME_HEADER_BYTES, "big") + payload


def read_frame(source: ByteReader, limit: int = MAX_REQUEST_BYTES) -> bytes:
    """Read one length-prefixed frame, refusing an oversized one unread.

    The length is checked against `limit` before the body is touched, which is
    the whole point: a bound applied after the read is not a bound.
    """
    declared = int.from_bytes(_read_exactly(source, FRAME_HEADER_BYTES), "big")
    if declared > limit:
        raise RequestTooLargeError(f"frame declares {declared} bytes; the limit is {limit}")
    return _read_exactly(source, declared)


def _read_exactly(source: ByteReader, count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = count
    while remaining > 0:
        chunk = source.read(remaining)
        if not chunk:
            raise TruncatedFrameError(f"wanted {count} bytes, got {count - remaining}")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def decode_request(payload: bytes) -> CliCommand:
    """Validate the shape, then build a command from the parts that survived.

    Every rejection here is a rejection of a *shape*. Nothing is dispatched on
    a string that merely arrived, and no key is carried through unexamined.
    """
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise MalformedRequestError(f"request is not UTF-8: {error}") from error

    try:
        parsed = json.loads(text)
    except ValueError as error:
        raise MalformedRequestError(f"request is not JSON: {error}") from error

    if not isinstance(parsed, dict):
        raise MalformedRequestError("request must be a JSON object")

    unknown = set(parsed) - _REQUEST_KEYS
    if unknown:
        # Refused rather than ignored. A key we silently drop is a key some
        # later version might start honouring, on a request nobody validated.
        raise MalformedRequestError(f"unknown request keys: {sorted(unknown)}")

    name = parsed.get("command")
    if not isinstance(name, str):
        raise MalformedRequestError("command must be a string")
    if name not in CONTROL_COMMANDS:
        raise MalformedRequestError(f"command is not served on this channel: {name!r}")

    arguments = parsed.get("arguments", {})
    if not isinstance(arguments, dict):
        raise MalformedRequestError("arguments must be a JSON object")
    if not all(isinstance(key, str) for key in arguments):
        raise MalformedRequestError("argument names must be strings")

    # Default evidence, which reads as "untrusted". The sender's claims about
    # its Windows session are not carried: they would be indistinguishable
    # from an assertion, and this channel serves nothing that turns on them.
    return CliCommand(name, dict(arguments), SessionEvidence())


def encode_response(response: CliResponse) -> bytes:
    return json.dumps({"code": response.code, "lines": list(response.lines)}, separators=(",", ":")).encode("utf-8")


def decode_response(payload: bytes) -> CliResponse:
    try:
        parsed = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise MalformedRequestError(f"response is not JSON: {error}") from error
    if not isinstance(parsed, dict) or not isinstance(parsed.get("code"), str):
        raise MalformedRequestError("response must be an object with a string code")
    lines = parsed.get("lines", [])
    if not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
        raise MalformedRequestError("response lines must be a list of strings")
    return CliResponse(str(parsed["code"]), tuple(str(line) for line in lines))


class ControlServer:
    """Frames in, frames out. Transport-independent, so it can be tested whole.

    Holds no connection and no state: every transport that can produce a reader
    and a writer -- a pipe, a pair of `BytesIO` -- gets identical behaviour,
    which is what makes the in-process tests evidence about the pipe too.
    """

    def __init__(self, dispatcher: RequestDispatcher, limit: int = MAX_REQUEST_BYTES) -> None:
        self.dispatcher = dispatcher
        self.limit = limit

    def serve_one(self, reader: ByteReader, writer: ByteWriter) -> CliResponse:
        """Serve exactly one request. Never raises on account of the request."""
        try:
            payload = read_frame(reader, self.limit)
        except TruncatedFrameError:
            # The peer vanished mid-frame. Writing a refusal to a stream that
            # has already gone is noise, so this one is not answered.
            return CliResponse(MALFORMED_REQUEST)
        except RequestTooLargeError:
            # Answered but not drained. Reading the body so the client could
            # hear this cleanly is the exhaustion we just refused.
            return self._reply(writer, CliResponse(REQUEST_TOO_LARGE))

        try:
            command = decode_request(payload)
        except MalformedRequestError:
            return self._reply(writer, CliResponse(MALFORMED_REQUEST))

        return self._reply(writer, self.dispatcher.handle(command))

    def _reply(self, writer: ByteWriter, response: CliResponse) -> CliResponse:
        # Best effort by design: a peer that has hung up, or is blocked writing
        # a payload we just refused to drain, cannot be made to listen.
        with contextlib.suppress(OSError):
            writer.write(encode_frame(encode_response(response)))
        return response


def owner_only_sddl(user_sid: str) -> str:
    """A DACL granting full access to that user, SYSTEM and administrators only.

    `P` makes it protected, so nothing is inherited in alongside these three.
    Administrators are included because they can take ownership of the object
    regardless; excluding them would buy no security and lose the ability to
    diagnose the service from an elevated shell.

    The SID is pattern-checked before interpolation. It reaches this function
    from an OS call today, but a string spliced into a security descriptor is
    exactly the kind of parameter that acquires a caller later.
    """
    if not _SID_PATTERN.match(user_sid):
        raise ValueError(f"not a well-formed SID: {user_sid!r}")
    return f"D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{user_sid})"


# --- Windows named pipe binding -------------------------------------------
#
# Everything below touches Win32. The imports are function-local so that this
# module imports, and the framing and validation above stay testable, on the
# Linux boxes the rest of the suite runs on.

_PIPE_ACCESS_DUPLEX = 0x00000003
_FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000
#: PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT are all zero. Byte mode is
#: deliberate: the frames carry their own length, so the bound is enforced by
#: the same code the in-process tests cover, and a client can be a plain
#: `open()` rather than a second set of Win32 calls.
_PIPE_MODE_BYTE_BLOCKING = 0x00000000
_PIPE_UNLIMITED_INSTANCES = 255
_PIPE_BUFFER_BYTES = 64 * 1024

_ERROR_PIPE_CONNECTED = 535
_EOF_WINERRORS = frozenset({109, 232, 233})  # BROKEN_PIPE, NO_DATA, PIPE_NOT_CONNECTED

_SDDL_REVISION_1 = 1
_DACL_SECURITY_INFORMATION = 0x00000004
_SE_KERNEL_OBJECT = 6
_TOKEN_QUERY = 0x0008
_TOKEN_USER_CLASS = 1


def current_user_sid() -> str:
    """This process's user SID, as a string. Windows only."""
    import ctypes
    from ctypes import wintypes

    advapi32, kernel32 = _win32()

    class _SidAndAttributes(ctypes.Structure):
        _fields_ = (("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD))

    class _TokenUser(ctypes.Structure):
        _fields_ = (("User", _SidAndAttributes),)

    token = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), _TOKEN_QUERY, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        size = wintypes.DWORD(0)
        advapi32.GetTokenInformation(token, _TOKEN_USER_CLASS, None, 0, ctypes.byref(size))
        buffer = ctypes.create_string_buffer(size.value)
        if not advapi32.GetTokenInformation(token, _TOKEN_USER_CLASS, buffer, size, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        user = ctypes.cast(buffer, ctypes.POINTER(_TokenUser)).contents
        text = wintypes.LPWSTR()
        if not advapi32.ConvertSidToStringSidW(user.User.Sid, ctypes.byref(text)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if text.value is None:
                raise OSError("the token user SID converted to nothing")
            return str(text.value)
        finally:
            kernel32.LocalFree(text)
    finally:
        kernel32.CloseHandle(token)


def create_pipe_instance(pipe_name: str, sddl: str, first: bool = False) -> int:
    """Create one instance of the named pipe, carrying `sddl` as its DACL.

    `first` sets FILE_FLAG_FIRST_PIPE_INSTANCE, which makes creation fail with
    ERROR_ACCESS_DENIED if the name is already taken. That failure is the
    point: without it a second process -- ours or somebody else's -- would
    serve alongside us on the same name and clients would reach whichever
    instance Windows handed them.
    """
    import _winapi
    import ctypes
    from ctypes import wintypes

    advapi32, kernel32 = _win32()

    class _SecurityAttributes(ctypes.Structure):
        _fields_ = (
            ("nLength", wintypes.DWORD),
            ("lpSecurityDescriptor", ctypes.c_void_p),
            ("bInheritHandle", wintypes.BOOL),
        )

    descriptor = ctypes.c_void_p()
    length = wintypes.ULONG(0)
    if not advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl, _SDDL_REVISION_1, ctypes.byref(descriptor), ctypes.byref(length)
    ):
        raise ctypes.WinError(ctypes.get_last_error())

    try:
        attributes = _SecurityAttributes()
        attributes.nLength = ctypes.sizeof(_SecurityAttributes)
        attributes.lpSecurityDescriptor = descriptor
        attributes.bInheritHandle = False
        flags = _PIPE_ACCESS_DUPLEX | (_FILE_FLAG_FIRST_PIPE_INSTANCE if first else 0)
        handle = _winapi.CreateNamedPipe(
            pipe_name,
            flags,
            _PIPE_MODE_BYTE_BLOCKING,
            _PIPE_UNLIMITED_INSTANCES,
            _PIPE_BUFFER_BYTES,
            _PIPE_BUFFER_BYTES,
            0,
            ctypes.addressof(attributes),
        )
    finally:
        # `ConvertStringSecurityDescriptorToSecurityDescriptorW` allocates on
        # the Win32 local heap, which no Python object owns. Windows copies
        # the descriptor into the object as it is created, so freeing here is
        # both safe and the only thing that stops a leak per instance -- and
        # this runs once per client connection, forever.
        kernel32.LocalFree(descriptor)
    return int(handle)


def pipe_sddl(handle: int) -> str:
    """Read the DACL back off a live pipe handle, in SDDL form.

    Exists so the access restriction can be asserted rather than asserted
    about. A security descriptor that was passed in but not applied looks
    exactly like one that was.
    """
    import ctypes
    from ctypes import wintypes

    advapi32, kernel32 = _win32()

    descriptor = ctypes.c_void_p()
    status = advapi32.GetSecurityInfo(
        wintypes.HANDLE(handle),
        _SE_KERNEL_OBJECT,
        _DACL_SECURITY_INFORMATION,
        None,
        None,
        None,
        None,
        ctypes.byref(descriptor),
    )
    if status != 0:
        raise ctypes.WinError(status)
    try:
        text = wintypes.LPWSTR()
        length = wintypes.ULONG(0)
        converted = advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            _SDDL_REVISION_1,
            _DACL_SECURITY_INFORMATION,
            ctypes.byref(text),
            ctypes.byref(length),
        )
        if not converted or text.value is None:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return str(text.value)
        finally:
            kernel32.LocalFree(text)
    finally:
        kernel32.LocalFree(descriptor)


class PipeStream:
    """A Win32 pipe handle behind the two methods the framing needs."""

    def __init__(self, handle: int) -> None:
        self.handle = handle

    def read(self, size: int, /) -> bytes:
        import _winapi

        try:
            data, _ = _winapi.ReadFile(self.handle, size, False)
        except OSError as error:
            if error.winerror in _EOF_WINERRORS:
                # A hang-up is end of stream, not a crash. `_read_exactly`
                # turns it into TruncatedFrameError if a frame was in progress.
                return b""
            raise
        return bytes(data)

    def write(self, data: bytes, /) -> int:
        import _winapi

        written, _ = _winapi.WriteFile(self.handle, data, False)
        return int(written)

    def close(self) -> None:
        import _winapi

        _winapi.CloseHandle(self.handle)


class _ClientStream:
    """A raw byte file behind the exact three methods the exchange needs.

    Unbuffered, so a written frame reaches the pipe without a flush, and
    narrowed to `bytes` so `read` cannot hand the framing a `None` the way a
    raw stream is entitled to.
    """

    def __init__(self, raw: IO[bytes]) -> None:
        self.raw = raw

    def read(self, size: int, /) -> bytes:
        return self.raw.read(size) or b""

    def write(self, data: bytes, /) -> int:
        return self.raw.write(data)

    def close(self) -> None:
        self.raw.close()


class NamedPipeServer:
    """Serves one control request per connection over a restricted named pipe.

    One connection at a time, on purpose. These commands set a flag or read a
    list of twenty records; a thread pool to serve them concurrently would be
    resident memory bought for a queue that is never longer than one.
    """

    def __init__(
        self,
        server: ControlServer,
        pipe_name: str = DEFAULT_PIPE_NAME,
        sddl: str | None = None,
    ) -> None:
        self.server = server
        self.pipe_name = pipe_name
        self.sddl = sddl or owner_only_sddl(current_user_sid())

    def create_instance(self, first: bool = False) -> int:
        return create_pipe_instance(self.pipe_name, self.sddl, first=first)

    def serve_connection(self, handle: int) -> CliResponse:
        """Wait for a client on `handle`, serve one request, hang up.

        Takes ownership of the handle: it is closed before this returns,
        whatever happened.
        """
        import _winapi

        stream = PipeStream(handle)
        try:
            try:
                _winapi.ConnectNamedPipe(handle, False)
            except OSError as error:
                # The client can win the race between creating the instance
                # and connecting to it. That is a connection, not a failure.
                if error.winerror != _ERROR_PIPE_CONNECTED:
                    raise
            response = self.server.serve_one(stream, stream)
            _flush_and_disconnect(handle)
            return response
        finally:
            stream.close()

    def serve_forever(self, should_continue: Callable[[], bool], listening: int = 0) -> None:
        """Accept connections until `should_continue` says otherwise.

        A spare instance is created before the current one is served, so the
        name is never momentarily unclaimed. Without that, a `jarvis status`
        landing in the gap between two connections would be told the service is
        not running -- which would be a lie the CLI had no way to detect.

        `listening` accepts an instance the caller already created. Worth
        having: the first instance is where "that name is already taken" shows
        up, and a bootstrap that creates it on the calling thread sees that
        failure at startup rather than losing it inside a background thread
        that nobody is watching.
        """
        if not listening:
            listening = self.create_instance(first=True)
        try:
            while should_continue():
                serving, listening = listening, 0
                try:
                    listening = self.create_instance()
                except BaseException:
                    _close_quietly(serving)
                    raise
                # `serve_connection` owns `serving` from here and closes it on
                # every path. Closing it here as well would eventually close
                # some later handle that Windows had reused the number for.
                self.serve_connection(serving)
        finally:
            _close_quietly(listening)


def connect_to_pipe(pipe_name: str) -> ByteStream:
    """Open the control pipe as a client. Byte mode, so `open` is enough."""
    # Not a context manager here: the caller owns the stream for the whole
    # request/response exchange and closes it in its own `finally`.
    return _ClientStream(open(pipe_name, "r+b", buffering=0))


def send_control_request(
    command: CliCommand,
    pipe_name: str = DEFAULT_PIPE_NAME,
    connect: Callable[[str], ByteStream] = connect_to_pipe,
) -> CliResponse:
    """Ask the running service one question and return its answer.

    Raises `ServiceNotRunningError` when the service is not listening, so
    the CLI can say that in words rather than reprinting an errno.
    """
    if command.name not in CONTROL_COMMANDS:
        return CliResponse(UNKNOWN_COMMAND)
    request = encode_frame(encode_request(command))
    try:
        stream = connect(pipe_name)
    except OSError as error:
        raise ServiceNotRunningError(str(error)) from error
    try:
        stream.write(request)
        return decode_response(read_frame(stream))
    except OSError as error:
        raise ServiceNotRunningError(str(error)) from error
    finally:
        stream.close()


def encode_request(command: CliCommand) -> bytes:
    """The request side of the wire format. Evidence is deliberately not sent."""
    return json.dumps(
        {"command": command.name, "arguments": dict(command.arguments)}, separators=(",", ":")
    ).encode("utf-8")


def _win32() -> tuple[Any, Any]:
    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    # Prototypes matter on 64-bit: without them ctypes truncates handles and
    # pointers to int, and the failures that produces are baffling.
    kernel32.GetCurrentProcess.argtypes = []
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    kernel32.FlushFileBuffers.argtypes = [wintypes.HANDLE]
    kernel32.FlushFileBuffers.restype = wintypes.BOOL
    kernel32.DisconnectNamedPipe.argtypes = [wintypes.HANDLE]
    kernel32.DisconnectNamedPipe.restype = wintypes.BOOL

    advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi32.OpenProcessToken.restype = wintypes.BOOL
    advapi32.GetTokenInformation.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    advapi32.GetTokenInformation.restype = wintypes.BOOL
    advapi32.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL
    advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.ULONG),
    ]
    advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
    advapi32.GetSecurityInfo.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.DWORD,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    advapi32.GetSecurityInfo.restype = wintypes.DWORD
    advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(wintypes.ULONG),
    ]
    advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW.restype = wintypes.BOOL
    return advapi32, kernel32


def _flush_and_disconnect(handle: int) -> None:
    _, kernel32 = _win32()
    # Flush first: DisconnectNamedPipe discards anything the client has not
    # read yet, which would drop the reply we just wrote.
    kernel32.FlushFileBuffers(handle)
    kernel32.DisconnectNamedPipe(handle)


def _close_quietly(handle: int) -> None:
    if not handle:
        return
    import _winapi

    with contextlib.suppress(OSError):
        _winapi.CloseHandle(handle)
