import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { OWNER_TOOL_DEFINITIONS } from "../../src/agent/owner-tools.js";
import {
  DEADLINE_LIST_TOOL_DEFINITION,
  executeDeadlineListTool,
} from "../../src/deadlines/deadline-list-tool.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { resetDeadlineTables } from "./deadline-fixture.js";
import { argumentTurn, NOW } from "../channels/argument-tool-fixture.js";

const call = (withinDays: unknown = 30, id = "deadline-list") =>
  ({ id, name: "deadline_list", arguments: JSON.stringify({ withinDays }) });

const receipt = (result: { providerResult: { content: string } }): string =>
  (JSON.parse(result.providerResult.content) as { receipt: string }).receipt;

async function collected(overrides: { externalId: string; title: string; dueAt: string | null }): Promise<string> {
  const repository = new DeadlineRepository(env.DB);
  await repository.ensureSource({ sourceId: "brightspace-ical", kind: "brightspace", label: "Brightspace", now: NOW });
  const created = await repository.upsert({
    sourceId: "brightspace-ical", course: "SPH4U Physics", title: overrides.title,
    externalId: overrides.externalId, dueAt: overrides.dueAt, now: NOW,
  });
  return created.deadline.deadlineId;
}

describe("deadline_list", () => {
  beforeEach(resetDeadlineTables);

  it("shows the stored effort-free row: title, course, due or no due date, status and source", async () => {
    const datedId = await collected({ externalId: "exam", title: "Final Exam", dueAt: "2026-09-25T18:00:00.000Z" });
    const undatedId = await collected({ externalId: "essay", title: "Comparative essay", dueAt: null });

    const text = receipt(await executeDeadlineListTool(env.DB, call(30), NOW));

    expect(text).toContain(datedId);
    expect(text).toContain("Final Exam");
    expect(text).toContain("due 2026-09-25T18:00:00.000Z");
    expect(text).toContain(undatedId);
    expect(text).toContain("Comparative essay");
    expect(text).toContain("no due date");
    expect(text).toContain("source brightspace-ical");
    // No category and no warning lead are shown, because none is stored.
    expect(text).not.toContain("effort");
    expect(text).not.toContain("lead");
  });

  it("asks the model to get a missing due date from Sid rather than guessing one", async () => {
    await collected({ externalId: "essay", title: "Comparative essay", dueAt: null });

    const text = receipt(await executeDeadlineListTool(env.DB, call(30), NOW));

    expect(text).toContain("ask Sid for those dates and store them with deadline_record");
  });

  it("does not list a dated deadline outside the window but still lists an undated one", async () => {
    await collected({ externalId: "soon", title: "Soon", dueAt: "2026-09-25T18:00:00.000Z" });
    await collected({ externalId: "far", title: "Far", dueAt: "2027-01-25T18:00:00.000Z" });
    await collected({ externalId: "undated", title: "Undated", dueAt: null });

    const text = receipt(await executeDeadlineListTool(env.DB, call(7), NOW));

    expect(text).toContain("Soon");
    expect(text).not.toContain("Far");
    expect(text).toContain("Undated");
  });

  it("says so plainly when there is nothing to list", async () => {
    const text = receipt(await executeDeadlineListTool(env.DB, call(7), NOW));
    expect(text).toContain("No open deadlines");
  });

  it.each([0, 366, 1.5, "30"])("refuses a withinDays window of %s", async (withinDays) => {
    const result = await executeDeadlineListTool(env.DB, call(withinDays), NOW);
    expect(receipt(result)).toContain("deadline_within_days_invalid");
  });

  it("is in the shared owner catalogue, so Telegram and calls offer the same view", () => {
    expect(OWNER_TOOL_DEFINITIONS.find((tool) => tool.name === "deadline_list")).toEqual(DEADLINE_LIST_TOOL_DEFINITION);
  });

  it("dispatches through an owner turn and shows an undated collected deadline", async () => {
    const id = await collected({ externalId: "essay", title: "Comparative essay", dueAt: null });
    const turn = await argumentTurn("what deadlines do I have", call(30));
    expect(turn.result.outcome).toBe("telegram_delivered");
    const result = JSON.parse(turn.requests[1]?.toolResults?.[0]?.content ?? "{}") as { status: string; receipt: string };
    expect(result.status).toBe("completed");
    expect(result.receipt).toContain(id);
    expect(result.receipt).toContain("no due date");
  });
});
