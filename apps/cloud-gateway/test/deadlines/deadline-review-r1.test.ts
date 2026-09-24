import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { recordDeadline as executeDeadline } from "../../src/deadlines/deadline-tool.js";
import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { DEFAULT_LEAD_MINUTES } from "../../src/deadlines/effort-classifier.js";
import type { ModelAdapterStreamInput } from "../../src/model/model-adapter.js";
import { resetDeadlineTables } from "./deadline-fixture.js";
import { argumentTurn } from "../channels/argument-tool-fixture.js";

const now = new Date("2026-09-23T14:00:00.000Z");
const message = "Chemistry Lab report is due September 25, 2026 at 3:30 pm.";
const args = { course: "Chemistry", title: "Lab report", dueAt: "2026-09-25T15:30:00-04:00",
  timeZone: "America/Toronto", effort: "project", evidenceExcerpt: message, dueExcerpt: "September 25, 2026 at 3:30 pm" };
const recordDeadline = (...values: Parameters<typeof executeDeadline> extends [...infer P, unknown] ? P : never) =>
  executeDeadline(...values, { ownerZone: "America/Toronto", messageAt: now.toISOString() });
const input = (userText: string) => ({ userText, principalId: "principal:deadline-review" }) as ModelAdapterStreamInput;
const call = (changes: Record<string, unknown> = {}) => ({ id: "review-call", name: "deadline_record", arguments: JSON.stringify({ ...args, ...changes }) });
const rows = () => env.DB.prepare("SELECT * FROM deadlines").all<Record<string, unknown>>();

describe("deadline review regression proofs", () => {
  beforeEach(resetDeadlineTables);

  it.each(["UTC", "America/Vancouver"])("refuses an unstated %s zone for the owner's Toronto wall time", async (timeZone) => {
    const dueAt = timeZone === "UTC" ? "2026-09-25T15:30:00Z" : "2026-09-25T15:30:00-07:00";
    expect((await recordDeadline(env.DB, input(message), call({ timeZone, dueAt }), now)).providerResult.content).toContain("deadline_zone_mismatch");
    expect((await rows()).results).toHaveLength(0);
  });

  it("exposes an owner-reported project inside its standard reminder lead window", async () => {
    await recordDeadline(env.DB, input(message), call(), now);
    const row = (await rows()).results[0]!;
    expect(row.lead_minutes).toBe(DEFAULT_LEAD_MINUTES.project);
    expect(await new DeadlineRepository(env.DB).listReminderDue(new Date("2026-09-24T19:30:00.000Z"))).toHaveLength(1);
  });

  it("preserves a submitted status when the owner mentions the deadline without another status", async () => {
    const submitted = `${message} submitted`;
    await recordDeadline(env.DB, input(submitted), call({ status: "submitted", evidenceExcerpt: submitted }), now);
    await recordDeadline(env.DB, input(message), call(), now);
    expect((await rows()).results[0]?.status).toBe("submitted");
  });

  it("refuses internally consistent invented evidence absent from the current message", async () => {
    const invented = "Chemistry Lab report is due September 26, 2026 at 4:30 pm.";
    const result = await recordDeadline(env.DB, input(message), call({ evidenceExcerpt: invented,
      dueExcerpt: "September 26, 2026 at 4:30 pm", dueAt: "2026-09-26T16:30:00-04:00" }), now);
    expect(result.providerResult.content).toContain("deadline_evidence_not_in_message");
    expect((await rows()).results).toHaveLength(0);
  });

  it("refuses to borrow the Physics clock for the Chemistry deadline", async () => {
    const text = "Chem due September 25, 2026. Physics quiz October 2, 2026 at 9:00 am";
    for (const dueExcerpt of ["September 25, 2026", "October 2, 2026 at 9:00 am", "September 25, 2026 at 9:00 am"]) {
      const result = await recordDeadline(env.DB, input(text), call({ course: "Chem", title: "Chem", evidenceExcerpt: text,
        dueExcerpt, dueAt: "2026-09-25T09:00:00-04:00" }), now);
      expect(JSON.parse(result.providerResult.content).status).toBe("refused");
      expect((await rows()).results).toHaveLength(0);
    }
  });

  it("accepts an explicitly named Vancouver zone and receipts it in the owner zone", async () => {
    const dueExcerpt = "September 25, 2026 at 3:30 pm America/Vancouver";
    const text = `Chemistry Lab report is due ${dueExcerpt}.`;
    const result = await recordDeadline(env.DB, input(text), call({ evidenceExcerpt: text, dueExcerpt,
      timeZone: "America/Vancouver", dueAt: "2026-09-25T15:30:00-07:00" }), now);
    expect((await rows()).results[0]?.due_at).toBe("2026-09-25T22:30:00.000Z");
    expect(result.receipt).toContain("6:30");
    expect(result.receipt).toContain("America/Toronto");
    expect(result.receipt).not.toContain("America/Vancouver");
  });

  it.each([["canceled", "cancelled"], ["handed in", "submitted"], ["turned in", "submitted"]])(
    "stores the stated status synonym %s as %s", async (status, expected) => {
      const text = `${message} ${status}`;
      await recordDeadline(env.DB, input(text), call({ status, evidenceExcerpt: text }), now);
      expect((await rows()).results[0]?.status).toBe(expected);
    });

  it("distinguishes creation, unchanged mentions, status updates and a moved due time", async () => {
    expect((await recordDeadline(env.DB, input(message), call(), now)).receipt).toMatch(/^Created /u);
    expect((await recordDeadline(env.DB, input(message), call(), now)).receipt).toMatch(/^Unchanged /u);
    const submitted = `${message} handed in`;
    expect((await recordDeadline(env.DB, input(submitted), call({ status: "submitted", evidenceExcerpt: submitted }), now)).receipt).toMatch(/^Updated /u);
    const moved = message.replace("25", "26");
    const result = await recordDeadline(env.DB, input(moved), call({ evidenceExcerpt: moved,
      dueExcerpt: args.dueExcerpt.replace("25", "26"), dueAt: "2026-09-26T15:30:00-04:00" }), now);
    expect(result.receipt).toMatch(/^Updated /u);
    expect(result.receipt).toContain("Previous due time: Friday, September 25, 2026");
    expect(result.receipt).toContain("submitted");
    expect((await rows()).results).toHaveLength(1);
  });

  it("updates effort and its lead window without calling the change unchanged", async () => {
    await recordDeadline(env.DB, input(message), call(), now);
    const result = await recordDeadline(env.DB, input(message), call({ effort: "quiz" }), now);
    expect(result.receipt).toMatch(/^Updated /u);
    expect((await rows()).results[0]).toMatchObject({ effort: "quiz", lead_minutes: DEFAULT_LEAD_MINUTES.quiz });
  });

  it("matches Chem and Chemistry across case and whitespace without a duplicate", async () => {
    const text = message.replace("Chemistry Lab report", "Chem lab   report");
    await recordDeadline(env.DB, input(text), call({ course: "Chem", title: "lab   report", evidenceExcerpt: text }), now);
    const result = await recordDeadline(env.DB, input(message), call(), now);
    expect(result.receipt).toMatch(/^Unchanged /u);
    expect((await rows()).results).toHaveLength(1);
  });

  it("finds a legacy literal identity before normalising the title", async () => {
    const repo = new DeadlineRepository(env.DB);
    await repo.ensureSource({ sourceId: "owner-reported", kind: "manual", label: "owner-reported", now });
    await repo.upsert({ sourceId: "owner-reported", externalId: await sha256Hex(canonicalJson({ principal: input(message).principalId,
      course: "Chem", title: "lab report" })), course: "Chem", title: "lab report", dueAt: "2026-09-25T19:30:00.000Z",
      effort: "project", leadMinutes: 0, now });
    const result = await recordDeadline(env.DB, input(message), call(), now);
    expect(result.receipt).toMatch(/^Updated /u);
    expect((await rows()).results).toHaveLength(1);
    expect((await rows()).results[0]?.lead_minutes).toBe(DEFAULT_LEAD_MINUTES.project);
  });

  it("asks which assignment is intended when a similar title is uncertain", async () => {
    await recordDeadline(env.DB, input(message), call(), now);
    const text = message.replace("Lab report", "Lab report draft");
    const result = await recordDeadline(env.DB, input(text), call({ title: "Lab report draft", evidenceExcerpt: text }), now);
    expect(result.providerResult.content).toContain("deadline_ambiguous_match");
    expect(result.providerResult.content).toContain("Lab report");
    expect((await rows()).results).toHaveLength(1);
  });

  it("does not match another principal's otherwise identical assignment", async () => {
    await recordDeadline(env.DB, input(message), call(), now);
    const result = await recordDeadline(env.DB, { ...input(message), principalId: "principal:other" }, call(), now);
    expect(result.receipt).toMatch(/^Created /u);
    expect((await rows()).results).toHaveLength(2);
  });

  it("stores a missing clock as date-only and says the end of day was not stated", async () => {
    const text = "Chemistry Lab report is due Friday";
    const result = await recordDeadline(env.DB, input(text), call({ evidenceExcerpt: text, dueExcerpt: "Friday", dueAt: "2026-09-25" }), now);
    expect((await rows()).results[0]?.due_at).toBe("2026-09-26T03:59:59.999Z");
    expect(result.receipt).toContain("date-only");
    expect(result.receipt).toContain("not a stated clock time");
  });

  it("returns a specific missing date reason to the model", async () => {
    const result = await argumentTurn(message, call({ dueExcerpt: "" }));
    expect(JSON.stringify(result.requests[1])).toContain("deadline_missing_date");
    expect((await rows()).results).toHaveLength(0);
  });

  it("resolves tomorrow from the durable message date in the configured owner zone", async () => {
    const text = "Chemistry Lab report is due tomorrow at 3pm";
    const result = await argumentTurn(text, call({ evidenceExcerpt: text, dueExcerpt: "tomorrow at 3pm",
      timeZone: undefined, dueAt: "2026-09-24T15:00:00-07:00" }), { timeZone: "America/Vancouver",
      messageAt: new Date("2026-09-24T05:00:00.000Z"), processingAt: new Date("2026-09-26T14:00:00.000Z") });
    expect((await rows()).results[0]?.due_at).toBe("2026-09-24T22:00:00.000Z");
    expect(result.replies.join(" ")).toContain("America/Vancouver");
    expect(JSON.stringify(result.requests[0])).toContain("2026-09-24T05:00:00.000Z");
  });
});
