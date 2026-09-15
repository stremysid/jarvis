import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { CallSession } from "../../src/voice/call-session-do.js";

// Reviewer probe for PR #40, finding B2 (adv40.md B2, pr40-adversarial F5).
//
// CallSessionDO.alarm() (call-session-do.ts:1634) deletes OWNER_STEP_UP_ALARM_KEY
// BEFORE the step-up handler runs. If handling then does not run to completion —
// e.g. #resolveCore returns "unavailable" on a transient D1/runtime hiccup, or no
// live core is present — the stored 60-second deadline is discarded and the
// Durable Object never re-arms it, so the window can never end the call. alarm()
// returns normally, so the runtime does not retry; a spoofed silent owner call
// then holds a capacity slot indefinitely.
//
// This probe ASSERTS THE BUG on head 6b63d08: after a single alarm() where no core
// resolves, the stored alarm key is gone and no alarm is rescheduled.
//
// The private key string is inlined because it is a stable storage key not exported
// by the module (call-session-do.ts:66).
// Expected on a fix ("delete the key only after handling succeeds; otherwise keep
// it and throw/re-arm so the runtime retries"): the key REMAINS after this alarm()
// (or alarm() throws) — so `toBeUndefined()` on the key fails, or the alarm() await
// rejects. Not a "no such table/column" failure.

const OWNER_STEP_UP_ALARM_KEY = "call-session.owner-step-up-alarm.v1";
const SESSION_ID = "01k3wceg0000000000000000b2" as Ulid;
const DEADLINE_AT = "2099-01-01T00:01:00.000Z";

describe("reviewer probe PR #40 B2 — alarm key deleted before handling loses the deadline", () => {
  it("discards the stored step-up alarm and does not re-arm it when no core handles the alarm", async () => {
    // A null runtime factory forces #resolveCore to return "unavailable" for any
    // socket — the transient-failure path where handling cannot run to completion.
    const stub = env.CALL_SESSION.getByName(SESSION_ID);

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      const object = new CallSession(state, env, null);

      // Arm a valid window alarm exactly as #armOwnerStepUpAlarm would.
      await state.storage.put(OWNER_STEP_UP_ALARM_KEY, Object.freeze({
        sessionId: SESSION_ID,
        lifecycleGeneration: 1 as const,
        kind: "window" as const,
        deadlineAt: DEADLINE_AT,
      }));
      await state.storage.setAlarm(new Date(DEADLINE_AT));

      expect(await state.storage.get(OWNER_STEP_UP_ALARM_KEY)).toBeDefined();
      expect(await state.storage.getAlarm()).not.toBeNull();

      // Fire the alarm. Handling cannot run (factory is null → "unavailable"),
      // but the key was already deleted at the top of alarm().
      await object.alarm();

      // THE BUG: the stored deadline is gone even though no core handled the alarm.
      // When the still-scheduled platform alarm next fires, alarm() finds no key and
      // just clears it, so the 60-second window can never end the call and no retry
      // can recover it.
      expect(await state.storage.get(OWNER_STEP_UP_ALARM_KEY)).toBeUndefined();

      // A retry (as the runtime would issue if handling had thrown) finds no key
      // and clears — still nothing ends the call.
      await object.alarm();
      expect(await state.storage.get(OWNER_STEP_UP_ALARM_KEY)).toBeUndefined();

      await state.storage.deleteAll();
    });
  });
});
