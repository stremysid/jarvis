## 2026-09-15 20:57 UTC — Claude Opus 5, PR #46 round-3 max re-review at 2c67441: cleared

This re-review covers fix commit `e719d65`, the merge of main `deea39c` (`bac7a8d`) and the mailbox head `2c67441`. The fixes address S1, S2, F1 and L1–L4 from the 18:11 UTC round-2 entry. GitHub reports MERGEABLE, and the migration audit still holds: this PR alone adds `0021`, main owns through `0022`, and #50 and #51 add none.

**Local checks on 2c67441** (Windows 11, `jarvis-pr40`, run one at a time while builder sessions were also active on this PC): lint, typecheck and `typecheck:voice-access` pass. `pnpm test` passes 3,217/3,217 with 0 timeouts. The serialized `pnpm test:voice-access` gate passes 6/6 runner checks and 874/874 tests with 0 timeouts.

**Contract gap ports** (`port46b-*.diff` against the five step-up test files). Every patch applied, and the base passes 240/240. All nine gaps are killed:

| Gap | Failed tests |
|---|---|
| gap0 | 25 (2 of them timeouts) |
| gap1 | 14 |
| gap2b | 1 |
| gap3b | 1 |
| gap3c | 3 |
| gap3d | 2 |
| gap3e | 2 |
| gap6 | 2 |
| gap6b | 1 |

**#40 round-4 core probes.** Q1c, Q2c, Q3c and Q6c still fail on this head, so the double-completion and alarm-clear bugs stay fixed after the S1 change.

**0021 trigger coverage** (`mut46d-triggers.json`, whole-block removal of all 10 triggers). `BASE` passes. All ten removals are killed by named behavioural tests, with 0 timeouts. The syntax inventory also fails each time, but it is no longer the only thing that does.
- **The six guards that were inventory-only in round 2 now fail behaviour:**
  - disabled-rejection and rejection-delivery `immutable` / `delete_forbidden` fail "keeps disabled rejections and completed rejection deliveries…";
  - notice `transition_guard` / `delete_forbidden` fail "refuses delivered notice rewrites, rollback to pending…".
- **The three insert guards** fail the `INSERT OR IGNORE` / `INSERT OR REPLACE` collision sweep.
- **`owner_call_step_up_disabled_rejections_terminalize`** fails four tests, including "rejects a disabled passed-A waiver with the fixed refusal", which is the F1 regression.

**Round-2 findings, verified by reading:**
- **S1 is fixed.** A failed Telegram alert now propagates out of `#deliverOwnerStepUpRejection` before `recordRejectionDelivered` runs. `#rejectOwnerStepUp` drops the cached delivery promise and rethrows, so the alarm isn't cleared and a later alarm or eviction retries. `D1OwnerStepUpAlertSink` releases its claim on any failure. On that retry the neutral refusal and `end` are sent again, both inside their existing try/catch; that is acceptable.
- **F1 is fixed.** When `assertWaiverAvailable` reports `owner_step_up_unavailable`, the call reconciles state and goes through the same durable refusal, `end`, rejection row and alert path. The `0021` disabled-rejection guards, the disabled-head query and the eviction resume query now accept `waived_passed_a`.
- **L1 is fixed:** `D1GuestGrantNoticeSink.drain` takes an injected clock per row. **L3 is fixed:** a resumed rejected socket whose marker is present is closed with 1008. **L4 is fixed:** addressed-other-bot, missing-space, missing-hyphen and Unicode-hyphen forms get the fixed zero-model usage reply, and the private-chat refusal goes to the owner's private chat. **L2** (bounded at-least-once delivery, poison rows) is recorded in KNOWN_ISSUES.

**No new findings.** S1, S2, F1, L1, L3 and L4 from the round-2 entry are fixed, and L2 is recorded in KNOWN_ISSUES.

**Next.** The reviewer merges this head. The next calling PR moves the R1 live-evidence contract to the passphrase design, including the sixth `owner-step-up-refused` record that `docs/runbooks/voice-smoke.md` still marks as superseded.

Merging turns nothing on. This code needs `0021` applied before deploy. Sid retains deploy, inbound-calling and live-call authority.

---
