## 2026-09-16 06:00 UTC — Claude Opus 5, PR #60 premise disproved on real D1, and the fix is proven

The probe I asked Sid for failed, so I ran the variation I had reserved the database for — this time straight against the D1 HTTP API, bypassing wrangler entirely, one statement per request. That removes every splitter from the picture. Results on `jarvis-probe-caseraise`, all real, all remote:

| statement, sent alone | result |
|---|---|
| `CREATE TABLE t (a TEXT)` | OK |
| `CREATE TRIGGER t_guard AFTER INSERT ON t BEGIN SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT,'probe') END; END;` | **`incomplete input: SQLITE_ERROR [7500]`** |
| `CREATE TRIGGER t_guard2 BEFORE INSERT ON t BEGIN SELECT RAISE(ABORT,'probe_rejected') WHERE NEW.a = 'bad'; END;` | OK |
| `INSERT INTO t (a) VALUES ('bad')` | **`probe_rejected: SQLITE_CONSTRAINT_TRIGGER`** — the guard fires |
| `INSERT INTO t (a) VALUES ('ok')` | OK — the guard does not over-fire |

So it is settled, and it is not a tooling problem: **remote D1 cannot parse `SELECT CASE WHEN … THEN RAISE(…) END;` inside a trigger body at all**, however it is delivered. No splitter, no `--command` shape and no better runbook will change that. **And the replacement form works**, including actually aborting with the correct error code — which is the part worth having proven rather than assumed.

**PR #60 stays open.** Its step 3 rebuilds a `0015` baseline by replaying `0001`–`0015`, and `0001`, `0002` and `0006` all carry the rejected form, so that step cannot complete as written. The work itself is sound — the shared splitter, the receipt discipline, the out-of-repo scratch config — and I want it, just not aimed at a wall. It becomes reviewable again the moment the migrations are replayable.

**The bigger thing this exposes, which matters more than the runbook.** Production is fine: those three are long applied and never re-run. But it means **this repository cannot currently rebuild its own database from scratch.** That is a standing disaster-recovery gap nobody had noticed, and it is the real reason the empty-database rehearsal kept failing review after review.

**Decision, and I am taking it rather than putting it to Sid.** Rewrite the guards in `0001`, `0002` and `0006` into the `SELECT RAISE(ABORT,'…') WHERE <condition>;` form — exactly the rewrite this repo already applied to `0014`'s three guards and `0015`'s eight on 2026-09-13, before they were applied. The unusual part is that these three are already live, so the rewrite changes the recorded text of applied migrations. I am taking that trade because the alternative is a database that can never be rebuilt, and because:
- the rewrite is semantically identical, now demonstrated end to end rather than argued;
- production's `d1_migrations` records names, not contents, so nothing in production notices;
- the files will carry a note that production was migrated with the earlier text and that the rewrite exists to make replay possible.

I have queued that as a build task, including widening `remote-d1-migration-syntax.test.ts` to assert that **no** migration anywhere contains the rejected form — today it only checks the files it enumerates, and the whole point is that nothing can reintroduce it. The existing allowance for plain `CASE … END` value expressions stays; those are proven fine remotely.

Nothing was applied, deployed or merged. The probe database holds only a two-row toy table and is Sid's to delete.

— Claude Opus 5
