import { describe, expect, it } from "vitest";
import {
  classifyTelegramUpdate,
  MAX_CALLBACK_DATA_BYTES,
} from "../../src/channels/telegram/telegram-types.js";

/**
 * A tap is not a message.
 *
 * It resolves a decision -- it writes an append-only response row that can
 * never be replaced. So the classifier reads only the fields that establish
 * whose tap it was and which question it answers, and refuses anything it
 * cannot place. Everything else in a callback_query, including the text of
 * the message the button was attached to, is content Jarvis has no reason to
 * carry forward.
 */

function callback(overrides: Record<string, unknown> = {}): unknown {
  return {
    update_id: 91,
    callback_query: {
      id: "4382bfdc",
      from: { id: 8_675_309 },
      message: { message_id: 12, chat: { id: -1_002 } },
      data: "d1:01k5d8s0m00000000000000001:yes",
      ...overrides,
    },
  };
}

describe("accepting a button tap", () => {
  it("returns the fields needed to answer it and place it", () => {
    const result = classifyTelegramUpdate(callback());
    expect(result).toEqual({
      kind: "callback",
      value: {
        updateId: 91,
        telegramUserId: "8675309",
        chatId: "-1002",
        callbackQueryId: "4382bfdc",
        messageId: 12,
        data: "d1:01k5d8s0m00000000000000001:yes",
      },
    });
  });

  it("carries nothing else from the payload", () => {
    // The message the keyboard was attached to may hold anything. None of it
    // is content Jarvis accepted, and none of it should survive here.
    const result = classifyTelegramUpdate(
      callback({
        chat_instance: "-7788",
        message: {
          message_id: 12,
          chat: { id: -1_002 },
          text: "the question as it was rendered",
          reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: "x" }]] },
          photo: [{ file_id: "AgACAgQAAx" }],
        },
      }),
    );

    expect(result.kind).toBe("callback");
    expect(Object.keys(result.kind === "callback" ? result.value : {})).toEqual([
      "updateId",
      "telegramUserId",
      "chatId",
      "callbackQueryId",
      "messageId",
      "data",
    ]);
  });

  it("does not treat a tap as text", () => {
    // The two authorise different things: text is a message to answer, a tap
    // resolves a question. A typed message that happened to look like
    // callback data must not be able to resolve a decision.
    expect(classifyTelegramUpdate(callback()).kind).not.toBe("text");
  });
});

describe("refusing a callback that cannot be placed", () => {
  it.each([
    ["no id to answer", { id: undefined }],
    ["a blank id", { id: "" }],
    ["no sender", { from: undefined }],
    ["a sender with no id", { from: {} }],
  ])("rejects %s as malformed", (_name, overrides) => {
    const result = classifyTelegramUpdate(callback(overrides));
    expect(result).toEqual({ kind: "rejected", updateId: 91, reason: "malformed" });
  });

  it("rejects a tap whose message Telegram no longer has", () => {
    // Nothing to edit and no chat to answer in, so there is no way to act on
    // it and no way to tell the owner it was received.
    const result = classifyTelegramUpdate(callback({ message: undefined }));
    expect(result).toEqual({ kind: "rejected", updateId: 91, reason: "unsupported_content" });
  });

  it("rejects a game callback, which is not a button tap at all", () => {
    // Accepting it would hand a value to the decision parser that never came
    // from a keyboard Jarvis built.
    const result = classifyTelegramUpdate(callback({ game_short_name: "tetris", data: undefined }));
    expect(result).toEqual({ kind: "rejected", updateId: 91, reason: "unsupported_content" });
  });

  it("rejects a game callback even when it also carries plausible data", () => {
    const result = classifyTelegramUpdate(callback({ game_short_name: "tetris" }));
    expect(result.kind).toBe("rejected");
  });

  it.each([
    ["no data", { data: undefined }],
    ["empty data", { data: "" }],
    ["non-string data", { data: 42 }],
    ["a lone surrogate", { data: "d1:\uD800" }],
  ])("rejects %s as unsupported", (_name, overrides) => {
    const result = classifyTelegramUpdate(callback(overrides));
    expect(result).toEqual({ kind: "rejected", updateId: 91, reason: "unsupported_content" });
  });

  it("rejects data longer than Telegram's own cap", () => {
    // Anything longer never came from a keyboard Telegram accepted from us.
    const result = classifyTelegramUpdate(
      callback({ data: "d".repeat(MAX_CALLBACK_DATA_BYTES + 1) }),
    );
    expect(result).toEqual({ kind: "rejected", updateId: 91, reason: "unsupported_content" });
  });

  it("measures the cap in bytes, not characters", () => {
    // 22 three-byte characters is 66 bytes and 22 JavaScript characters. A
    // length check would let it through and Telegram would not.
    const result = classifyTelegramUpdate(callback({ data: "あ".repeat(22) }));
    expect(result).toEqual({ kind: "rejected", updateId: 91, reason: "unsupported_content" });
  });

  it("accepts data exactly at the cap", () => {
    const result = classifyTelegramUpdate(callback({ data: "d".repeat(MAX_CALLBACK_DATA_BYTES) }));
    expect(result.kind).toBe("callback");
  });

  it("rejects a callback_query that is not an object", () => {
    expect(classifyTelegramUpdate({ update_id: 91, callback_query: "yes" })).toEqual({
      kind: "rejected",
      updateId: 91,
      reason: "malformed",
    });
  });
});
