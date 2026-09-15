## 2026-09-15 06:41 UTC — Claude Opus 5, PR #42 max review at 5b516d1: changes requested (small)

This is a max review of migration `0019_memory_ingress.sql`, the #39 N6 ingress guard plus F1, and of the F2 test rework. The branch merges cleanly with main at `0d659bf`, and `0019` is the reserved number (checked against every open branch).

**Local checks on 5b516d1** (Windows 11, `jarvis-deploy`): lint and typecheck pass. `pnpm test` passed **2,922 of 2,922** with 0 timeouts.

**What 0019 does, by reading.**
- `events_memory_owner_command_ingress_guard` reserves the `memory.owner_command` / `memory-control` pair in both directions.
- For owner commands, it requires an active human subject and a canonical envelope whose eventId, correlationId, eventType, source, subjectId, occurredAt, receivedAt and contentHash mirror the row.
- It also requires `producerVersion = memory-control-v1`, an allowlisted operation and a ULID `targetId`.
- `memory_topic_events_recent_insert_guard` adds F1's `occurred_at >= now − 5 min` bound.
- No sync or HTTP route appends caller-typed events. The reviewer grepped `src/sync` and `src/http`: device sync only pulls, acknowledges, distils and projects, and Telegram, conversation and call writers use fixed types. So reserving the pair in SQL, plus no generic producer, closes N6(b) at the schema boundary. The 0016 guards already bind operands (N6(a)).
- Remote D1: no `CASE … RAISE` and no recursive CTEs. It uses `json_type`/`json_extract`/`GLOB` in a WHEN clause, which already appear in 0016. Add both triggers to the attended scratch proof.

**Clause and trigger removals** (`mut42.json`, each against `cloud-memory-ingress-migration.test.ts` and `cloud-memory-migration.test.ts`; BASE passed; 0 timeouts).
- **Killed by a named test:** the source-without-type clause, `producerVersion`, and the operation allowlist.
- **Invalid:** removing either whole trigger fails the ingress file in setup, with all 3 of its tests skipped and 141 others passing. No assertion ran, so this isn't a kill; whole-trigger coverage is unmeasured.
- **Survived** (all tests pass with the clause removed): type-without-source, principal `human`, principal `active`, envelope `eventId`, `correlationId`, `subjectId`, `occurredAt`, `contentHash`, `targetId` length and `targetId` charset.

**B1. The owner-command authenticity boundary isn't isolated by tests.** Ten of its clauses can be deleted with every test still green. The negative tests use envelopes that fail several clauses at once (for example payload `{}` with a wrong source), so each clause is masked by another. This trigger is the schema's only defence against forged owner commands, which can forget, correct or move memories.
- Fix: starting from one valid canonical command (which must be accepted), add one negative test per clause, changing exactly one field and asserting `memory_owner_command_ingress_invalid`:
  - type with a non-`memory-control` source;
  - an inactive principal and a non-human principal;
  - each envelope field mismatch: eventId, correlationId, eventType, source, subjectId, occurredAt, receivedAt, contentHash;
  - a non-object envelope or payload;
  - a `targetId` that is 25 or 27 characters, starts with `8`, or contains `I`, `L`, `O` or `U`.
- Test: rerun the clause removals, and each must fail its own test.

**S1. The whole-trigger removal runs are invalid.** Removing either trigger makes the ingress file fail in setup rather than in an assertion. Keep the setup free of trigger-presence checks, or give the inventory its own test that asserts both trigger names and SQL, so removal shows up as a named failure and the suite's behavioural tests still run.

**F2 is fixed** (`mut42-f2.json`, 0016 single-pin removals against the reworked migration tests; BASE passed; 0 timeouts). Removing any one of these pins is now caught by its named single-column collision test:
- vector `item_kind`, `content_hash`, `principal_id`, `item_id` and `mutation_id`;
- run `principal_id` and `run_key`;
- placement-state `placement_id`.

The only survivor is placement-state `principal_id`. It is equivalent by trace: the same guard's event match requires `event.principal_id = NEW.principal_id` for the pinned, globally unique `placement_id`, so no alternative event can match.

**F1 is fixed.** Removing `memory_topic_events_recent_insert_guard` wasn't validly measured (S1), but its dedicated test asserts `memory_topic_event_stale` for a 10-minute-old stamp and accepts a current one.

**Next.** Fix B1, S1 and any F2 residual, then request re-review. The reviewer reruns the clause and pin removals. `0016` and `0019` are then proven together on scratch remote D1 before any production apply.

Sid retains merge and migration authority. Nothing is applied or deployed.
