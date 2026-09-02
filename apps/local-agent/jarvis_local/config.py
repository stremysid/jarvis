"""Validated configuration for the Jarvis Windows local agent.

Configuration arrives entirely through the environment. Nothing here reads,
logs, or echoes a value: the agent's diagnostics may name a variable but must
never reveal what it contains.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import PureWindowsPath
from urllib.parse import urlsplit

REQUIRED_CONFIG: tuple[str, ...] = (
    "JARVIS_CLOUD_BASE_URL",
    "JARVIS_DEVICE_ID",
    "JARVIS_PRINCIPAL_ID",
    "JARVIS_DEVICE_KEY_PATH",
    "JARVIS_ARCHIVE_PATH",
    "JARVIS_MEMORY_PATH",
)

_PATH_CONFIG: tuple[str, ...] = (
    "JARVIS_DEVICE_KEY_PATH",
    "JARVIS_ARCHIVE_PATH",
    "JARVIS_MEMORY_PATH",
)


def _is_absolute(value: str) -> bool:
    """True for an absolute path on either platform.

    Tests and CI run on Linux while the agent itself targets Windows, so accept
    a rooted POSIX path as well as a drive-qualified or UNC Windows path.
    """
    if value.startswith("/"):
        return True
    windows = PureWindowsPath(value)
    return windows.is_absolute()


def _is_origin_url(value: str) -> bool:
    """Require an https origin with no path, query, fragment or credentials.

    A base URL carrying a path is almost always a mis-set variable, and the
    agent builds every request path itself.
    """
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    if parts.scheme != "https" or not parts.hostname:
        return False
    if parts.username or parts.password:
        return False
    return parts.path in ("", "/") and not parts.query and not parts.fragment


@dataclass(frozen=True, slots=True)
class JarvisLocalConfig:
    """An immutable snapshot of the agent's environment."""

    environment: Mapping[str, str]

    @classmethod
    def load(cls, environment: Mapping[str, str]) -> JarvisLocalConfig:
        return cls(dict(environment))

    @classmethod
    def from_environment(cls) -> JarvisLocalConfig:
        return cls.load(os.environ)

    def missing_names(self) -> tuple[str, ...]:
        """Required names that are absent, empty, or only whitespace.

        Reported in declaration order so output is deterministic.
        """
        return tuple(name for name in REQUIRED_CONFIG if not self.environment.get(name, "").strip())

    def is_valid(self) -> bool:
        """Whether every present value is well formed. Assumes nothing is missing."""
        if not _is_origin_url(self.environment.get("JARVIS_CLOUD_BASE_URL", "")):
            return False
        return all(_is_absolute(self.environment.get(name, "")) for name in _PATH_CONFIG)
