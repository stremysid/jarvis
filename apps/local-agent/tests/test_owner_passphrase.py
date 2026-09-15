from __future__ import annotations

import base64
import io
import json
import re
import urllib.error
from email.message import Message
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from jarvis_local.cli import build_parser, main
from jarvis_local.config import JarvisLocalConfig
from jarvis_local.owner_passphrase import (
    OWNER_PASSPHRASE_PATH,
    GeneratedOwnerPassphrase,
    OwnerPassphraseClient,
    OwnerPassphraseStatus,
    run_owner_passphrase,
)
from jarvis_local.owner_passphrase_policy import (
    canonicalize_owner_passphrase,
    derive_owner_passphrase_digest,
)
from jarvis_local.sync.cloud_client import (
    CloudOwnerPassphraseMismatchError,
    CloudPassphraseStateChangedError,
    HttpCloudClient,
)

CONFIG = {
    "JARVIS_CLOUD_BASE_URL": "https://gateway.example",
    "JARVIS_DEVICE_ID": "device:home",
    "JARVIS_PRINCIPAL_ID": "principal:owner",
    "JARVIS_DEVICE_KEY_PATH": "C:/Jarvis/device.key",
}
VECTORS = Path(__file__).parents[3] / "packages/contracts/fixtures/owner-passphrase-known-answer-v1.json"


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


def test_python_runs_the_shared_canonicalization_and_verifier_known_answers() -> None:
    vectors = json.loads(VECTORS.read_text(encoding="utf-8"))
    allowed = {"ablaze", "abrasion", "abrasive", "active"}
    for vector in vectors["validCanonicalization"]:
        assert canonicalize_owner_passphrase(vector["input"], allowed).decode("ascii") == vector["canonical"]
    for candidate in vectors["invalidCandidates"]:
        with pytest.raises(ValueError, match="owner_passphrase_candidate_invalid"):
            canonicalize_owner_passphrase(candidate, allowed)
    verifier = vectors["verifier"]
    canonical = canonicalize_owner_passphrase(verifier["phrase"], allowed)
    digest = derive_owner_passphrase_digest(
        pepper=base64.b64decode(verifier["pepperBase64"]),
        owner_identity_id=verifier["ownerIdentityId"],
        verifier_version=verifier["verifierVersion"],
        canonical_phrase=canonical,
        salt=base64.b64decode(verifier["saltBase64"]),
    )
    assert base64.b64encode(digest).decode("ascii") == verifier["digestBase64"]


def test_client_reads_status_then_sends_only_expected_version_and_a_fresh_salt() -> None:
    key = Ed25519PrivateKey.generate()
    opener = WireOpener([
        {"schemaVersion": "1.0", "deviceKeyMatches": True, "verifierVersion": 4, "verifierStatus": "active"},
        {
            "schemaVersion": "1.0",
            "deviceKeyMatches": True,
            "verifierVersion": 5,
            "verifierStatus": "active",
            "wordListVersion": "eff-long-cmudict-2026-09-v2",
            "phrase": "ablaze abrasion abrasive",
        },
        {
            "schemaVersion": "1.0",
            "deviceKeyMatches": True,
            "verifierVersion": 5,
            "verifierStatus": "active",
            "wordListVersion": "eff-long-cmudict-2026-09-v2",
            "phrase": "ablaze abrasion abrasive",
        },
    ])
    client = OwnerPassphraseClient(HttpCloudClient(
        base_url="https://gateway.example",
        device_id="device:home",
        principal_id="principal:owner",
        audience="jarvis-local-agent",
        key=key,
        opener=opener,
    ))
    assert client.status() == OwnerPassphraseStatus(4, "active")
    assert client.generate(4) == GeneratedOwnerPassphrase("ablaze abrasion abrasive", 5)
    assert client.generate(4) == GeneratedOwnerPassphrase("ablaze abrasion abrasive", 5)
    assert all(request.full_url == f"https://gateway.example{OWNER_PASSPHRASE_PATH}" for request in opener.requests)
    first = json.loads(opener.requests[1].data)
    second = json.loads(opener.requests[2].data)
    assert set(first) == {"schemaVersion", "operation", "expectedVerifierVersion", "requestSalt"}
    assert first["operation"] == "generate"
    assert first["expectedVerifierVersion"] == 4
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", first["requestSalt"])
    assert first["requestSalt"] != second["requestSalt"]


@pytest.mark.parametrize(
    "response",
    [
        {
            "schemaVersion": "1.0",
            "deviceKeyMatches": True,
            "verifierVersion": 1,
            "verifierStatus": "active",
            "wordListVersion": "unknown",
            "phrase": "ablaze abrasion abrasive",
        },
        {
            "schemaVersion": "1.0",
            "deviceKeyMatches": True,
            "verifierVersion": 2,
            "verifierStatus": "active",
            "wordListVersion": "eff-long-cmudict-2026-09-v2",
            "phrase": "ablaze abrasion abrasive",
        },
        {
            "schemaVersion": "1.0",
            "deviceKeyMatches": True,
            "verifierVersion": 1,
            "verifierStatus": "active",
            "wordListVersion": "eff-long-cmudict-2026-09-v2",
            "phrase": "ablaze abrasion",
        },
    ],
    ids=["metadata", "version", "phrase-shape"],
)
def test_client_rejects_each_generated_response_binding(response: dict[str, Any]) -> None:
    class Transport:
        def post_signed(self, _path: str, _body: Any) -> dict[str, Any]:
            return response

    with pytest.raises(RuntimeError, match="invalid generated owner passphrase"):
        OwnerPassphraseClient(Transport()).generate(None)  # type: ignore[arg-type]


def test_generate_requires_windows_and_both_interactive_terminals_before_loading_a_key(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr("jarvis_local.owner_passphrase._is_windows", lambda: False)
    assert run_owner_passphrase(JarvisLocalConfig.load(CONFIG), "generate") == 2
    assert capsys.readouterr().out.strip() == "owner passphrase generation must run from the enrolled Windows 11 PC"

    class Terminal(io.StringIO):
        def __init__(self, interactive: bool) -> None:
            super().__init__()
            self._interactive = interactive

        def isatty(self) -> bool:
            return self._interactive

    monkeypatch.setattr("jarvis_local.owner_passphrase._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.owner_passphrase.sys.stdin", Terminal(False))
    monkeypatch.setattr("jarvis_local.owner_passphrase.sys.stdout", Terminal(True))
    monkeypatch.setattr(
        "jarvis_local.owner_passphrase.platform_device_key_store",
        lambda _path: pytest.fail("loaded key without an interactive terminal"),
    )
    assert run_owner_passphrase(JarvisLocalConfig.load(CONFIG), "generate") == 2


def test_generate_confirms_rotation_and_displays_the_worker_phrase_once(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class Client:
        def status(self) -> OwnerPassphraseStatus:
            return OwnerPassphraseStatus(7, "active")

        def generate(self, expected: int | None) -> GeneratedOwnerPassphrase:
            assert expected == 7
            return GeneratedOwnerPassphrase("ablaze abrasion abrasive", 8)

    monkeypatch.setattr("jarvis_local.owner_passphrase._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.owner_passphrase._interactive_terminal", lambda: True)
    monkeypatch.setattr("jarvis_local.owner_passphrase._client", lambda _config: Client())
    monkeypatch.setattr("builtins.input", lambda _prompt: "yes")
    assert run_owner_passphrase(JarvisLocalConfig.load(CONFIG), "generate") == 0
    output = capsys.readouterr().out
    assert output.count("ablaze abrasion abrasive") == 1
    assert "Verifier version: 8" in output


def test_generate_requires_exact_confirmation_before_replacing_the_verifier(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class Client:
        def status(self) -> OwnerPassphraseStatus:
            return OwnerPassphraseStatus(7, "active")

        def generate(self, _expected: int | None) -> GeneratedOwnerPassphrase:
            pytest.fail("replacement ran without exact owner confirmation")

    monkeypatch.setattr("jarvis_local.owner_passphrase._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.owner_passphrase._interactive_terminal", lambda: True)
    monkeypatch.setattr("jarvis_local.owner_passphrase._client", lambda _config: Client())
    monkeypatch.setattr("builtins.input", lambda _prompt: "no")
    assert run_owner_passphrase(JarvisLocalConfig.load(CONFIG), "generate") == 1
    assert capsys.readouterr().out.strip() == "owner passphrase generation cancelled"


def test_status_reports_disabled_verifier_as_an_operator_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class Client:
        def status(self) -> OwnerPassphraseStatus:
            return OwnerPassphraseStatus(7, "disabled")

    monkeypatch.setattr("jarvis_local.owner_passphrase._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.owner_passphrase._client", lambda _config: Client())
    assert run_owner_passphrase(JarvisLocalConfig.load(CONFIG), "status") == 1
    assert capsys.readouterr().out.strip() == "owner passphrase is disabled at verifier version 7"


def test_status_never_displays_a_phrase_and_main_routes_nested_commands(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    captured: list[tuple[dict[str, str], str]] = []

    def routed(config: JarvisLocalConfig, operation: str) -> int:
        captured.append((dict(config.environment), operation))
        return 0

    monkeypatch.setattr(
        "jarvis_local.cli.run_owner_passphrase",
        routed,
    )
    monkeypatch.setattr("jarvis_local.cli.JarvisLocalConfig.from_environment", lambda: JarvisLocalConfig.load(CONFIG))
    operation = build_parser().parse_args(["owner-passphrase", "generate"]).owner_passphrase_operation
    assert operation == "generate"
    assert main(["owner-passphrase", "status"]) == 0
    assert captured == [(CONFIG, "status")]
    assert capsys.readouterr().out == ""


def test_exact_conflict_response_maps_to_retryable_operator_guidance() -> None:
    body = io.BytesIO(b'{"error":"owner_passphrase_state_changed"}')
    error = urllib.error.HTTPError("https://gateway.example", 409, "conflict", Message(), body)
    client = HttpCloudClient(
        base_url="https://gateway.example",
        device_id="device:home",
        principal_id="principal:owner",
        audience="jarvis-local-agent",
        key=Ed25519PrivateKey.generate(),
        opener=WireOpener([error]),
    )
    with pytest.raises(CloudPassphraseStateChangedError, match="owner_passphrase_state_changed"):
        client.post_signed(OWNER_PASSPHRASE_PATH, {"schemaVersion": "1.0", "operation": "status"})


def test_exact_owner_mismatch_response_has_distinct_operator_guidance(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    body = io.BytesIO(b'{"error":"owner_passphrase_owner_mismatch"}')
    error = urllib.error.HTTPError("https://gateway.example", 403, "forbidden", Message(), body)
    client = HttpCloudClient(
        base_url="https://gateway.example",
        device_id="device:home",
        principal_id="principal:owner",
        audience="jarvis-local-agent",
        key=Ed25519PrivateKey.generate(),
        opener=WireOpener([error]),
    )
    with pytest.raises(CloudOwnerPassphraseMismatchError, match="owner_passphrase_owner_mismatch"):
        client.post_signed(OWNER_PASSPHRASE_PATH, {"schemaVersion": "1.0", "operation": "status"})

    class Client:
        def status(self) -> OwnerPassphraseStatus:
            raise CloudOwnerPassphraseMismatchError("owner_passphrase_owner_mismatch")

    monkeypatch.setattr("jarvis_local.owner_passphrase._is_windows", lambda: True)
    monkeypatch.setattr("jarvis_local.owner_passphrase._client", lambda _config: Client())
    assert run_owner_passphrase(JarvisLocalConfig.load(CONFIG), "status") == 1
    assert capsys.readouterr().out.strip() == (
        "server owner identity configuration does not match the enrolled device principal"
    )
