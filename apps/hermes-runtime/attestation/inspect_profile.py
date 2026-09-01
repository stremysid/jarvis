#!/usr/bin/env python3
"""Derive a secret-free HermesRuntimeAttestationV1 from a protected runtime tree."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import http.client
import json
import re
import socket
import stat
import sys
from email.parser import BytesParser
from pathlib import Path
from typing import Any

HASH = re.compile(r"^[a-f0-9]{64}$")
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")
SAFE_VERSION = re.compile(r"^[A-Za-z0-9.+_-]+$")
FORBIDDEN = re.compile(
    r"(?:secret|protected|token|password|credential|api[_-]?key|authorization|bearer|host|user[_-]?sid|principal|identity)",
    re.I,
)
ALLOWED_KEYS = {"contextTokens", "credentialMode", "host", "maxOutputTokens", "serviceHost"}
ALLOWED_VALUES = {"nonsecret-test-token", "protected-environment"}
EMPTY_TOOLS_HASH = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
REMOTE_CATALOG_HASH = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
MODELS_DEV_HASH = "0ad75b8d2d416f1a1015ef33b2d3f7da25221314c911bc49e95556ddaa1e02b4"


class FixedParser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        raise ValueError("invalid arguments")


def fail() -> None:
    raise ValueError("invalid attestation")


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_value(value: Any) -> str:
    return sha256(canonical_bytes(value))


def load_canonical(path: Path) -> tuple[Any, bytes]:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf") or not raw.endswith(b"\n") or b"\r" in raw or b"\n" in raw[:-1]:
        fail()
    try:
        value = json.loads(raw[:-1].decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail()
    if raw != canonical_bytes(value) + b"\n":
        fail()
    return value, raw


def exact_keys(value: Any, expected: set[str]) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        fail()


def contained(root: Path, *parts: str) -> Path:
    candidate = root.joinpath(*parts)
    try:
        candidate.resolve(strict=False).relative_to(root.resolve(strict=True))
    except (OSError, ValueError):
        fail()
    return candidate


def is_reparse(path: Path) -> bool:
    try:
        return path.is_symlink() or bool(getattr(path.stat(follow_symlinks=False), "st_file_attributes", 0) & 0x400)
    except OSError:
        fail()
    return False


def require_regular(path: Path, readonly: bool = True) -> bytes:
    if not path.is_file() or is_reparse(path):
        fail()
    mode = path.stat().st_mode
    if readonly and mode & stat.S_IWRITE:
        fail()
    return path.read_bytes()


def tree_hash(path: Path) -> str:
    if is_reparse(path):
        fail()
    if path.is_file():
        return sha256(require_regular(path))
    if not path.is_dir():
        fail()
    entries: list[dict[str, Any]] = []
    for child in sorted(path.rglob("*"), key=lambda item: item.relative_to(path).as_posix()):
        if is_reparse(child):
            fail()
        if child.is_file():
            entries.append({"path": child.relative_to(path).as_posix(), "sha256": sha256(require_regular(child))})
        elif not child.is_dir():
            fail()
    return hash_value(entries)


def require_safe(value: Any, path: tuple[str, ...] = ()) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str) or (FORBIDDEN.search(key) and key not in ALLOWED_KEYS):
                fail()
            require_safe(child, (*path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            require_safe(child, (*path, str(index)))
    elif isinstance(value, str):
        if (not path or path[0] != "providerInventory") and value not in ALLOWED_VALUES and FORBIDDEN.search(value):
            fail()
        if re.search(r"^(?:[A-Za-z]:|[/\\]{2})", value) or re.search(r"S-1-5-", value, re.I):
            fail()


def socket_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def verify_compatibility_listener(contract: dict[str, Any]) -> None:
    connection = http.client.HTTPConnection("127.0.0.1", 8792, timeout=1.0)
    try:
        connection.request(
            "GET",
            contract["readiness"]["route"],
            headers={"Authorization": f"Bearer {contract['authorization']['fixedPublicValue']}"},
        )
        response = connection.getresponse()
        body = response.read()
        if response.status != contract["readiness"]["status"]:
            fail()
        if response.getheader("content-type") != contract["readiness"]["contentType"]:
            fail()
        if body != contract["readiness"]["utf8"].encode("utf-8"):
            fail()
    except (OSError, http.client.HTTPException):
        fail()
    finally:
        connection.close()


def parse_metadata(path: Path) -> tuple[str, str]:
    try:
        message = BytesParser().parsebytes(require_regular(path))
    except Exception:
        fail()
    name, version = message.get("Name"), message.get("Version")
    if not isinstance(name, str) or not isinstance(version, str) or not SAFE_NAME.fullmatch(name) or not SAFE_VERSION.fullmatch(version):
        fail()
    if FORBIDDEN.search(name) or FORBIDDEN.search(version):
        fail()
    return name, version


def parse_distributions(site_packages: Path, sbom: dict[str, Any]) -> tuple[list[dict[str, str]], str, str]:
    if not site_packages.is_dir() or is_reparse(site_packages):
        fail()
    distributions: list[dict[str, str]] = []
    aggregates: list[dict[str, Any]] = []
    covered: set[str] = set()
    dist_infos = sorted(site_packages.glob("*.dist-info"), key=lambda path: path.name.casefold())
    if not dist_infos:
        fail()
    for dist_info in dist_infos:
        if is_reparse(dist_info):
            fail()
        name, version = parse_metadata(dist_info / "METADATA")
        record_path = dist_info / "RECORD"
        record_bytes = require_regular(record_path)
        record_hash = sha256(record_bytes)
        verified: list[dict[str, Any]] = []
        try:
            rows = list(csv.reader(record_bytes.decode("utf-8", errors="strict").splitlines()))
        except (UnicodeDecodeError, csv.Error):
            fail()
        if not rows:
            fail()
        for row in rows:
            if len(row) != 3 or not row[0] or "\\" in row[0]:
                fail()
            relative = Path(row[0])
            if relative.is_absolute() or ".." in relative.parts:
                fail()
            target = contained(site_packages, *relative.parts)
            normalized = relative.as_posix()
            if normalized in covered:
                fail()
            covered.add(normalized)
            if normalized == record_path.relative_to(site_packages).as_posix():
                if row[1] or row[2]:
                    fail()
                verified.append({"path": normalized, "sha256": record_hash, "size": len(record_bytes)})
                continue
            data = require_regular(target)
            try:
                size = int(row[2])
            except ValueError:
                fail()
            if size != len(data) or not row[1].startswith("sha256="):
                fail()
            expected = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode("ascii")
            if row[1] != f"sha256={expected}":
                fail()
            verified.append({"path": normalized, "sha256": sha256(data), "size": size})
        distributions.append({"name": name, "recordHash": record_hash, "version": version})
        aggregates.append({"distribution": name, "files": sorted(verified, key=lambda item: item["path"]), "recordHash": record_hash})
    actual_files = {
        path.relative_to(site_packages).as_posix()
        for path in site_packages.rglob("*")
        if path.is_file()
    }
    if actual_files != covered:
        fail()
    distributions.sort(key=lambda item: (item["name"].casefold(), item["version"]))
    aggregates.sort(key=lambda item: item["distribution"].casefold())
    expected = {(sbom["metadata"]["component"]["name"], sbom["metadata"]["component"]["version"])}
    expected.update((component["name"], component["version"]) for component in sbom["components"])
    if {(item["name"], item["version"]) for item in distributions} != expected:
        fail()
    return distributions, hash_value(distributions), hash_value(aggregates)


def derive(runtime_root: Path, mode: str, trusted_root: Path) -> dict[str, Any]:
    if mode not in {"live", "pinned_runtime"} or not runtime_root.is_absolute() or not runtime_root.is_dir() or is_reparse(runtime_root):
        fail()
    trusted_lock, _ = load_canonical(trusted_root / "hermes-profile-lock.json")
    trusted_source, _ = load_canonical(trusted_root / "hermes-source-lock.json")
    trusted_artifacts, _ = load_canonical(trusted_root / "runtime-artifacts-lock.json")
    runtime_lock, _ = load_canonical(contained(runtime_root, "locks", "hermes-profile-lock.json"))
    runtime_source, _ = load_canonical(contained(runtime_root, "locks", "hermes-source-lock.json"))
    runtime_artifacts, _ = load_canonical(contained(runtime_root, "locks", "runtime-artifacts-lock.json"))
    if (runtime_lock, runtime_source, runtime_artifacts) != (trusted_lock, trusted_source, trusted_artifacts):
        fail()
    for name in ("hermes-profile-lock.json", "hermes-source-lock.json", "runtime-artifacts-lock.json"):
        require_regular(contained(runtime_root, "locks", name))

    exact_keys(trusted_lock, {"compatibilityStub", "profiles", "schemaVersion", "sourceLockHash"})
    if len(trusted_lock["profiles"]) != 1:
        fail()
    profile = trusted_lock["profiles"][0]
    route = profile["runtimeModes"][mode]
    profile_root = contained(runtime_root, "profiles", profile["id"])
    home = contained(profile_root, "home")
    mode_record, _ = load_canonical(contained(profile_root, "mode.json"))
    if mode_record != {"configurationHash": route["configurationHash"], "mode": mode}:
        fail()
    require_regular(contained(profile_root, "mode.json"))

    for file_name, repository_name in (("config.yaml", "config.yaml"), ("config.compatibility.yaml", "config.compatibility.yaml")):
        actual, _ = load_canonical(contained(home, file_name))
        trusted, _ = load_canonical(trusted_root / "profiles" / profile["id"] / repository_name)
        if actual != trusted:
            fail()
        require_regular(contained(home, file_name))
    config_name = Path(route["configurationFile"]).name
    config, _ = load_canonical(contained(home, config_name))
    if hash_value(config) != route["managedConfigHash"]:
        fail()
    envelope = {
        "baseUrl": config["model"].get("base_url"),
        "compatibilityContractHash": trusted_lock["compatibilityStub"]["contractHash"] if mode == "pinned_runtime" else None,
        "credentialMode": config["runtime"].get("compatibilityCredentialMode", "protected-environment"),
        "managedConfigHash": hash_value(config),
        "model": config["model"]["default"],
        "provider": config["model"]["provider"],
    }
    if envelope != route["configurationEnvelope"] or hash_value(envelope) != route["configurationHash"]:
        fail()
    if config["catalog_policy"] != {"alternate_cache": "deny", "background_refresh": False, "etag": "deny", "network": "deny", "refresh": "deny"}:
        fail()

    remote_bytes = require_regular(contained(home, "cache", "model_catalog.json"))
    models_dev_bytes = require_regular(contained(home, "models_dev_cache.json"))
    if sha256(remote_bytes) != REMOTE_CATALOG_HASH or sha256(models_dev_bytes) != MODELS_DEV_HASH:
        fail()
    catalog_activity, _ = load_canonical(contained(home, "runtime", "catalog-activity.json"))
    if catalog_activity != {"backgroundRefresh": False, "networkRequests": 0}:
        fail()
    require_regular(contained(home, "runtime", "catalog-activity.json"))
    forbidden_catalogs = []
    for path in home.rglob("*"):
        relative = path.relative_to(home).as_posix()
        lowered = path.name.lower()
        if ".etag" in lowered or ("model_catalog" in lowered and relative != "cache/model_catalog.json") or ("models_dev" in lowered and relative != "models_dev_cache.json"):
            forbidden_catalogs.append(relative)
    if forbidden_catalogs:
        fail()

    provider_root = contained(home, "providers")
    if not provider_root.is_dir() or is_reparse(provider_root):
        fail()
    provider_entries = sorted(provider_root.iterdir(), key=lambda path: path.name)
    if any(not path.is_file() or is_reparse(path) or path.suffix != ".provider" for path in provider_entries):
        fail()
    providers = sorted(path.stem for path in provider_entries)
    if providers != sorted(profile["providerInventory"]):
        fail()
    for provider in providers:
        if require_regular(provider_root / f"{provider}.provider") != f"{provider}\n".encode("utf-8"):
            fail()
    plugin_root = contained(home, "plugins")
    if not plugin_root.is_dir() or any(plugin_root.iterdir()):
        fail()
    effective_tools, _ = load_canonical(contained(home, "runtime", "effective-tools.json"))
    if effective_tools != [] or hash_value(effective_tools) != EMPTY_TOOLS_HASH:
        fail()
    require_regular(contained(home, "runtime", "effective-tools.json"))

    for writable in profile["writablePaths"]:
        path = contained(home, *writable.split("/"))
        if not path.is_dir() or not path.stat().st_mode & stat.S_IWRITE:
            fail()
    immutable_artifacts = []
    for relative in profile["immutablePaths"]:
        path = contained(home, *relative.split("/"))
        immutable_artifacts.append({"path": relative, "sha256": tree_hash(path), "writable": False})

    contract_bytes = require_regular(contained(runtime_root, "contracts", "hermes-runs-api-v2026.8.27.json"))
    if sha256(contract_bytes) != trusted_source["runsEventContractFileSha256"]:
        fail()
    sbom, sbom_bytes = load_canonical(contained(runtime_root, "sbom", "hermes-agent.cdx.json"))
    require_regular(contained(runtime_root, "sbom", "hermes-agent.cdx.json"))
    if sha256(sbom_bytes) != trusted_source["sbomFileSha256"] or hash_value(sbom) != trusted_source["sbomSha256"]:
        fail()

    launcher_parent = contained(runtime_root, "service-host", "launchers")
    bundles = [path for path in launcher_parent.iterdir() if path.is_dir() and path.name.startswith("sha256-")]
    if len(bundles) != 1 or is_reparse(bundles[0]):
        fail()
    bundle = bundles[0]
    manifest, _ = load_canonical(bundle / "manifest.json")
    if bundle.name != f"sha256-{hash_value(manifest)}" or manifest.get("schemaVersion") != "1":
        fail()
    expected_launchers = ["brain_bridge.py", "hermes_voice_safe.py", "openai_compatibility_stub.py"]
    if [item.get("path") for item in manifest.get("files", [])] != expected_launchers:
        fail()
    for item in manifest["files"]:
        data = require_regular(bundle / item["path"])
        if sha256(data) != item["sha256"]:
            fail()
    source_hash = sha256(require_regular(bundle / "openai_compatibility_stub.py"))
    bundle_hash = bundle.name.removeprefix("sha256-")

    if not socket_open(profile["listener"]["port"]):
        fail()
    compatibility_contract, _ = load_canonical(trusted_root / trusted_lock["compatibilityStub"]["contractPath"])
    if hash_value(compatibility_contract) != trusted_lock["compatibilityStub"]["contractHash"]:
        fail()
    if mode == "live":
        if socket_open(8792):
            fail()
        compatibility_stub = None
    else:
        verify_compatibility_listener(compatibility_contract)
        compatibility_stub = {
            "baseUrl": trusted_lock["compatibilityStub"]["baseUrl"],
            "contractHash": trusted_lock["compatibilityStub"]["contractHash"],
            "credentialMode": "nonsecret-test-token",
            "launcherBundleHash": bundle_hash,
            "processRunning": True,
            "sourceHash": source_hash,
        }

    site_packages = contained(runtime_root, "releases", trusted_source["sourceCommit"], "venvs", profile["id"], "Lib", "site-packages")
    distributions, distributions_hash, record_hash = parse_distributions(site_packages, sbom)
    if sys.version_info[:3] != (3, 11, 16):
        fail()
    if not contained(runtime_root, "toolchain", f"uv-{trusted_artifacts['uv']['version']}", "uv.exe").is_file():
        fail()
    if not contained(runtime_root, "service-host", f"winsw-{trusted_artifacts['winsw']['version']}", "WinSW-x64.exe").is_file():
        fail()

    attestation = {
        "backgroundReviewEnabled": config["auxiliary"]["background_review"]["enabled"],
        "catalog": {"alternateCachePaths": [], "backgroundRefresh": catalog_activity["backgroundRefresh"], "etagPaths": [], "modelCatalogEnabled": config["model_catalog"]["enabled"], "modelsDevCacheHash": sha256(models_dev_bytes), "modelsDevUrl": config["models_dev"]["url"], "networkRequests": catalog_activity["networkRequests"], "remoteCacheHash": sha256(remote_bytes)},
        "compatibilityStub": compatibility_stub,
        "compression": {"activeCheckpointProvider": None, "checkpointRequired": config["compression"]["checkpoint_required"], "enabled": config["compression"]["enabled"]},
        "configurationHash": route["configurationHash"],
        "effectiveTools": effective_tools,
        "effectiveToolsHash": hash_value(effective_tools),
        "environment": sorted(config["environment"]),
        "generalPlugins": config["plugins"]["enabled"],
        "immutableArtifacts": sorted(immutable_artifacts, key=lambda item: item["path"]),
        "installedDistributions": distributions,
        "installedDistributionsHash": distributions_hash,
        "kind": "HermesRuntimeAttestationV1",
        "listener": profile["listener"],
        "managedConfigHash": hash_value(config),
        "mcpServers": list(config["mcp_servers"]),
        "memory": {"memoryEnabled": config["memory"]["memory_enabled"], "userProfileEnabled": config["memory"]["user_profile_enabled"]},
        "messagingGateways": config["messaging_gateways"],
        "mode": mode,
        "modelOverride": {"contextTokens": config["model_overrides"]["deepseek"]["deepseek-v4-pro"]["context_tokens"], "maxOutputTokens": config["model_overrides"]["deepseek"]["deepseek-v4-pro"]["max_output_tokens"], "reasoning": config["model_overrides"]["deepseek"]["deepseek-v4-pro"]["reasoning"], "tools": config["model_overrides"]["deepseek"]["deepseek-v4-pro"]["tools"], "vision": config["model_overrides"]["deepseek"]["deepseek-v4-pro"]["vision"]},
        "process": profile["process"],
        "profileId": profile["id"],
        "profileLockHash": hash_value(trusted_lock),
        "providerInventory": profile["providerInventory"],
        "providerInventoryHash": hash_value(profile["providerInventory"]),
        "providerOverrides": profile["providerOverrides"],
        "recordAggregateHash": record_hash,
        "runsContractHash": trusted_source["runsEventContractHash"],
        "sbomHash": hash_value(sbom),
        "schemaVersion": "1",
        "selectedModel": config["model"]["default"],
        "selectedProvider": config["model"]["provider"],
        "serviceId": profile["serviceId"],
        "sourceCommit": trusted_source["sourceCommit"],
        "sourceLockHash": hash_value(trusted_source),
        "sourceTree": trusted_source["sourceTree"],
        "updaterAvailable": False,
        "versions": {"package": trusted_source["packageVersion"], "python": trusted_source["pythonVersion"], "serviceHost": f"WinSW-{trusted_artifacts['winsw']['version']}", "uv": trusted_artifacts["uv"]["version"]},
        "writablePaths": profile["writablePaths"],
    }
    require_safe(attestation)
    return attestation


def main() -> int:
    parser = FixedParser(add_help=False)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--mode", choices=("live", "pinned_runtime"), required=True)
    parser.add_argument("--expected-attestation", type=Path)
    try:
        args = parser.parse_args()
        trusted_root = Path(__file__).resolve().parents[1]
        attestation = derive(args.runtime_root, args.mode, trusted_root)
        output = canonical_bytes(attestation) + b"\n"
        if args.expected_attestation is not None:
            _expected, expected_bytes = load_canonical(args.expected_attestation)
            if expected_bytes != output:
                fail()
    except Exception:
        sys.stderr.write("Hermes runtime attestation invalid\n")
        return 1
    sys.stdout.buffer.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
