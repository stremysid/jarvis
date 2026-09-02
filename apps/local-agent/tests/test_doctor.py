"""Diagnostics must name what is missing without ever revealing a value.

The foundation design fixes the exit codes: 0 ready, 2 missing credentials,
3 invalid configuration, 4 failed dependency checks. It also requires that
`jarvis doctor` "names missing variable identifiers without printing values
or derived fingerprints" -- so a hash or prefix of a value is as much a leak
as the value itself.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from jarvis_local.config import REQUIRED_CONFIG, JarvisLocalConfig
from jarvis_local.doctor import DoctorReport, run_doctor


def complete_environment(tmp_path: Path) -> dict[str, str]:
    return {
        "JARVIS_CLOUD_BASE_URL": "https://jarvis.example",
        "JARVIS_DEVICE_ID": "device_01j0000000000000000000000",
        "JARVIS_PRINCIPAL_ID": "principal_01j0000000000000000000000",
        "JARVIS_DEVICE_KEY_PATH": str(tmp_path / "device.key"),
        "JARVIS_ARCHIVE_PATH": str(tmp_path / "archive.sqlite3"),
        "JARVIS_MEMORY_PATH": str(tmp_path / "memory.sqlite3"),
    }


def test_doctor_reports_only_missing_identifiers_and_exit_two(tmp_path: Path) -> None:
    environment = complete_environment(tmp_path)
    del environment["JARVIS_CLOUD_BASE_URL"]
    report = run_doctor(JarvisLocalConfig.load(environment))
    assert report.exit_code == 2
    assert report.lines == ("missing: JARVIS_CLOUD_BASE_URL",)


def test_doctor_lists_every_missing_name_in_declaration_order(tmp_path: Path) -> None:
    report = run_doctor(JarvisLocalConfig.load({}))
    assert report.exit_code == 2
    assert report.lines == tuple(f"missing: {name}" for name in REQUIRED_CONFIG)


def test_doctor_treats_blank_and_whitespace_as_missing(tmp_path: Path) -> None:
    environment = complete_environment(tmp_path)
    environment["JARVIS_DEVICE_ID"] = "   "
    report = run_doctor(JarvisLocalConfig.load(environment))
    assert report.exit_code == 2
    assert report.lines == ("missing: JARVIS_DEVICE_ID",)


def test_doctor_reports_ready_when_configuration_is_complete(tmp_path: Path) -> None:
    report = run_doctor(JarvisLocalConfig.load(complete_environment(tmp_path)))
    assert report.exit_code == 0
    assert report.lines == ("ready",)


@pytest.mark.parametrize(
    "name,value",
    [
        ("JARVIS_CLOUD_BASE_URL", "http://jarvis.example"),  # plaintext transport
        ("JARVIS_CLOUD_BASE_URL", "https://jarvis.example/path"),  # origin only
        ("JARVIS_CLOUD_BASE_URL", "not-a-url"),
        ("JARVIS_DEVICE_KEY_PATH", "relative/device.key"),  # must be absolute
        ("JARVIS_ARCHIVE_PATH", "relative/archive.sqlite3"),
    ],
)
def test_doctor_reports_invalid_configuration_with_exit_three(tmp_path: Path, name: str, value: str) -> None:
    environment = complete_environment(tmp_path)
    environment[name] = value
    report = run_doctor(JarvisLocalConfig.load(environment))
    assert report.exit_code == 3
    assert report.lines == ("invalid configuration",)


def test_doctor_reports_dependency_failure_with_exit_four(tmp_path: Path) -> None:
    report = run_doctor(
        JarvisLocalConfig.load(complete_environment(tmp_path)),
        dependencies_ready=lambda: False,
    )
    assert report.exit_code == 4
    assert report.lines == ("dependency check failed",)


def test_missing_configuration_is_reported_before_invalid_configuration(tmp_path: Path) -> None:
    """A missing name must not be masked by another value being malformed."""
    environment = complete_environment(tmp_path)
    del environment["JARVIS_DEVICE_ID"]
    environment["JARVIS_CLOUD_BASE_URL"] = "not-a-url"
    report = run_doctor(JarvisLocalConfig.load(environment))
    assert report.exit_code == 2
    assert report.lines == ("missing: JARVIS_DEVICE_ID",)


def test_output_never_contains_a_value_or_any_derived_fingerprint(tmp_path: Path) -> None:
    """The security property: identifiers only, never values, hashes or prefixes."""
    configured_url = "https://private-tenant-host.example"
    environment = complete_environment(tmp_path)
    environment["JARVIS_CLOUD_BASE_URL"] = configured_url
    environment["JARVIS_DEVICE_ID"] = ""  # force a report that mentions another name

    rendered = "\n".join(run_doctor(JarvisLocalConfig.load(environment)).lines)

    assert configured_url not in rendered
    assert "private-tenant-host" not in rendered
    for length in (4, 8, 12, 16):
        assert configured_url[:length] not in rendered
    digest = hashlib.sha256(configured_url.encode("utf-8")).hexdigest()
    for length in (8, 16, 32, 64):
        assert digest[:length] not in rendered
    # And no value from any other variable leaked either.
    for name, value in environment.items():
        if name == "JARVIS_DEVICE_ID" or not value.strip():
            continue
        assert value not in rendered


def test_report_is_immutable() -> None:
    report = DoctorReport(0, ("ready",))
    with pytest.raises((AttributeError, TypeError)):
        report.exit_code = 1  # type: ignore[misc]
