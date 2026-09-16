## 2026-09-16 HH:MM UTC — Claude Opus 5, PR #60 review at 4937c09: held, not cleared — one unproven premise

The work is good and addresses everything I asked for. I am not clearing it, because the whole procedure rests on a premise neither of us has tested against remote D1, and I have now cleared this document twice on premises that turned out to be false. One cheap owner-run probe settles it.

**The premise.** Step 3 applies `0001`–`0015` statement by statement through the shared splitter, sending each complete trigger as a single `wrangler d1 execute --command`. That assumes remote D1 accepts a trigger whose body contains `SELECT CASE WHEN … THEN RAISE(…) END;` when it arrives as one whole statement. **The 2026-09-13 entry in this log says otherwise**: "a trigger body containing `SELECT CASE WHEN ... THEN RAISE(...) END;` fails, **even written on one line** … The remote path ends the trigger at the CASE's `END`." If that is still true, the helper fails on `0001`, refuses the receipt, and Sid stops at the same wall one layer deeper. `0001`, `0002` and `0006` all contain that form.

Local evidence cannot settle this. `node:sqlite` and local D1 accept the form; the failure is specific to the remote path, which is exactly why the empty-database version of this runbook passed review twice and then failed in Sid's hands.

**The probe that settles it** — two commands plus cleanup, against a throwaway, costing nothing:
```
npx.cmd wrangler d1 create jarvis-probe-caseraise
npx.cmd wrangler d1 execute jarvis-probe-caseraise --remote --command "CREATE TABLE t (a TEXT); CREATE TRIGGER t_guard BEFORE INSERT ON t BEGIN SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'probe') END; END;"
npx.cmd wrangler d1 delete jarvis-probe-caseraise
```
If it executes, the premise holds and I clear this PR as it stands. If it fails with `incomplete input`, step 3 needs a different way to reach the `0015` baseline — and at that point the honest answer may be that a faithful baseline is not reachable with the available tooling, which is worth knowing before more work goes into it.

**What I verified and found sound.**
- **The splitter really is shared, not copied.** `splitMigration` now lives in `scripts/split-migration.mjs` and `apps/cloud-gateway/test/persistence/migration.ts:2` imports it, so the helper and the test harness cannot drift. I checked this specifically because the ready entry's claim of "the exact shared implementation" is the kind of thing that is usually a duplicated function body. It is not.
- **Receipt discipline is real and tested.** `scripts/test/prepare-d1-scratch-baseline.test.mjs` pins both halves: the loader uses the shared splitter on a trigger-bearing migration, and a failing statement stops the run **without** recording a receipt. That is the distinction that makes these receipts genuine rather than fabricated, and it is the right thing to have tested.
- **The scratch config is created in the Windows temporary directory and the runbook refuses to proceed if the path is inside the repository** — a stronger check than the rule I asked for, and it matches the approach I proved works: wrangler ignores the configured `migrations_dir` for a database its config does not declare, so a scratch-only config is required.
- **Step 1 is now honest about the boundary**: it claims compatibility of the candidates over seeded existing rows and says plainly that it does not reproduce production's data volume or real row contents.
- **The plain-`CASE` allowance is documented in `remote-d1-migration-syntax.test.ts`**, so nobody over-tightens that pattern later. Correct — a plain `CASE … END` value expression inside a trigger is proven fine on remote D1.
- Everything good from the previous version survives: the double scratch-name confirmation, case-sensitive comparisons, trigger names extracted from the files, an exit-code check on every command, the stale-list and stale-count guidance, the account database-limit path, cleanup and deletion, and the handoff to `deploy.md` rather than duplicating the production procedure. Windows 11 and PowerShell 7 throughout; no bash, no `chmod`.

**One thing to fix regardless of the probe result, small:** the ready entry says PowerShell's parser accepts all eight command blocks, but the runbook now has more steps than that after renumbering — say which blocks were parsed, or re-run the check across all of them, so the claim matches the document.

**Status:** not merged, deliberately. `0016`–`0024` and `0025` all remain unapplied candidates. Nothing here creates, deletes, queries or migrates a database by itself.

— Claude Opus 5
