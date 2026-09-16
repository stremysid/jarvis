## 2026-09-16 HH:MM UTC — Claude Opus 5, the merged scratch-proof runbook cannot complete; two defects proven with Sid at the keyboard

Sid and I ran `docs/runbooks/migration-scratch-proof.md` end to end against a real throwaway D1 tonight. It does not work, and I cleared it twice without checking whether the procedure could run. Recording exactly what we proved, because two of these facts were already in this log and I missed them.

**Defect 1 — wrangler ignores the configured `migrations_dir` for a database the config does not declare.** The runbook's step 3 passes `--config apps/cloud-gateway/wrangler.toml` with a scratch database name. That config declares only `jarvis` and `jarvis_test`, so wrangler falls back to the default folder and fails before any network call:
`X [ERROR] No migrations present at C:\javis\apps\cloud-gateway\migrations.`
Proven on wrangler 4.127.1. **Workaround that works and keeps the production config untouched:** a scratch-only config file outside the repository declaring just the scratch database with `migrations_dir` pointing at `src/persistence/migrations`. With that, `d1 migrations list --remote` correctly listed all 24 pending files in order, `0001`–`0023` and `0025`, with no `0024` — the nine are exactly what the repo holds today.

**Defect 2, the blocking one — a fresh remote D1 cannot take `0001`, so an empty-database rehearsal can never reach the nine.** `wrangler d1 migrations apply --remote` prompted for 24 migrations, we confirmed, and it failed immediately:
`incomplete input: SQLITE_ERROR [code: 7500]`
Nothing applied — a follow-up `migrations list` still showed all 24 pending. **This log already records it**, on 2026-09-13 at 20:35: *"Even 0001 fails on a fresh remote DB, so live 0001/0002/0006 were applied some other way."* I quoted that entry's error string in both of my PR #58 reviews as evidence the expectation was grounded, and did not read the sentence that invalidates the whole procedure. The runbook's premise — start from an empty scratch database and apply everything — is the one case known not to work.

**What we also proved, which is good news for the nine.** I suspected `0016_cloud_memory.sql` was a second instance of the hazard: `memory_item_transitions_insert_guard` (starting line 1336) contains a `CASE ... END` at line 1489, inside the trigger, and `remote-d1-migration-syntax.test.ts:54-56` only rejects `SELECT CASE … RAISE(`. On a throwaway remote database this executed cleanly:
`CREATE TABLE t (a TEXT, b TEXT); CREATE TRIGGER t_guard BEFORE INSERT ON t WHEN NEW.a = CASE WHEN NEW.b = 'x' THEN 'y' ELSE 'z' END BEGIN SELECT RAISE(ABORT,'nope'); END;` → `Executed 2 commands`.
So a plain `CASE … END` as a value expression inside a trigger is fine on remote D1; the hazard is only the statement form `SELECT CASE WHEN … THEN RAISE(…) END;`. `0001`, `0002` and `0006` contain that form; `0003`, `0004` and **all nine unapplied migrations do not**. The existing syntax test is aimed correctly and should not be widened — but it deserves a comment saying why plain `CASE` is deliberately allowed, so nobody over-tightens it later.

**Net effect for Sid:** his nine candidates carry no known remote-D1 hazard, and the production apply starts at `0016`, so `0001` is never re-executed. What is missing is a rehearsal that can actually run. Both throwaway databases were deleted and nothing was left on his account; production is untouched and still at `0015`.

**What the runbook needs (new PR, not a patch to the current text):**
1. Stop rehearsing from empty. Bring scratch to a `0015`-equivalent baseline the way production genuinely is, then let `migrations apply` run only `0016` onward — which is the real production path and the only one worth rehearsing.
2. The repo already owns the tool for step 1: `splitMigration` in `apps/cloud-gateway/test/persistence/migration.ts` lifts trigger bodies out before splitting on semicolons, which is exactly what wrangler's splitter fails to do. Applying `0001`–`0015` through that splitter with `d1 execute`, then recording the matching `d1_migrations` rows for files actually applied, gives a faithful baseline. That is not "fabricating receipts": every receipt would correspond to SQL genuinely executed against that database. Say so explicitly in the runbook so the distinction is not lost.
3. Use a scratch-only wrangler config outside the repository, per defect 1, and keep the existing rule that the returned database id never lands in a repository file.
4. Keep everything already good: the double scratch-name confirmation, the case-sensitive comparisons, extracting trigger names from the files, the exit-code check on every command, the stale-list guidance, and step 9 pointing at `deploy.md`.
5. With a real `0015` baseline in place, the seeding I originally asked for becomes possible after all — seed the production-shaped rows before applying `0016` onward, and the proof finally covers the `NOT NULL`, existing-row-guard and unique-index classes that the current step 4 correctly lists as uncovered.

Nothing was merged, deployed or applied by this session. The nine migrations `0016`–`0023` and `0025` remain unapplied candidates.

— Claude Opus 5
