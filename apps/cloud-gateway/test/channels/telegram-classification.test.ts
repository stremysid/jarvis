import { describe, expect, it } from "vitest";
import {
  buildRejectionPayload,
  rejectionReply,
} from "../../src/channels/telegram/telegram-rejection.js";
import {
  MAX_TEXT_BYTES,
  classifyTelegramUpdate,
} from "../../src/channels/telegram/telegram-types.js";

function message(overrides: Record<string, unknown> = {}): unknown {
  return {
    update_id: 71,
    message: { message_id: 5, from: { id: 12345 }, chat: { id: 12345 }, ...overrides },
  };
}

describe("classifying a Telegram update", () => {
  it("accepts a plain text message and returns only what is needed", () => {
    const result = classifyTelegramUpdate(message({ text: "hello" }));
    expect(result).toEqual({
      kind: "text",
      value: { updateId: 71, telegramUserId: "12345", chatId: "12345", messageId: 5, text: "hello" },
    });
  });

  it("normalizes text to NFC", () => {
    const decomposed = "café";
    const result = classifyTelegramUpdate(message({ text: decomposed }));
    expect(result.kind).toBe("text");
    if (result.kind !== "text") throw new Error("unreachable");
    expect(result.value.text).toBe("café".normalize("NFC"));
  });

  it("accepts a negative chat id, since groups use them", () => {
    const result = classifyTelegramUpdate({
      update_id: 71,
      message: { message_id: 5, from: { id: 1 }, chat: { id: -100123 }, text: "hi" },
    });
    expect(result.kind).toBe("text");
    if (result.kind !== "text") throw new Error("unreachable");
    expect(result.value.chatId).toBe("-100123");
  });

  it.each([
    ["photo", { photo: [{ file_id: "AgACAgQ" }] }],
    ["document", { document: { file_id: "BQACAgQ", file_name: "secret.pdf" } }],
    ["voice", { voice: { file_id: "AwACAgQ" } }],
    ["video", { video: { file_id: "BAACAgQ" } }],
    ["sticker", { sticker: { file_id: "CAACAgQ" } }],
    ["location", { location: { latitude: 51.5, longitude: -0.1 } }],
    ["contact", { contact: { phone_number: "+441234567890" } }],
    ["poll", { poll: { question: "which?" } }],
  ])("rejects %s as unsupported content", (_name, attachment) => {
    const result = classifyTelegramUpdate(message(attachment));
    expect(result).toEqual({ kind: "rejected", updateId: 71, reason: "unsupported_content" });
  });

  it("rejects an attachment that arrives alongside text", () => {
    // Accepting the text and dropping the attachment would misrepresent what
    // was actually sent.
    const result = classifyTelegramUpdate(message({ text: "look at this", document: { file_id: "X" } }));
    expect(result).toEqual({ kind: "rejected", updateId: 71, reason: "unsupported_content" });
  });

  it("rejects a caption, which is media text rather than a text message", () => {
    const result = classifyTelegramUpdate(message({ caption: "my passport" }));
    expect(result.kind).toBe("rejected");
  });

  it.each(["edited_message", "channel_post", "callback_query", "inline_query"])(
    "rejects %s as unsupported rather than treating it as an error",
    (kind) => {
      const result = classifyTelegramUpdate({ update_id: 71, [kind]: { message_id: 1 } });
      expect(result).toEqual({ kind: "rejected", updateId: 71, reason: "unsupported_content" });
    },
  );

  it("rejects text over the size limit distinctly", () => {
    const oversized = "a".repeat(MAX_TEXT_BYTES + 1);
    expect(classifyTelegramUpdate(message({ text: oversized }))).toEqual({
      kind: "rejected",
      updateId: 71,
      reason: "message_too_large",
    });
  });

  it("accepts text exactly at the limit", () => {
    expect(classifyTelegramUpdate(message({ text: "a".repeat(MAX_TEXT_BYTES) })).kind).toBe("text");
  });

  it("measures the limit in UTF-8 bytes, not characters", () => {
    // Four bytes per emoji: well under the character count, over the byte cap.
    const emoji = "\u{1F600}".repeat(MAX_TEXT_BYTES / 4 + 1);
    expect(classifyTelegramUpdate(message({ text: emoji }))).toMatchObject({ reason: "message_too_large" });
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "update"],
    ["prototype-polluted object", Object.create({ update_id: 1 })],
  ])("treats a %s body as malformed", (_name, body) => {
    expect(classifyTelegramUpdate(body)).toEqual({ kind: "rejected", updateId: 0, reason: "malformed" });
  });

  it.each([0, -1, 1.5, "71", null])("rejects update_id %s as malformed", (updateId) => {
    expect(classifyTelegramUpdate({ update_id: updateId, message: {} })).toMatchObject({ reason: "malformed" });
  });

  it("rejects lone surrogates rather than storing unpaired text", () => {
    expect(classifyTelegramUpdate(message({ text: "bad \uD800" }))).toMatchObject({
      reason: "unsupported_content",
    });
  });

  it("rejects empty text", () => {
    expect(classifyTelegramUpdate(message({ text: "" }))).toMatchObject({ reason: "unsupported_content" });
  });
});

describe("rejection payloads", () => {
  it("contains exactly the update id and reason", () => {
    expect(buildRejectionPayload(71, "unsupported_content")).toEqual({
      updateId: 71,
      reason: "unsupported_content",
    });
  });

  it("cannot carry media metadata, because it never receives the update", () => {
    const payload = buildRejectionPayload(71, "unsupported_content");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/file_id|caption|photo|document|phone_number|latitude/);
    expect(Object.keys(payload).sort()).toEqual(["reason", "updateId"]);
  });

  it("is frozen so a later stage cannot decorate it", () => {
    const payload = buildRejectionPayload(71, "rate_limited") as Record<string, unknown>;
    expect(Object.isFrozen(payload)).toBe(true);
  });

  it("gives unauthorized and unsupported the same neutral reply", () => {
    // An unallowlisted sender must not be able to detect that they are
    // unallowlisted, only that Jarvis does not answer them.
    expect(rejectionReply("unauthorized")).toBe(rejectionReply("unsupported_content"));
    expect(rejectionReply("unsupported_content")).toBe("Jarvis accepts text messages only.");
  });

  it("gives every reason a reply", () => {
    for (const reason of ["malformed", "unsupported_content", "message_too_large", "unauthorized", "rate_limited"] as const) {
      expect(rejectionReply(reason).length).toBeGreaterThan(0);
    }
  });
});
