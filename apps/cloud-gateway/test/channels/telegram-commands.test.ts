import { describe, expect, it } from "vitest";
import {
  parseCommand,
  parseToggle,
  type CommandParse,
} from "../../src/channels/telegram/telegram-commands.js";

/**
 * Two failures this file exists to prevent.
 *
 * A message that merely contains a slash being dispatched to something that
 * acts -- because the alternative to answering it with the model is acting on
 * it, and acting is the expensive direction to be wrong in.
 *
 * And `/shadow maybe` resolving to a state. Shadow mode is the gate that
 * keeps tier-2 actions from running, so a typo that silently turns it off is
 * the exact outcome the tiered design was built to make impossible.
 */

const BOT = "jarvis_sid_bot";

function parse(text: string, bot: string | null = BOT): CommandParse {
  return parseCommand(text, bot);
}

describe("messages that are not commands", () => {
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
});

describe("recognising a command", () => {
  it("routes a self-call command and its confirmation before ordinary model text", () => {
    expect(parse("/call check in")).toEqual({ kind: "command", name: "call", argument: "check in", addressedTo: null });
    expect(parse("/call@Jarvis_Sid_Bot check in --confirm"))
      .toMatchObject({ kind: "command", name: "call", argument: "check in --confirm" });
  });

  it("routes only the known hyphenated owner step-up command", () => {
    expect(parse("/disable-owner-step-up --confirm")).toEqual({
      kind: "command", name: "disable-owner-step-up", argument: "--confirm", addressedTo: null,
    });
    expect(parse("/disable-owner-step-up@Jarvis_Sid_Bot --confirm")).toEqual({
      kind: "command", name: "disable-owner-step-up", argument: "", addressedTo: "Jarvis_Sid_Bot",
    });
    expect(parse("/Disable-Owner-Step-Up --confirm")).toEqual({
      kind: "command", name: "disable-owner-step-up", argument: "", addressedTo: null,
    });
    expect(parse("/disable-owner-step-up@some_other_bot --confirm")).toEqual({
      kind: "command", name: "disable-owner-step-up", argument: "", addressedTo: "some_other_bot",
    });
    for (const text of [
      "/disable-owner-step-up--confirm",
      "/disable-owner-stepup --confirm",
      "/disable\u2011owner\u2011step\u2011up --confirm",
    ]) {
      expect(parse(text)).toMatchObject({ kind: "command", name: "disable-owner-step-up", argument: "" });
    }
    expect(parse("/not-a-command")).toEqual({ kind: "text" });
    expect(parse("/enable-owner-step-up --confirm")).toEqual({ kind: "text" });
  });

  it("preserves all owner step-up confirmation text so trailing input cannot be hidden", () => {
    expect(parse("/disable-owner-step-up --confirm\ndo not disable"))
      .toMatchObject({ name: "disable-owner-step-up", argument: "--confirm\ndo not disable" });
  });

  it("preserves an entire call argument so truncation cannot manufacture final confirmation", () => {
    const argument = `${"a".repeat(246)} --confirm extra words`;
    expect(parse(`/call ${argument}`)).toMatchObject({ name: "call", argument });
    expect(parse("/call check in --confirm\ndo not place this call"))
      .toMatchObject({ name: "call", argument: "check in --confirm\ndo not place this call" });
  });

  it("parses a bare command", () => {
    expect(parse("/status")).toEqual({
      kind: "command",
      name: "status",
      argument: "",
      addressedTo: null,
    });
  });

  it("parses the same command addressed to this bot, as Telegram sends it in a group", () => {
    expect(parse("/status@jarvis_sid_bot")).toMatchObject({ kind: "command", name: "status" });
  });

  it("matches the bot name case-insensitively, because Telegram usernames are", () => {
    expect(parse("/status@Jarvis_Sid_Bot")).toMatchObject({ kind: "command", name: "status" });
  });

  it("keeps the argument", () => {
    expect(parse("/vault pricing sheet decision")).toMatchObject({
      name: "vault",
      argument: "pricing sheet decision",
    });
  });

  it("keeps the argument when the command is also addressed", () => {
    expect(parse("/vault@jarvis_sid_bot pricing sheet")).toMatchObject({
      name: "vault",
      argument: "pricing sheet",
    });
  });

  it("tolerates leading whitespace", () => {
    expect(parse("  /status")).toMatchObject({ kind: "command", name: "status" });
  });

  it("takes only the first line, so a pasted block below a command is not swallowed", () => {
    expect(parse("/vault pricing\nsome pasted notes\nmore notes")).toMatchObject({
      name: "vault",
      argument: "pricing",
    });
  });

  it("bounds an oversized argument rather than carrying it onward", () => {
    const parsed = parse(`/vault ${"x".repeat(2_000)}`);
    expect(parsed.kind).toBe("command");
    expect(parsed.kind === "command" && parsed.argument).toHaveLength(256);
  });

  it("accepts a command when the bot's own name is unknown", () => {
    // Before the bot has resolved its own username it must still answer a
    // bare command, or a fresh deployment looks dead.
    expect(parse("/status", null)).toMatchObject({ kind: "command", name: "status" });
  });
});

describe("commands that do not exist", () => {
  it("reports an unknown command rather than answering it with the model", () => {
    // Reaching the model would produce a confident paragraph about a command
    // that does nothing, which reads as though it worked.
    expect(parse("/deploy")).toEqual({ kind: "unknown_command", attempted: "deploy" });
  });

  it("does not report a message that was never command-shaped as an unknown command", () => {
    expect(parse("/not-a-command")).toEqual({ kind: "text" });
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
