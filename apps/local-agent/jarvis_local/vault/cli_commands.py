"""`jarvis vault ...` -- thin wrappers, and deliberately nothing more.

The parser and the dispatch live here rather than in `cli.py` so the change to
that shared file is four lines. Another agent is adding service subcommands to
the same module at the same time, and a small additive edit is the difference
between two changes that merge and two that fight.

Thin means thin. Every command below resolves configuration, calls one object,
and prints. No command formats a path into its output -- `search` and `show`
print opaque document ids and the note's label -- because the terminal is
where output gets copied from.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from jarvis_local.archive.database import SQLiteDirectoryError
from jarvis_local.config import JarvisLocalConfig
from jarvis_local.vault.diagnostics import run_vault_diagnostics, vault_report
from jarvis_local.vault.reconciliation import VaultReconciler
from jarvis_local.vault.repository import VaultNotBoundError, VaultRepository
from jarvis_local.vault.retrieval import VAULT_CLI, VaultLocalRetriever
from jarvis_local.vault.setup import default_setup_service

VAULT_COMMAND = "vault"

EXIT_OK = 0
EXIT_REFUSED = 1
EXIT_MISSING_CONFIGURATION = 2
EXIT_NOT_BOUND = 4


def add_vault_subcommands(subcommands: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    """Attach `jarvis vault setup|sync|search|show|doctor`."""
    vault = subcommands.add_parser(VAULT_COMMAND, help="work with the Obsidian vault memory adapter")
    actions = vault.add_subparsers(dest="vault_command", required=True)

    actions.add_parser("setup", help="choose, create and bind the owned vault root")
    actions.add_parser("sync", help="record what changed in the vault since the last run")
    actions.add_parser("doctor", help="report vault readiness without disclosing configuration values")

    search = actions.add_parser("search", help="search the vault deterministically, with no model call")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=8)

    show = actions.add_parser("show", help="print one note by its opaque id")
    show.add_argument("identifier")
    show.add_argument("--max-chars", type=int, default=4000)


def run_vault_command(arguments: argparse.Namespace) -> int:
    config = JarvisLocalConfig.from_environment()
    archive_path = config.environment.get("JARVIS_ARCHIVE_PATH", "").strip()
    principal_id = config.environment.get("JARVIS_PRINCIPAL_ID", "").strip()
    if not archive_path or not principal_id:
        print("missing: JARVIS_ARCHIVE_PATH")
        print("missing: JARVIS_PRINCIPAL_ID")
        return EXIT_MISSING_CONFIGURATION
    if not os.path.isabs(archive_path):
        # A relative archive path would be resolved against the working
        # directory, so `jarvis vault search` run from two folders would read two
        # different stores. Refused rather than resolved for the same reason the
        # store boundary refuses it: the location must not depend on where the
        # command was started.
        print(f"JARVIS_ARCHIVE_PATH must be an absolute path: {archive_path}")
        return EXIT_MISSING_CONFIGURATION

    # Read-only on permissions, and explicitly so. `repair_permissions=False`
    # creates no directory and writes no ACL, so a vault read cannot rewrite the
    # permissions of the archive directory as a side effect -- which is what it
    # did while the `JARVIS_ALLOW_REAL_DACL` gate was briefly removed.
    #
    # `open` is inside the `try` because refusing a store that does not exist is
    # the point of the read-only opener, and that refusal arrives from here rather
    # than later.
    try:
        repository = VaultRepository.open(Path(archive_path), repair_permissions=False)
    except SQLiteDirectoryError as error:
        print(str(error))
        return EXIT_MISSING_CONFIGURATION
    try:
        return _dispatch(arguments, repository, principal_id)
    except VaultNotBoundError:
        print("no vault is bound; run `jarvis vault setup` first")
        return EXIT_NOT_BOUND
    finally:
        repository.close()


def _dispatch(arguments: argparse.Namespace, repository: VaultRepository, principal_id: str) -> int:
    command = arguments.vault_command
    if command == "setup":
        return _setup(repository, principal_id)
    if command == "sync":
        return _sync(repository, principal_id)
    if command == "doctor":
        return _doctor(repository, principal_id)
    if command == "search":
        return _search(repository, principal_id, arguments.query, arguments.limit)
    if command == "show":
        return _show(repository, principal_id, arguments.identifier, arguments.max_chars)
    raise AssertionError(f"unhandled vault command: {command}")


def _setup(repository: VaultRepository, principal_id: str) -> int:
    result = default_setup_service(repository).setup(principal_id)
    print(f"root: {result.code}")
    if not result.ok:
        return EXIT_REFUSED
    if result.created_layout:
        print(f"created: {', '.join(result.created_layout)}")
    return EXIT_OK


def _sync(repository: VaultRepository, principal_id: str) -> int:
    binding = repository.require_binding(principal_id)
    result = VaultReconciler(repository, binding).run()
    print(f"status: {result.status}")
    print(f"examined: {result.documents_examined}")
    print(f"appended: {result.observations_appended}")
    print(f"unchanged: {result.unchanged}")
    print(f"tombstoned: {result.tombstoned}")
    if result.skipped_too_large or result.unstable or result.undecodable:
        print(f"skipped: {result.skipped_too_large + result.unstable + result.undecodable}")
    return EXIT_OK if result.complete else EXIT_REFUSED


def _doctor(repository: VaultRepository, principal_id: str) -> int:
    report = vault_report(run_vault_diagnostics(repository, principal_id))
    for line in report.lines:
        print(line)
    return report.exit_code


def _search(repository: VaultRepository, principal_id: str, query: str, limit: int) -> int:
    results = VaultLocalRetriever(repository).search(
        query, principal_id=principal_id, purpose=VAULT_CLI, limit=limit
    )
    for result in results:
        print(f"{result.document_id}  v{result.document_version}  {result.display_label}")
    if not results:
        print("no matching notes")
    return EXIT_OK


def _show(repository: VaultRepository, principal_id: str, identifier: str, max_chars: int) -> int:
    found = VaultLocalRetriever(repository).show(
        identifier, principal_id=principal_id, purpose=VAULT_CLI, max_chars=max_chars
    )
    if found is None:
        print("no such note")
        return EXIT_REFUSED
    print(f"{found.document_id}  v{found.document_version}  {found.display_label}")
    print(found.excerpt)
    return EXIT_OK
