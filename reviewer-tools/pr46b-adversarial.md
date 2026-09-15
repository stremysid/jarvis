# PR #46 round-2 adversarial review (91fe8be vs round-1 2fdce98)

No H findings. No path gives owner authority to a disabled-head, rejected or guest call. No path forges or steals an outbox claim.

## Findings

**M1: a failed rejection alert is lost for good once the delivery marker is written.**
`call-session-do.ts:1214-1226` swallows any `alert()` failure. Examples: Telegram 5xx or timeout at `owner-call-step-up.ts:535-538`, or no owner chat at `:523-524`. `:1227` then records `owner_call_step_up_rejection_deliveries` anyway. After that, `:1203` returns early on every retry path (alarm, frame, close), and `:1190` clears the alarm. No job drains `owner_call_step_up_alerts` (`job-table.ts:197-218` drains only guest notices). The stuck claim is only retried by the *next* rejection. Result: one spoofed call during a Telegram blip means Sid never hears about it. N1 turned the round-1 duplicate into a silent miss.
*Test:* the alert sink throws once. Expect the rejection to finish, then after evict plus close or alarm, exactly one Telegram alert. Fix direction: write the marker only after `alert()` resolves, or give alerts a drained outbox.

**M2: a disabled head still ends waived passed-A owner calls with a 1011 close.**
`ownerStepUpRequirement` ignores head status (`owner-call-step-up.ts:121-128`, used at `inbound.ts:405`). When the policy is `waive_on_passed_a` and attestation is passed-A, the binding is `waived_passed_a`. `assertWaiverAvailable` then throws `owner_step_up_unavailable` (`owner-call-step-up.ts:285`, called at `call-session-do.ts:914`). That propagates to the 1011 close at `:2072-2075`. There is no refusal, no `end` frame, no rejection row and no alert. `#recordDisabledRejection` (`owner-call-step-up.ts:426`) and the 0021 guard (`0021:63`) accept only `requirement = 'required'`. S1 is therefore unmet whenever the non-default policy is set, and that is the policy a leaked-phrase response is most likely to hit.
*Test:* set policy `waive_on_passed_a`, disable, place an inbound passed-A owner call. Expect the refusal, `end`, one alert and no 1011.

**L1: guest notices are sent at least once, not exactly once.**
The idempotency key does nothing: `telegram-provider.ts:11-17` drops it on purpose. Two ways a notice is sent twice:
- Telegram accepts the message, then the `delivered` UPDATE (`guest-grant-notice.ts:555-559`) fails, the isolate dies, or the 10 s timeout fires. The catch releases the claim (`:564-573`) and the next drain sends again.
- `drain` passes one `now` to every row (`:577-590`), so a claim taken late in a slow drain is already past its expiry (`:528`). A concurrent `notify` with a fresh clock can clear and re-claim it (`:521-534`) while the first send is still in flight.

The only harm is a duplicate informational message.
*Test:* the fake send succeeds and the delivered UPDATE throws, then drain runs. Expect one send (today: two). Second test: advance the clock 40 s between rows.

**L2: an undeliverable notice fails silently, forever, and can block newer ones.**
There is no attempt count, terminal state or owner alert. Drain re-selects the oldest pending rows each time (`guest-grant-notice.ts:582-584`, `ORDER BY created_at LIMIT 10`). Ten rows that always fail (for example `maskNumber` throwing at `:486-487`) would stop every newer row from being retried. Today nothing produces such a row, so the likelihood is low.
*Test:* 10 rows that cannot be masked plus 1 valid row. Expect the valid row delivered, or a surfaced dead-letter count.

**L3: edge cases around the delivery marker.**
- **Marker already written:** `call-session-do.ts:1203` returns without closing the socket. If Twilio has not closed after `end`, each later frame goes through `:2067-2069` → `:1336-1339` → return, and the relay stays open until the provider times out.
- **Marker write fails:** if `recordRejectionDelivered` throws (`:1227`), the memo is cleared (`:1182`). The next event repeats the refusal and `end`, and adds 1 to `observation_count` (coalescing hides the second Telegram).

*Test:* marker present, resume, send a prompt. Expect a 1008 close. Second test: marker insert fails once. Expect one refusal frame.

**L4: some near-miss disable commands still reach the model.**
- `/disable-owner-step-up@OtherBot --confirm` returns `{kind:"text"}` (`telegram-commands.ts:98-105`) and goes to `replyTo` (`index.ts:380`).
- `/disable-owner-step-up--confirm`, `/disable-owner-stepup --confirm` and Unicode-hyphen variants match neither pattern (`:23`, `:39`, `:88-91`), so they are also text.

Minor related point: the `private_chat_required` reply is posted into the group (`index.ts:276-277`), which tells group members the feature exists.
*Test:* each of these forms produces zero model calls and a fixed reply.

## Checked and sound
- **Same-write notice:**
  - Each of create, replace, rotate and revoke puts its notice INSERT in the same `batch`, with a checked changes count (`voice-access-repository.ts:1077/1160/1234/1300`, results at `:1083-1086` and similar).
  - The 0021 guard ties the row to the event id, `created_at`, event type and owner principal. `activated` (`:1550`) is correctly not notified.
  - An idempotent replay returns before the batch.
  - `#mutateAndNotice` checks the outbox even when the repository throws.
- **Claim integrity:**
  - The transition trigger forbids one claim replacing another, any change after delivery, going straight from unclaimed to delivered, key edits and deletes.
  - The delivered UPDATE only succeeds for the matching `claim_id`.
  - Every 0021 BEFORE INSERT guard checks for an existing row first, so INSERT OR REPLACE aborts before a conflicting row can be deleted. UPDATE OR REPLACE cannot change a primary key.
- **Crash recovery:** a pending row with an expired or absent claim is retried by the `*/5` drain (`wrangler.toml:60`). A Worker death between commit and send is recovered within 5 minutes.
- **Notice content:** fixed operation text, masked E.164 number and ISO time, sent only to the sole verified owner Telegram subject (a private user id).
- **Disabled-head rejection for `required` bindings:**
  - 0017 sets the verifier to `revoked`, which matches the 0021 guard.
  - `pre_auth` plus NOT EXISTS makes disabled rejection, ordinary rejection and success mutually exclusive.
  - A disable that commits mid-verification makes the attempt or match insert raise, and that maps to `rejected` (`owner-call-step-up.ts:227-242`).
  - begin, prompt, interrupt, reprompt and alarm all reconcile.
  - The marker is written *after* the refusal, `end` and alert attempts. A crash before the marker re-runs delivery rather than skipping it.
  - The alert text names the recovery command.
- **Resume gating:**
  - A cached rejected guest or enrollment core gets a 1008 close (`call-session-do.ts:2116-2118`).
  - An uncached one needs a `required` owner binding that is not activation-only (`:2138-2151`) and the `owner_step_up` interaction (`:2168`, constructor `:756-764`).
  - A guest PIN rejection keeps `guest_pin`, so it gets mismatch.
  - `terminate()` writes `TERMINATION_KEY` (`:1895`) before its `rejected` transition, so that path gets mismatch too.
- **Telegram:**
  - Case and addressed forms get an empty argument and the usage reply, with no model call.
  - The private check compares `chatId` with `telegramUserId`. Group and supergroup ids are negative, so they cannot equal a positive user id.
  - `edited_message`, channel and business updates are rejected by the classifier.
  - A forward still needs the owner's own message with the exact text.
- **Remote D1:**
  - All 0021 triggers use a WHEN clause with `SELECT RAISE` in BEGIN.
  - No trigger has `CASE … RAISE` or a CTE.
  - The `CASE` in `state()` is a runtime SELECT, not a trigger.
  - The AFTER INSERT terminalize trigger copies the existing 0018 pattern.
