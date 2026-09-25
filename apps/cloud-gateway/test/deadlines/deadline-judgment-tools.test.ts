import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { OWNER_TOOL_DEFINITIONS } from "../../src/agent/owner-tools.js";
import {
  DEADLINE_JUDGMENT_TOOL_DEFINITIONS,
  executeDeadlineJudgmentTool,
} from "../../src/deadlines/deadline-judgment-tools.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { resetDeadlineTables } from "./deadline-fixture.js";
import { argumentTurn, NOW } from "../channels/argument-tool-fixture.js";

const COLLECTED = Object.freeze({
  sourceId: "brightspace-ical",
  externalId: "c-physics:exam-1",
  course: "SPH4U Physics",
  title: "Final Exam",
  dueAt: "2026-09-25T18:00:00.000Z",
});

const call = (name: string, args: Record<string, unknown>, id = "judgment-call") =>
  ({ id, name, arguments: JSON.stringify(args) });

const receipt = (result: { providerResult: { content: string } }): string =>
  (JSON.parse(result.providerResult.content) as { receipt: string }).receipt;

/** A collected exam as ingestion stores it: `other` with the `other` lead, unjudged. */
async function collectedRow(): Promise<string> {
  const repository = new DeadlineRepository(env.DB);
  await repository.ensureSource({ sourceId: COLLECTED.sourceId, kind: "brightspace", label: "Brightspace", now: NOW });
  const created = await repository.upsert({
    sourceId: COLLECTED.sourceId, externalId: COLLECTED.externalId, course: COLLECTED.course,
    title: COLLECTED.title, dueAt: COLLECTED.dueAt, effort: "other", leadMinutes: 1_440, now: NOW,
  });
  return created.deadline.deadlineId;
}

describe("deadline_list and deadline_judge", () => {
  beforeEach(resetDeadlineTables);

  it("shows a collected row as unjudged effort so the model can see what needs judging", async () => {
    const deadlineId = await collectedRow();
    const result = await executeDeadlineJudgmentTool(env.DB, call("deadline_list", { withinDays: 30 }), NOW);

    const text = receipt(result);
    expect(text).toContain("Final Exam");
    // The id is what deadline_judge needs, so the listing must carry it.
    expect(text).toContain(deadlineId);
    expect(text).toContain("unjudged effort (stored other)");
    expect(text).toContain("Judge each one with deadline_judge");
    // The listing must say how many rows need a judgment, not just that some do.
    expect(text).toContain("1 of 1 listed deadlines have unjudged effort");
  });

  it("shows a deadline Jarvis judged as a judged effort, not as unjudged", async () => {
    const deadlineId = await collectedRow();
    await executeDeadlineJudgmentTool(env.DB, call("deadline_judge", { deadlineId, effort: "exam" }), NOW);

    const text = receipt(await executeDeadlineJudgmentTool(env.DB, call("deadline_list", { withinDays: 30 }), NOW));
    expect(text).toContain("effort exam");
    expect(text).not.toContain("unjudged effort");
    expect(text).toContain("Every listed deadline has a judged effort.");
  });

  it("judges a collected row by id and leaves its due date, status and source untouched", async () => {
    const deadlineId = await collectedRow();
    const result = await executeDeadlineJudgmentTool(env.DB, call("deadline_judge",
      { deadlineId, effort: "exam", leadMinutes: 10_080 }), NOW);

    expect(receipt(result)).toContain("effort exam");
    expect(receipt(result)).toContain("10080-minute warning lead");
    const stored = await new DeadlineRepository(env.DB).readDeadline(deadlineId);
    expect(stored).toMatchObject({
      effort: "exam", leadMinutes: 10_080, effortJudged: true, dueAt: COLLECTED.dueAt,
      status: "open", sourceId: COLLECTED.sourceId, externalId: COLLECTED.externalId,
    });
  });

  it("uses the new effort's default lead when the effort changes and no lead is named", async () => {
    const deadlineId = await collectedRow();
    await executeDeadlineJudgmentTool(env.DB, call("deadline_judge",
      { deadlineId, effort: "exam", leadMinutes: 45 }), NOW);

    await executeDeadlineJudgmentTool(env.DB, call("deadline_judge", { deadlineId, effort: "quiz" }, "second-call"), NOW);
    expect(await new DeadlineRepository(env.DB).readDeadline(deadlineId))
      .toMatchObject({ effort: "quiz", leadMinutes: 720 });
  });

  it("keeps the stored lead when the effort is unchanged and no lead is named", async () => {
    const deadlineId = await collectedRow();
    await executeDeadlineJudgmentTool(env.DB, call("deadline_judge",
      { deadlineId, effort: "exam", leadMinutes: 45 }), NOW);

    await executeDeadlineJudgmentTool(env.DB, call("deadline_judge", { deadlineId, effort: "exam" }, "second-call"), NOW);
    expect(await new DeadlineRepository(env.DB).readDeadline(deadlineId))
      .toMatchObject({ effort: "exam", leadMinutes: 45 });
  });

  it("refuses an unknown deadline id without writing anything", async () => {
    const result = await executeDeadlineJudgmentTool(env.DB, call("deadline_judge",
      { deadlineId: "01k3w1t4000000000000009999", effort: "exam" }), NOW);

    expect(receipt(result)).toContain("deadline_id_unknown");
    expect(receipt(result)).toContain("Nothing changed.");
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM deadlines").first<{ count: number }>())?.count).toBe(0);
  });

  it.each([
    ["an invalid effort", { deadlineId: "x", effort: "midterm" }],
    ["a negative lead", { deadlineId: "x", effort: "exam", leadMinutes: -1 }],
    ["an unknown argument", { deadlineId: "x", effort: "exam", other: true }],
  ])("refuses %s before touching the store", async (_label, args) => {
    const result = await executeDeadlineJudgmentTool(env.DB, call("deadline_judge", args), NOW);
    expect(receipt(result)).toContain("deadline_input_invalid");
  });

  it("refuses a withinDays window outside the documented range", async () => {
    for (const withinDays of [0, 366, 1.5]) {
      const result = await executeDeadlineJudgmentTool(env.DB, call("deadline_list", { withinDays }), NOW);
      expect(receipt(result)).toContain("deadline_within_days_invalid");
    }
  });

  it("tells the model the listing is where it learns which rows it must judge", () => {
    const list = DEADLINE_JUDGMENT_TOOL_DEFINITIONS.find((tool) => tool.name === "deadline_list")!;
    const judge = DEADLINE_JUDGMENT_TOOL_DEFINITIONS.find((tool) => tool.name === "deadline_judge")!;
    // The instruction lives in the tool description because that is the surface
    // the model reads; the register row claims only what this instruction and
    // the deadline_judge executor actually do.
    expect(list.description).toContain("After listing, call deadline_judge for every row marked unjudged effort");
    expect(list.description).toContain("Never infer an effort from a title word list");
    expect(judge.description).toContain("your judgment of what the work is");
    expect(judge.description).toContain("ask Sid rather than guessing");
  });

  it("offers both tools to Telegram and calls alike through the shared owner catalogue", () => {
    const names = OWNER_TOOL_DEFINITIONS.map((tool) => tool.name);
    for (const { name } of DEADLINE_JUDGMENT_TOOL_DEFINITIONS) expect(names).toContain(name);
  });

  it("dispatches deadline_judge through an owner turn", async () => {
    const deadlineId = await collectedRow();
    const turn = await argumentTurn("that final exam is an exam", call("deadline_judge", { deadlineId, effort: "exam" }));
    expect(turn.result.outcome).toBe("telegram_delivered");
    expect((await new DeadlineRepository(env.DB).readDeadline(deadlineId))?.effortJudged).toBe(true);
  });
});
