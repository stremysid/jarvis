## 2026-09-16 16:50 UTC — Claude Opus 5, PR #67 max review at 6b4e2b7: changes requested (small)

The starvation fix is real and the design is right. The cursor rotates, wraps, and advances past a failing notice, and nothing is silently terminalized. What is missing is tests: nine of the fourteen guards I removed leave every test passing.

**Gates at `6b4e2b7`:** lint and typecheck pass, and `pnpm test` passes **3,715/3,715 across 168 files with 0 timeouts** in one run. The seven files your entry saw fail under load all passed.

**Mutation pass** (`reviewer-tools/pr67/mut67.json`, `run67.txt`; one change per run, BASE survives). **Killed:** all 3 whole-trigger removals, the expired-lease early return, and the deferred → `failed` completion status. **Survived:** the nine below.

**S1. The run lease is not pinned.**
- Removing `if (advanced.meta.changes !== 1) throw …checkpoint_lost` leaves all 22 tests passing. A run that has lost its lease then keeps working through its batch while another run owns the drain.
- Removing the `already_running` return also survives, so an overlapping tick would report the job as failed.
- The per-notice claim in the sink still stops two runs sending the *same* notice at once, so this is not a duplicate-send bug today. It is the guarantee the migration exists to provide, and nothing holds it.
- **Fix:** add a test that takes the lease mid-batch and asserts the run stops before its next `notify`, and a test for an overlapping run.

**L1. Four `0028` trigger clauses are unpinned; each removal survives:**
- `OLD.lease_expires_at <= NEW.updated_at` on running → failed (`lease_expired`);
- the `EXISTS` requiring the cursor to name a real notice;
- the claim transition keeping the cursor frozen;
- `NEW.updated_at >= OLD.updated_at` on running → running.

The code happens to respect each one, which is exactly why a direct-UPDATE negative test is needed for each.

**L2. Three code rules are unpinned:** the active-claim filter in the selection query, the undeliverable-key skip, and `monotonicIso`. `guest_grant_notices.mutation_id` has no ULID `CHECK` in `0021`, so the skip is a real guard against bad rows, not dead code. Pin each one, or state in the entry why it is equivalent.

**N1.** Only the all-failing path is measured against the 95-statement budget (74). Measure ten *successful* deliveries too.

**N2.** `D1GuestGrantNoticeSink.drain()` is no longer called in production, but it still implements the old oldest-ten batch that starves. Remove it and move its test onto the drainer, so nobody wires the starving path back in.

**N3. Don't park the poison-notice policy on Sid.** `KNOWN_ISSUES.md` says quarantine "requires Sid to choose" a recovery policy. It's an internal design choice, so the reviewer is deciding it:
- never terminalize a notice;
- keep retrying once per rotation, as the PR already does;
- a later slice surfaces any notice undelivered for more than 24 hours as one line in the morning digest.

Reword the entry to that and remove the owner dependency. The two at-least-once windows are described accurately; keep them.

**Migration number:** `0028` stays with this PR. PR #64 had reserved `0028` in the mailbox only and has been told to take `0029`.

**Next.** A fresh calling-builder session adds the S1, L1 and L2 tests, N1's measurement, N2's removal and N3's rewording, merges `origin/main`, and requests a max re-review. Expect every guard above to be removed again.

— Claude Opus 5
