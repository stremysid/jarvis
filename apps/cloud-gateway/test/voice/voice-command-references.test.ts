import { describe, expect, it } from "vitest";
import { parseCommand } from "../../src/channels/telegram/telegram-commands.js";
import { OWNER_TOOL_DEFINITIONS } from "../../src/agent/owner-tools.js";
import {
  OWNER_VOICE_AGENT_CHANNEL_PROMPT,
  OWNER_VOICE_CONFIRMATION_SURFACE_REFUSAL,
  OWNER_VOICE_INFERRED_MEMORY_CONFIRMATION_REFUSAL,
} from "../../src/voice/voice-agent.js";

/**
 * F1: the call told Sid to open `/decisions`, which the bot does not know.
 *
 * A call has no keyboard, so the Telegram message in these strings is the only
 * route to the tap that authorizes a tier-3 action or a staged memory. The
 * strings are imported rather than retyped so this test fails on the text a
 * caller actually hears.
 *
 * `/queue` is no longer a code command: the text reaches the model, which
 * calls the `decision_queue` tool to read what is waiting. What has to keep
 * working is that the tool exists in the shared catalogue, so the instruction
 * a call gives Sid is one the bot can act on.
 */
describe("the Telegram surface a call names", () => {
  const surfaces: ReadonlyArray<readonly [string, string]> = [
    ["OWNER_VOICE_AGENT_CHANNEL_PROMPT", OWNER_VOICE_AGENT_CHANNEL_PROMPT],
    [
      "OWNER_VOICE_INFERRED_MEMORY_CONFIRMATION_REFUSAL",
      OWNER_VOICE_INFERRED_MEMORY_CONFIRMATION_REFUSAL,
    ],
    ["OWNER_VOICE_CONFIRMATION_SURFACE_REFUSAL", OWNER_VOICE_CONFIRMATION_SURFACE_REFUSAL],
  ];

  it("names /queue, which reaches the model and resolves to the decision_queue tool", () => {
    const named = new Set<string>();
    for (const [, text] of surfaces) {
      for (const command of text.match(/\/[a-z][a-z0-9-]*/gu) ?? []) named.add(command);
    }
    expect(named).toEqual(new Set(["/queue"]));

    // The command text is ordinary text now, so it reaches the model...
    expect(parseCommand("/queue", null)).toEqual({ kind: "text" });
    // ...and the capability it names is on both channels.
    expect(OWNER_TOOL_DEFINITIONS.map((definition) => definition.name)).toContain("decision_queue");
  });
});
