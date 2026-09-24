import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { voiceArgumentTurn, withMismatchedVoiceOwnerTurn } from "../channels/voice-argument-fixture.js";
import { resetDeadlineTables } from "./deadline-fixture.js";
import { testToolGate } from "../autonomy/tool-gate-fixture.js";
import { OWNER_TELEGRAM_TOOL_DEFINITIONS } from "../../src/channels/telegram/owner-telegram-agent.js";

const text = "Chem lab due tomorrow at 3pm";
const call = { id: "voice-deadline", name: "deadline_record", arguments: JSON.stringify({ course: "Chem", title: "lab",
  dueAt: "2026-09-24T22:00:00.000Z", effort: "project", evidenceExcerpt: text, dueExcerpt: "tomorrow at 3pm" }) };
const options = { messageAt: new Date("2026-09-24T05:00:00.000Z"), processingAt: new Date("2026-09-26T14:00:00.000Z"), timeZone: "America/Vancouver" };
const rows = async () => (await env.DB.prepare("SELECT * FROM deadlines").all()).results;

describe("deadline voice parity", () => {
  beforeEach(resetDeadlineTables);

  it("records a spoken deadline from the durable turn date in the configured owner zone", async () => {
    const turn = await voiceArgumentTurn(text, call, options);
    expect(turn.result.outcome).toBe("voice_sent");
    expect(await rows()).toMatchObject([{ course: "Chem", title: "lab", due_at: "2026-09-24T22:00:00.000Z" }]);
    expect(turn.spoken).toContain('Created "Chem": "lab"');
    expect(turn.spoken).toContain("America/Vancouver");
    expect(turn.spoken).toContain("3:00");
    expect(turn.requests[0]?.tools.find(tool => tool.name === "deadline_record"))
      .toEqual(OWNER_TELEGRAM_TOOL_DEFINITIONS.find(tool => tool.name === "deadline_record"));
    expect(JSON.stringify(turn.requests[0])).toContain("Owner time zone: America/Vancouver");
  });

  it("records a spoken deadline with the default Toronto owner zone", async () => {
    const turn = await voiceArgumentTurn(text, { ...call, arguments: call.arguments.replace("22:00", "19:00") });
    expect(turn.spoken).toContain("America/Toronto");
    expect(await rows()).toMatchObject([{ due_at: "2026-09-24T19:00:00.000Z" }]);
  });

  it.each([{ direct: false }, { wrongOwner: true }])("refuses a voice deadline without owner authority %j", async (change) => {
    await voiceArgumentTurn(text, call, { ...options, ...change });
    expect(await rows()).toEqual([]);
  });

  it("refuses a spoken deadline when the shared argument tier gate fails", async () => {
    const gate = await testToolGate(env.DB);
    await voiceArgumentTurn(text, call, { ...options, gate: { ...gate, evaluateToolCall: async () => { throw new Error("tier_refused"); } } });
    expect(await rows()).toEqual([]);
  });

  it("refuses a voice deadline if the durable turn channel disagrees with the call", async () => {
    const turn = await withMismatchedVoiceOwnerTurn(() => voiceArgumentTurn(text, call, options));
    expect(JSON.parse(turn.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "refused" });
    expect(await rows()).toEqual([]);
  });
});
