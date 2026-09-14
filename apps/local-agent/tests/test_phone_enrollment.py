"""The owner-phone command must prove the configured key before revealing state."""

from __future__ import annotations

import base64
import http.client
import io
import json
import re
import urllib.error
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.cli import build_parser, main
from jarvis_local.config import JarvisLocalConfig
from jarvis_local.phone_enrollment import (
    OWNER_PHONE_ENROLLMENT_PATH,
    OwnerPhoneEnrollmentClient,
    run_phone_enrollment,
)
from jarvis_local.sync.cloud_client import (
    CloudAuthError,
    CloudRequestExpiredError,
    CloudSyncError,
    HttpCloudClient,
)

PHONE = "+14165550123"
CONFIG = {
    "JARVIS_CLOUD_BASE_URL": "https://gateway.example",
    "JARVIS_DEVICE_ID": "device:home-private",
    "JARVIS_PRINCIPAL_ID": "principal:owner-private",
    "JARVIS_DEVICE_KEY_PATH": str(Path("C:/Jarvis/private/device.key")),
}


class FakeGateway:
    def __init__(self, responses: list[object]) -> None:
        self.responses = responses
        self.requests: list[tuple[str, dict[str, object]]] = []

    def post_signed(self, path: str, body: dict[str, object]) -> dict[str, object]:
        self.requests.append((path, body))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        assert isinstance(response, dict)
        return response


class FakeStore:
    def __init__(self, key: Ed25519PrivateKey | Exception) -> None:
        self.key = key
        self.loaded = 0

    def load_existing(self) -> Ed25519PrivateKey:
        self.loaded += 1
        if isinstance(self.key, Exception):
            raise self.key
        return self.key

    def load_or_create(self) -> None:
        pytest.fail("phone preflight silently created a replacement key")


@pytest.fixture
def key() -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(bytes(range(32)))


def install_fakes(
    monkeypatch: pytest.MonkeyPatch,
    key: Ed25519PrivateKey,
    responses: list[object],
) -> tuple[FakeStore, FakeGateway]:
    store = FakeStore(key)
    gateway = FakeGateway(responses)
    monkeypatch.setattr("jarvis_local.phone_enrollment._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.phone_enrollment.platform_device_key_store", lambda _path: store)
    monkeypatch.setattr("jarvis_local.phone_enrollment.HttpCloudClient", lambda **_kwargs: gateway)
    return store, gateway


def test_parser_exposes_preflight_status_and_interactive_begin() -> None:
    assert build_parser().parse_args(["enroll-phone"]).phone_operation == "begin"
    assert build_parser().parse_args(["enroll-phone", "--preflight"]).phone_operation == "preflight"
    assert build_parser().parse_args(["enroll-phone", "--status"]).phone_operation == "status"


def test_preflight_loads_only_the_existing_key_and_reports_no_identifiers(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    store, gateway = install_fakes(monkeypatch, key, [{"schemaVersion": "1.0", "deviceKeyMatches": True}])

    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "preflight") == 0
    assert store.loaded == 1
    assert gateway.requests == [(OWNER_PHONE_ENROLLMENT_PATH, {"schemaVersion": "1.0", "operation": "preflight"})]
    output = capsys.readouterr().out
    assert output.strip() == "device key matches the active production record"
    for private_value in (*CONFIG.values(), key.public_key().public_bytes_raw().hex()):
        assert private_value not in output


def test_key_mismatch_is_fixed_non_disclosing_output(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    install_fakes(monkeypatch, key, [CloudAuthError("private device:home fingerprint deadbeef")])

    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "preflight") == 1
    output = capsys.readouterr().out
    assert output.strip() == "device key does not match the active production record"
    assert "device:home" not in output
    assert "deadbeef" not in output


def test_begin_stops_at_key_mismatch_before_prompting_for_or_sending_the_phone(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    _, gateway = install_fakes(monkeypatch, key, [CloudAuthError("private key detail")])
    monkeypatch.setattr("jarvis_local.phone_enrollment._interactive_terminal", lambda: True)
    prompt = lambda _message: pytest.fail("prompted before key match")  # noqa: E731
    monkeypatch.setattr("jarvis_local.phone_enrollment.getpass.getpass", prompt)

    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "begin") == 1
    assert gateway.requests == [
        (OWNER_PHONE_ENROLLMENT_PATH, {"schemaVersion": "1.0", "operation": "preflight"}),
    ]
    assert capsys.readouterr().out.strip() == "device key does not match the active production record"


def test_missing_key_never_creates_one_or_discloses_its_path(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    store = FakeStore(FileNotFoundError(CONFIG["JARVIS_DEVICE_KEY_PATH"]))
    monkeypatch.setattr("jarvis_local.phone_enrollment._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.phone_enrollment.platform_device_key_store", lambda _path: store)

    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "preflight") == 1
    output = capsys.readouterr().out
    assert output.strip() == "configured device key is missing or unreadable"
    assert CONFIG["JARVIS_DEVICE_KEY_PATH"] not in output
    assert store.loaded == 1


def test_begin_hides_input_masks_confirmation_and_sends_only_after_yes(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    _, gateway = install_fakes(monkeypatch, key, [
        {"schemaVersion": "1.0", "deviceKeyMatches": True},
        {
        "schemaVersion": "1.0",
        "deviceKeyMatches": True,
        "enrollmentState": "pending",
        "challengeId": "challenge:opaque",
        "response": "482913",
        "expiresAt": "2026-09-14T14:05:00.000Z",
        },
    ])
    monkeypatch.setattr("jarvis_local.phone_enrollment._interactive_terminal", lambda: True)
    hidden_entries = iter([PHONE, PHONE])
    monkeypatch.setattr("jarvis_local.phone_enrollment.getpass.getpass", lambda _prompt: next(hidden_entries))
    prompts: list[str] = []
    monkeypatch.setattr("builtins.input", lambda prompt: prompts.append(prompt) or "yes")

    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "begin") == 0
    assert gateway.requests[0] == (
        OWNER_PHONE_ENROLLMENT_PATH, {"schemaVersion": "1.0", "operation": "preflight"},
    )
    begin_path, begin_body = gateway.requests[1]
    assert begin_path == OWNER_PHONE_ENROLLMENT_PATH
    assert set(begin_body) == {"schemaVersion", "operation", "phoneNumber", "requestSalt"}
    assert begin_body["schemaVersion"] == "1.0"
    assert begin_body["operation"] == "begin"
    assert begin_body["phoneNumber"] == PHONE
    salt = begin_body["requestSalt"]
    assert isinstance(salt, str)
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", salt)
    assert len(base64.urlsafe_b64decode(f"{salt}=")) == 32
    output = capsys.readouterr().out
    assert PHONE not in output
    assert prompts == ["Enroll phone ending 0123? Type yes to continue: "]
    assert "482913" in output
    assert "call" in output.lower()


@pytest.mark.parametrize("confirmation", ["", "y", "no"])
def test_declined_confirmation_sends_nothing(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
    confirmation: str,
) -> None:
    _, gateway = install_fakes(monkeypatch, key, [
        {"schemaVersion": "1.0", "deviceKeyMatches": True},
    ])
    monkeypatch.setattr("jarvis_local.phone_enrollment._interactive_terminal", lambda: True)
    monkeypatch.setattr("jarvis_local.phone_enrollment.getpass.getpass", lambda _prompt: PHONE)
    monkeypatch.setattr("builtins.input", lambda _prompt: confirmation)

    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "begin") == 1
    assert gateway.requests == [
        (OWNER_PHONE_ENROLLMENT_PATH, {"schemaVersion": "1.0", "operation": "preflight"}),
    ]
    assert PHONE not in capsys.readouterr().out


def test_mismatched_hidden_phone_entries_never_send_begin(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    _, gateway = install_fakes(monkeypatch, key, [
        {"schemaVersion": "1.0", "deviceKeyMatches": True},
    ])
    monkeypatch.setattr("jarvis_local.phone_enrollment._interactive_terminal", lambda: True)
    hidden_entries = iter([PHONE, "+14165550999"])
    monkeypatch.setattr("jarvis_local.phone_enrollment.getpass.getpass", lambda _prompt: next(hidden_entries))
    monkeypatch.setattr("builtins.input", lambda _prompt: "yes")

    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "begin") == 2
    assert gateway.requests == [
        (OWNER_PHONE_ENROLLMENT_PATH, {"schemaVersion": "1.0", "operation": "preflight"}),
    ]
    assert capsys.readouterr().out.strip() == "phone entries do not match"


def test_invalid_phone_stops_after_preflight_without_sending_it(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    _, gateway = install_fakes(monkeypatch, key, [
        {"schemaVersion": "1.0", "deviceKeyMatches": True},
    ])
    monkeypatch.setattr("jarvis_local.phone_enrollment._interactive_terminal", lambda: True)
    monkeypatch.setattr("jarvis_local.phone_enrollment.getpass.getpass", lambda _prompt: "14165550123")

    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "begin") == 2
    assert gateway.requests == [
        (OWNER_PHONE_ENROLLMENT_PATH, {"schemaVersion": "1.0", "operation": "preflight"}),
    ]
    assert capsys.readouterr().out.strip() == "phone number must use E.164 form"


@pytest.mark.parametrize(
    ("state", "expected_code"),
    [("absent", 1), ("pending", 0), ("expired", 1), ("active", 0), ("conflict", 1)],
)
def test_status_reports_only_the_fixed_public_state(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
    state: str,
    expected_code: int,
) -> None:
    install_fakes(monkeypatch, key, [{
        "schemaVersion": "1.0", "deviceKeyMatches": True, "enrollmentState": state,
    }])
    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "status") == expected_code
    assert capsys.readouterr().out.strip() == f"owner phone enrollment is {state}"


def test_conflicting_begin_is_safely_refused_without_echoing_the_number(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    install_fakes(monkeypatch, key, [
        {"schemaVersion": "1.0", "deviceKeyMatches": True},
        {
        "schemaVersion": "1.0", "deviceKeyMatches": True, "enrollmentState": "conflict",
        },
    ])
    monkeypatch.setattr("jarvis_local.phone_enrollment._interactive_terminal", lambda: True)
    monkeypatch.setattr("jarvis_local.phone_enrollment.getpass.getpass", lambda _prompt: PHONE)
    monkeypatch.setattr("builtins.input", lambda _prompt: "yes")

    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "begin") == 1
    output = capsys.readouterr().out
    assert output.strip().endswith("conflict")
    assert PHONE not in output


def test_malformed_gateway_response_is_refused_without_echoing_fields(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    install_fakes(monkeypatch, key, [{
        "schemaVersion": "1.0", "deviceKeyMatches": True, "enrollmentState": "active", "phoneNumber": PHONE,
    }])
    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "status") == 4
    output = capsys.readouterr().out
    assert output.strip() == "owner phone enrollment status is unavailable"
    assert PHONE not in output


def test_begin_refuses_non_windows_and_noninteractive_runs_before_loading_a_key(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr("jarvis_local.phone_enrollment._is_windows", lambda: False)
    monkeypatch.setattr(
        "jarvis_local.phone_enrollment.platform_device_key_store",
        lambda _path: pytest.fail("loaded key off Windows"),
    )
    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "begin") == 2
    assert "Windows 11" in capsys.readouterr().out

    monkeypatch.setattr("jarvis_local.phone_enrollment._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.phone_enrollment._interactive_terminal", lambda: False)
    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "begin") == 2
    assert "interactive" in capsys.readouterr().out


def test_begin_refuses_when_only_stdin_is_a_terminal_before_loading_a_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Terminal(io.StringIO):
        def __init__(self, interactive: bool) -> None:
            super().__init__()
            self._interactive = interactive

        def isatty(self) -> bool:
            return self._interactive

    output = Terminal(False)
    monkeypatch.setattr("jarvis_local.phone_enrollment._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.phone_enrollment.sys.stdin", Terminal(True))
    monkeypatch.setattr("jarvis_local.phone_enrollment.sys.stdout", output)
    monkeypatch.setattr(
        "jarvis_local.phone_enrollment.platform_device_key_store",
        lambda _path: pytest.fail("loaded key without an interactive output terminal"),
    )

    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "begin") == 2
    assert output.getvalue().strip() == "owner phone enrollment requires an interactive terminal"


def test_begin_refuses_when_stdin_is_not_a_terminal_before_loading_a_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Terminal(io.StringIO):
        def __init__(self, interactive: bool) -> None:
            super().__init__()
            self._interactive = interactive

        def isatty(self) -> bool:
            return self._interactive

    output = Terminal(True)
    monkeypatch.setattr("jarvis_local.phone_enrollment._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.phone_enrollment.sys.stdin", Terminal(False))
    monkeypatch.setattr("jarvis_local.phone_enrollment.sys.stdout", output)
    monkeypatch.setattr(
        "jarvis_local.phone_enrollment.platform_device_key_store",
        lambda _path: pytest.fail("loaded key without an interactive input terminal"),
    )

    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "begin") == 2
    assert output.getvalue().strip() == "owner phone enrollment requires an interactive terminal"


def test_missing_local_configuration_has_a_distinct_non_disclosing_message(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr("jarvis_local.phone_enrollment._is_windows", lambda: True)
    incomplete = {**CONFIG, "JARVIS_CLOUD_BASE_URL": ""}

    assert run_phone_enrollment(JarvisLocalConfig.load(incomplete), "preflight") == 2
    assert capsys.readouterr().out.strip() == "owner phone enrollment configuration is incomplete"


def test_expired_signed_request_has_a_distinct_clock_message(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    install_fakes(monkeypatch, key, [CloudRequestExpiredError("signed_request_expired")])

    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "preflight") == 2
    assert capsys.readouterr().out.strip() == "device clock is outside the gateway freshness window"


def test_begin_connection_reset_returns_fixed_unavailable_output(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    key: Ed25519PrivateKey,
) -> None:
    install_fakes(monkeypatch, key, [
        {"schemaVersion": "1.0", "deviceKeyMatches": True},
        CloudSyncError("private connection detail"),
    ])
    monkeypatch.setattr("jarvis_local.phone_enrollment._interactive_terminal", lambda: True)
    entries = iter([PHONE, PHONE])
    monkeypatch.setattr("jarvis_local.phone_enrollment.getpass.getpass", lambda _prompt: next(entries))
    monkeypatch.setattr("builtins.input", lambda _prompt: "yes")

    assert run_phone_enrollment(JarvisLocalConfig.load(CONFIG), "begin") == 4
    output = capsys.readouterr().out
    assert output.strip() == "owner phone enrollment request is unavailable"
    assert "private connection detail" not in output


def test_main_routes_enroll_phone_without_requiring_node_store_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[tuple[dict[str, str], str]] = []
    monkeypatch.setattr(
        "jarvis_local.cli.run_phone_enrollment",
        lambda config, operation: captured.append((dict(config.environment), operation)) or 0,
    )
    monkeypatch.setattr("jarvis_local.cli.JarvisLocalConfig.from_environment", lambda: JarvisLocalConfig.load(CONFIG))

    assert main(["enroll-phone", "--preflight"]) == 0
    assert captured == [(CONFIG, "preflight")]


class WireOpener:
    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.requests: list[Any] = []

    def __call__(self, request: Any, timeout: float | None = None) -> Any:
        self.requests.append(request)
        stream = io.BytesIO(json.dumps(self.response).encode("utf-8"))
        stream.__enter__ = lambda: stream  # type: ignore[method-assign]
        stream.__exit__ = lambda *_: None  # type: ignore[method-assign]
        return stream


def test_client_uses_the_exact_signed_path_and_canonical_operation(key: Ed25519PrivateKey) -> None:
    opener = WireOpener({"schemaVersion": "1.0", "deviceKeyMatches": True})
    transport = HttpCloudClient(
        base_url="https://gateway.example",
        device_id="device:home",
        principal_id="principal:owner",
        audience="jarvis-local-agent",
        key=key,
        opener=opener,
    )
    client = OwnerPhoneEnrollmentClient(transport)
    assert client.preflight() is True
    sent = opener.requests[0]
    assert sent.full_url == f"https://gateway.example{OWNER_PHONE_ENROLLMENT_PATH}"
    assert json.loads(sent.data) == {"operation": "preflight", "schemaVersion": "1.0"}
    envelope = json.loads(sent.headers["X-jarvis-signed-request"])
    assert envelope["deviceId"] == "device:home"


def test_client_salts_the_begin_body_before_signing(key: Ed25519PrivateKey) -> None:
    opener = WireOpener({
        "schemaVersion": "1.0",
        "deviceKeyMatches": True,
        "enrollmentState": "pending",
        "challengeId": "challenge:opaque",
        "response": "482913",
        "expiresAt": "2026-09-14T14:05:00.000Z",
    })
    transport = HttpCloudClient(
        base_url="https://gateway.example",
        device_id="device:home",
        principal_id="principal:owner",
        audience="jarvis-local-agent",
        key=key,
        opener=opener,
    )

    OwnerPhoneEnrollmentClient(transport).begin(PHONE)

    body = json.loads(opener.requests[0].data)
    assert set(body) == {"operation", "phoneNumber", "requestSalt", "schemaVersion"}
    assert body["phoneNumber"] == PHONE
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", body["requestSalt"])
    assert len(base64.urlsafe_b64decode(f"{body['requestSalt']}=")) == 32


def test_client_uses_a_fresh_salt_for_each_begin(key: Ed25519PrivateKey) -> None:
    opener = WireOpener({
        "schemaVersion": "1.0",
        "deviceKeyMatches": True,
        "enrollmentState": "pending",
        "challengeId": "challenge:opaque",
        "response": "482913",
        "expiresAt": "2026-09-14T14:05:00.000Z",
    })
    transport = HttpCloudClient(
        base_url="https://gateway.example",
        device_id="device:home",
        principal_id="principal:owner",
        audience="jarvis-local-agent",
        key=key,
        opener=opener,
    )
    client = OwnerPhoneEnrollmentClient(transport)

    client.begin(PHONE)
    client.begin(PHONE)

    first = json.loads(opener.requests[0].data)["requestSalt"]
    second = json.loads(opener.requests[1].data)["requestSalt"]
    assert first != second


def test_client_preserves_authentication_failure_for_non_disclosing_mapping(key: Ed25519PrivateKey) -> None:
    error = urllib.error.HTTPError("https://gateway.example", 401, "no", {}, None)  # type: ignore[arg-type]
    transport = HttpCloudClient(
        base_url="https://gateway.example",
        device_id="device:home",
        principal_id="principal:owner",
        audience="jarvis-local-agent",
        key=key,
        opener=lambda *_args, **_kwargs: (_ for _ in ()).throw(error),
    )
    with pytest.raises(CloudAuthError):
        OwnerPhoneEnrollmentClient(transport).preflight()


def test_client_classifies_only_the_fixed_expired_request_response_as_clock_skew(
    key: Ed25519PrivateKey,
) -> None:
    error = urllib.error.HTTPError(
        "https://gateway.example",
        401,
        "no",
        {},
        io.BytesIO(b'{"error":"signed_request_expired"}'),
    )
    transport = HttpCloudClient(
        base_url="https://gateway.example",
        device_id="device:home",
        principal_id="principal:owner",
        audience="jarvis-local-agent",
        key=key,
        opener=lambda *_args, **_kwargs: (_ for _ in ()).throw(error),
    )

    with pytest.raises(CloudRequestExpiredError):
        OwnerPhoneEnrollmentClient(transport).preflight()


def test_client_wraps_a_connection_reset_while_reading_the_response(
    key: Ed25519PrivateKey,
) -> None:
    class BrokenStream(io.BytesIO):
        def read(self, *_args: object) -> bytes:  # type: ignore[override]
            raise ConnectionResetError("private transport detail")

    transport = HttpCloudClient(
        base_url="https://gateway.example",
        device_id="device:home",
        principal_id="principal:owner",
        audience="jarvis-local-agent",
        key=key,
        opener=lambda *_args, **_kwargs: BrokenStream(),
    )

    with pytest.raises(CloudSyncError, match="gateway unreachable or unusable"):
        OwnerPhoneEnrollmentClient(transport).preflight()


def test_client_wraps_an_incomplete_response_without_a_traceback(
    key: Ed25519PrivateKey,
) -> None:
    class BrokenStream(io.BytesIO):
        def read(self, *_args: object) -> bytes:  # type: ignore[override]
            raise http.client.IncompleteRead(b'{"schemaVersion"', 64)

    transport = HttpCloudClient(
        base_url="https://gateway.example",
        device_id="device:home",
        principal_id="principal:owner",
        audience="jarvis-local-agent",
        key=key,
        opener=lambda *_args, **_kwargs: BrokenStream(),
    )

    with pytest.raises(CloudSyncError, match="gateway unreachable or unusable"):
        OwnerPhoneEnrollmentClient(transport).preflight()


def test_client_wraps_a_non_utf8_response_without_a_traceback(
    key: Ed25519PrivateKey,
) -> None:
    transport = HttpCloudClient(
        base_url="https://gateway.example",
        device_id="device:home",
        principal_id="principal:owner",
        audience="jarvis-local-agent",
        key=key,
        opener=lambda *_args, **_kwargs: io.BytesIO(b"\xff"),
    )

    with pytest.raises(CloudSyncError, match="gateway unreachable or unusable"):
        OwnerPhoneEnrollmentClient(transport).preflight()
