import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createFakeCallingSystem } from "./voice-call-system.js";

// PR33 PROBE ONLY. The contract never speaks a correct phrase, so this flaw is invisible to it.
// Deepgram-style final text: capitalised and punctuated.
const CORRECT_PHRASE_AS_TRANSCRIBED = "Correct horse battery.";

describe("PR33 probe gap 1: the success path is never exercised", () => {
  it.each(["inbound", "outbound"] as const)(
    "an %s owner who says the right phrase has it committed as a turn and sent to the model",
    async (direction) => {
      const system = await createFakeCallingSystem();
      try {
        if (direction === "inbound") {
          expect((await system.inbound()).status).toBe(200);
        } else {
          await expect(system.dispatch()).resolves.toMatchObject({ status: "dispatched" });
          expect((await system.claimOutboundTwiML(system.acceptedCallSid())).status).toBe(200);
        }
        const call = await system.openRelay();
        await call.setup();
        await call.prompt(CORRECT_PHRASE_AS_TRANSCRIBED);
        const events = JSON.stringify((await env.DB.prepare("SELECT envelope_json FROM events").all()).results);
        const requests = await call.modelRequests();
        const authorities = await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM call_session_authorities WHERE session_id = ? AND authority_kind = 'owner'",
        ).bind(call.sessionId).first<{ count: number }>();
        expect({
          phase: await call.phase(),
          ownerAuthorities: authorities?.count,
          phraseInEvents: events.includes("Correct horse battery"),
          phraseInModelUserText: requests.some((request) => request.userText.includes("Correct horse battery")),
          conversationTurns: await system.conversationTurnCount(),
        }).toEqual({
          phase: "active",
          ownerAuthorities: 1,
          phraseInEvents: true,
          phraseInModelUserText: true,
          conversationTurns: 1,
        });
      } finally {
        await system.cleanup();
      }
    },
  );
});
