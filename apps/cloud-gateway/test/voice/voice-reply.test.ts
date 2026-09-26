import { describe, expect, it } from "vitest";
import { VoiceReplyStream } from "../../src/agent/voice-reply.js";
import type { ExecutedTool } from "../../src/agent/owner-agent-core.js";
import { guardVoiceReplySentence, UNRECEIPTED_VOICE_ACTION } from "../../src/school/school-catchup-model.js";

const PARAPHRASES = [
  "Memory updated.", "I've made a note of that.", "I've logged that.", "It's in your memory now.",
  "Your coffee preference is now in my memory.", "I've wiped that from memory.", "I've erased that memory.",
  "I've put that in your notes.", "That preference is gone now.", "I have cancelled your appointment.",
  "I've set a reminder for 5 pm.", "Your reminder is set for tomorrow.", "Reminder created.",
  "Your message went out.", "I've taken care of it.", "Consider it done.", "All set.", "Noted.",
];

function tagged(sentence: string, toolName = "memory_remember", receiptIds: string[] = ["receipt:save"]): string {
  return `[[claim ${JSON.stringify({ toolName, receiptIds })}]]${sentence}[[/claim]]`;
}

function receipt(name = "memory_remember", receiptId: string | null = "receipt:save"): ExecutedTool {
  return { receiptId, receipt: "Saved one memory.", referencedItemIds: [],
    providerResult: { toolCallId: "save", name, content: "synthetic tool result" } };
}

function render(text: string, executed: readonly ExecutedTool[] = []): string {
  const reply = new VoiceReplyStream(executed, new Set());
  return [...reply.push(text), ...reply.finish()].map((part) => part.text).join("").trim();
}

describe("model-declared voice claims", () => {
  it.each(PARAPHRASES)("replaces the model-declared action %s when no current receipt proves it", (sentence) => {
    expect(render(tagged(sentence))).toBe(UNRECEIPTED_VOICE_ACTION);
  });

  it.each(PARAPHRASES)("catches the untagged action %s with the omission backstop", (sentence) => {
    expect(render(sentence)).toBe(UNRECEIPTED_VOICE_ACTION);
  });

  it("uses the model declaration for a novel paraphrase outside the regex vocabulary", () => {
    const sentence = "The filing step is behind us.";
    expect(guardVoiceReplySentence(sentence, new Set())).toBe(sentence);
    expect(render(tagged(sentence))).toBe(UNRECEIPTED_VOICE_ACTION);
    expect(render(tagged(sentence), [receipt()])).toBe(sentence);
  });

  it("strips a supported marker at every chunk boundary before releasing its sentence", () => {
    const text = tagged("I've logged that.") + " You can ask later.";
    for (let split = 1; split < text.length; split += 1) {
      const reply = new VoiceReplyStream([receipt()], new Set());
      const heard = [...reply.push(text.slice(0, split)), ...reply.push(text.slice(split)), ...reply.finish()]
        .map((part) => part.text).join("");
      expect(heard, `split ${split}`).toBe("I've logged that. You can ask later.");
    }
  });

  it.each([
    ["a missing receipt", [], ["receipt:save"]],
    ["a stale receipt", [receipt()], ["receipt:old"]],
    ["an empty inventory", [receipt()], []],
    ["a mismatched tool", [receipt("memory_forget")], ["receipt:save"]],
    ["a refused tool", [receipt("memory_remember", null)], ["receipt:save"]],
    ["a mixture of real and invented receipts", [receipt()], ["receipt:save", "receipt:old"]],
  ] as const)("refuses a novel declaration supported by %s", (_name, executed, ids) => {
    expect(render(tagged("The filing step is behind us.", "memory_remember", [...ids]), executed))
      .toBe(UNRECEIPTED_VOICE_ACTION);
  });

  it("binds guided draft proof to one exact declared sentence and leaves an adjacent claim unproven", () => {
    const sentence = "I sent your draft to Telegram.";
    const output = render(tagged(sentence, "guided_assignment_draft") + " I've logged that.", [receipt("guided_assignment_draft")]);
    expect(output).toBe(`${sentence} ${UNRECEIPTED_VOICE_ACTION}`);
    expect(render(tagged(sentence), [receipt()])).toBe(UNRECEIPTED_VOICE_ACTION);
  });

  it("does not use a proof for part of a sentence or for a different declared sentence", () => {
    expect(render("I have " + tagged("saved that."), [receipt()])).toBe(UNRECEIPTED_VOICE_ACTION);
    expect(guardVoiceReplySentence("I sent your other draft to Telegram.", new Set(), {
      receiptedInternalSentences: [{ sentence: "I sent your draft to Telegram.", toolNames: ["guided_assignment_draft"] }],
    })).toBe(UNRECEIPTED_VOICE_ACTION);
  });

  it("keeps a credential request even with a guided draft receipt, and still refuses a false Brightspace check", () => {
    // Sid allowed Jarvis to ask for and hold a code (2026-09-24), so no rule
    // rewrites the request. A claimed D2L check still needs its own evidence.
    expect(render(tagged("Send me your password.", "guided_assignment_draft"), [receipt("guided_assignment_draft")]))
      .toContain("Send me your password.");
    expect(render(tagged("I checked D2L.", "guided_assignment_draft"), [receipt("guided_assignment_draft")]))
      .toBe(UNRECEIPTED_VOICE_ACTION);
  });

  it.each([
    "[[claim null]]Done.[[/claim]]", "[[claim []]]Done.[[/claim]]", "[[claim {}]]Done.[[/claim]]",
    '[[claim {"toolName":"memory_remember","receiptIds":"receipt:save"}]]Done.[[/claim]]',
    '[[claim {"toolName":"memory_remember","receiptIds":["receipt:save","receipt:save"]}]]Done.[[/claim]]',
    '[[claim {"toolName":"memory_remember","receiptIds":[],"trusted":true}]]Done.[[/claim]]',
    '[[claim {"toolName":"memory-remember","receiptIds":[]}]]Done.[[/claim]]',
    '[[claim {"toolName":"memory_remember","receiptIds":[4]}]]Done.[[/claim]]',
    tagged("Done.", "memory_remember", ["one", "two", "three", "four", "five"]),
    "[[wrong]]Done.[[/claim]]", "[[claim ", tagged("One action. Another action."),
    '[[other {"toolName":"memory_remember","receiptIds":["receipt:save"]}]]Done.[[/claim]]',
    tagged("Done"), tagged("[[nested]]Done."), tagged("Done.").slice(0, -1),
  ])("refuses malformed or incomplete claim framing %s without speaking it", (text) => {
    const reply = new VoiceReplyStream([receipt()], new Set());
    const heard: string[] = [];
    expect(() => {
      heard.push(...reply.push(text).map((part) => part.text));
      heard.push(...reply.finish().map((part) => part.text));
    }).toThrow();
    expect(heard).toEqual([]);
  });

  it("says Sid's own PIN back to him exactly as it is", () => {
    const raw = "Your PIN is 4821. Your code is 123456.";
    const reply = new VoiceReplyStream([], new Set());
    const heard = [...raw].flatMap((character) => reply.push(character)).concat([...reply.finish()])
      .map((part) => part.text).join("");
    expect(heard).toBe(raw);
  });

  it("redacts a machine credential in the original prose before replacing a claim that contains it", () => {
    const raw = "I saved Bearer alpha.bravo-charlie0123 in your file. You can ask later.";
    const reply = new VoiceReplyStream([], new Set());
    const heard = [...raw].flatMap((character) => reply.push(character)).concat([...reply.finish()])
      .map((part) => part.text).join("");
    expect(heard).not.toContain("bravo-charlie0123");
    expect(heard).toContain(UNRECEIPTED_VOICE_ACTION);
    expect(heard).toContain("You can ask later.");
  });

  it("keeps annotation offsets aligned after redaction changes an earlier sentence", () => {
    const raw = "The value Bearer alpha.bravo-charlie0123 is private. " + tagged("I've logged that.");
    expect(render(raw, [receipt()])).toBe("The value [REDACTED_AUTHORIZATION] is private. I've logged that.");
  });

  it("refuses annotation offsets that do not survive as redacted prefixes", () => {
    expect(() => render("The value Bearer " + tagged("opaque0123456789.") + " stays private.", [receipt()]))
      .toThrow("voice_claim_redaction_overlap");
  });

  it("does not borrow guided draft proof for a passive completion in a later sentence", () => {
    const sentence = "Your message has been sent.";
    expect(render(tagged(sentence, "guided_assignment_draft") + " Your application is now in with Western.", [receipt("guided_assignment_draft")]))
      .toBe(`${sentence} ${UNRECEIPTED_VOICE_ACTION}`);
  });
});
