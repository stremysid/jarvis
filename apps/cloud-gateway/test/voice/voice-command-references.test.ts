import { describe, expect, it } from "vitest";
import { parseCommand } from "../../src/channels/telegram/telegram-commands.js";
import {
  OWNER_VOICE_AGENT_CHANNEL_PROMPT,
  OWNER_VOICE_CONFIRMATION_SURFACE_REFUSAL,
  OWNER_VOICE_INFERRED_MEMORY_CONFIRMATION_REFUSAL,
} from "../../src/voice/voice-agent.js";

/**
 * F1: the call told Sid to open `/decisions`, which the bot does not know.
 *
 * A call has no keyboard, so the Telegram command in these strings is the only
 * route to the tap that authorizes a tier-3 action or a staged memory. A name
 * that parses as `unknown_command` dead-ends the one instruction voice gives
 * him. The strings are imported rather than retyped so this test fails on the
 * text a caller actually hears.
 */
describe("the commands a call names", () => {
  const surfaces: ReadonlyArray<readonly [string, string]> = [
    ["OWNER_VOICE_AGENT_CHANNEL_PROMPT", OWNER_VOICE_AGENT_CHANNEL_PROMPT],
    [
      "OWNER_VOICE_INFERRED_MEMORY_CONFIRMATION_REFUSAL",
      OWNER_VOICE_INFERRED_MEMORY_CONFIRMATION_REFUSAL,
    ],
    ["OWNER_VOICE_CONFIRMATION_SURFACE_REFUSAL", OWNER_VOICE_CONFIRMATION_SURFACE_REFUSAL],
  ];

  it("names only commands the Telegram bot recognises in the voice prompt and its spoken refusals", () => {
    const named = new Set<string>();
    for (const [surface, text] of surfaces) {
      for (const command of text.match(/\/[a-z][a-z0-9-]*/gu) ?? []) {
        named.add(command);
        expect(parseCommand(command, null), `${surface} names ${command}`)
          .toMatchObject({ kind: "command" });
      }
    }
    // Without this the loop is vacuous once a surface stops naming a command,
    // and the point of the fix is which command the three surfaces name.
    expect(named).toEqual(new Set(["/queue"]));
  });
});
