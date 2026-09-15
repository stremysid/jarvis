# PR #40 re-review probes — report

Repo: ksid1229-ops/jarvis, branch codex/r1-owner-passphrase-step-up.
Buggy head: 6b63d08. Fix head: 337c290 ("Harden owner call step-up recovery and authority").
Test copy: C:\Users\Sid\jarvis-pr40 (currently detached at 337c290, clean).
Windows 11, Git Bash / PowerShell, pnpm.cmd. Lockfile unchanged between heads (no install needed).

A probe PASSES on the buggy head (asserts the bug) and must FAIL on a correct fix
(guard RAISEs / call ends), never on "no such table/column".

Run command (from C:\Users\Sid\jarvis-pr40, one vitest process at a time):
    pnpm.cmd exec vitest --config vitest.workspace.ts run <file>
    # add --disableConsoleIntercept to see the sweep matrix

Probe files (as delivered here; on the test copy they lived at the paths noted):
- zz-reviewer-pr40-b1-replace.test.ts     -> apps/cloud-gateway/test/persistence/  (B1a,B1b,B1c)
- zz-reviewer-pr40-b3-waiver-head.test.ts -> apps/cloud-gateway/test/persistence/  (B3)
- zz-reviewer-pr40-sweep.test.ts          -> apps/cloud-gateway/test/persistence/  (Sweep)
- zz-reviewer-pr40-b2-alarm.test.ts       -> apps/cloud-gateway/test/voice/        (B2)
- zz-reviewer-pr40-s1-split-repeat.test.ts-> tests/acceptance/fake/               (S1)

## Summary

Probe | 6b63d08 (buggy) | 337c290 (fix) | Verdict
B1a bindings REPLACE -> waiver -> mint | PASS (bug) | FAIL: RAISE owner_call_step_up_binding_invalid | FIXED
B1b windows REPLACE -> extend deadline | PASS (bug) | FAIL: RAISE owner_call_step_up_window_invalid | FIXED
B1c repeat_checks REPLACE -> reset | PASS (bug) | FAIL: RAISE owner_call_step_up_repeat_invalid | FIXED
Sweep (0018 OR REPLACE matrix) | PASS (holes) | FAIL: every table blocked | FIXED
B3 waiver ignores disabled/absent head | PASS (bug) | FAIL: RAISE call_session_authority_requires_current_lineage | FIXED
S1 split-final repeat leaks to model | PASS (bug) | FAIL: model got [] | FIXED
B2 alarm key deleted before handling | PASS (bug) | PASS (STILL OPEN) | NOT FIXED (partial)

Fix mechanism observed: all nine 0018 tables are now "STRICT, WITHOUT ROWID" (kills the
explicit-rowid REPLACE), and every insert guard now rejects an already-present natural key
(a new owner_step_up_alert_insert_invalid guard was also added). The waiver branch of
call_session_authorities_require_current_lineage now requires an active head+verifier.

## FINDING still open on 337c290 — B2 (adv F5, "resolveCore unavailable" variant)

CallSessionDO.alarm() (apps/cloud-gateway/src/voice/call-session-do.ts:1692-1705) now
deletes OWNER_STEP_UP_ALARM_KEY at line 1704, AFTER the handling loop instead of before it.
That closes the "handleOwnerStepUpAlarm throws" case (a throw at line 1702 propagates before
1704, so the key survives and the DO runtime retries). It does NOT close the case the
adversarial review listed first: when #resolveCore returns "unavailable" (transient D1 read
failure at call-session-do.ts:1986-1987, factory/core-construction failure at 1993/2005-2007)
or "mismatch", the loop body's `if (resolved.kind === "ready")` is false, handling is
skipped, NO exception is thrown, the loop completes, and line 1704 still deletes the key.
alarm() returns normally, so the runtime does not retry and nothing re-arms the window. The
60-second deadline is lost and the pre_auth call is never ended — a spoofed silent owner call
keeps holding a capacity slot. Probe B2 passes on BOTH heads.
Suggested fix: only delete the key on a branch that actually handled the alarm (ready core);
on "unavailable" keep the key and throw / re-arm so the runtime retries.

## Per-probe detail

### B1a/B1b/B1c — zz-reviewer-pr40-b1-replace.test.ts
Proves on 6b63d08 that INSERT OR REPLACE deletes a LEAF 0018 row without firing its BEFORE
DELETE guard (recursive_triggers=0), switching a `required` binding to the waiver and minting
owner authority with no phrase (B1a), extending the 60s window deadline (B1b), and re-opening
the one-time repeat check with a fresh unresolved row (B1c). Setup reaches pre_auth via
getOrCreateInboundSession + bindRelaySession (sets provider_connected_at for the 0007
call_session_authorities_provider_lifetime trigger) + transitionCallSession.
- 6b63d08: 3 passed.
- 337c290: 3 failed. B1a rejected with owner_call_step_up_binding_invalid at the INSERT OR
  REPLACE; B1b owner_call_step_up_window_invalid; B1c owner_call_step_up_repeat_invalid.
  (Meaningful guard RAISEs, not "no such table".)

### Sweep — zz-reviewer-pr40-sweep.test.ts
Enumerates the nine 0018 tables from sqlite_schema (survives renames; PRAGMA columns; detects
WITHOUT ROWID), then for a leaf/natural row of each tries INSERT OR REPLACE (natural key),
INSERT OR REPLACE (explicit rowid), and UPDATE OR REPLACE of each PK column. Explicit 120s
test timeout (7 fixtures + 600k-round PBKDF2 = a genuine long test, not load). On the fix head
one fixture adaptation only: the row read skips `rowid` for WITHOUT ROWID tables (asserted
behavior unchanged).
- 6b63d08: PASS (holes present). 337c290: FAIL (all holes closed).

Sweep matrix — 6b63d08 (BUGGY):
  bindings      : naturalKey=replaced  explicitRowid=replaced  updateOrReplace=blocked(binding_immutable)
  windows       : naturalKey=replaced  explicitRowid=replaced  updateOrReplace=blocked(window_immutable)
  attempts      : naturalKey=blocked:attempt_invalid   rowid=blocked:attempt_invalid   update=blocked:attempt_transition_invalid
  reprompts     : naturalKey=blocked:reprompt_invalid  rowid=blocked:reprompt_invalid  update=blocked:reprompt_immutable
  successes     : naturalKey=blocked:success_invalid   rowid=blocked:success_invalid   update=blocked:success_immutable
  repeat_checks : naturalKey=blocked:repeat_invalid(outcome!=NULL shape gate)  freshUnresolved=REPLACED  update=blocked:repeat_transition_invalid
  rejections    : naturalKey=blocked:rejection_invalid rowid=blocked:rejection_invalid update=blocked:rejection_immutable
  alerts        : naturalKey=replaced  explicitRowid=replaced  updateOrReplace=updated  (NO delete/immutability guard at all)
  guest_pin     : naturalKey=blocked:guest_call_pin_attempt_invalid  rowid=blocked  update=blocked:guest_call_pin_attempt_immutable
Holes on 6b63d08: bindings, windows, repeat_checks (via fresh-unresolved), and alerts.

Sweep matrix — 337c290 (FIX); every table now WITHOUT ROWID:
  bindings      : naturalKey=blocked:binding_invalid    explicitRowid=skipped_without_rowid  update=blocked:binding_immutable
  windows       : naturalKey=blocked:window_invalid      explicitRowid=skipped_without_rowid  update=blocked:window_immutable
  attempts      : naturalKey=blocked:attempt_invalid     explicitRowid=skipped_without_rowid  update=blocked:attempt_transition_invalid
  reprompts     : naturalKey=blocked:reprompt_invalid     explicitRowid=skipped_without_rowid  update=blocked:reprompt_immutable
  successes     : naturalKey=blocked:success_invalid      explicitRowid=skipped_without_rowid  update=blocked:success_immutable
  repeat_checks : naturalKey=blocked:repeat_invalid       freshUnresolved=blocked:repeat_invalid  update=blocked:repeat_transition_invalid
  rejections    : naturalKey=blocked:rejection_invalid     explicitRowid=skipped_without_rowid  update=blocked:rejection_immutable
  alerts        : naturalKey=blocked:owner_step_up_alert_insert_invalid  explicitRowid=skipped_without_rowid  update=updated (designed upsert)
  guest_pin     : naturalKey=blocked:guest_call_pin_attempt_invalid  explicitRowid=skipped_without_rowid  update=blocked:guest_call_pin_attempt_immutable
On the fix, no INSERT OR REPLACE form replaces a guarded 0018 row.

NEW observation (true on 6b63d08, now fixed): on the buggy head owner_call_step_up_alerts was
the one 0018 table with NO delete-forbidden and NO immutability trigger, so INSERT OR REPLACE
and UPDATE OR REPLACE both freely mutated the alert coalescing state (reset observation_count,
clear last_sent_at, or drop a row to force/suppress owner alerts). 337c290 adds an insert
guard (owner_step_up_alert_insert_invalid) and WITHOUT ROWID; the delete-via-REPLACE path is
closed. Its UPDATE OR REPLACE still succeeds ("updated"), but that is its designed coalescing
upsert, not a delete-bypass.

### B2 — zz-reviewer-pr40-b2-alarm.test.ts
See FINDING above. Builds new CallSession(state, env, null) (null factory -> #resolveCore
returns "unavailable"; also no live socket), arms a valid window alarm in DO storage
(call-session.owner-step-up-alarm.v1 — string inlined, not exported), fires alarm(), and
asserts the alarm key is deleted afterward.
- 6b63d08: PASS (bug). 337c290: PASS (STILL OPEN — key still deleted at line 1704 with no
  handling and no retry).

### B3 — zz-reviewer-pr40-b3-waiver-head.test.ts
Builds a waived inbound-owner pre_auth session, removes the passphrase head+verifier
(clearOwnerPassphraseDataForTest -> disabled/never-configured), then inserts owner authority.
- 6b63d08: PASS (waiver branch had no head check -> authority minted).
- 337c290: FAIL — authority INSERT RAISEs call_session_authority_requires_current_lineage
  (waiver branch now requires active head + verifier).

### S1 — zz-reviewer-pr40-s1-split-repeat.test.ts  (adv S1/F8, was SUSPECTED — FEASIBLE)
After success + 2.001s, the repeated phrase split into finals "ablaze abrasion" then
"abrasive" both reach the fake model (modelRequests) with no repeat_checks row on 6b63d08 —
candidate/secret words leak to model input and transcript.
- 6b63d08: PASS (bug). 337c290: FAIL — modelRequests is [] ("expected [] to include
  'ablaze abrasion'"); the fix assembles/suppresses post-success fragments before the model.
