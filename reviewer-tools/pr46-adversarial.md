# PR #46 adversarial review (head 2fdce98 vs main f0bfbe9)

No H findings. No path found that gives owner authority, re-enables step-up or sets a phrase.

## Findings

**M1: a disabled step-up ends owner calls without the fixed refusal or an alert.**
`owner-call-step-up.ts:183` throws `owner_step_up_unavailable` inside `call-session-do.ts:908`. `call-session-do.ts:2052-2055` catches it and closes the socket with code 1011, and `handleSocketClose` then marks the call `failed`. The spec (lines 119-120) says every owner call must "play a fixed refusal" until a new phrase is generated. Today there is no refusal line, no rejection receipt and no alert, so Sid never learns a spoofer called after he disabled step-up. A call already in `pre_auth` when disable commits behaves the same way (`owner-call-step-up.ts:205-206`). Authority is still correctly refused.
*Test:* disable, then place an inbound owner call. Expect the `OWNER_STEP_UP_REJECTED` frame, the `end` frame and one alert. Add a variant where disable commits in the middle of the window.

**M2: guest-grant notices are not durable.**
The notice runs inside the same request, after the commit (`owner-access-service.ts:779-795`, `:801-814`, `:820-831`, `:834-844`). Two failure cases:
- If the repository call throws after D1 has already committed (an ambiguous response), `:845-847` maps it to `owner_access_operation_failed`. The grant exists but no notice is sent.
- If the Worker isolate dies, the socket closes or the turn aborts between commit and `notify`, the notice is lost. There is no retry and no pending row. The step-up alert sink, by contrast, keeps D1 claim rows.

The spec (lines 279-281) says every grant create, permission change, PIN rotation or revoke emits a notice.
*Test:* fake repository commits then throws. Expect the notice to be sent, or a durable pending-notice row that a retry later delivers.

**M3 (regression): a rejected guest or enrollment socket is no longer closed after eviction.**
`#resolveCore(socket, true)` (`call-session-do.ts:2037`, `:2110`) now returns a core for `rejected` sessions. `:2047-2049` then sends every frame to `handleOwnerStepUpAlarm`. For `guest_pin` and `owner_enrollment` interactions that method only clears the alarm and returns (`:1309-1312`), so the socket stays open. Before this PR (f0bfbe9), a frame after eviction got `mismatch` and a 1008 close. That was the only close path for a guest rejected at `:1524`/`:1529`, because those transitions send no `end` and no close. Result: a billed ConversationRelay session stays open after an unverified guest fails.
*Test:* three wrong guest PINs, hibernate, send a prompt. Expect a 1008 close or an `end` frame.

**M4 (low likelihood): near-miss disable commands go to the model.**
`/disable-owner-step-up@Bot --confirm` and `/Disable-owner-step-up --confirm` parse as plain text (`telegram-commands.ts:23`, `:88-93`; a test asserts `{kind:"text"}`). They then reach `replyTo`, so DeepSeek answers (`index.ts:352-366`). The model can reply in prose as if step-up were disabled during a compromise response. `index.ts:239-240` exists to prevent exactly that.
*Test:* the addressed and capitalized forms never call the model and get the fixed usage reply.

**L1: after eviction the refusal is repeated and the alert count goes up.**
Completed delivery is only remembered in memory, per isolate (`call-session-do.ts:1159-1175`). A new core on a `rejected` session runs the full delivery again (`:1316-1319`): a second refusal line, a second `end` frame, and `alert()` adds 1 to `observation_count` (`owner-call-step-up.ts:422-438`). If more than 15 minutes have passed, Sid gets a second Telegram alert. It triggers when the Durable Object hibernates between the `end` frame and Twilio's close event.
*Test:* finish a rejection, hibernate, close the socket. Expect one refusal frame and `observation_count` 1.

**L2: the rejection alert does not mention the recovery command.**
The spec (lines 121-122) says rejection alerts link to this recovery action. The text at `owner-call-step-up.ts:448-450` does not.
*Test:* alert text contains `/disable-owner-step-up --confirm`.

**L3: disable works from a group chat and replies in the group.**
Neither the classifier nor the 0017 trigger checks the chat type. The confirmation is posted to `accepted.chatId` (`index.ts:263-264`), so group members see that step-up was disabled. Separately, the confirmation is best-effort: if the send fails under `waitUntil`, the receipt is committed with nothing shown to Sid. Re-sending the command then correctly answers `already_disabled`.
*Test:* a negative (group) chat id is refused, or the reply goes to the owner's private chat.

## Checked and sound
- **Authority:**
  - The adapter checks the owner principal and the exact text (`telegram-owner-step-up-command.ts:34-38`).
  - The 0017 trigger (`0017:242-283`) binds the receipt to the owner's verified Telegram subject, the `telegram.update` receipt, the exact payload text and a 5-minute window, and `authorization_event_id` is UNIQUE.
  - An authenticated guest is refused.
  - `edited_message` and `channel_post` are rejected by the classifier.
  - Replayed update ids never invoke `onAccepted`.
  - A missing `--confirm`, extra arguments, a second line, a non-breaking space or a trailing space all fail closed (usage reply, or the exact-text throw).
  - Concurrent disables resolve to `already_disabled` via `stateChanged`.
  - No Telegram or call path writes a rotation commit or a phrase, so re-enable stays device-signed only.
- **Disable takes effect:**
  - Authority rehydrate, management and access-change checks require an active head and verifier (`voice-access-repository.ts:1380-1389`, `:1576-1590`, `:1606-1617`).
  - Attempt, success and waiver guards require an active head, so active owner calls go stale on their next authorization.
  - Nothing is exploitable while step-up is disabled. After re-enable the old success receipts no longer match the new verifier version.
- **Racing reprompt against match:** the 0018 success guard requires `pre_auth` and the rejection guard requires no success, so a rejected session cannot mint authority.
- **Notice content:**
  - The text is fixed: operation, masked number (2-character prefix plus last 4 digits) and ISO time.
  - No PIN or permission detail.
  - Sent only after the commit completes; `list` sends nothing; a failure never rolls back the commit.
- **750 ms deadline:**
  - Voice only.
  - A failed retrieval resolves to a fallback, so there is no unhandled rejection.
  - The timer is cleared and a late result is ignored, with no partial context.
  - The abort signal is still checked before the model call.
  - The retriever only runs SELECTs, so a retrieval that outlives the timeout reads but never writes.
- **F1, F2, F3, F5:**
  - One shared delivery per isolate.
  - After a failed alarm clear, a retry only clears the alarm again.
  - A socket close always sets the terminal phase, even if the alarm clear fails.
  - Late-fragment and assembly-alarm reprompts cannot both run.
  - D1 triggers back up every guard.
