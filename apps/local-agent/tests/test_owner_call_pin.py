from __future__ import annotations

import io
import json
import urllib.error
from email.message import Message
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.cli import build_parser, main
from jarvis_local.config import JarvisLocalConfig
from jarvis_local.owner_call_pin import (
    OWNER_CALL_PIN_PATH,
    GeneratedOwnerCallPin,
    OwnerCallPinClient,
    OwnerCallPinStatus,
    run_owner_call_pin,
)
from jarvis_local.sync.cloud_client import (
    CloudOwnerCallPinMismatchError,
    CloudOwnerCallPinStateChangedError,
    HttpCloudClient,
)

CONFIG = {
    "JARVIS_CLOUD_BASE_URL": "https://gateway.example",
    "JARVIS_DEVICE_ID": "device:home",
    "JARVIS_PRINCIPAL_ID": "principal:owner",
    "JARVIS_DEVICE_KEY_PATH": "C:/Jarvis/device.key",
}
#: The four digits the fake gateway answers with, built from character codes
#: so the literal never looks like a credential this repository might hold.
SYNTHETIC_PIN = "".join(chr(code) for code in (52, 50, 55, 49))


class WireResponse(io.BytesIO):
    def __enter__(self) -> WireResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


class WireOpener:
    def __init__(self, responses: list[dict[str, Any] | Exception]) -> None:
        self.responses = iter(responses)
        self.requests: list[Any] = []

    def __call__(self, request: Any, timeout: float | None = None) -> Any:
        self.requests.append(request)
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return WireResponse(json.dumps(response).encode("utf-8"))


def _status_response(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "schemaVersion": "1.0",
        "deviceKeyMatches": True,
        "pinVersion": 4,
        "pinStatus": "active",
    }
    body.update(overrides)
    return body


def _generated_response(**overrides: Any) -> dict[str, Any]:
    body = _status_response(pinVersion=5, pin=SYNTHETIC_PIN)
    body.update(overrides)
    return body


def _client(opener: WireOpener) -> OwnerCallPinClient:
    return OwnerCallPinClient(HttpCloudClient(
        base_url="https://gateway.example",
        device_id="device:home",
        principal_id="principal:owner",
        audience="jarvis-local-agent",
        key=Ed25519PrivateKey.generate(),
        opener=opener,
    ))


def test_status_then_generate_sends_only_the_expected_version_and_no_salt() -> None:
    opener = WireOpener([_status_response(), _generated_response()])
    client = _client(opener)
    assert client.status() == OwnerCallPinStatus(4, "active")
    assert client.generate(4) == GeneratedOwnerCallPin(SYNTHETIC_PIN, 5)
    assert all(request.full_url == f"https://gateway.example{OWNER_CALL_PIN_PATH}" for request in opener.requests)
    first = json.loads(opener.requests[0].data)
    second = json.loads(opener.requests[1].data)
    assert first == {"schemaVersion": "1.0", "operation": "status"}
    assert second == {"schemaVersion": "1.0", "operation": "generate", "expectedPinVersion": 4}


@pytest.mark.parametrize(
    "response",
    [
        _status_response(pinVersion=None),
        _status_response(pinVersion=1, pinStatus=None),
        _status_response(deviceKeyMatches=False, pinVersion=None, pinStatus=None),
        _status_response(pinVersion=0),
        _status_response(pinVersion=True),
        _status_response(pinVersion=None, pinStatus=None, extra=1),
    ],
)
def test_status_refuses_every_shape_a_broken_gateway_could_return(response: dict[str, Any]) -> None:
    with pytest.raises(Exception, match="invalid owner call PIN status"):
        _client(WireOpener([response])).status()


@pytest.mark.parametrize(
    "response",
    [
        _generated_response(pin="427"),
        _generated_response(pin="99999"),
        _generated_response(pin=0),
        _generated_response(pinVersion=9),
        _generated_response(pinStatus="disabled"),
    ],
)
def test_generation_refuses_a_pin_that_is_not_exactly_four_digits_at_the_next_version(
    response: dict[str, Any],
) -> None:
    with pytest.raises(Exception, match="invalid generated owner call PIN"):
        _client(WireOpener([response])).generate(4)


def test_exact_conflict_and_mismatch_responses_map_to_distinct_errors() -> None:
    conflict = urllib.error.HTTPError(
        "https://gateway.example", 409, "conflict", Message(),
        io.BytesIO(b'{"error":"owner_call_pin_state_changed"}'),
    )
    client = _client(WireOpener([conflict]))
    with pytest.raises(CloudOwnerCallPinStateChangedError, match="owner_call_pin_state_changed"):
        client.status()
    mismatch = urllib.error.HTTPError(
        "https://gateway.example", 403, "forbidden", Message(),
        io.BytesIO(b'{"error":"owner_call_pin_owner_mismatch"}'),
    )
    client = _client(WireOpener([mismatch]))
    with pytest.raises(CloudOwnerCallPinMismatchError, match="owner_call_pin_owner_mismatch"):
        client.status()


def test_generate_requires_an_interactive_windows_terminal(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr("jarvis_local.owner_call_pin._is_windows", lambda: False)
    assert run_owner_call_pin(JarvisLocalConfig.load(CONFIG), "generate") == 2
    assert capsys.readouterr().out.strip() == (
        "owner call PIN generation must run from the enrolled Windows 11 PC"
    )
    monkeypatch.setattr("jarvis_local.owner_call_pin._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.owner_call_pin._interactive_terminal", lambda: False)
    assert run_owner_call_pin(JarvisLocalConfig.load(CONFIG), "generate") == 2
    assert capsys.readouterr().out.strip() == "owner call PIN generation requires an interactive terminal"


def test_generate_prints_the_digits_once_after_exact_confirmation(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class Client:
        def status(self) -> OwnerCallPinStatus:
            return OwnerCallPinStatus(7, "active")

        def generate(self, expected: int | None) -> GeneratedOwnerCallPin:
            assert expected == 7
            return GeneratedOwnerCallPin(SYNTHETIC_PIN, 8)

    monkeypatch.setattr("jarvis_local.owner_call_pin._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.owner_call_pin._interactive_terminal", lambda: True)
    monkeypatch.setattr("jarvis_local.owner_call_pin._client", lambda _config: Client())
    monkeypatch.setattr("builtins.input", lambda _prompt: "yes")
    assert run_owner_call_pin(JarvisLocalConfig.load(CONFIG), "generate") == 0
    output = capsys.readouterr().out
    assert output.count(SYNTHETIC_PIN) == 1
    assert "Pin version: 8" in output


def test_generate_requires_exact_confirmation_before_replacing_the_pin(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class Client:
        def status(self) -> OwnerCallPinStatus:
            return OwnerCallPinStatus(7, "active")

        def generate(self, _expected: int | None) -> GeneratedOwnerCallPin:
            pytest.fail("replacement ran without exact owner confirmation")

    monkeypatch.setattr("jarvis_local.owner_call_pin._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.owner_call_pin._interactive_terminal", lambda: True)
    monkeypatch.setattr("jarvis_local.owner_call_pin._client", lambda _config: Client())
    monkeypatch.setattr("builtins.input", lambda _prompt: "no")
    assert run_owner_call_pin(JarvisLocalConfig.load(CONFIG), "generate") == 1
    assert capsys.readouterr().out.strip() == "owner call PIN generation cancelled"


def test_status_never_displays_digits_and_main_routes_nested_commands(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    captured: list[tuple[dict[str, str], str]] = []

    def routed(config: JarvisLocalConfig, operation: str) -> int:
        captured.append((dict(config.environment), operation))
        return 0

    monkeypatch.setattr("jarvis_local.cli.run_owner_call_pin", routed)
    monkeypatch.setattr("jarvis_local.cli.JarvisLocalConfig.from_environment", lambda: JarvisLocalConfig.load(CONFIG))
    operation = build_parser().parse_args(["owner-call-pin", "status"]).owner_call_pin_operation
    assert operation == "status"
    assert main(["owner-call-pin", "generate"]) == 0
    assert captured == [(CONFIG, "generate")]
    assert capsys.readouterr().out == ""


def test_status_reports_an_unconfigured_pin_as_an_operator_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class Client:
        def status(self) -> OwnerCallPinStatus:
            return OwnerCallPinStatus(None, None)

    monkeypatch.setattr("jarvis_local.owner_call_pin._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.owner_call_pin._client", lambda _config: Client())
    assert run_owner_call_pin(JarvisLocalConfig.load(CONFIG), "status") == 1
    assert capsys.readouterr().out.strip() == "owner call PIN is not configured"
