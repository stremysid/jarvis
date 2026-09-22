"""Abrupt process exit must leave the owner a usable restart diagnosis."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from jarvis_local.crypto.device_keys import platform_device_key_store
from jarvis_local.transport.cli_protocol import CliCommand
from jarvis_local.transport.unix_socket import send_unix_control_request
from tests.test_node import linux_only, settings_at


@linux_only
def test_a_killed_node_and_a_live_duplicate_both_report_the_endpoint_without_removing_it(tmp_path: Path) -> None:
    parent = tmp_path / "private"
    parent.mkdir(mode=0o700)
    settings = settings_at(parent)
    platform_device_key_store(settings.device_key_path).load_or_create()
    code = """
import sys
from pathlib import Path
import jarvis_local.node as node
from jarvis_local.config import JarvisLocalConfig
from tests.test_node import EmptyCycleOpener, linux_environment, settings_at

settings = settings_at(Path(sys.argv[1]))
builder = node.build_node
node.build_node = lambda settings: builder(settings, opener=EmptyCycleOpener())
config = JarvisLocalConfig.load(linux_environment(
    JARVIS_DEVICE_KEY_PATH=str(settings.device_key_path),
    JARVIS_ARCHIVE_PATH=str(settings.archive_path),
    JARVIS_MEMORY_PATH=str(settings.memory_path),
    JARVIS_CONTROL_SOCKET=str(settings.control_endpoint_name),
))
raise SystemExit(node.run_node(config))
"""
    command = [sys.executable, "-c", code, os.fspath(parent)]
    process = subprocess.Popen(  # noqa: S603 - fixed interpreter and in-test source
        command, cwd=Path(__file__).resolve().parents[1],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + 5
        while True:
            assert process.poll() is None
            try:
                response = send_unix_control_request(CliCommand("status"), settings.control_endpoint_name)
                if "cycles_recorded 1" in response.lines:
                    break
            except OSError:
                pass
            except RuntimeError:
                pass
            if time.monotonic() >= deadline:
                pytest.fail("the child node never served its first cycle status")
            time.sleep(0.02)
        identity = settings.control_endpoint_name.stat().st_ino
        for killed in (False, True):
            if killed:
                process.kill()
                process.communicate(timeout=5)
                assert process.returncode == -signal.SIGKILL
            restarted = subprocess.run(  # noqa: S603 - fixed interpreter and in-test source
                command, cwd=Path(__file__).resolve().parents[1],
                capture_output=True, text=True, timeout=5,
            )
            assert restarted.returncode == 4, (restarted.stdout, restarted.stderr)
            assert str(settings.control_endpoint_name) in restarted.stdout
            assert "stale socket" in restarted.stdout
            assert "rm --" in restarted.stdout
            assert settings.control_endpoint_name.is_socket()
            assert settings.control_endpoint_name.stat().st_ino == identity
            if not killed:
                assert send_unix_control_request(CliCommand("status"), settings.control_endpoint_name).code == "ok"
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)
