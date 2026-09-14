"""PR #31 adversarial tests for `jarvis enroll-phone` (attack 10 and CLI privacy).

Synthetic data only; no network. Tests named ``test_finding_*`` assert the
demonstrated undesired behaviour so they pass as reproductions.
"""

from __future__ import annotations

import base64
import builtins
import hashlib
import io
import json
import logging
import os
import re
import sys
import traceback
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local import phone_enrollment
from jarvis_local.config import JarvisLocalConfig
from jarvis_local.crypto.device_keys import DPAPI_PREFIX, DeviceKeyStore
from jarvis_local.phone_enrollment import OWNER_PHONE_ENROLLMENT_PATH, run_phone_enrollment
from jarvis_local.sync.cloud_client import CloudAuthError, CloudSyncError, HttpCloudClient

PHONE = "+15005550006"
RESPONSE = "907315"
MISMATCH = "device key does not match the active production record"
# v2 (327ddda): a missing or unreadable key now has its own fixed, non-disclosing message.
KEY_UNAVAILABLE = "configured device key is missing or unreadable"
WINDOWS_ONLY = pytest.mark.skipif(sys.platform != "win32", reason="exercises the real Windows DPAPI key store")
PHONE_FRAGMENTS = (PHONE, PHONE[1:], PHONE[:-4], "5005550006")

PREFLIGHT_OK: dict[str, object] = {"schemaVersion": "1.0", "deviceKeyMatches": True}
PENDING: dict[str, object] = {
    "schemaVersion": "1.0",
    "deviceKeyMatches": True,
    "enrollmentState": "pending",
    "challengeId": "challenge:opaque",
    "response": RESPONSE,
    "expiresAt": "2026-09-14T14:05:00.000Z",
}


def state(name: str) -> dict[str, object]:
    return {"schemaVersion": "1.0", "deviceKeyMatches": True, "enrollmentState": name}


def config_for(key_path: Path, **overrides: str | None) -> JarvisLocalConfig:
    values: dict[str, str] = {
        "JARVIS_CLOUD_BASE_URL": "https://gateway.example",
        "JARVIS_DEVICE_ID": "device:synthetic-home",
        "JARVIS_PRINCIPAL_ID": "principal:synthetic-owner",
        "JARVIS_DEVICE_KEY_PATH": str(key_path),
    }
    for name, value in overrides.items():
        if value is None:
            values.pop(name, None)
        else:
            values[name] = value
    return JarvisLocalConfig.load(values)


class FakeGateway:
    def __init__(self, responses: list[object]) -> None:
        self.responses = list(responses)
        self.requests: list[tuple[str, dict[str, object]]] = []

    def post_signed(self, path: str, body: dict[str, object]) -> dict[str, object]:
        self.requests.append((path, body))
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        assert isinstance(response, dict)
        return response


class FakeStore:
    def __init__(self, key: Ed25519PrivateKey) -> None:
        self.key = key
        self.loaded = 0

    def load_existing(self) -> Ed25519PrivateKey:
        self.loaded += 1
        return self.key

    def load_or_create(self) -> None:
        pytest.fail("enroll-phone called load_or_create")


class WireOpener:
    """urlopen stand-in: records requests, never touches the network."""

    def __init__(self, responses: list[dict[str, Any] | BaseException]) -> None:
        self.responses = list(responses)
        self.requests: list[Any] = []

    def __call__(self, request: Any, timeout: float | None = None) -> Any:  # noqa: ANN401
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return io.BytesIO(json.dumps(response).encode("utf-8"))


@pytest.fixture
def key() -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(bytes(range(1, 33)))


@pytest.fixture
def forbid_key_creation(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(_self: DeviceKeyStore) -> object:
        pytest.fail("enroll-phone reached a key-creation path")

    monkeypatch.setattr(DeviceKeyStore, "load_or_create", refuse)
    monkeypatch.setattr(DeviceKeyStore, "_create_sealed", refuse)


def interactive(monkeypatch: pytest.MonkeyPatch, phone: str = PHONE, answer: str = "yes") -> dict[str, list[str]]:
    prompts: dict[str, list[str]] = {"getpass": [], "input": []}
    monkeypatch.setattr(phone_enrollment, "_interactive_terminal", lambda: True)

    def fake_getpass(prompt: str = "") -> str:
        prompts["getpass"].append(prompt)
        return phone

    def fake_input(prompt: str = "") -> str:
        prompts["input"].append(prompt)
        return answer

    monkeypatch.setattr(phone_enrollment.getpass, "getpass", fake_getpass)
    monkeypatch.setattr(builtins, "input", fake_input)
    return prompts


# --- 10a: a missing or unusable key is never replaced -------------------------------------------


@WINDOWS_ONLY
@pytest.mark.parametrize("operation", ["preflight", "status", "begin"])
def test_real_store_missing_key_is_refused_and_creates_no_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    forbid_key_creation: None,
    operation: str,
) -> None:
    key_path = tmp_path / "not-created" / "device.key"
    monkeypatch.setattr(phone_enrollment, "_is_windows", lambda: True)
    monkeypatch.setattr(phone_enrollment, "HttpCloudClient", lambda **_kw: pytest.fail("built a transport without a key"))
    prompts = interactive(monkeypatch)

    assert run_phone_enrollment(config_for(key_path), operation) == 1

    captured = capsys.readouterr()
    assert captured.out.strip() == KEY_UNAVAILABLE
    assert captured.err == ""
    assert list(tmp_path.rglob("*")) == []
    assert str(key_path) not in captured.out
    assert prompts == {"getpass": [], "input": []}


@WINDOWS_ONLY
@pytest.mark.parametrize("contents", [bytes(range(32)), DPAPI_PREFIX + b"\x00" * 64, b""])
def test_real_store_refuses_an_unusable_key_file_without_overwriting_it(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    forbid_key_creation: None,
    contents: bytes,
) -> None:
    key_path = tmp_path / "device.key"
    key_path.write_bytes(contents)
    monkeypatch.setattr(phone_enrollment, "_is_windows", lambda: True)
    monkeypatch.setattr(phone_enrollment, "HttpCloudClient", lambda **_kw: pytest.fail("built a transport from a bad key"))

    assert run_phone_enrollment(config_for(key_path), "preflight") == 1

    assert capsys.readouterr().out.strip() == KEY_UNAVAILABLE
    assert key_path.read_bytes() == contents
    assert sorted(path.name for path in tmp_path.iterdir()) == ["device.key"]


def test_cli_source_has_no_key_creation_path() -> None:
    source = Path(phone_enrollment.__file__).read_text(encoding="utf-8")
    assert "load_existing()" in source
    assert "load_or_create" not in source
    assert "_create_sealed" not in source


# --- 10b: real sealed key, real signing, no network --------------------------------------------


@WINDOWS_ONLY
def test_real_sealed_key_begin_sends_the_number_only_inside_the_signed_body(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    key_path = tmp_path / "device.key"
    real_key = phone_enrollment.platform_device_key_store(key_path).load_or_create()  # test fixture only
    assert isinstance(real_key, Ed25519PrivateKey)
    sealed = key_path.read_bytes()
    opener = WireOpener([PREFLIGHT_OK, PENDING])
    real_client = HttpCloudClient
    monkeypatch.setattr(phone_enrollment, "_is_windows", lambda: True)
    monkeypatch.setattr(phone_enrollment, "HttpCloudClient", lambda **kw: real_client(**kw, opener=opener))
    monkeypatch.setattr(DeviceKeyStore, "load_or_create", lambda _self: pytest.fail("load_or_create during enroll-phone"))
    prompts = interactive(monkeypatch)

    assert run_phone_enrollment(config_for(key_path), "begin") == 0

    assert key_path.read_bytes() == sealed
    assert len(opener.requests) == 2
    preflight_request, begin_request = opener.requests
    for request in opener.requests:
        assert request.full_url == f"https://gateway.example{OWNER_PHONE_ENROLLMENT_PATH}"
        for name, value in request.header_items():
            for fragment in PHONE_FRAGMENTS:
                assert fragment not in value, name
    assert PHONE.encode() not in preflight_request.data
    begin_body = json.loads(begin_request.data)
    # v2 (327ddda): the signed begin body gains exactly one random requestSalt; nothing else changes.
    assert set(begin_body) == {"operation", "phoneNumber", "requestSalt", "schemaVersion"}
    assert {name: begin_body[name] for name in ("operation", "phoneNumber", "schemaVersion")} == {
        "operation": "begin", "phoneNumber": PHONE, "schemaVersion": "1.0",
    }
    salt = begin_body["requestSalt"]
    assert isinstance(salt, str)
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", salt)
    assert len(base64.urlsafe_b64decode(f"{salt}=")) == 32
    for fragment in PHONE_FRAGMENTS:
        assert fragment not in salt
    envelope = json.loads(begin_request.get_header("X-jarvis-signed-request"))
    assert envelope["bodyHash"] == hashlib.sha256(begin_request.data).hexdigest()
    message = "\n".join([
        "POST", OWNER_PHONE_ENROLLMENT_PATH, envelope["deviceId"], envelope["principalId"],
        envelope["audience"], envelope["issuedAt"], envelope["nonce"], envelope["bodyHash"],
    ]).encode("utf-8")
    real_key.public_key().verify(base64.b64decode(envelope["signatureBase64"]), message)

    captured = capsys.readouterr()
    for fragment in PHONE_FRAGMENTS:
        assert fragment not in captured.out + captured.err
    assert RESPONSE in captured.out
    assert prompts["input"] == ["Enroll phone ending 0006? Type yes to continue: "]
    assert prompts["getpass"] == [
        "Phone number in E.164 form (input hidden): ",
        "Re-enter the same phone number (input hidden): ",
    ]


# --- 10c: output, log and disk privacy on every begin outcome ----------------------------------


@pytest.mark.parametrize(
    ("begin_result", "expected_code"),
    [
        (PENDING, 0),
        (state("conflict"), 1),
        (state("active"), 0),
        (state("expired"), 1),
        (state("absent"), 1),
        (CloudAuthError("gateway rejected the device: HTTP 401"), 1),
        (CloudSyncError("gateway returned HTTP 409"), 4),
        (CloudSyncError("gateway returned HTTP 500"), 4),
        ({**state("active"), "phoneNumber": PHONE}, 4),
        ({**PENDING, "phoneNumber": PHONE}, 4),
        ({**PENDING, "response": PHONE}, 4),
        ({**PENDING, "expiresAt": PHONE}, 4),
        ({**PENDING, "challengeId": PHONE}, 0),
    ],
)
def test_begin_never_prints_or_logs_the_number(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
    key: Ed25519PrivateKey,
    begin_result: object,
    expected_code: int,
) -> None:
    caplog.set_level(logging.DEBUG)
    monkeypatch.setattr(phone_enrollment, "_is_windows", lambda: True)
    monkeypatch.setattr(phone_enrollment, "platform_device_key_store", lambda _path: FakeStore(key))
    gateway = FakeGateway([PREFLIGHT_OK, begin_result])
    monkeypatch.setattr(phone_enrollment, "HttpCloudClient", lambda **_kw: gateway)
    prompts = interactive(monkeypatch)

    assert run_phone_enrollment(config_for(Path("C:/synthetic/device.key")), "begin") == expected_code

    captured = capsys.readouterr()
    visible = captured.out + captured.err + caplog.text + "".join(prompts["getpass"])
    for fragment in PHONE_FRAGMENTS:
        assert fragment not in visible
    assert prompts["input"] == ["Enroll phone ending 0006? Type yes to continue: "]
    if isinstance(begin_result, dict) and begin_result.get("response") == RESPONSE and expected_code == 0 \
            and begin_result.get("enrollmentState") == "pending":
        assert RESPONSE in captured.out
    else:
        assert RESPONSE not in visible


def test_finding_unhandled_read_error_escapes_run_phone_enrollment_without_leaking_the_number(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    class BrokenStream(io.BytesIO):
        def read(self, *_args: object) -> bytes:  # type: ignore[override]
            raise ConnectionResetError(10054, "An existing connection was forcibly closed by the remote host")

    def opener(request: Any, timeout: float | None = None) -> Any:  # noqa: ANN401
        if b'"begin"' in (request.data or b""):
            return BrokenStream()
        return io.BytesIO(json.dumps(PREFLIGHT_OK).encode("utf-8"))

    real_client = HttpCloudClient
    monkeypatch.setattr(phone_enrollment, "_is_windows", lambda: True)
    monkeypatch.setattr(phone_enrollment, "platform_device_key_store", lambda _path: FakeStore(key))
    monkeypatch.setattr(phone_enrollment, "HttpCloudClient", lambda **kw: real_client(**kw, opener=opener))
    interactive(monkeypatch)

    # Demonstrated: the fixed "request is unavailable" mapping does not cover an OSError raised while the
    # response body is read, so the command exits through an uncaught traceback instead of exit code 4.
    with pytest.raises(ConnectionResetError) as caught:
        run_phone_enrollment(config_for(Path("C:/synthetic/device.key")), "begin")

    rendered = "".join(traceback.format_exception(caught.value))
    captured = capsys.readouterr()
    for fragment in PHONE_FRAGMENTS:
        assert fragment not in rendered
        assert fragment not in captured.out + captured.err


def test_begin_writes_nothing_to_disk(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    monkeypatch.chdir(tmp_path)
    writes: list[str] = []
    real_open = builtins.open
    real_io_open = io.open
    real_os_open = os.open
    real_os_write = os.write

    def spy_open(file: Any, mode: str = "r", *args: Any, **kwargs: Any) -> Any:  # noqa: ANN401
        if any(flag in str(mode) for flag in "wax+"):
            writes.append(f"open:{file}:{mode}")
        return real_open(file, mode, *args, **kwargs)

    def spy_io_open(file: Any, mode: str = "r", *args: Any, **kwargs: Any) -> Any:  # noqa: ANN401
        if any(flag in str(mode) for flag in "wax+"):
            writes.append(f"io.open:{file}:{mode}")
        return real_io_open(file, mode, *args, **kwargs)

    def spy_os_open(path: Any, flags: int, *args: Any, **kwargs: Any) -> int:  # noqa: ANN401
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND):
            writes.append(f"os.open:{path}")
        return real_os_open(path, flags, *args, **kwargs)

    def spy_os_write(descriptor: int, data: Any) -> int:  # noqa: ANN401
        if PHONE.encode() in bytes(data):
            writes.append(f"os.write:{descriptor}")
        return real_os_write(descriptor, data)

    opener = WireOpener([PREFLIGHT_OK, PENDING])
    real_client = HttpCloudClient
    monkeypatch.setattr(phone_enrollment, "_is_windows", lambda: True)
    monkeypatch.setattr(phone_enrollment, "platform_device_key_store", lambda _path: FakeStore(key))
    monkeypatch.setattr(phone_enrollment, "HttpCloudClient", lambda **kw: real_client(**kw, opener=opener))
    interactive(monkeypatch)
    monkeypatch.setattr(builtins, "open", spy_open)
    monkeypatch.setattr(io, "open", spy_io_open)
    monkeypatch.setattr(os, "open", spy_os_open)
    monkeypatch.setattr(os, "write", spy_os_write)

    code = run_phone_enrollment(config_for(tmp_path / "device.key"), "begin")

    monkeypatch.undo()
    assert code == 0
    assert writes == []
    assert [path for path in tmp_path.rglob("*")] == []
    assert PHONE not in capsys.readouterr().out


def test_status_and_preflight_never_prompt_for_or_send_a_number(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    monkeypatch.setattr(phone_enrollment, "_is_windows", lambda: True)
    monkeypatch.setattr(phone_enrollment, "platform_device_key_store", lambda _path: FakeStore(key))
    monkeypatch.setattr(phone_enrollment.getpass, "getpass", lambda _prompt="": pytest.fail("prompted for a number"))
    monkeypatch.setattr(builtins, "input", lambda _prompt="": pytest.fail("prompted for confirmation"))
    for operation, responses, expected in (
        ("preflight", [PREFLIGHT_OK], "device key matches the active production record"),
        ("status", [state("pending")], "owner phone enrollment is pending"),
    ):
        gateway = FakeGateway(responses)
        monkeypatch.setattr(phone_enrollment, "HttpCloudClient", lambda _gateway=gateway, **_kw: _gateway)
        assert run_phone_enrollment(config_for(Path("C:/synthetic/device.key")), operation) == 0
        assert all("phoneNumber" not in body for _path, body in gateway.requests)
        assert capsys.readouterr().out.strip() == expected


@pytest.mark.parametrize(
    "typed",
    ["+1\uff15005550006", "+15005550006\u200b", "+1 500 555 0006", "+15005550006;x", "tel:+15005550006", "+015005550006"],
)
def test_non_canonical_phone_input_is_refused_before_sending_and_not_echoed(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
    typed: str,
) -> None:
    monkeypatch.setattr(phone_enrollment, "_is_windows", lambda: True)
    monkeypatch.setattr(phone_enrollment, "platform_device_key_store", lambda _path: FakeStore(key))
    gateway = FakeGateway([PREFLIGHT_OK])
    monkeypatch.setattr(phone_enrollment, "HttpCloudClient", lambda **_kw: gateway)
    prompts = interactive(monkeypatch, phone=typed)

    assert run_phone_enrollment(config_for(Path("C:/synthetic/device.key")), "begin") == 2

    assert gateway.requests == [(OWNER_PHONE_ENROLLMENT_PATH, {"schemaVersion": "1.0", "operation": "preflight"})]
    assert capsys.readouterr().out.strip() == "phone number must use E.164 form"
    assert prompts["input"] == []


def test_finding_configuration_errors_are_reported_as_a_device_key_mismatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    store = FakeStore(key)
    monkeypatch.setattr(phone_enrollment, "_is_windows", lambda: True)
    monkeypatch.setattr(phone_enrollment, "platform_device_key_store", lambda _path: store)

    # A plain-http base URL: the existing key loads fine; the transport refuses the scheme.
    code = run_phone_enrollment(
        config_for(tmp_path / "device.key", JARVIS_CLOUD_BASE_URL="http://gateway.example"), "preflight",
    )
    assert (code, store.loaded) == (1, 1)
    assert capsys.readouterr().out.strip() == MISMATCH

    # A missing device id: the key is never even consulted.
    code = run_phone_enrollment(config_for(tmp_path / "device.key", JARVIS_DEVICE_ID=None), "preflight")
    assert (code, store.loaded) == (1, 1)
    assert capsys.readouterr().out.strip() == MISMATCH


# --- v2 (327ddda) inverted findings: each passes on the fix and fails if the finding returns ------------


def test_inverted_read_error_after_begin_returns_the_fixed_unavailable_output(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    class BrokenStream(io.BytesIO):
        def read(self, *_args: object) -> bytes:  # type: ignore[override]
            raise ConnectionResetError(10054, "An existing connection was forcibly closed by the remote host")

    def opener(request: Any, timeout: float | None = None) -> Any:  # noqa: ANN401
        if b'"begin"' in (request.data or b""):
            return BrokenStream()
        return io.BytesIO(json.dumps(PREFLIGHT_OK).encode("utf-8"))

    real_client = HttpCloudClient
    monkeypatch.setattr(phone_enrollment, "_is_windows", lambda: True)
    monkeypatch.setattr(phone_enrollment, "platform_device_key_store", lambda _path: FakeStore(key))
    monkeypatch.setattr(phone_enrollment, "HttpCloudClient", lambda **kw: real_client(**kw, opener=opener))
    interactive(monkeypatch)

    assert run_phone_enrollment(config_for(Path("C:/synthetic/device.key")), "begin") == 4

    captured = capsys.readouterr()
    assert captured.out.strip() == "owner phone enrollment request is unavailable"
    assert captured.err == ""
    for fragment in PHONE_FRAGMENTS:
        assert fragment not in captured.out + captured.err


def test_inverted_configuration_errors_have_their_own_message_and_are_not_a_key_mismatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    store = FakeStore(key)
    monkeypatch.setattr(phone_enrollment, "_is_windows", lambda: True)
    monkeypatch.setattr(phone_enrollment, "platform_device_key_store", lambda _path: store)

    code = run_phone_enrollment(
        config_for(tmp_path / "device.key", JARVIS_CLOUD_BASE_URL="http://gateway.example"), "preflight",
    )
    assert (code, store.loaded) == (2, 1)
    assert capsys.readouterr().out.strip() == "owner phone enrollment configuration is incomplete"

    code = run_phone_enrollment(config_for(tmp_path / "device.key", JARVIS_DEVICE_ID=None), "preflight")
    assert (code, store.loaded) == (2, 1)
    assert capsys.readouterr().out.strip() == "owner phone enrollment configuration is incomplete"
    assert list(tmp_path.iterdir()) == []
