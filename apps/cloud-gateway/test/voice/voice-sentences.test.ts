import { describe, expect, it } from "vitest";
import { VoiceSentences } from "../../src/agent/voice-sentences.js";
import { guardVoiceReplySentence, UNRECEIPTED_VOICE_ACTION } from "../../src/school/school-catchup-model.js";

describe("voice sentence receipts", () => {
  it.each([
    "I've saved that.", "I've\nsaved that.", "We have just recorded your preference.",
    "I have unpinned that.", "I'm restoring your note.", "That is now stored.",
    "Done.", "Pinned.", "Submitted.", "I sent your reference to the teacher.",
    "Your application has been submitted.", "Your application is now in with Western.",
    "I checked D2L.", "Brightspace has been refreshed.",
  ])("replaces the unreceipted sentence %s before speech", (sentence) => {
    expect(guardVoiceReplySentence(sentence, new Set())).toBe(UNRECEIPTED_VOICE_ACTION);
  });

  it("accepts only an exact receipt instead of using one successful action to license another", () => {
    const receipts = new Set(["Saved one memory."]);
    expect(guardVoiceReplySentence("Saved one memory.", receipts)).toBe("Saved one memory.");
    expect(guardVoiceReplySentence("I saved your other preference.", receipts)).toBe(UNRECEIPTED_VOICE_ACTION);
    expect(guardVoiceReplySentence("I have unpinned that.", receipts)).toBe(UNRECEIPTED_VOICE_ACTION);
  });

  it.each([
    "I haven't saved that.", "I can help you prepare a draft.",
    "When your application is submitted, keep the receipt.",
    "You said your application has been submitted.",
    "I haven't checked D2L.", "I looked at the D2L dates you pasted.",
    "Do you want me to note that you take your coffee black?",
  ])("preserves the non-action sentence %s", (sentence) => {
    expect(guardVoiceReplySentence(sentence, new Set())).toBe(sentence);
  });

  it("keeps a credential request inside a draft or a receipt, because Sid may be asked for a code", () => {
    const request = "Send me your password.";
    expect(guardVoiceReplySentence(request, new Set([request]))).toBe(request);
    expect(guardVoiceReplySentence(`Draft: "${request}"`, new Set())).toBe(`Draft: "${request}"`);
  });

  it("keeps passive advice and a Brightspace denial from exempting a following completion", () => {
    const sentences = new VoiceSentences();
    const result = [...sentences.push("When your application is submitted, keep proof. Your application is now in with Western. I haven't checked D2L. I checked D2L."), ...sentences.finish()]
      .map((sentence) => guardVoiceReplySentence(sentence, new Set()));
    expect(result).toEqual([
      "When your application is submitted, keep proof.", UNRECEIPTED_VOICE_ACTION,
      "I haven't checked D2L.", UNRECEIPTED_VOICE_ACTION,
    ]);
  });
});

describe("voice sentence buffering", () => {
  it("holds a split action claim through line breaks until its sentence is complete", () => {
    const sentences = new VoiceSentences();
    expect(sentences.push("I've\nsa")).toEqual([]);
    expect(sentences.push("ved that. Advice follows")).toEqual(["I've\nsaved that. "]);
    expect(sentences.finish()).toEqual(["Advice follows"]);
    expect(sentences.finish()).toEqual([]);
  });

  it("keeps a title and decimal within their sentence instead of releasing a misleading prefix", () => {
    const sentences = new VoiceSentences();
    expect(sentences.push("I emailed Ms.")).toEqual([]);
    expect(sentences.push(" Smith for you. A draft costs 1.5 minutes.")).toEqual([
      "I emailed Ms. Smith for you. ",
    ]);
    expect(sentences.finish()).toEqual(["A draft costs 1.5 minutes."]);
  });

  it("does not split a word at internal punctuation or emit an empty suffix", () => {
    const sentences = new VoiceSentences();
    expect(sentences.push("example.test is a placeholder. ")).toEqual(["example.test is a placeholder. "]);
    expect(sentences.finish()).toEqual([]);
  });

  it.each([
    ["It costs 3.", "5 dollars."],
    ["An example is e.", "g. a draft."],
    ["Walk along St.", " Clair."],
    ["Examples etc.", " belong here."],
    ["1.", " Start here."],
  ])("holds the terminal period in %s until its continuation arrives", (first, rest) => {
    const sentences = new VoiceSentences();
    expect(sentences.push(first)).toEqual([]);
    expect(sentences.push(rest)).toEqual([]);
    expect(sentences.finish()).toEqual([first + rest]);
  });
});
