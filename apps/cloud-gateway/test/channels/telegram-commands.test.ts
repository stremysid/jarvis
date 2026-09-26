import { describe, expect, it } from "vitest";
import {
  parseCommand,
  parseToggle,
  type CommandParse,
} from "../../src/channels/telegram/telegram-commands.js";

/**
 * The router is deliberately tiny now. `/status`, `/queue`, `/digest` and
 * everything else reach the model, which calls the matching tool; only the
 * owner's two permission switches and the text-authorized call stay code.
 *
 * Two failures this file exists to prevent.
 *
 * A message that merely contains a slash being dispatched to something that
 * acts -- because the alternative to answering it with the model is acting on
 * it, and acting is the expensive direction to be wrong in.
 *
 * And `/shadow maybe` resolving to a state. Shadow mode is the gate that keeps
 * tier-2 actions from running, so a typo that silently turns it off is the
 * exact outcome the tiered design was built to make impossible.
 */

const BOT = "jarvis_sid_bot";

function parse(text: string, bot: string | null = BOT): CommandParse {
  return parseCommand(text, bot);
}

describe("messages that are not mechanical commands", () => {
  it.each([
    ["ordinary text", "what did I decide about the pricing sheet"],
    ["a slash mid-sentence", "the file is at /help if you need it"],
    ["a bare slash", "/"],
    ["a path", "/usr/local/bin"],
    ["a number", "/123"],
    ["a hyphenated word", "/not-a-command"],
    ["an empty message", ""],
    ["only whitespace", "   "],
  ])("treats %s as text", (_name, text) => {
    expect(parse(text)).toEqual({ kind: "text" });
  });

  it("treats a command addressed to another bot as text", () => {
    // In a group both bots receive the message. Answering one aimed at
    // somebody else is worse than ignoring it.
    expect(parse("/status@some_other_bot")).toEqual({ kind: "text" });
  });

  it.each(["/status", "/queue", "/digest", "/vault pricing sheet", "/help", "/deploy"])(
    "hands the reporting or unknown command %s to the model rather than routing it",
    (text) => {
      // These are capabilities the model reaches through tools now, and an
      // unknown name is a message the model must read and answer. Refusing any
      // of them in code would decide what Sid's words meant.
      expect(parse(text)).toEqual({ kind: "text" });
    },
  );

  it("treats the removed owner step-up command as ordinary text rather than dispatching it", () => {
    // The per-call passphrase gate is gone, so `/disable-owner-step-up` has no
    // handler. A hyphenated name does not match the command shape at all.
    expect(parse("/disable-owner-step-up --confirm")).toEqual({ kind: "text" });
  });
});

describe("recognising a mechanical command", () => {
  it("routes a self-call command and its confirmation before ordinary model text", () => {
    expect(parse("/call check in")).toEqual({ kind: "command", name: "call", argument: "check in", addressedTo: null });
    expect(parse("/call@Jarvis_Sid_Bot check in --confirm"))
      .toMatchObject({ kind: "command", name: "call", argument: "check in --confirm" });
  });

  it("preserves an entire call argument so truncation cannot manufacture final confirmation", () => {
    const argument = `${"a".repeat(246)} --confirm extra words`;
    expect(parse(`/call ${argument}`)).toMatchObject({ name: "call", argument });
    expect(parse("/call check in --confirm\ndo not place this call"))
      .toMatchObject({ name: "call", argument: "check in --confirm\ndo not place this call" });
  });

  it.each(["/shadow on", "/shadow off", "/exam on", "/exam off"])(
    "routes the mechanical switch %s",
    (text) => {
      const [name, argument] = text.slice(1).split(" ");
      expect(parse(text)).toEqual({ kind: "command", name, argument, addressedTo: null });
    },
  );

  it("parses the same command addressed to this bot, as Telegram sends it in a group", () => {
    expect(parse("/exam@jarvis_sid_bot on")).toMatchObject({ kind: "command", name: "exam", argument: "on" });
  });

  it("matches the bot name case-insensitively, because Telegram usernames are", () => {
    expect(parse("/shadow@Jarvis_Sid_Bot off")).toMatchObject({ kind: "command", name: "shadow", argument: "off" });
  });

  it("tolerates leading whitespace", () => {
    expect(parse("  /shadow on")).toMatchObject({ kind: "command", name: "shadow" });
  });

  it("takes only the first line, so a pasted block below a command is not swallowed", () => {
    expect(parse("/shadow on\nsome pasted notes\nmore notes")).toMatchObject({
      name: "shadow",
      argument: "on",
    });
  });

  it("never silently truncates an argument", () => {
    // The old parser sliced every non-call argument to 256 characters without
    // telling Sid. Nothing is sliced now: the mechanical commands validate
    // their own argument, and `requireConfirmation` refuses an over-long call
    // visibly rather than dropping its tail.
    const parsed = parse(`/exam ${"x".repeat(2_000)}`);
    expect(parsed.kind).toBe("command");
    expect(parsed.kind === "command" && parsed.argument).toHaveLength(2_000);
  });

  it("accepts a command when the bot's own name is unknown", () => {
    // Before the bot has resolved its own username it must still answer a
    // bare command, or a fresh deployment looks dead.
    expect(parse("/shadow on", null)).toMatchObject({ kind: "command", name: "shadow" });
  });
});

describe("reading an on/off argument", () => {
  it.each([
    ["on", "on"],
    ["ON", "on"],
    ["  on  ", "on"],
    ["enable", "on"],
    ["enabled", "on"],
    ["off", "off"],
    ["OFF", "off"],
    ["disable", "off"],
    ["disabled", "off"],
  ])("reads %s as %s", (argument, expected) => {
    expect(parseToggle(argument)).toBe(expected);
  });

  it.each([
    ["an empty argument", ""],
    ["a hedge", "maybe"],
    ["a typo", "of"],
    ["a number", "1"],
    ["a boolean literal", "true"],
    ["a negation", "not off"],
  ])("refuses %s rather than guessing a state", (_name, argument) => {
    // `/shadow of` must not disable shadow mode. Guessing here is how the
    // gate that keeps tier-2 actions from running gets turned off by a typo.
    expect(parseToggle(argument)).toBeNull();
  });
});
