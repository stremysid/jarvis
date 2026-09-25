import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { DEADLINE_TOOL_DEFINITION, recordDeadline as executeDeadline } from "../../src/deadlines/deadline-tool.js";
import { DEFAULT_LEAD_MINUTES } from "../../src/deadlines/effort-lead-times.js";
import type { ModelAdapterStreamInput } from "../../src/model/model-adapter.js";
import { resetDeadlineTables } from "./deadline-fixture.js";
import { argumentTurn, NOW } from "../channels/argument-tool-fixture.js";

const message = "Chemistry Lab report is due September 25, 2026 at 3:30 pm.";
const args = { course: "Chemistry", title: "Lab report", dueAt: "2026-09-25T15:30:00-04:00", effort: "project" };
const recordDeadline = (...values: Parameters<typeof executeDeadline> extends [...infer P, unknown] ? P : never) =>
  executeDeadline(...values, { ownerZone: "America/Toronto" });
const call = (changes: Record<string, unknown> = {}) => ({ id: "deadline-call", name: "deadline_record", arguments: JSON.stringify({ ...args, ...changes }) });
const input = (principalId = "principal:test") => ({ userText: message, principalId }) as ModelAdapterStreamInput;
const rows = () => env.DB.prepare("SELECT * FROM deadlines ORDER BY first_seen_at, deadline_id").all<Record<string, unknown>>();
const content = (result: { providerResult: { content: string } }) => JSON.parse(result.providerResult.content) as { status: string; receipt: string };
const ownerRow = async (course: string, title: string, principalId = "principal:test") => {
  const repo = new DeadlineRepository(env.DB);
  await repo.ensureSource({ sourceId: "owner-reported", kind: "manual", label: "owner-reported", now: NOW });
  await repo.upsert({ sourceId: "owner-reported", externalId: await sha256Hex(canonicalJson({ principal: principalId, course, title })),
    course, title, dueAt: "2026-09-25T19:30:00.000Z", effort: "project", leadMinutes: DEFAULT_LEAD_MINUTES.project, now: NOW });
};

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

  it("tells the model to decide the fields itself and to ask Sid when it is unsure", () => {
    expect(DEADLINE_TOOL_DEFINITION.description).toContain("You decide the course, title, due date and time, effort and status");
    expect(DEADLINE_TOOL_DEFINITION.description).toContain("ask him instead of calling this tool");
    // The effort is the model's judgment, including its uncertainty; the tool
    // offers no word list for it to fall back on.
    expect(DEADLINE_TOOL_DEFINITION.description).toContain("your judgment of what this is");
    expect(DEADLINE_TOOL_DEFINITION.description).toContain("ask Sid rather than guessing");
    expect(DEADLINE_TOOL_DEFINITION.parameters.required).toEqual(["course", "title", "dueAt", "effort"]);
    expect(Object.keys(DEADLINE_TOOL_DEFINITION.parameters.properties as object)).toContain("leadMinutes");
    expect(DEADLINE_TOOL_DEFINITION.parameters.required).not.toContain("leadMinutes");
    expect(Object.keys(DEADLINE_TOOL_DEFINITION.parameters.properties as object)).not.toContain("dueExcerpt");
    expect(Object.keys(DEADLINE_TOOL_DEFINITION.parameters.properties as object)).not.toContain("evidenceExcerpt");
  });

  it.each([
    ["a period between the title and a lowercase due phrase", "Chem lab report. due 3pm friday",
      { course: "Chem", title: "lab report", dueAt: "2026-09-25T15:00:00-04:00" }, "2026-09-25T19:00:00.000Z"],
    ["a due phrase in the sentence after the title", "English essay. It is due next Friday, I think at 11:59pm.",
      { course: "English", title: "essay", dueAt: "2026-10-02T23:59:00-04:00", effort: "essay" }, "2026-10-03T03:59:00.000Z"],
    ["a course the model expands from Sid's abbreviation", "chem lab due friday at 3",
      { course: "Chemistry", title: "Lab", dueAt: "2026-09-25T15:00:00-04:00" }, "2026-09-25T19:00:00.000Z"],
    ["a bare weekday naming the message day", "Math quiz due Wednesday at 5pm",
      { course: "Math", title: "quiz", dueAt: "2026-09-23T17:00:00-04:00", effort: "quiz" }, "2026-09-23T21:00:00.000Z"],
    ["a title Sid never said beside another assignment's clock", "Chem due September 25, 2026. Physics quiz October 2, 2026 at 9:00 am",
      { course: "Chem", title: "assignment", dueAt: "2026-09-25" }, "2026-09-26T03:59:59.999Z"],
    ["a clock that has already passed today", "Bio worksheet was due at 8am today, I missed it",
      { course: "Bio", title: "worksheet", dueAt: "2026-09-23T08:00:00-04:00", status: "missed", effort: "other" }, "2026-09-23T12:00:00.000Z"],
  ])("accepts %s when the model supplies a valid date", async (_label, text, changes, stored) => {
    const turn = await argumentTurn(text, call(changes));
    expect(JSON.parse(turn.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "completed" });
    expect((await rows()).results).toMatchObject([{ course: changes.course, title: changes.title, due_at: stored }]);
  });

  it("records a status the model infers from wording the old keyword list refused", async () => {
    const turn = await argumentTurn("finally finished the chem lab and put it in the dropbox", call({ status: "submitted" }));
    expect(JSON.parse(turn.requests[1]?.toolResults?.[0]?.content ?? "{}")).toMatchObject({ status: "completed" });
    expect((await rows()).results).toMatchObject([{ status: "submitted" }]);
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

  it.each(["submitted", "missed", "cancelled"])("records the %s status the model chose", async (status) => {
    await recordDeadline(env.DB, input(), call({ status }), NOW);
    expect((await rows()).results[0]?.status).toBe(status);
  });

  it("reopens a submitted deadline when the model sets it open", async () => {
    await recordDeadline(env.DB, input(), call({ status: "submitted" }), NOW);
    const result = await recordDeadline(env.DB, input(), call({ status: "open" }), NOW);
    expect(result.receipt).toMatch(/^Updated /u);
    expect((await rows()).results[0]?.status).toBe("open");
  });

  it("preserves a submitted status when a later call leaves status out", async () => {
    await recordDeadline(env.DB, input(), call({ status: "submitted" }), NOW);
    await recordDeadline(env.DB, input(), call(), NOW);
    expect((await rows()).results[0]?.status).toBe("submitted");
  });

  it("updates the same course and title without creating another row", async () => {
    await recordDeadline(env.DB, input(), call(), NOW);
    await recordDeadline(env.DB, input(), call({ status: "submitted", effort: "essay" }), NOW);
    expect((await rows()).results).toMatchObject([{ status: "submitted", effort: "essay" }]);
    await recordDeadline(env.DB, input(), call({ dueAt: "2026-09-26T15:30:00-04:00", status: "cancelled" }), NOW);
    expect((await rows()).results).toMatchObject([{ status: "cancelled", due_at: "2026-09-26T19:30:00.000Z" }]);
    expect((await rows()).results).toHaveLength(1);
  });

  it("distinguishes creation, unchanged mentions, status updates and a moved due time", async () => {
    expect((await recordDeadline(env.DB, input(), call(), NOW)).receipt).toMatch(/^Created /u);
    expect((await recordDeadline(env.DB, input(), call(), NOW)).receipt).toMatch(/^Unchanged /u);
    expect((await recordDeadline(env.DB, input(), call({ status: "submitted" }), NOW)).receipt).toMatch(/^Updated /u);
    const result = await recordDeadline(env.DB, input(), call({ dueAt: "2026-09-26T15:30:00-04:00" }), NOW);
    expect(result.receipt).toMatch(/^Updated /u);
    expect(result.receipt).toContain("Previous due time: Friday, September 25, 2026");
    expect(result.receipt).toContain("submitted");
    expect((await rows()).results).toHaveLength(1);
  });

  it("exposes an owner-reported project inside its standard reminder lead window", async () => {
    await recordDeadline(env.DB, input(), call(), NOW);
    expect((await rows()).results[0]?.lead_minutes).toBe(DEFAULT_LEAD_MINUTES.project);
    expect(await new DeadlineRepository(env.DB).listReminderDue(new Date("2026-09-24T19:30:00.000Z"))).toHaveLength(1);
  });

  it("updates effort and its lead window without calling the change unchanged", async () => {
    await recordDeadline(env.DB, input(), call(), NOW);
    const result = await recordDeadline(env.DB, input(), call({ effort: "quiz" }), NOW);
    expect(result.receipt).toMatch(/^Updated /u);
    expect((await rows()).results[0]).toMatchObject({ effort: "quiz", lead_minutes: DEFAULT_LEAD_MINUTES.quiz });
  });

  it("stores a model-supplied lead time instead of the effort's default", async () => {
    await recordDeadline(env.DB, input(), call({ effort: "exam", leadMinutes: 45 }), NOW);
    expect((await rows()).results[0]).toMatchObject({ effort: "exam", lead_minutes: 45 });
  });

  it("keeps a model-supplied lead when a later status update leaves leadMinutes out", async () => {
    await recordDeadline(env.DB, input(), call({ effort: "exam", leadMinutes: 45 }), NOW);
    await recordDeadline(env.DB, input(), call({ effort: "exam", status: "submitted" }), NOW);

    // A missing leadMinutes means "keep the stored lead", the same way a missing
    // status keeps the stored status. Recomputing the default here silently
    // replaced an explicit 45-minute warning with 7 days.
    expect((await rows()).results[0]).toMatchObject({ effort: "exam", lead_minutes: 45, status: "submitted" });
  });

  it("keeps a model-supplied lead when a later correction moves the due date", async () => {
    await recordDeadline(env.DB, input(), call({ effort: "exam", leadMinutes: 45 }), NOW);
    await recordDeadline(env.DB, input(), call({ effort: "exam", dueAt: "2026-09-26T15:30:00-04:00" }), NOW);

    expect((await rows()).results[0]).toMatchObject({
      effort: "exam", lead_minutes: 45, due_at: "2026-09-26T19:30:00.000Z",
    });
  });

  it("uses the new effort's default lead when the effort changes without a lead", async () => {
    await recordDeadline(env.DB, input(), call({ effort: "exam", leadMinutes: 45 }), NOW);
    await recordDeadline(env.DB, input(), call({ effort: "quiz" }), NOW);

    // The old 45-minute lead described an exam and no longer fits a quiz, so it
    // is not kept across a change of kind; the new effort's default applies.
    expect((await rows()).results[0]).toMatchObject({ effort: "quiz", lead_minutes: 720 });
  });

  it("states the stored effort and lead minutes in the receipt", async () => {
    const result = await recordDeadline(env.DB, input(), call({ effort: "exam", leadMinutes: 45 }), NOW);

    // Rule 2: a reply may claim only what a receipt shows, so the receipt has to
    // name the judgment and the lead that were actually stored.
    expect(result.receipt).toContain("effort exam");
    expect(result.receipt).toContain("lead 45 minutes");
  });

  it("marks an owner-recorded deadline as a judged effort", async () => {
    await recordDeadline(env.DB, input(), call(), NOW);
    expect((await rows()).results[0]).toMatchObject({ effort: "project", effort_judged: 1 });
  });

  it("lets the model change both effort and lead time on an existing deadline", async () => {
    await recordDeadline(env.DB, input(), call({ effort: "project" }), NOW);
    const result = await recordDeadline(env.DB, input(), call({ effort: "exam", leadMinutes: 100 }), NOW);
    expect(result.receipt).toMatch(/^Updated /u);
    expect((await rows()).results).toMatchObject([{ effort: "exam", lead_minutes: 100 }]);
    expect((await rows()).results).toHaveLength(1);
  });

  it("matches a course and title across case and whitespace without a duplicate", async () => {
    await recordDeadline(env.DB, input(), call({ course: "chemistry", title: "lab   report" }), NOW);
    const result = await recordDeadline(env.DB, input(), call(), NOW);
    expect(result.receipt).toMatch(/^Unchanged /u);
    expect((await rows()).results).toHaveLength(1);
  });

  it("finds a legacy literal identity before normalising the title", async () => {
    await ownerRow("Chemistry", "lab report");
    const result = await recordDeadline(env.DB, input(), call(), NOW);
    expect(result.receipt).toMatch(/^Updated /u);
    expect((await rows()).results).toHaveLength(1);
    expect((await rows()).results[0]?.lead_minutes).toBe(DEFAULT_LEAD_MINUTES.project);
  });

  it("refuses when two stored legacy rows already share one normalised identity", async () => {
    for (const course of ["chemistry", "Chemistry"]) await ownerRow(course, "Lab report");
    const result = await recordDeadline(env.DB, input(), call(), NOW);
    expect(result.providerResult.content).toContain("deadline_ambiguous_match");
    expect((await rows()).results).toHaveLength(2);
  });

  it.each([
    ["an abbreviated course", { course: "Chem" }, '"Chemistry" / "Lab report"'],
    ["a longer title", { title: "Lab report draft" }, '"Chemistry" / "Lab report"'],
  ])("saves %s beside a similar stored row and names that row for the model", async (_label, changes, named) => {
    await recordDeadline(env.DB, input(), call(), NOW);
    const result = await recordDeadline(env.DB, input(), call(changes), NOW);
    expect(result.receipt).toMatch(/^Created /u);
    expect(result.receipt).toContain(`Similar stored deadlines: ${named}`);
    expect((await rows()).results).toHaveLength(2);
  });

  it("names no similar rows when nothing stored looks alike", async () => {
    await recordDeadline(env.DB, input(), call({ course: "Physics", title: "Quiz" }), NOW);
    expect((await recordDeadline(env.DB, input(), call(), NOW)).receipt).not.toContain("Similar stored deadlines");
  });

  it("does not match another principal's otherwise identical assignment", async () => {
    await recordDeadline(env.DB, input(), call(), NOW);
    const result = await recordDeadline(env.DB, input("principal:other"), call(), NOW);
    expect(result.receipt).toMatch(/^Created /u);
    expect(result.receipt).not.toContain("Similar stored deadlines");
    expect((await rows()).results).toHaveLength(2);
  });

  it("stores a date-only due at the end of that day in the owner zone and says no clock was stated", async () => {
    const result = await recordDeadline(env.DB, input(), call({ dueAt: "2026-09-25" }), NOW);
    expect((await rows()).results[0]?.due_at).toBe("2026-09-26T03:59:59.999Z");
    expect(result.receipt).toContain("Date-only: stored at end of day in America/Toronto, not a stated clock time.");
  });

  it("stores a date-only due at the end of that day in a zone the model names", async () => {
    const result = await recordDeadline(env.DB, input(), call({ dueAt: "2026-09-25", timeZone: "America/Vancouver" }), NOW);
    expect((await rows()).results[0]?.due_at).toBe("2026-09-26T06:59:59.999Z");
    expect(result.receipt).toContain("in America/Vancouver");
  });

  it.each([["2026-11-01", "2026-11-02T04:59:59.999Z"], ["2026-03-08", "2026-03-09T03:59:59.999Z"]])(
    "ends the daylight-saving change day %s at its local midnight", async (dueAt, stored) => {
      await recordDeadline(env.DB, input(), call({ dueAt }), NOW);
      expect((await rows()).results[0]?.due_at).toBe(stored);
    });

  it("uses the later 23:59 when a zone repeats the last hour of the day", async () => {
    // Santiago falls back from 24:00 to 23:00 on 2026-04-04, so 23:59 happens twice.
    await recordDeadline(env.DB, input(), call({ dueAt: "2026-04-04", timeZone: "America/Santiago" }), NOW);
    expect((await rows()).results[0]?.due_at).toBe("2026-04-05T03:59:59.999Z");
  });

  it.each([
    ["UTC", "2026-09-25T15:30:00Z", "2026-09-25T15:30:00.000Z"],
    ["a Vancouver offset", "2026-09-25T15:30:00-07:00", "2026-09-25T22:30:00.000Z"],
    ["a winter offset", "2026-12-01T15:30:00-05:00", "2026-12-01T20:30:00.000Z"],
    ["milliseconds", "2026-09-25T15:30:00.250-04:00", "2026-09-25T19:30:00.250Z"],
    ["no seconds", "2026-09-25T15:30-04:00", "2026-09-25T19:30:00.000Z"],
  ])("stores an instant given with %s exactly", async (_label, dueAt, stored) => {
    const result = await recordDeadline(env.DB, input(), call({ dueAt }), NOW);
    expect((await rows()).results[0]?.due_at).toBe(stored);
    expect(result.receipt).toContain("America/Toronto");
    expect(result.receipt).not.toContain("Date-only");
  });

  it.each([
    ["a weekday word instead of a date", { dueAt: "Friday" }],
    ["an instant without an offset", { dueAt: "2026-09-25T15:30:00" }],
    ["a nonexistent calendar date", { dueAt: "2026-02-30" }],
    ["a nonexistent date inside an instant", { dueAt: "2026-02-30T10:00:00Z" }],
    ["hour 24", { dueAt: "2026-09-25T24:00:00Z" }],
    ["minute 60", { dueAt: "2026-09-25T15:60:00Z" }],
    ["second 60", { dueAt: "2026-09-25T15:30:60Z" }],
    ["an offset beyond fourteen hours", { dueAt: "2026-09-25T15:30:00+15:00" }],
    ["an offset with minute 60", { dueAt: "2026-09-25T15:30:00+05:60" }],
    ["an empty due value", { dueAt: "" }],
    ["a numeric offset instead of an IANA zone", { dueAt: "2026-09-25", timeZone: "-04:00" }],
    ["an unknown IANA zone", { dueAt: "2026-09-25", timeZone: "Mars/Olympus" }],
    ["an invalid effort", { effort: "huge" }],
    ["a negative lead time", { leadMinutes: -1 }],
    ["a fractional lead time", { leadMinutes: 1.5 }],
    ["a non-numeric lead time", { leadMinutes: "45" }],
    ["a status outside the stored set", { status: "handed in" }],
    ["a blank course", { course: "   " }],
    ["a blank title", { title: "   " }],
    ["an unknown argument", { other: true }],
    ["an old excerpt argument", { dueExcerpt: "Friday" }],
  ])("refuses %s before creating a source or a deadline", async (_label, changes) => {
    const result = await recordDeadline(env.DB, input(), call(changes), NOW);
    expect(content(result).status).toBe("refused");
    expect(content(result).receipt).toContain("Nothing changed.");
    expect((await rows()).results).toHaveLength(0);
    expect(await new DeadlineRepository(env.DB).readSource("owner-reported")).toBeNull();
  });

  it("refuses a date-only due on a local date the zone skipped instead of storing the epoch", async () => {
    // Samoa jumped from 29 to 31 December 2011, so 2011-12-30 has no 23:59 in Pacific/Apia.
    const result = await recordDeadline(env.DB, input(), call({ dueAt: "2011-12-30", timeZone: "Pacific/Apia" }), NOW);
    expect(content(result).status).toBe("refused");
    expect(content(result).receipt).toContain("2011-12-30 has no 23:59 in Pacific/Apia");
    expect((await rows()).results).toHaveLength(0);
  });

  it("refuses a misconfigured owner zone rather than storing in a guessed zone", async () => {
    const result = await executeDeadline(env.DB, input(), call({ dueAt: "2026-09-25" }), NOW, { ownerZone: "Not/AZone" });
    expect(content(result).status).toBe("refused");
    expect((await rows()).results).toHaveLength(0);
  });

  it("receipts in the configured owner zone from the owner turn", async () => {
    const result = await argumentTurn(message, call({ dueAt: "2026-09-24T15:00:00-07:00" }), { timeZone: "America/Vancouver" });
    expect((await rows()).results[0]?.due_at).toBe("2026-09-24T22:00:00.000Z");
    expect(result.replies.join(" ")).toContain("America/Vancouver");
    expect(result.replies.join(" ")).toContain("3:00");
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

  it("retries metadata when another writer changes the due time after the row is read", async () => {
    const repo = new DeadlineRepository(env.DB);
    await repo.ensureSource({ sourceId: "owner-reported", kind: "manual", label: "owner-reported", now: NOW });
    const entry = { sourceId: "owner-reported", externalId: "metadata-race", course: "Chemistry", title: "Lab report",
      dueAt: "2026-09-25T19:30:00.000Z", effort: "project" as const, leadMinutes: 0, now: NOW };
    await repo.upsert(entry);
    let inject = true;
    const database = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("SET status = coalesce")) return statement;
        return { bind(...values: unknown[]) { const bound = statement.bind(...values); return {
          async first() {
            if (inject) { inject = false; await repo.upsert({ ...entry, dueAt: "2026-09-26T19:30:00.000Z" }); }
            return bound.first();
          },
        }; } };
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await new DeadlineRepository(database).upsert({ ...entry, status: "submitted" });
    expect(result.outcome).toBe("revised");
    expect(result.previous?.dueAt).toBe("2026-09-26T19:30:00.000Z");
    expect(result.deadline).toMatchObject({ dueAt: entry.dueAt, status: "submitted" });
  });

  it("reports an effort-only owner retag as updated when its lead minutes are unchanged", async () => {
    await recordDeadline(env.DB, input(), call(), NOW);
    const row = (await rows()).results[0]!;
    const result = await new DeadlineRepository(env.DB).upsert({ sourceId: "owner-reported", externalId: String(row.external_id),
      course: "Chemistry", title: "Lab report", dueAt: String(row.due_at), effort: "quiz",
      leadMinutes: DEFAULT_LEAD_MINUTES.project, replaceEffortAndLead: true, now: NOW });
    expect(result.outcome).toBe("updated");
    expect(result.deadline.effort).toBe("quiz");
    expect(result.deadline.leadMinutes).toBe(DEFAULT_LEAD_MINUTES.project);
  });
});
