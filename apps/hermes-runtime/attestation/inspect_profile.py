#!/usr/bin/env python3
"""Offline fail-closed validation for HermesRuntimeAttestationV1.

This entrypoint deliberately uses only the Python standard library. The
bootstrap invokes it with the profile interpreter, so it cannot import user,
project, or ambient provider/plugin code while inspecting the runtime record.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

HASH = re.compile(r"^[a-f0-9]{64}$")
GIT = re.compile(r"^[a-f0-9]{40}$")
SECRET_KEY = re.compile(r"(?:api[_-]?key|password|secret|bearer|authorization)", re.I)
ABSOLUTE = re.compile(r"^(?:[A-Za-z]:|[/\\])")


def fail() -> None:
    raise ValueError("invalid attestation")


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def load_canonical(path: Path) -> Any:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf") or not raw.endswith(b"\n") or b"\r" in raw or b"\n" in raw[:-1]:
        fail()
    try:
        value = json.loads(raw[:-1].decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail()
    if raw != canonical_bytes(value) + b"\n":
        fail()
    return value


def exact_keys(value: Any, expected: set[str]) -> None:
    if not isinstance(value, dict) or set(value) != expected or any(SECRET_KEY.search(key) for key in value):
        fail()


def hash_value(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def require_hash(value: Any) -> None:
    if not isinstance(value, str) or HASH.fullmatch(value) is None:
        fail()


def require_relative(path: Any) -> None:
    if not isinstance(path, str) or not path or ABSOLUTE.search(path) or any(part == ".." for part in re.split(r"[/\\]", path)):
        fail()


def validate(attestation: Any, lock: Any, source: Any, artifacts: Any) -> None:
    top = {
        "schemaVersion", "kind", "profileId", "serviceId", "process", "mode", "configurationHash",
        "sourceCommit", "sourceTree", "sourceLockHash", "profileLockHash", "managedConfigHash",
        "runsContractHash", "compatibilityStub", "environment", "selectedProvider", "selectedModel",
        "providerInventory", "providerInventoryHash", "providerOverrides", "modelOverride", "catalog",
        "compression", "generalPlugins", "effectiveTools", "effectiveToolsHash", "mcpServers", "memory",
        "backgroundReviewEnabled", "messagingGateways", "writablePaths", "immutableArtifacts",
        "installedDistributions", "installedDistributionsHash", "recordAggregateHash", "versions", "listener",
        "updaterAvailable", "sbomHash",
    }
    exact_keys(attestation, top)
    if attestation["schemaVersion"] != "1" or attestation["kind"] != "HermesRuntimeAttestationV1": fail()
    if len(lock.get("profiles", [])) != 1: fail()
    profile = lock["profiles"][0]
    mode = attestation["mode"]
    if mode not in {"pinned_runtime", "live"}: fail()
    route = profile["runtimeModes"][mode]
    if (attestation["profileId"], attestation["serviceId"], attestation["process"]) != (profile["id"], profile["serviceId"], profile["process"]): fail()
    if attestation["configurationHash"] != route["configurationHash"] or attestation["managedConfigHash"] != route["configurationHash"]: fail()
    if not GIT.fullmatch(str(attestation["sourceCommit"])) or not GIT.fullmatch(str(attestation["sourceTree"])): fail()
    if attestation["sourceCommit"] != source["sourceCommit"] or attestation["sourceTree"] != source["sourceTree"]: fail()
    if attestation["sourceLockHash"] != lock["sourceLockHash"] or attestation["sourceLockHash"] != hash_value(source): fail()
    if attestation["profileLockHash"] != hash_value(lock) or attestation["runsContractHash"] != source["runsEventContractHash"]: fail()
    if attestation["sbomHash"] != source["sbomSha256"]: fail()
    if (attestation["selectedProvider"], attestation["selectedModel"]) != (route["provider"], route["model"]): fail()
    if attestation["providerInventory"] != profile["providerInventory"] or attestation["providerInventoryHash"] != profile["providerInventoryHash"]: fail()
    if hash_value(attestation["providerInventory"]) != profile["providerInventoryHash"]: fail()
    if attestation["providerOverrides"] != profile["providerOverrides"]: fail()
    if attestation["environment"] != ["HERMES_MANAGED", "HERMES_SAFE_MODE"]: fail()
    if attestation["modelOverride"] != {"contextTokens": 1000000, "maxOutputTokens": 393216, "reasoning": True, "tools": False, "vision": False}: fail()
    if attestation["generalPlugins"] != [] or attestation["effectiveTools"] != [] or attestation["mcpServers"] != [] or attestation["messagingGateways"] != []: fail()
    if attestation["effectiveToolsHash"] != profile["effectiveToolsHash"]: fail()
    if attestation["memory"] != profile["memory"] or attestation["backgroundReviewEnabled"] is not False: fail()
    if attestation["compression"] != profile["compression"]: fail()
    if attestation["listener"] != profile["listener"] or attestation["updaterAvailable"] is not False: fail()
    if attestation["writablePaths"] != profile["writablePaths"]: fail()
    for path in attestation["writablePaths"]: require_relative(path)

    catalog = attestation["catalog"]
    exact_keys(catalog, {"modelCatalogEnabled", "modelsDevUrl", "remoteCacheHash", "modelsDevCacheHash", "etagPaths", "alternateCachePaths", "networkRequests", "backgroundRefresh"})
    expected_catalog = {"modelCatalogEnabled": False, "modelsDevUrl": "jarvis-disabled://models-dev", "remoteCacheHash": profile["catalog"]["remoteCatalog"]["sha256"], "modelsDevCacheHash": profile["catalog"]["modelsDev"]["sha256"], "etagPaths": [], "alternateCachePaths": [], "networkRequests": 0, "backgroundRefresh": False}
    if catalog != expected_catalog: fail()

    stub = attestation["compatibilityStub"]
    if mode == "live":
        if stub is not None or route["baseUrl"] is not None or route["stubProcessRequired"] is not False: fail()
    else:
        exact_keys(stub, {"baseUrl", "contractHash", "sourceHash", "processRunning", "credentialMode"})
        if stub["baseUrl"] != lock["compatibilityStub"]["baseUrl"] or stub["contractHash"] != lock["compatibilityStub"]["contractHash"]: fail()
        require_hash(stub["sourceHash"])
        if stub["processRunning"] is not True or stub["credentialMode"] != "nonsecret-test-token": fail()

    immutable = attestation["immutableArtifacts"]
    if not isinstance(immutable, list) or sorted(item.get("path", "") for item in immutable) != sorted(profile["immutablePaths"]): fail()
    for item in immutable:
        exact_keys(item, {"path", "sha256", "writable"}); require_relative(item["path"]); require_hash(item["sha256"])
        if item["writable"] is not False: fail()

    distributions = attestation["installedDistributions"]
    if not isinstance(distributions, list) or not distributions: fail()
    for item in distributions:
        exact_keys(item, {"name", "version", "recordHash"}); require_hash(item["recordHash"])
        if not isinstance(item["name"], str) or not isinstance(item["version"], str) or SECRET_KEY.search(item["version"]): fail()
    require_hash(attestation["installedDistributionsHash"]); require_hash(attestation["recordAggregateHash"])

    versions = attestation["versions"]
    exact_keys(versions, {"python", "uv", "package", "serviceHost"})
    expected_versions = {"python": source["pythonVersion"], "uv": artifacts["uv"]["version"], "package": source["packageVersion"], "serviceHost": f"WinSW-{artifacts['winsw']['version']}"}
    if versions != expected_versions: fail()


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--validate-attestation", type=Path, required=True)
    parser.add_argument("--profile-lock", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    try:
        attestation = load_canonical(args.validate_attestation)
        lock = load_canonical(args.profile_lock)
        source = load_canonical(root / "hermes-source-lock.json")
        artifacts = load_canonical(root / "runtime-artifacts-lock.json")
        validate(attestation, lock, source, artifacts)
    except Exception:
        sys.stderr.write("Hermes runtime attestation invalid\n")
        return 1
    sys.stdout.buffer.write(canonical_bytes(attestation) + b"\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
