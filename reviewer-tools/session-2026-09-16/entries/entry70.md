## 2026-09-16 16:05 UTC — Claude Opus 5, PR #70 max review at 2db29a9: changes requested (small)

The rewrite is right. What is missing is proof that two of the seven rewritten guards still fire.

**Gates at `2db29a9`:** lint and typecheck pass, and `pnpm test` passes **3,721/3,721 across 166 files**. The four Hermes `test:all` failures (SBOM trusted-host path, one source-lock timeout) are outside this PR and unchanged by it.

**Cross-check.** An earlier reviewer session produced its own rewrite of these three files (`reviewer-tools/remote-d1-0016/base-rewrites/`). This PR's migration text is **byte-identical** to it apart from the new header comments. Every predicate, error code and trigger name is unchanged. The comments and the `DECISIONS.md` entry say what they must: production ran the earlier text and was not re-migrated. The repository-wide syntax test covers all 25 migrations and keeps the allowance for value-expression `CASE`.

**Guard-level mutations** (`reviewer-tools/pr70/mut70.json`, `run70.txt`). Each change removes or neutralizes one rewritten `SELECT RAISE … WHERE` statement; BASE survives. Whole-trigger removal, which your entry reports, cannot show that the rewritten *statement* fires. This does.
- **Killed by named tests:**
  - G4, G5, G6: the three capacity guards in `0002`;
  - G7: `identity_challenge_state_changed` in `0006`.
- **Survived, equivalent:** G1, the same guard in `0001`. `0006` drops and recreates `identity_challenges_activate_pending_identity`, so `0001`'s copy never runs on a replayed database.
- **Survived, real gap — S1:** G2 `sync_cursor_compare_failed` and G3 `sync_snapshot_state_changed` in `0001`'s sync acknowledgement trigger. Deleting either statement leaves every test passing, so nothing proves either one fires, before or after the rewrite. That leaves "semantically identical" unproven for exactly the two guards that depend on `changes()` after an `UPDATE`.

**S1 fix.** Add two named negative tests that reach the trigger directly:
1. an acknowledgement with a stale `expected_current` must abort with `sync_cursor_compare_failed` and leave the cursor unchanged;
2. an acknowledgement of a snapshot that is already acknowledged or expired must abort with `sync_snapshot_state_changed`.

I will rerun G2 and G3 and require each to be killed by its own test.

**Next.** The same database-builder session adds the two tests, merges `origin/main`, runs the affected files, lint and typecheck, and requests re-review.

— Claude Opus 5
