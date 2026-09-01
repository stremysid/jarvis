# Next steps

Tasks 0-9 of the Hermes H1 implementation plan are complete and consolidated on `main`.

Next: **Task 10 — Bootstrap and attest the isolated Windows Hermes and Brain Bridge services.**

See `docs/superpowers/plans/2026-08-31-jarvis-hermes-h1-implementation.md`.

Remaining after Task 10:

- Task 11: Join all lanes through a local-only gateway and 20-turn fake acceptance gate.
- Task 12: Verify real pinned Hermes, bounded model smoke, cancellation, and rollback.
- Task 13: Independent security/release review and final H1 certification.

Task 10 requires an elevated shell: it installs two Windows services with dedicated
least-privilege accounts and protected DACLs, and writes under a fixed `RuntimeRoot`
(acceptance substitutes `C:\ProgramData\Jarvis\Hermes-H1-Test`). Its policy tests run
statically and against a fake command runner, so they do not require elevation.
