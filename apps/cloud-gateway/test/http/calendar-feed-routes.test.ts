import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import worker from "../../src/index.js";
import { handleCalendarFeedRequest } from "../../src/http/calendar-feed-routes.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import { SchoolCatchupRepository } from "../../src/school/school-catchup-repository.js";
import { UniversityTrackerRepository } from "../../src/university/university-tracker-repository.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { applyUniversityApplicationDetailsMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const owner = "principal:calendar-owner";
const token = crypto.randomUUID().replace(/-/gu, "");
const path = `/calendar/${token}.ics`;
const bindings = () => ({ ...env, CALENDAR_FEED_TOKEN: token, OWNER_PRINCIPAL_ID: owner });
const request = (url = path, method = "GET") =>
  new Request(`https://worker.internal${url}`, { method }) as Request<unknown, IncomingRequestCfProperties>;
const dependencies = () => ({ clock: () => NOW, rateLimiter: { allow: vi.fn(() => true) } });
const dispatch = (url = path, method = "GET", overrides = {}) =>
  worker.fetch(request(url, method), { ...bindings(), ...overrides }, createExecutionContext());
const unfold = (value: string) => value.replace(/\r\n /gu, "");

async function seed(principalId: string) {
  const turnId = newUlid(NOW);
  const evidence = "Prepare my applications and school plan for 2027-01-15.";
  await env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
    VALUES (?, 'human', 'active', 'Calendar fixture', ?, ?)`).bind(principalId, NOW.toISOString(), NOW.toISOString()).run();
  const redacted = new Redactor().redactText(evidence);
  if (!redacted.ok) throw new Error("calendar_fixture_invalid");
  await new ConversationRepository(env.DB, new EventRepository(env.DB)).getOrCreateTurn({
    turnId, principalId, sessionId: `telegram:${principalId}`, channel: "telegram", userText: redacted, now: NOW,
  });
  await new SchoolCatchupRepository(env.DB).applyOwnerPlan({ principalId, turnId, today: "2026-09-23",
    responseHash: "a".repeat(64), now: NOW, plan: {
      engaged: true, reply: "Saved", completeActionIds: [],
      courseUpdates: ["Chemistry", "Retired"].map((name, index) => ({
        courseRef: `new-${index + 1}`, name, platform: null, addFacts: [], resolveFactIds: [],
      })),
      plan: [
        { courseRef: "new-1", localDate: "2026-09-23", sequenceRank: 1, text: "First task", estimatedMinutes: 25 },
        { courseRef: "new-1", localDate: "2026-09-24", sequenceRank: 1, text: "Second task", estimatedMinutes: 30 },
        { courseRef: "new-1", localDate: "2026-09-25", sequenceRank: 1, text: "Completed task", estimatedMinutes: 20 },
        { courseRef: "new-1", localDate: "2026-09-26", sequenceRank: 1, text: "Superseded task", estimatedMinutes: 20 },
        { courseRef: "new-2", localDate: "2026-09-27", sequenceRank: 1, text: "Inactive course task", estimatedMinutes: 20 },
      ],
    } });
  await env.DB.prepare(`UPDATE school_catchup_actions SET status = 'completed', completed_at = ?
    WHERE principal_id = ? AND action_text = 'Completed task'`).bind(NOW.toISOString(), principalId).run();
  await env.DB.prepare(`UPDATE school_catchup_actions SET status = 'superseded', superseded_at = ?
    WHERE principal_id = ? AND action_text = 'Superseded task'`).bind(NOW.toISOString(), principalId).run();
  await env.DB.prepare(`UPDATE school_course_cards SET active = 0 WHERE principal_id = ? AND course_name = 'Retired'`)
    .bind(principalId).run();
  const verification = { state: "unverified", sourceUrl: null, cycle: null } as const;
  await new UniversityTrackerRepository(env.DB).applyOwnerPlan({ principalId, turnId,
    responseHash: "b".repeat(64), now: NOW, plan: {
      engaged: true,
      programUpdates: [{ programRef: "new-1", university: "Test University", campus: null, programName: "Computing",
        ouacCode: null, verification, addRequirements: [], addDates: [], resolveItemIds: [] }],
      applicationUpdates: Array.from({ length: 12 }, (_, index) => ({
        itemRef: `new-item-${index + 1}`, programRef: "new-1", kind: "essay", label: `Essay ${index + 1}`,
        status: "not_started", statusEvidence: evidence, dueDate: { date: "2027-01-15", verification, evidence },
      })),
      workflowUpdates: Array.from({ length: 12 }, (_, index) => ({
        workflowRef: `new-workflow-${index + 1}`, programRef: "new-1", applicationItemRef: `new-item-${index + 1}`,
        kind: "submission_step", label: `Submission ${index + 1}`, owner: "sid", status: "prepared",
        statusEvidence: `Prepare Submission ${index + 1} for Essay ${index + 1} due 2027-01-15.`,
        preparedDetails: null, executionBoundary: "owner_only",
        deadline: { date: "2027-01-15", instant: null, timeZone: null, verification, evidence },
      })),
    } });
}

beforeAll(async () => { await applyUniversityApplicationDetailsMigration(); });
let limiterTime = NOW.getTime();
beforeEach(() => {
  limiterTime += 86_400_001;
  vi.spyOn(Date, "now").mockReturnValue(limiterTime);
});
afterEach(() => vi.restoreAllMocks());

describe("the private calendar route", () => {
  it("returns indistinguishable private 404 responses for absent short and wrong credentials without reading D1", async () => {
    const read = vi.spyOn(env.DB, "prepare").mockImplementation(() => { throw new Error("must not read"); });
    for (const overrides of [
      { CALENDAR_FEED_TOKEN: undefined }, { CALENDAR_FEED_TOKEN: "" },
      { CALENDAR_FEED_TOKEN: token.slice(0, 31) }, { CALENDAR_FEED_TOKEN: crypto.randomUUID() },
    ]) {
      const response = await dispatch(path, "GET", overrides);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toBe("Not found");
    }
    for (const short of [token.slice(0, 31), "🙂".repeat(16)]) {
      expect((await dispatch(`/calendar/${encodeURIComponent(short)}.ics`, "GET", { CALENDAR_FEED_TOKEN: short })).status).toBe(404);
    }
    for (const wrong of [token.slice(1), `${token}x`, `x${token.slice(1)}`, `${token.slice(0, -1)}x`]) {
      expect((await dispatch(`/calendar/${wrong}.ics`)).status).toBe(404);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("returns private 404 responses for malformed calendar paths and every unsupported method", async () => {
    const read = vi.spyOn(env.DB, "prepare");
    for (const url of ["/calendar", "/calendar/", "/calendar/.ics", `${path}/extra`, "/calendar/%ZZ.ics", path.replace(".ics", ".txt")]) {
      const response = await dispatch(url);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toBe("Not found");
    }
    for (const method of ["POST", "HEAD", "PUT", "DELETE"]) expect((await dispatch(path, method)).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it("admits a 32-character credential and never echoes or logs it on success or failure", async () => {
    const logs = ["log", "info", "warn", "error", "debug"] as const;
    const spies = logs.map((name) => vi.spyOn(console, name));
    const responses = [await dispatch()];
    vi.spyOn(env.DB, "prepare").mockImplementation(() => { throw new Error(`database error at ${path}`); });
    responses.push(await dispatch());
    expect(responses.map((response) => response.status)).toEqual([200, 503]);
    for (const response of responses) {
      const body = await response.text();
      expect(`${body}${JSON.stringify([...response.headers])}`.includes(token)).toBe(false);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("rotates the credential immediately and accepts an encoded path without reflecting the URL", async () => {
    const rotated = crypto.randomUUID();
    expect((await dispatch(path, "GET", { CALENDAR_FEED_TOKEN: rotated })).status).toBe(404);
    expect((await dispatch(`/calendar/${rotated}.ics`, "GET", { CALENDAR_FEED_TOKEN: rotated })).status).toBe(200);
    const encoded = token.split("").map((character) => `%${character.charCodeAt(0).toString(16)}`).join("");
    expect((await dispatch(`/calendar/${encoded}.ics`)).status).toBe(200);
  });

  it("limits calendar requests separately from health and returns 404 for a wrong token even while limited", async () => {
    for (let index = 0; index < 30; index += 1) expect((await dispatch()).status).toBe(200);
    const limited = await dispatch();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("private, no-store");
    expect(await limited.text()).toBe("Unavailable");
    expect((await dispatch("/health")).status).toBe(200);
    expect((await dispatch(`/calendar/${crypto.randomUUID()}.ics`)).status).toBe(404);
    vi.mocked(Date.now).mockReturnValue(limiterTime + 60_001);
    expect((await dispatch()).status).toBe(200);
  });

  it("fails closed before reading D1 when the owner is missing or rate admission fails", async () => {
    const read = vi.spyOn(env.DB, "prepare");
    const missing = await dispatch(path, "GET", { OWNER_PRINCIPAL_ID: undefined });
    expect(missing.status).toBe(503);
    expect(await missing.text()).toBe("Unavailable");
    const deps = dependencies();
    deps.rateLimiter.allow.mockReturnValue(false);
    expect((await handleCalendarFeedRequest(request(), bindings(), deps)).status).toBe(429);
    expect(read).not.toHaveBeenCalled();
  });

  it("reads all planned owner tasks and university dates and only open deadlines inside the exact window without writing", async () => {
    await seed(owner);
    await seed("principal:calendar-other");
    // Course ids are scoped to a principal. A collision must not cross the join.
    await env.DB.prepare(`INSERT INTO school_course_cards (principal_id, course_id, course_key,
      course_name, course_name_source, owner_source_turn_id, active, created_at, updated_at)
      SELECT 'principal:calendar-other', course_id, 'collision', 'Other owner course', course_name_source,
        (SELECT turn_id FROM conversation_turns WHERE principal_id = 'principal:calendar-other' LIMIT 1),
        active, created_at, updated_at FROM school_course_cards
      WHERE principal_id = ? AND course_name = 'Chemistry'`).bind(owner).run();
    const deadlines = new DeadlineRepository(env.DB);
    const source = await deadlines.createSource({ kind: "manual", label: "Calendar fixtures", now: NOW });
    const from = NOW.getTime() - 14 * 86_400_000;
    const to = NOW.getTime() + 90 * 86_400_000;
    for (const [label, due, status] of [
      ["before", from - 1, "open"], ["lower", from, "open"], ["upper", to - 1, "open"],
      ["after", to, "open"], ["submitted", NOW.getTime(), "submitted"],
    ] as const) {
      const result = await deadlines.upsert({ sourceId: source.sourceId, externalId: label, course: "Physics", title: label,
        dueAt: new Date(due).toISOString(), effort: "test", leadMinutes: 90, now: NOW });
      if (status === "submitted") await env.DB.prepare("UPDATE deadlines SET status = 'submitted' WHERE deadline_id = ?")
        .bind(result.deadline.deadlineId).run();
    }
    const prepare = vi.spyOn(env.DB, "prepare");
    const response = await handleCalendarFeedRequest(request(), bindings(), dependencies());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    const feed = unfold(await response.text());
    expect(feed.match(/BEGIN:VEVENT/gu)).toHaveLength(28);
    expect(feed).toContain("SUMMARY:Chemistry: First task (25 min)");
    expect(feed).toContain("SUMMARY:Chemistry: Second task (30 min)");
    expect(feed).not.toContain("Completed task");
    expect(feed).not.toContain("Superseded task");
    expect(feed).not.toContain("Inactive course task");
    expect(feed).not.toContain("Other owner course");
    for (const label of ["lower", "upper"]) expect(feed).toContain(`SUMMARY:Physics: ${label}`);
    for (const label of ["before", "after", "submitted"]) expect(feed).not.toContain(`SUMMARY:Physics: ${label}`);
    for (let index = 1; index <= 12; index += 1) {
      expect(feed).toContain(`SUMMARY:[unverified] Test University / Computing: Essay ${index}\r\n`);
      expect(feed).toContain(`SUMMARY:[unverified] Test University / Computing: Submission ${index}\r\n`);
    }
    expect(prepare.mock.calls.every(([sql]) => /^SELECT\b/u.test(sql))).toBe(true);
    const university = new UniversityTrackerRepository(env.DB);
    expect(await university.listApplicationItemsByDueDate(owner)).toHaveLength(5);
    expect(await university.listWorkflowItemsByDueDate(owner)).toHaveLength(5);
    for (const limit of [0, 11, 1.5, NaN]) {
      await expect(university.listApplicationItemsByDueDate(owner, limit)).rejects.toThrow("university_application_digest_limit_invalid");
      await expect(university.listWorkflowItemsByDueDate(owner, limit)).rejects.toThrow("university_workflow_digest_limit_invalid");
    }
  });
});
