# PR #5 independent review

Reviewed by Codex (OpenAI), 2026-09-10. Author of the escalation: Claude
Opus 5. Scope: PR #5 at `edac2723fe61fa9e4f623123d9f45f0c18feeee0`, including
its inherited changes against `db2b3a5b011a25f3d56b5d33cc00a97f25365719`.
The escalation itself is the diff from `99da803` to `edac272`.

**No merge-blocking finding. The escalation is clean.** This conclusion
applies to that immutable head, not to subsequent R0 implementation. Sid
merges. This review does not certify deployment or the R0 exit test.

1. **Security checks are unchanged.** `Assert-LiteralRuntimeRoot`,
   `OpenWorkflowLock`, the runtime PowerShell implementation, and its Win32
   share flags are unchanged. Raw 8.3 rejection still runs in the regular
   `temp-path.test.mjs` suite. The escalation changes fixture paths and
   cleanup, not security assertions, permissions, or rejection behavior.
2. **Canonical paths keep the same referent.** The shared helper resolves
   `tmpdir()` with `realpathSync.native` before creating fixtures in nine
   Hermes files. Deployment tests equivalently canonicalize their freshly
   created directory. Source-lock directory enumeration, volume-root and
   junction setup retain the same filesystem locations. Tests that intend
   to supply an aliased path still construct one explicitly. The intended
   change is which spelling reaches the literal-path boundary, not which
   behavior the assertions measure. A failed canonicalization throws.
3. **Cleanup retries remain failures for persistent handles.** Deletes use
   finite `maxRetries: 10`, `retryDelay: 50`; rejection remains awaited and
   is not caught and discarded. Runtime locking and process cleanup are
   unchanged. The PowerShell workflow lock is disposed in `finally`, and
   the verifier runner waits for child closure. A separate local Node
   24.19.0 probe held a file with PowerShell `FileShare.None`: recursive
   deletion exhausted these retries with `EBUSY` after 34,104 ms, then
   succeeded after handle release. Recursive retries can compound, so
   2.75 seconds is not a bound for the whole tree. This demonstrates that
   retries do not hide a persistently held handle. It does **not** reproduce
   or prove the precise cause of the original transient CI race.
4. **The interpreter pin remains exact.** CI pins uv to `0.12.7`, installs
   `3.11.16`, and immediately invokes
   `py -V:Astral/CPython3.11.16` as a failing preflight if unavailable.
   Runtime attestation uses that same exact selector. Neither lock file nor
   runtime interpreter validation is loosened to a generic Python 3.11.

The literal claim "no skipped tests anywhere in PR #5" needs qualification:
the inherited diff contains a Windows-known-folder test skipped on Linux
and the roadmap-authorized move of two extended Hermes suites to a manual
workflow (source-lock 77, containment 61). The fast raw-alias regression
remains in ordinary PR CI. `edac272` introduces no further exclusions or
weakened assertions. The complete manual extended suites were not run as
part of this review.

## Evidence and limits

[CI run 34553801860](https://github.com/ksid1229-ops/jarvis/actions/runs/34553801860)
was observed successful at this head: all seven jobs, Hermes 108/108,
workspace 1,935/1,935, watchdog 113/113, deployment-script checks, Python
checks on both operating systems, and byte-exact integrity checks.
The Windows Hermes suite was not rerun locally: this machine lacks its
expected trusted PowerShell installation path. No path check was bypassed.

Supporting API contracts: [Node filesystem retry semantics](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesrmpath-options)
and [uv managed Python versions and Windows registration](https://docs.astral.sh/uv/concepts/python-versions/).
