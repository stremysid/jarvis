No caller-level authority bypass was found with the waiver off, which is the
shipped default. The reviewer read the cited code for every blocker below.

**B1 (F1–F3). `INSERT OR REPLACE` bypasses the 0018 guards, and the binding
case mints owner authority.**
- `owner_call_step_up_bindings_insert_guard` (104–141) validates only the new
  row's shape. It never rejects an existing key.
- REPLACE deletes the existing binding without firing
  `owner_call_step_up_bindings_delete_forbidden`, because `recursive_triggers`
  is 0. The #39 probes proved that on this runtime.
- So `INSERT OR REPLACE INTO owner_call_step_up_bindings` can turn an inbound
  owner session's `required` binding into
  `waived_passed_a / passed_a / waive_on_passed_a`. The shape guard accepts that
  for an inbound owner session.
- The authority trigger's waiver branch (495–498) checks only those binding
  fields, not the waiver setting, so owner authority is inserted with no phrase.
- The same pattern lets the 60 s window be re-inserted with a later deadline
  (`owner_call_step_up_windows`, 155–175), and the one-time repeat check be
  reset (`owner_call_step_up_repeat_checks`, 410–429).

Fix:
- Add an existing-key (and existing-rowid) rejection to every 0018 insert guard,
  or declare the tables `WITHOUT ROWID` plus key guards.
- Make `bind()`, `begin()` and `expire()` read-then-insert, so Twilio webhook
  retries stay idempotent.
- Add a REPLACE sweep test over every 0018 table.

The #39 findings are the same class. Fix both with one shared pattern.

**B2 (F5). A D1 hiccup at the deadline leaves a silent call open forever.**
`CallSessionDO.alarm()` deletes `OWNER_STEP_UP_ALARM_KEY` (`call-session-do.ts`
1634) before `handleOwnerStepUpAlarm` runs. If handling throws, Durable Objects
retry the alarm, but the retry sees no stored alarm and just clears it. The
60-second window therefore never ends that call. Two such spoofed calls hold
both owner slots and block Sid's own inbound calls. Fix: delete the key only
after handling succeeds, and make handling idempotent. Add a test where the
first alarm attempt throws.

**B3 (F4). The dormant waiver ignores a disabled or unconfigured verifier.**
The waiver branch (`0018` 495–498, `call-session-do.ts` 919–931, and the
`voice-access-repository.ts` waiver path) never checks the passphrase head. With
the waiver on, `/disable-owner-step-up` would not stop waived calls. It is off
today, but the fix belongs in `0018` before it is applied: require the head to
be `active`, with a current verifier, in the waiver branch.

**S1 (F8, suspected). Split-final repeat suppression.** If speech-to-text
splits a repeated phrase into fragments after "Verified.", the fragment check
(`owner-call-step-up.ts` 249–251) misses it. The words then reach model input
and the transcript, which the design forbids. Either assemble fragments inside
the post-success guard window before the repeat check, or record the design
limit and add a test.

**S2. The voice gate is timing-sensitive at the default 5 s.**
- On an otherwise idle machine, the full `pnpm test:voice-access` run here
  passed 806 of 811. There were 4 × "Test timed out in 5000ms" (the KAT, step-up
  success receipt, guest hibernation limit and inbound 5xx cleanup tests), plus
  one cascade assertion in the guest-log test.
- The same 4 files passed 70 of 70 when run alone.
- 600,000-round PBKDF2 tests under the gate's own file parallelism sit right at
  the limit. `pnpm release:voice-gate` must be reliable, so set explicit
  timeouts on the KDF-heavy tests, or lower the gate's concurrency.

**Lows (see the report).**
- Eviction doesn't restore the deadline, so stray alarms consume re-prompts and
  can refuse a correct phrase in that call.
- A mid-verify final starts a new fragment.
- An attempt's `resolved_at` is stamped before the KDF, so a late success can
  land after the window.
- A verifier crash ends the call without the refusal line, `<Hangup/>` or
  alert.
- The outbound slot reservation only holds when both inbound calls are exactly
  `pre_auth`.
