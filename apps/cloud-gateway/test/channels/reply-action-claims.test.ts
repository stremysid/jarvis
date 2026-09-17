import { describe, expect, it } from "vitest";
import type { ModelAdapter, ModelAdapterStreamInput, ModelToken } from "../../src/model/model-types.js";
import { Redactor } from "../../src/security/redaction.js";
import { guardSchoolReply } from "../../src/school/school-catchup-model.js";
import {
  DelegatedReplyTracker,
  ReplyActionClaimGuardModelAdapter,
  guardReplyActionClaims,
  issueReplyActionReceipt,
  issueReplyActionToken,
  type ReplyActionReceipt,
} from "../../src/channels/reply-action-claims.js";
import {
  BENIGN_HONEST_REPLIES,
  FALSE_EXTERNAL_ACTION_CLAIMS,
  TRUE_IN_APP_ACTION_REPLIES,
} from "../fixtures/reply-action-claim-corpus.js";

const TURN = "01k58n6a000000000000000000";
const OTHER_TURN = "01k58n6a000000000000000001";

function input(): ModelAdapterStreamInput {
  return {
    correlationId: TURN,
    principalId: "principal:owner",
    channel: "telegram",
    userText: "help",
    context: [],
    reasoningEffort: "low",
    firstTokenTimeoutMs: 40_000,
    timeoutMs: 90_000,
    contextTokenBudget: 32_000,
    maxOutputCharacters: 8_000,
    signal: new AbortController().signal,
  };
}

async function collect(stream: AsyncIterable<ModelToken>): Promise<string> {
  let text = "";
  for await (const token of stream) text += token.text;
  return text;
}

function model(tokens: readonly ModelToken[]): ModelAdapter {
  return Object.freeze({
    async *stream(): AsyncIterable<ModelToken> {
      yield* tokens;
    },
  });
}

const falseClaims = Object.entries(FALSE_EXTERNAL_ACTION_CLAIMS)
  .flatMap(([group, claims]) => claims.map((claim) => [group, claim] as const));

describe("owner Telegram reply action claims", () => {
  it("measures the pre-existing school-only guard against the copied b1r3 corpus", () => {
    const redactor = new Redactor();
    const claimsStillShown = falseClaims.filter(([, claim]) => guardSchoolReply(claim, redactor) === claim);
    expect(claimsStillShown).toHaveLength(59);
  });

  it.each(falseClaims)("catches the b1r3 %s false claim: %s", (_group, claim) => {
    const guarded = guardReplyActionClaims(TURN, claim);
    expect(guarded.text).not.toBe(claim);
    expect(guarded.removedSentences).toBeGreaterThan(0);
    expect(guarded.text).toContain("I can't send messages");
  });

  it("keeps the b2r3 benign corpus within main's two-of-41 over-refusal ceiling", () => {
    const school = issueReplyActionReceipt(TURN, "school-plan");
    const university = issueReplyActionReceipt(TURN, "university-tracker");
    const refusals: string[] = [];
    for (const [group, replies] of Object.entries(BENIGN_HONEST_REPLIES)) {
      const receipts = group === "plans / checklists / study"
        ? [school]
        : group === "corrections / reminders / owner reports" || group === "internal saves that really happened"
          ? [school, university]
          : [];
      for (const reply of replies) {
        if (guardReplyActionClaims(TURN, reply, receipts).text !== reply) refusals.push(reply);
      }
    }
    expect(refusals).toEqual(["I'll remind you about the Waterloo AIF on Friday."]);
  });

  it.each(TRUE_IN_APP_ACTION_REPLIES)("shows a true in-app statement when this turn has its code receipt: %s", (reply) => {
    const receipts = [
      issueReplyActionReceipt(TURN, "school-plan"),
      issueReplyActionReceipt(TURN, "university-tracker"),
    ];
    expect(guardReplyActionClaims(TURN, reply, receipts).text).toBe(reply);
  });

  it("refuses an unreceipted in-app save and does not accept a forged or other-turn receipt", () => {
    const reply = "I've updated your school plan for tonight.";
    const forged = Object.freeze(Object.create(null)) as ReplyActionReceipt;
    const otherTurn = issueReplyActionReceipt(OTHER_TURN, "school-plan");
    expect(guardReplyActionClaims(TURN, reply).text).toContain("couldn't verify");
    expect(guardReplyActionClaims(TURN, reply, [forged]).text).toContain("couldn't verify");
    expect(guardReplyActionClaims(TURN, reply, [otherTurn]).text).toContain("couldn't verify");
    expect(guardReplyActionClaims(TURN, reply, [issueReplyActionReceipt(TURN, "school-plan")]).text).toBe(reply);
  });

  it.each([
    "Booked a table at Pai for 7pm.",
    "Your reservation is confirmed.",
    "Message sent to Mom.",
    "I'll call the dentist now.",
    "On it, booking now.",
    "I scheduled an appointment with the dentist.",
  ])("refuses Sid's unreceipted external-action case: %s", (reply) => {
    expect(guardReplyActionClaims(TURN, reply).text).toBe(
      "I can't send messages, make calls or bookings, pay, submit, register, apply, or contact anyone yet; I can draft or prepare it for you.",
    );
  });

  it.each([
    "I can't book tables yet, but here's Pai's number.",
    "Want me to draft a text to Mom?",
  ])("keeps Sid's honest non-action case: %s", (reply) => {
    expect(guardReplyActionClaims(TURN, reply).text).toBe(reply);
  });

  it("removes only offending sentences and keeps the useful answer before one honest line", () => {
    const reply = "Pai's phone number is 416-555-0100. Booked a table there for 7pm. I can draft what to say about allergies.";
    expect(guardReplyActionClaims(TURN, reply).text).toBe(
      "Pai's phone number is 416-555-0100. I can draft what to say about allergies. I can't send messages, make calls or bookings, pay, submit, register, apply, or contact anyone yet; I can draft or prepare it for you.",
    );
  });

  it("does not let a later draft label excuse an earlier false action claim", () => {
    const reply = "Booked Pai for 7pm. Here's a draft: Hi Mom, dinner is at seven.";
    const guarded = guardReplyActionClaims(TURN, reply).text;
    expect(guarded).not.toContain("Booked Pai");
    expect(guarded).toContain("Here's a draft: Hi Mom, dinner is at seven.");
    expect(guarded).toContain("I can't send messages");
  });

  it("allows the future booked follow-up only when code issued a booking receipt for this turn", () => {
    const reply = "On it, booking now. Booked Pai for 7pm.";
    expect(guardReplyActionClaims(TURN, reply, [issueReplyActionReceipt(TURN, "book")]).text).toBe(reply);
  });

  it("carries adapter-issued in-app authority through the final model boundary", async () => {
    const reply = "I've updated your school plan for tonight.";
    const guarded = new ReplyActionClaimGuardModelAdapter({
      model: model([issueReplyActionToken(TURN, reply, ["school-plan"])]),
    });
    await expect(collect(guarded.stream(input()))).resolves.toBe(reply);
  });

  it("trusts a memory adapter's own receipt but still guards its delegated ordinary reply", async () => {
    const tracker = new DelegatedReplyTracker();
    const delegated = Object.freeze({ index: 0, text: "Booked a table at Pai for 7pm." });
    const fallbackGuard = new ReplyActionClaimGuardModelAdapter({
      model: tracker.wrap(model([delegated])),
      memoryFallback: tracker,
    });
    await expect(collect(fallbackGuard.stream(input()))).resolves.toContain("I can't send messages");

    const memoryReply = "Remembered 1 memory. Memory: \"Sid prefers concise replies\"";
    const memoryGuard = new ReplyActionClaimGuardModelAdapter({
      model: model([Object.freeze({ index: 0, text: memoryReply })]),
      memoryFallback: new DelegatedReplyTracker(),
    });
    await expect(collect(memoryGuard.stream(input()))).resolves.toBe(memoryReply);
  });
});
