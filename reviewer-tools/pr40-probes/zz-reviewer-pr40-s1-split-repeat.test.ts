import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Ulid } from "../../../packages/contracts/src/index.js";
import { createFakeCallingSystem, type FakeCallingSystem } from "./voice-call-system.js";
import { FAKE_OWNER_PASSPHRASE } from "./voice-access-system.js";

// Reviewer probe for PR #40, finding S1 (adv40.md S1, pr40-adversarial F8, SUSPECTED).
//
// After "Verified.", verifyRepeat (owner-call-step-up.ts:249-251) canonicalizes each
// final on its own. A repeated phrase that STT splits into fragments ("ablaze abrasion"
// then "abrasive") fails canonicalization per fragment, so verifyRepeat returns
// "continue" WITHOUT reserving a repeat check, and the fragments flow into
// conversation.handleTurn — reaching model input and the transcript, which the design
// forbids for candidate text.
//
// This probe ASSERTS THE BUG on head 6b63d08: after success, split fragments of the
// phrase reach the fake model and no repeat-check row is created for them.
//
// Expected on a fix (assemble post-success fragments in a short window before the
// repeat compare and suppress a candidate-shaped assembly): the fragments are held /
// suppressed and do NOT reach the model — so the `toContainEqual` model-request
// expectation fails. Not a "no such table/column" failure.

const FRAGMENT_A = "ablaze abrasion"; // first two of the three secret words
const FRAGMENT_B = "abrasive";        // final secret word

let system: FakeCallingSystem | null = null;
afterEach(async () => { await system?.cleanup(); system = null; });

async function repeatCheckRows(sessionId: Ulid): Promise<number> {
  return (await env.DB.prepare(
    "SELECT count(*) AS n FROM owner_call_step_up_repeat_checks WHERE session_id = ?",
  ).bind(sessionId).first<{ n: number }>())?.n ?? 0;
}

describe("reviewer probe PR #40 S1 — split-final phrase repeat leaks to the model after success", () => {
  it("forwards STT fragments of the repeated passphrase to model input past repeat suppression", async () => {
    system = await createFakeCallingSystem();
    expect((await system.inbound()).status).toBe(200);
    const call = await system.openRelay();
    await call.setup();
    await call.prompt(FAKE_OWNER_PASSPHRASE);
    expect(await call.phase()).toBe("active");

    // Leave the 2-second blanket post-success suppression window.
    system.advanceTime(2_001);

    // The owner repeats the phrase, but STT splits it into two finals.
    await call.prompt(FRAGMENT_A);
    await call.prompt(FRAGMENT_B);

    const userTexts = (await call.modelRequests()).map((request) => request.userText);
    // THE BUG: fragments of the secret phrase reached the model / transcript.
    expect(userTexts).toContain(FRAGMENT_A);
    expect(userTexts).toContain(FRAGMENT_B);
    // The per-fragment repeat compare never engaged (canonicalization failed), so no
    // repeat-check row exists for these leaked fragments.
    expect(await repeatCheckRows(call.sessionId)).toBe(0);
  });
});
