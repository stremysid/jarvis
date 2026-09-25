import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { recordDeadline as executeDeadline } from "../../src/deadlines/deadline-tool.js";
import { proveDeadlineDue } from "../../src/deadlines/deadline-date-proof.js";
import type { ModelAdapterStreamInput } from "../../src/model/model-adapter.js";
import { resetDeadlineTables } from "./deadline-fixture.js";
import { argumentTurn, NOW } from "../channels/argument-tool-fixture.js";

const message = "Chemistry Lab report is due September 25, 2026 at 3:30 pm.";
const args = { course: "Chemistry", title: "Lab report", dueAt: "2026-09-25T15:30:00-04:00",
  timeZone: "America/Toronto", effort: "project", evidenceExcerpt: message, dueExcerpt: "September 25, 2026 at 3:30 pm" };
const recordDeadline = (...values: Parameters<typeof executeDeadline> extends [...infer P, unknown] ? P : never) =>
  executeDeadline(...values, { ownerZone: "America/Toronto", messageAt: NOW.toISOString() });
const call = (changes = {}) => ({ id: "deadline-call", name: "deadline_record", arguments: JSON.stringify({ ...args, ...changes }) });
const input = (userText = message) => ({ userText, principalId: "principal:test" }) as ModelAdapterStreamInput;
const rows = () => env.DB.prepare("SELECT * FROM deadlines").all<Record<string, unknown>>();

describe("owner reported deadlines", () => {
  beforeEach(resetDeadlineTables);

  it("dispatches a dated row through the owner turn and displays its local receipt", async () => {
    const result = await argumentTurn(message, call());
    expect(result.result.outcome).toBe("telegram_delivered");
    expect(result.replies.join(" ")).toContain('Created "Chemistry": "Lab report"');
    expect(result.replies.join(" ")).toContain("3:30");
    expect(result.replies.join(" ")).toContain("America/Toronto");
    expect((await rows()).results).toMatchObject([{ source_id: "owner-reported", due_at: "2026-09-25T19:30:00.000Z", status: "open", effort: "project" }]);
    const repo = new DeadlineRepository(env.DB);
    expect(await repo.readSource("owner-reported")).toMatchObject({ kind: "manual", label: "owner-reported" });
    expect(await repo.listDueWithin({ from: NOW, to: new Date("2026-09-30T00:00:00.000Z") })).toHaveLength(1);
    expect(await repo.listStudyCandidates(NOW)).toHaveLength(1);
  });

  it("hides deadline_record from a Telegram guest and refuses a forged call without writing a row", async () => {
    // Keep direct text, durable evidence and valid arguments: only the principal
    // differs from the successful owner turn, so another refusal cannot mask it.
    const turn = await argumentTurn(message, call(), { wrongOwner: true });
    expect(turn.result.outcome).toBe("telegram_delivered");
    expect(turn.requests).toHaveLength(2);
    for (const request of turn.requests) {
      expect(request.tools).toEqual([]);
      expect(request.tools.map(tool => tool.name)).not.toContain("deadline_record");
      expect(request.toolChoice).toBe("none");
    }
    expect(JSON.parse(turn.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({
      status: "refused",
      receipt: "I refused that tool call because this is not Sid's direct current Telegram text. Nothing changed.",
    });
    expect((await rows()).results).toEqual([]);
    expect(await new DeadlineRepository(env.DB).readSource("owner-reported")).toBeNull();
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
    await recordDeadline(env.DB, input(moved), call({ dueAt: "2026-09-26T15:30:00-04:00", dueExcerpt: "September 26, 2026 at 3:30 pm", status: "cancelled", evidenceExcerpt: moved }), NOW);
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
    ["a numeric timezone instead of an IANA zone", { timeZone: "-04:00" }],
    ["an invalid effort", { effort: "huge" }],
    ["an unknown argument", { other: true }],
  ])("refuses %s before creating a source or a deadline", async (_label, changes) => {
    expect(JSON.parse((await recordDeadline(env.DB, input(), call(changes), NOW)).providerResult.content).status).toBe("refused");
    expect((await rows()).results).toHaveLength(0);
    expect(await new DeadlineRepository(env.DB).readSource("owner-reported")).toBeNull();
  });

  it("refuses evidence cut out of the middle of a word", async () => {
    expect(JSON.parse((await recordDeadline(env.DB, input(`Bio${message}`), call(), NOW)).providerResult.content).status).toBe("refused");
    expect((await rows()).results).toHaveLength(0);
  });

  it("persists the requested status when an unchanged row appears between update and read", async () => {
    const repository = new DeadlineRepository(env.DB);
    await repository.ensureSource({ sourceId: "owner-reported", kind: "manual", label: "owner-reported", now: NOW });
    const entry = { sourceId: "owner-reported", externalId: "raced", course: "Chemistry", title: "Lab report",
      dueAt: "2026-09-25T19:30:00.000Z", effort: "project" as const, leadMinutes: 0, now: NOW };
    let injectRace = true;
    const database = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => new Proxy(target.prepare(sql), { get(statement, method) {
        if (method === "bind") return (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return new Proxy(bound, { get(query, operation) {
            if (operation === "first" && sql.includes("UPDATE deadlines") && injectRace) return async () => {
              injectRace = false;
              await repository.upsert(entry);
              return null;
            };
            const value = Reflect.get(query, operation);
            return typeof value === "function" ? value.bind(query) : value;
          } });
        };
        const value = Reflect.get(statement, method);
        return typeof value === "function" ? value.bind(statement) : value;
      } });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await new DeadlineRepository(database).upsert({ ...entry, status: "submitted" });
    expect(result.deadline.status).toBe("submitted");
    expect((await repository.readByExternalId("owner-reported", "raced"))?.status).toBe("submitted");
  });

  it("refuses an explicit open status even when the evidence contains that word", async () => {
    const text = `${message} open`;
    expect(JSON.parse((await recordDeadline(env.DB, input(text), call({ status: "open", evidenceExcerpt: text }), NOW)).providerResult.content).status).toBe("refused");
    expect((await rows()).results).toHaveLength(0);
  });

  it("refuses an offset mismatch even when both clock times occur in the evidence", async () => {
    const text = `${message} The office closes at 4:30 pm.`;
    expect((await recordDeadline(env.DB, input(text), call({ dueAt: "2026-09-25T15:30:00-05:00", evidenceExcerpt: text }), NOW)).providerResult.content)
      .toContain("deadline_resolved_date_mismatch");
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

  it("uses the winter offset for an unambiguous clock", () => {
    expect(proveDeadlineDue({ dueAt: "2026-12-01T15:30:00-05:00", ownerZone: "America/Toronto",
      dueExcerpt: "2026-12-01 15:30", messageAt: NOW.toISOString() }).dueAt).toBe("2026-12-01T20:30:00.000Z");
  });
});
