## 2026-09-16 HH:MM UTC — Claude Opus 5, PR #58 review at aac4d96: changes requested (small)

This is the right document and it is unusually careful — the double-confirm on the scratch name, the refusal to take a literal database name, the exit-code check on every command, and the "expect exactly this line" pattern are all what a tired owner at a keyboard needs. Two changes before it is safe to hand him, and both are about what happens when reality differs from the day it was written.

**Verified, not taken on trust.** Docs-only: `docs/runbooks/migration-scratch-proof.md`, one line in `NEXT_STEPS.md`, one `AGENT_LOG` entry, nothing else. I checked the numbers and the strings myself:
- **200 `CREATE TRIGGER` declarations across the nine files and 197 unique names** — confirmed by counting. The three-replacement claim holds.
- **`incomplete input: SQLITE_ERROR [7500]`** is a real remote-D1 failure this repo actually hit; it is recorded in `docs/AGENT_LOG.md:6251`. Good — that expectation is grounded, not invented.
- **`sqlite_schema`** is the form already used across the repo's own migration tests, so the trigger inventory query will work.
- The `deploy.md#r0-item-5-migrate-then-deploy` anchor resolves to the real heading.
- The `--remote --config --env ''` shape matches `deploy.md`, and `pnpm.cmd` is right for this machine. No bash, no `chmod`, no Linux assumption anywhere.

**S1. The hard-coded list of nine will go stale and dead-end him.** Step 3 compares every migration at or after `0016_` against a literal nine-name list and throws `"Repository candidates do not match the reviewed nine in order."` PR #52 has `0024` open right now and the R2 distillation slice will take `0026`, so by the time Sid runs this the check will almost certainly fire. Stopping is the right behaviour — but the runbook never tells him what it means, so at midnight he gets a red error and no next step. Add one sentence at that throw: this means the reviewed set changed since the runbook was written, it is **not** a database failure, and the fix is to update the list and get the new set reviewed before proceeding. Same for the `197` trigger-inventory count in step 4, which moves with every new migration.

**S2. The proof's blind spot is the one thing production has that scratch does not: rows.** A new scratch database starts empty and applies `0001` through `0025` in order. Production will apply `0016` onward onto a live database already at `0015` **with real data in it** — one human principal, one device, one active Telegram identity, and the events behind them. A migration that is fine against empty tables and fails against existing rows — a `NOT NULL` column without a default, a new guard whose condition is false for a row already there, a unique index over data that already violates it — passes this proof and fails on his real database. Step 1 does disclose this in a clause ("not the contents of production rows"), which is honest, but it reads as a footnote rather than the main limitation.
- **Fix:** add a step between 3 and 4 that seeds the scratch database with a minimal, non-secret row set in production's shape — one `human` principal, one device, one active Telegram channel identity, and one conversation event — **before** applying `0016` onward, then applies and re-runs the receipts check. Use obviously fake identifiers and no real phone number, token or account id. Then say plainly in step 1 that the proof now covers the additive migrations against a production-shaped database, and still does not cover production's data volume.
- If you would rather not seed, say so and instead promote the limitation into its own numbered step so Sid reads it as a known gap rather than a parenthetical — but seeding is the version that actually earns the word "proof".

**Two one-liners, your call:**
- The `CASE`/`RAISE` check in step 6 matches Wrangler's exact wording in three substrings. If a future Wrangler changes that message the step throws, which is the safe direction — add half a sentence saying a mismatch there means "ask for a review", not "the database is broken".
- If `wrangler d1 create` fails because the account is at its database limit, the runbook currently just stops. One line telling him to delete an older `scratch` database first would save a round trip.

**Not blocking, and worth saying:** the deliberate choice to extract trigger names from the files rather than maintain a second hand-written list is the right call, and the `-cne` case-sensitive comparisons on the confirmation prompts are a nice touch. Nothing in here applies a migration, deploys, or touches a secret, and step 8 correctly refuses to duplicate the production procedure.

**What to do:** S1 and S2, then the two one-liners if you agree, and post a ready entry. No code changes, so lint and typecheck are enough.

— Claude Opus 5
