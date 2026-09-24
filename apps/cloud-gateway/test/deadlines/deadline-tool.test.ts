import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { proveDeadlineTime, recordDeadline } from "../../src/deadlines/deadline-tool.js";
import type { ModelAdapterStreamInput } from "../../src/model/model-adapter.js";
import { resetDeadlineTables } from "./deadline-fixture.js";
import { argumentTurn, NOW } from "../channels/argument-tool-fixture.js";

const message = "Chemistry Lab report is due September 25, 2026 at 3:30 pm.";
const args = { course: "Chemistry", title: "Lab report", dueAt: "2026-09-25T15:30:00-04:00",
  timeZone: "America/Toronto", effort: "project", evidenceExcerpt: message };
const call = (changes = {}) => ({ id: "deadline-call", name: "deadline_record", arguments: JSON.stringify({ ...args, ...changes }) });
const input = (userText = message) => ({ userText, principalId: "principal:test" }) as ModelAdapterStreamInput;
const rows = () => env.DB.prepare("SELECT * FROM deadlines").all<Record<string, unknown>>();

describe("owner reported deadlines", () => {
  beforeEach(resetDeadlineTables);

  it("dispatches a dated row through the owner turn and displays its local receipt", async () => {
    const result = await argumentTurn(message, call());
    expect(result.result.outcome).toBe("telegram_delivered");
    expect(result.replies.join(" ")).toContain('Recorded "Chemistry": "Lab report"');
    expect(result.replies.join(" ")).toContain("3:30");
    expect(result.replies.join(" ")).toContain("America/Toronto");
    expect((await rows()).results).toMatchObject([{ source_id: "owner-reported", due_at: "2026-09-25T19:30:00.000Z", status: "open", effort: "project" }]);
    const repo = new DeadlineRepository(env.DB);
    expect(await repo.readSource("owner-reported")).toMatchObject({ kind: "manual", label: "owner-reported" });
    expect(await repo.listDueWithin({ from: NOW, to: new Date("2026-09-30T00:00:00.000Z") })).toHaveLength(1);
    expect(await repo.listStudyCandidates(NOW)).toHaveLength(1);
  });

  it.each(["submitted", "missed", "cancelled"])("records the explicitly stated %s status", async (status) => {
    const text = `${message} ${status}`;
    await recordDeadline(env.DB, input(text), call({ status, evidenceExcerpt: text }), NOW);
    expect((await rows()).results[0]?.status).toBe(status);
  });

  it("updates the same course and title without creating another row", async () => {
    await recordDeadline(env.DB, input(), call(), NOW);
    const text = `${message} submitted`;
    await recordDeadline(env.DB, input(text), call({ status: "submitted", effort: "essay", evidenceExcerpt: text }), NOW);
    expect((await rows()).results).toMatchObject([{ status: "submitted", effort: "essay" }]);
    expect((await rows()).results).toHaveLength(1);
    const moved = "Chemistry Lab report is due September 26, 2026 at 3:30 pm. cancelled";
    await recordDeadline(env.DB, input(moved), call({ dueAt: "2026-09-26T15:30:00-04:00", status: "cancelled", evidenceExcerpt: moved }), NOW);
    expect((await rows()).results).toMatchObject([{ status: "cancelled", due_at: "2026-09-26T19:30:00.000Z" }]);
  });

  it.each([
    ["invented evidence", { evidenceExcerpt: "Chemistry Lab report is due September 26, 2026 at 3:30 pm." }],
    ["an invented course", { course: "Biology" }],
    ["an invented title", { title: "Exam" }],
    ["an unstated status", { status: "submitted" }],
    ["a date absent from the evidence", { dueAt: "2026-09-26T15:30:00-04:00" }],
    ["a time absent from the evidence", { dueAt: "2026-09-25T16:30:00-04:00" }],
    ["a mismatched zone offset", { dueAt: "2026-09-25T15:30:00-05:00" }],
    ["a missing offset", { dueAt: "2026-09-25T15:30:00" }],
    ["an invalid effort", { effort: "huge" }],
    ["an unknown argument", { other: true }],
  ])("refuses %s before creating a source or a deadline", async (_label, changes) => {
    await expect(recordDeadline(env.DB, input(), call(changes), NOW)).rejects.toThrow();
    expect((await rows()).results).toHaveLength(0);
    expect(await new DeadlineRepository(env.DB).readSource("owner-reported")).toBeNull();
  });

  it("refuses evidence cut out of the middle of a word", async () => {
    await expect(recordDeadline(env.DB, input(`Bio${message}`), call(), NOW)).rejects.toThrow();
    expect((await rows()).results).toHaveLength(0);
  });

  it("refuses an explicit open status even when the evidence contains that word", async () => {
    const text = `${message} open`;
    await expect(recordDeadline(env.DB, input(text), call({ status: "open", evidenceExcerpt: text }), NOW)).rejects.toThrow();
    expect((await rows()).results).toHaveLength(0);
  });

  it.each([
    ["a forwarded turn", { direct: false, durableDirect: true }],
    ["a nonprivate turn", { pipeline: false }],
    ["a forged direct marker", { durableDirect: false }],
    ["a tier gate failure", { gate: { async evaluateToolCall() { throw new Error("denied"); } } }],
  ])("refuses %s before the argument tool writes", async (_label, options) => {
    const result = await argumentTurn(message, call(), options);
    expect(result.result.outcome).toBe("telegram_delivered");
    expect((await rows()).results).toHaveLength(0);
  });

  it("compares the stated date and clock in winter and during the repeated fall hour", () => {
    expect(() => proveDeadlineTime("2026-09-25T15:30:00", "America/Toronto", message)).toThrow("deadline_time_invalid");
    expect(proveDeadlineTime("2026-12-01T15:30:00-05:00", "America/Toronto", "2026-12-01 15:30"))
      .toBe("2026-12-01T20:30:00.000Z");
    expect(proveDeadlineTime("2026-11-01T01:30:00-05:00", "America/Toronto", "1 November 2026 1:30am"))
      .toBe("2026-11-01T06:30:00.000Z");
    expect(() => proveDeadlineTime("2026-03-08T02:30:00-05:00", "America/Toronto", "2026-03-08 02:30"))
      .toThrow("deadline_zone_or_date_invalid");
    expect(() => proveDeadlineTime("2026-02-30T15:30:00-05:00", "America/Toronto", "March 2, 2026 at 3:30 pm"))
      .toThrow("deadline_zone_or_date_invalid");
  });
});
