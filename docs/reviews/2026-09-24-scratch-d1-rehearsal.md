# Scratch D1 rehearsal — 2026-09-24

**Result: PASS.** The reviewer ran this on a throwaway remote D1, created and
deleted through the Cloudflare API. Sid authorized that rehearsal in the
orchestrator chat on 2026-09-24: "2: yes". Production application and deployment
were not performed by this rehearsal and remain Sid's separate actions.

Recorded by **Codex GPT-6 Astra, headless cloud docs builder,
claude/friendly-hawking-qjcyia**, from the reviewer's rehearsal, not from a new run.
Sources: the harness-supplied `SUMMARY.md`, `table.md` and `seeds.sql` in its
2026-09-24 rehearsal scratch directory. Database and account identifiers are omitted.
The copied baseline/candidate migration files match this checkout byte-for-byte.

## What ran

1. Baseline `0001`–`0035` plus `0038`: **36 files, 702 statements**, all successful.
2. Synthetic seeds described below, followed by `0039`, `0040`, `0043` and `0045`
   in that order: **3/3, 15/15, 4/4 and 7/7 statements**, respectively.
3. Object and trigger checks: **23/23 new objects present**; every new trigger
   rejected the bad write and allowed the good write used in the rehearsal.
4. `0045` rewrite and duplicate-pairing pre-check, including a separate duplicate
   failure case and rollback observation.
5. Open [#174](https://github.com/stremysid/jarvis/pull/174)'s `0044` applied **after
   `0045`**, **38/38 statements**. `PRAGMA foreign_key_check` returned no violations.

Main's observed pending set is `0039`, `0040`, `0043`, `0045`; `0044` is on #174.
`0036`, `0037`, `0041` and `0042` are absent. This successful out-of-number-order
scratch application does not stand in for review or owner production authority.
No candidate contains `CASE…RAISE` or `WITH RECURSIVE`.

## Per-file results

D1 SQL milliseconds are the sum of per-statement `sql_duration_ms`, not total
wall time or a production-duration estimate. Table transcribed from `table.md`.

| # | File | Phase | Result | Statements | D1 SQL ms (sum of per-statement sql_duration_ms) |
|---|---|---|---|---|---|
| 1 | 0001_foundation.sql | baseline | success | 53 | 10.3754 |
| 2 | 0002_foundation_hardening.sql | baseline | success | 9 | 2.4252 |
| 3 | 0003_calling.sql | baseline | success | 10 | 3.0628 |
| 4 | 0004_call_sessions.sql | baseline | success | 25 | 5.6735 |
| 5 | 0005_conversation.sql | baseline | success | 21 | 4.2160 |
| 6 | 0006_voice_access.sql | baseline | success | 46 | 43.8962 |
| 7 | 0007_voice_access_boundaries.sql | baseline | success | 8 | 6.5591 |
| 8 | 0008_autonomy.sql | baseline | success | 10 | 1.4015 |
| 9 | 0009_decisions.sql | baseline | success | 12 | 2.3499 |
| 10 | 0010_projects.sql | baseline | success | 7 | 1.3879 |
| 11 | 0011_deadlines.sql | baseline | success | 9 | 1.5892 |
| 12 | 0012_liveness.sql | baseline | success | 3 | 1.1127 |
| 13 | 0013_scheduled_runs.sql | baseline | success | 2 | 0.6554 |
| 14 | 0014_memory_projection.sql | baseline | success | 29 | 7.4513 |
| 15 | 0015_voice_runtime.sql | baseline | success | 11 | 11.4506 |
| 16 | 0016_cloud_memory.sql | baseline | success | 121 | 30.0206 |
| 17 | 0017_owner_passphrase.sql | baseline | success | 18 | 4.3724 |
| 18 | 0018_owner_call_step_up.sql | baseline | success | 42 | 9.2694 |
| 19 | 0019_memory_ingress.sql | baseline | success | 2 | 0.9058 |
| 20 | 0020_school_catchup.sql | baseline | success | 31 | 6.4810 |
| 21 | 0021_voice_owner_delivery.sql | baseline | success | 14 | 4.5057 |
| 22 | 0022_university_tracker.sql | baseline | success | 27 | 6.0528 |
| 23 | 0023_study_coach.sql | baseline | success | 22 | 6.4554 |
| 24 | 0024_university_application_workflow.sql | baseline | success | 11 | 2.4958 |
| 25 | 0025_archive_literal_history.sql | baseline | success | 12 | 3.4499 |
| 26 | 0026_memory_distillation.sql | baseline | success | 15 | 30.8065 |
| 27 | 0027_school_observations.sql | baseline | success | 19 | 4.6627 |
| 28 | 0028_guest_grant_notice_drain.sql | baseline | success | 5 | 1.7196 |
| 29 | 0029_university_application_details.sql | baseline | success | 15 | 3.5448 |
| 30 | 0030_study_coach_weak_spots.sql | baseline | success | 13 | 58.5522 |
| 31 | 0031_memory_backup.sql | baseline | success | 22 | 5.1152 |
| 32 | 0032_memory_living_notes.sql | baseline | success | 32 | 8.7968 |
| 33 | 0033_d2l_notification_email.sql | baseline | success | 11 | 3.0575 |
| 34 | 0034_scheduled_run_detail.sql | baseline | success | 1 | 32.6077 |
| 35 | 0035_autonomy_tool_capabilities.sql | baseline | success | 1 | 0.7492 |
| 36 | 0038_memory_lifetime_and_pins.sql | baseline | success | 13 | 35.8660 |
| 37 | 0039_tool_confirmation_consumptions.sql | candidate | success | 3 | 1.0428 |
| 38 | 0040_school_collector_keys.sql | candidate | success | 15 | 4.4893 |
| 39 | 0043_guided_assignment.sql | candidate | success | 4 | 1.3094 |
| 40 | 0045_school_collector_hosts.sql | candidate | success | 7 | 54.9376 |
| 41 | pr174_0044_owner_channel_parity.sql | optional #174 | success | 38 | 8.0382 |

## Synthetic seeds and rewrite result

No production rows or personal assignment content were copied. The supplied
seed SQL used synthetic identities, device/Telegram relationships, a conversation
event and turn, decisions and responses, deadline sources, deadlines and children.
Only their roles are recorded here; synthetic key material and identifiers are omitted.

- One answered collector-pairing decision, one answered tier-3 confirmation, and
  an open tier-3 decision sharing the latter's origin reference. The two tier-3
  rows check that `0045`'s partial uniqueness rule applies only to collector pairing.
- Two legacy LDSB collector sources, one with a recorded health failure. Controls
  were an already host-qualified LDSB source, a Classroom source and a non-collector
  Brightspace source.
- Five deadlines: three under legacy LDSB sources, one under the already-qualified
  source and one Classroom control. Fixtures include open/submitted status, a
  reminder timestamp, two revisions and an exam quiet window.

The recorded `0045` outcome was **two LDSB sources copied, three deadlines
repointed and two legacy sources deactivated**. Deadline ids, statuses and reminder
state remained unchanged. This is a result on those seeds, not a claim about all
possible existing production rows.

## The pre-check and duplicate case

The rehearsal's pre-check returned **0 groups**:

```sql
SELECT principal_id, origin_reference, COUNT(*) AS rows_per_key,
       GROUP_CONCAT(decision_id) AS decision_ids
FROM decision_items
WHERE origin = 'school-collector-pair'
GROUP BY principal_id, origin_reference
HAVING COUNT(*) > 1;
```

A separately seeded duplicate makes **statement 4 of `0045` fail**. D1 rolled
back the **whole call**; a plain rerun after fixing the duplicate succeeded.
**Do not split-retry the failed call.** Recheck production for duplicate groups
before its application; the scratch result says nothing about production's rows.

## Limits and next actions

Synthetic rows establish the observed schema, trigger and rewrite behavior only.
They do not measure production volume, lock duration, live collector uploads,
provider delivery or device acceptance. The optional #174 schema result is
compatibility evidence for the tested file, not a channel-parity code review.
The scratch database was deleted after the run, per the harness record.

- Before production application: finish the required reviews, recheck the exact
  migration set and run the duplicate pre-check on the authorized production path.
- At Sid's production rollout: follow the reviewed runbook and [OWNER-ACTIONS](../OWNER-ACTIONS.md);
  application and deployment remain **not started** at this record's observation.
