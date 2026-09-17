## 2026-09-17 03:00 UTC — Claude Opus 5, PR #85 max review at 5b05f62: cleared with required follow-ups

**Cleared for Sid's production timeout, with an explicit exception.** Two Medium findings (M1, M2) only trigger once archive segments exist. Production D1 has **0 archive segments**, and its oldest event is 2026-09-02, so archival starts around 2026-12-01. The required follow-up PR (queued now) must merge long before then. The live 800 ms timeout Sid hit today is fixed now.
- **Gates at `5b05f62`**, in a Windows Workers-pool checkout: lint 0, typecheck 0. The full suite ran **4,893/4,894**. The one failure is this PR's own wall-clock test (`starts literal history before a 700 ms base lookup…`), which timed out under builder load. `telegram-memory.test.ts` passes **53/53** alone, twice.
- **Adversarial second reviewer:** `reviewer-tools/pr85-adversarial.md`, tests in `reviewer-tools/pr85/agent/adversarial-pr85.test.ts`. I re-ran them at this head: **3 pass, 4 fail** (A1, B1, B2, B3).
- **Checked and sound:**
  - The batched item reader equals the old `readCurrentItem` + `readItemVisibility` on real remember/forget flows (C1).
  - Forgetting end to end holds (C2).
  - Literal-history batch suppression, subject, hash and circuit checks match the old path.
  - `D1ContextRetriever` produces the same two statements as one batch, so voice output is unchanged.
  - Bound parameters are ≤25 per statement, and the telemetry round-trip count matches the harness.
  - No migration and no out-of-scope files.

**F1 (M1, regression, dormant until archives exist).** Literal search now always starts, and its failure rejects the whole memory promise (`telegram-memory-retriever.ts:776-791`, `:744`). Once the archive circuit latches open (`archival-service.ts:260`, never closed), ordinary questions lose all memory. B1 passes on main and fails here.
- **Fix:** don't start literal search when its result can't be used, or treat its failure as "no hits".

**F2 (M2, dormant until archives exist).** Archived-source items are validated one after another (`memory-repository.ts:1181`, `:1211`, `:1232`). A1: three archived memories at 25 ms per round trip took 641–658 ms, with 1 of 3 runs timing out. `Promise.all` alone brings it to 286–300 ms.
- **Fix:** validate items concurrently, cache receipt checks per event, and pin A1 at ≤500 ms.

**F3 (Medium, pre-existing on main). Literal-history recall never reaches a real Telegram turn.** The recent context includes the current question, so `recentContextCoversQuery` (`:795`) is always true. B2: "Where did I put the quartz stapler?" gets 0 history hits once the statement is outside the recent window. The builder's harnesses never include the current turn, so they miss this.
- **Fix:** exclude the current turn's own event from coverage and dedup checks.

**F4 (Low, pre-existing).** `retrieveMemory` still awaits the base result inside the 800 ms memory deadline (`:787`). B3: a 900 ms base discards memory that was ready at about 80 ms.
- **Fix:** run memory work under its own deadline, and merge and deduplicate after both settle.

**F5 (Low, tests).**
- The wall-clock bounds (250/350 ms) flake under load. Assert round-trip counts with a generous time bound instead.
- These mutations survive the named suites:
  - literal suppressed-row skip (`literal-history.ts:696`);
  - archived event-id check (`:701`);
  - per-row seal check (`:675`);
  - batched `creation_event_suppressed` forced to 0;
  - suppressed-source list emptied;
  - `recentEventIds` dedup (`telegram-memory-retriever.ts:801`).
- **Add:**
  - C1 as a differential test;
  - kill tests for each mutation above;
  - a race test that inserts a suppression between the FTS query and the batch.

**F6 (Low).** The combined topic walk caps redirects plus parents at 64 (`memory-repository.ts:2914`). Allow 128, or document the cap.

**Required follow-up:** a fresh memory builder fixes F1–F6 with the reviewer's A1, B1, B2 and B3 passing, before archival begins and before PR #83 round 2 builds on this code.

— Claude Opus 5
