import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";
import { collectorFixture, observedBatch, bytes, type CollectorFixture } from "./collector-fixtures.js";
import { SchoolCollectorRepository } from "../../src/school/collector-repository.js";
import { mapSchoolCourse, evidenceShape } from "../../src/school/collector-mapping.js";
import type { SchoolBatch } from "../../src/school/collector-protocol.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { DeadlineIngestion } from "../../src/deadlines/deadline-ingestion.js";
import { assembleDigest } from "../../src/jobs/digest-job.js";

beforeAll(applyNewestRuntimeMigration);
const repo = (f: CollectorFixture) => new SchoolCollectorRepository(env.DB, f.owner, f.clock);
const ingest = async (f: CollectorFixture, batch: SchoolBatch) => repo(f).ingest(f.key.collector_id, batch, await sha256Hex(bytes(batch)));

describe("school evidence and projection", () => {
  it("maps the observed null DueDate through its linked module and retains undated work", async () => {
    const f = await collectorFixture();
    const batch = observedBatch(f);
    const mapped = mapSchoolCourse(batch);
    expect(mapped.failures).toEqual([]);
    expect(mapped.items).toEqual([
      { id: "folder-17", title: "Synthetic essay", dueAt: "2026-09-24T03:59:00.000Z", dateSource: "availability end",
        dateRoute: batch.routes[1]!.route, submission: "unknown" },
      { id: "folder-18", title: "Undated practice", dueAt: null, dateSource: null, dateRoute: null, submission: "unknown" },
    ]);
    expect(mapped.deadlines).toHaveLength(1);
    const receipt = await ingest(f, batch);
    expect(receipt.outcome).toBe("good");
    const status = await repo(f).status();
    expect(status.state).toBe("current");
    expect(status.lastGoodReadAt).toBe(batch.startedAt);
    expect(status.evidence).toHaveLength(5);
    expect(status.evidence.find((row) => row.route === batch.routes[0]!.route)?.raw_json).toBe(JSON.stringify(batch.routes[0]!.body));
    expect(status.evidence[0]!.mapped_json).toContain("Undated practice");
    expect(await env.DB.prepare("SELECT title, due_at FROM deadlines WHERE source_id = ?").bind(`d2l-api:ldsb.elearningontario.ca:${f.courseId}`).first())
      .toEqual({ title: "Synthetic essay [availability end]", due_at: "2026-09-24T03:59:00.000Z" });
  });

  it.each([
    ["an empty object", 200, {}],
    ["a refusal", 403, {}],
    ["a missing-tool response", 404, {}],
  ] as const)("keeps one deadline identity after a good read when folders returns %s", async (_label, status, body) => {
    const f = await collectorFixture();
    await ingest(f, observedBatch(f));
    f.setNow(new Date(f.clock().getTime() + 60_000));
    const next = observedBatch(f);
    await ingest(f, { ...next, routes: next.routes.map((route, index) => index === 0 ? { ...route, status, body } : route) });
    expect((await repo(f).status()).state).toBe("current");
    const deadlines = await env.DB.prepare("SELECT external_id, status FROM deadlines WHERE source_id = ? AND status = 'open' ORDER BY external_id")
      .bind(`d2l-api:ldsb.elearningontario.ca:${f.courseId}`).all();
    expect(deadlines.results).toEqual([{ external_id: "folder-17", status: "open" }]);
  });

  it("keeps the last good assignment date when the folder list is refused", async () => {
    const f = await collectorFixture();
    const first = structuredClone(observedBatch(f)) as unknown as { routes: any[] } & SchoolBatch;
    first.routes[0].body[0].DueDate = "2026-10-01T12:00:00Z";
    await ingest(f, first);
    f.setNow(new Date(f.clock().getTime() + 60_000));
    const next = observedBatch(f);
    const refused = { ...next, routes: next.routes.map((route, index) => index === 0 ? { ...route, status: 403, body: {} } : route) };
    const mapped = mapSchoolCourse(refused);
    expect(mapped.items.some((item) => item.id === "folder-17")).toBe(false);
    expect(mapped.unmapped).toContain(`${refused.routes[1]!.route}:linked_topic_folder_list_unread`);
    expect((await ingest(f, refused)).outcome).toBe("good");
    expect((await repo(f).status()).state).toBe("current");
    expect(await env.DB.prepare("SELECT due_at FROM deadlines WHERE source_id = ? AND external_id = 'folder-17'")
      .bind(`d2l-api:ldsb.elearningontario.ca:${f.courseId}`).first()).toEqual({ due_at: "2026-10-01T12:00:00.000Z" });
  });

  it("does not turn a quiz-linked topic into an assignment folder", async () => {
    const f = await collectorFixture();
    const batch = structuredClone(observedBatch(f)) as unknown as { routes: any[] } & SchoolBatch;
    batch.routes[1].body.Modules[0].Topics.push({ TopicId: 42, Title: "Synthetic quiz", ToolItemId: 55,
      TypeIdentifier: "Quiz", EndDateTime: "2026-10-05T00:00:00Z" });
    batch.routes.push({ ...batch.routes[2], route: `/d2l/api/le/1.82/${f.courseId}/quizzes/`, body: { Objects: [
      { QuizId: 55, Name: "Synthetic quiz", DueDate: "2026-10-04T00:00:00Z", EndDate: "2026-10-05T00:00:00Z" },
    ], Next: null } });
    const mapped = mapSchoolCourse(batch);
    expect(mapped.items.some((item) => item.id === "folder-55")).toBe(false);
    expect(mapped.items.map((item) => item.id)).toEqual(expect.arrayContaining(["topic-42", "quiz-55", "quiz-55-end"]));
  });

  it("does not give an assignment folder a quiz-linked topic's end date", async () => {
    const f = await collectorFixture();
    const batch = structuredClone(observedBatch(f)) as unknown as { routes: any[] } & SchoolBatch;
    batch.routes[1].body.Modules[0].Topics.push({ TopicId: 42, Title: "Synthetic quiz", ToolItemId: 18,
      TypeIdentifier: "Quiz", EndDateTime: "2026-10-05T00:00:00Z" });
    const mapped = mapSchoolCourse(batch);
    expect(mapped.items.find((item) => item.id === "folder-18")).toMatchObject({ dueAt: null, dateSource: null, dateRoute: null });
    expect(mapped.items.find((item) => item.id === "topic-42")).toMatchObject({ dueAt: "2026-10-05T00:00:00.000Z" });
  });

  it("prefers myItems dates then assignment DueDate then availability end and labels each source", async () => {
    const f = await collectorFixture();
    const batch = structuredClone(observedBatch(f)) as unknown as { routes: any[] } & SchoolBatch;
    batch.routes[0].body[0].DueDate = "2026-09-25T12:00:00Z";
    expect(mapSchoolCourse(batch).items[0]).toMatchObject({ dueAt: "2026-09-25T12:00:00.000Z", dateSource: "assignment DueDate" });
    // This is a proposed adapter fixture. PR 161 did not observe content/myItems.
    batch.routes.push({ route: `/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=${f.courseId}`, status: 200, fetchedAt: batch.startedAt,
      complete: true, body: [{ ToolItemId: 17, DueDate: "2026-09-26T12:00:00Z" }] });
    expect(mapSchoolCourse(batch).items[0]).toMatchObject({ dueAt: "2026-09-26T12:00:00.000Z", dateSource: "content/myItems" });
    batch.routes[0].body[0].DueDate = null;
    batch.routes.pop();
    batch.routes[1].body.Modules[0].Topics[0].EndDateTime = "2026-09-22T12:00:00Z";
    expect(mapSchoolCourse(batch).items[0]).toMatchObject({ dueAt: "2026-09-22T12:00:00.000Z", dateSource: "availability end" });
  });

  it("keeps empty submissions and denied folder counts as evidence and only labels a positive own status submitted", async () => {
    const f = await collectorFixture();
    const batch = structuredClone(observedBatch(f)) as unknown as { routes: any[] } & SchoolBatch;
    expect(mapSchoolCourse(batch).items.map((item) => item.submission)).toEqual(["unknown", "unknown"]);
    batch.routes[3].body = { Status: 1 };
    expect(mapSchoolCourse(batch).items[0]!.submission).toBe("positive submission status");
    for (const status of [0, 2, 3]) {
      batch.routes[3].body.Status = status;
      expect(mapSchoolCourse(batch).items[0]!.submission).toBe("unknown");
    }
    batch.routes[3].body.Status = 1;
    batch.routes[3].status = 403;
    expect(mapSchoolCourse(batch).items[0]!.submission).toBe("unknown");
    expect(JSON.stringify(mapSchoolCourse(batch))).not.toMatch(/"missed"|"missing"/);
  });

  it("fails the whole read if any course fails and keeps the previous good read time", async () => {
    const f = await collectorFixture();
    const first = observedBatch(f);
    await ingest(f, first);
    f.setNow(new Date(f.clock().getTime() + 60_000));
    const a = observedBatch(f);
    const b = observedBatch(f, "another-course");
    const courseIds = [f.courseId, "another-course"];
    await ingest(f, { ...a, courseIds });
    expect((await repo(f).status()).state).toBe("incomplete");
    await ingest(f, { ...b, courseIds, readId: a.readId, routes: b.routes.map((route, index) => index === 2
      ? { ...route, status: 401, body: { Errors: [{ Message: "Not Authorized" }] } } : route) });
    const status = await repo(f).status({ limit: 100 });
    expect(status.state).toBe("failed");
    expect(status.lastGoodReadAt).toBe(first.startedAt);
    expect(status.refused).toEqual([{ route: b.routes[2]!.route, course: "another-course", host: b.host, disposition: "session expired", status: 401, fetched_at: b.startedAt }]);
    expect(status.evidence).toHaveLength(15);
  });

  it.each(["grades", "myItems"])("records a %s 403 without failing the read or hiding available deadlines", async (tool) => {
    const f = await collectorFixture();
    const batch = observedBatch(f);
    const refusal = { ...batch.routes[2]!, status: 403, body: { Errors: [{ Message: "Not Authorized" }] } };
    const routes = tool === "grades" ? batch.routes.map((route, i) => i === 2 ? refusal : route)
      : [...batch.routes, { ...refusal, route: `/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=${f.courseId}` }];
    expect((await ingest(f, { ...batch, routes })).outcome).toBe("good");
    const status = await repo(f).status();
    expect(status).toMatchObject({ state: "current", lastGoodReadAt: batch.startedAt });
    expect(status.refused).toEqual([{ route: routes.find((route) => route.status === 403)!.route, course: f.courseId, host: batch.host, disposition: "refused", status: 403, fetched_at: batch.startedAt }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM deadlines WHERE source_id = ?").bind(`d2l-api:ldsb.elearningontario.ca:${f.courseId}`).first()).toEqual({ n: 1 });
  });

  it("keeps required tool refusals empty while failing transport, authentication, incomplete and unfamiliar results", async () => {
    const f = await collectorFixture();
    const batch = observedBatch(f);
    const refused = { ...batch, routes: batch.routes.map((route) => ({ ...route, status: 403, body: null })) };
    expect(mapSchoolCourse(refused)).toEqual({ items: [], deadlines: [], failures: [], unmapped: [] });
    expect((await ingest(f, refused)).outcome).toBe("good");
    for (const status of [0, 301, 302, 401, 500, 503]) {
      const invalid = { ...batch, readId: newUlid(f.clock()), routes: batch.routes.map((route, i) => i === 2 ? { ...route, status } : route) };
      expect((await ingest(f, invalid)).outcome, `HTTP ${status}`).toBe("failed");
    }
    for (const route of [{ ...batch.routes[2]!, status: 403, complete: false }, { ...batch.routes[2]!, body: "not JSON data" }]) {
      expect((await ingest(f, { ...batch, readId: newUlid(f.clock()), routes: batch.routes.map((row, i) => i === 2 ? route : row) })).outcome).toBe("failed");
    }
  });

  it("retains unknown JSON submissions without guessing a status and labels non-JSON bodies as session failures", async () => {
    const f = await collectorFixture();
    const batch = observedBatch(f);
    for (const body of [null, [], "unexpected login page", true]) {
      const routes = batch.routes.map((row, i) => i === 3 ? { ...row, body } : row);
      expect((await ingest(f, { ...batch, readId: newUlid(f.clock()), routes })).outcome).toBe(typeof body === "string" ? "failed" : "good");
      expect(mapSchoolCourse({ ...batch, routes }).items[0]!.submission).toBe("unknown");
      const refused = routes.map((row, i) => i === 3 ? { ...row, status: 403 } : row);
      expect((await ingest(f, { ...batch, readId: newUlid(f.clock()), routes: refused })).outcome).toBe(typeof body === "string" ? "failed" : "good");
    }
  });

  it("names the missing mysubmissions route instead of falling back to all-users submissions", async () => {
    const f = await collectorFixture();
    const batch = observedBatch(f);
    const allUsersRoute = `/d2l/api/le/1.82/${f.courseId}/dropbox/folders/17/submissions/`;
    const mapped = mapSchoolCourse({ ...batch, routes: batch.routes.map((row, index) => index === 3 ? { ...row, route: allUsersRoute } : row) });
    expect(mapped.failures).toContain(`${allUsersRoute}mysubmissions/:not_read`);
    expect(mapped.items[0]!.submission).toBe("unknown");
  });

  it("bounds refusals to the latest read and requested limit without losing the older good read time", async () => {
    const f = await collectorFixture();
    const first = observedBatch(f);
    await ingest(f, first);
    let latest = first;
    for (let i = 0; i < 6; i += 1) {
      f.setNow(new Date(f.clock().getTime() + 60_000));
      latest = observedBatch(f);
      await ingest(f, { ...latest, routes: latest.routes.map((route, index) => index >= 2 ? { ...route, status: 403, body: null } : route) });
    }
    let refusedRowsReturned = 0;
    const database = { prepare(sql: string) {
      const statement = env.DB.prepare(sql);
      if (!sql.startsWith("SELECT e.route, e.course, e.status, e.fetched_at")) return statement;
      return { bind(...args: unknown[]) { const bound = statement.bind(...args); return { async all() {
        const result = await bound.all();
        refusedRowsReturned = result.results.length;
        return result;
      } }; } };
    } } as unknown as D1Database;
    const bounded = await new SchoolCollectorRepository(database, f.owner, f.clock).status({ limit: 1 });
    expect(refusedRowsReturned).toBe(2);
    expect(bounded.refused).toHaveLength(1);
    expect(bounded.refused[0]!.fetched_at).toBe(latest.startedAt);
    expect(bounded.refusedTruncated).toBe(true);
    expect((await repo(f).status({ limit: 100 })).refused).toHaveLength(3);
    // A bounded latest-read query must not erase success behind a run of failures.
    for (let i = 0; i < 6; i += 1) {
      f.setNow(new Date(f.clock().getTime() + 60_000));
      await ingest(f, { ...observedBatch(f), enrollmentComplete: false });
    }
    expect(await repo(f).status({ limit: 1 })).toMatchObject({ state: "failed", lastGoodReadAt: latest.startedAt });
  });

  it("returns at most one row from each read aggregate while retaining the last complete good read", async () => {
    const f = await collectorFixture();
    await ingest(f, observedBatch(f));
    f.setNow(new Date(f.clock().getTime() + 60_000));
    await ingest(f, observedBatch(f));
    const rowsReturned: number[] = [];
    // Observe real SQL results, so removing LIMIT cannot hide behind first() discarding rows.
    const database = { prepare(sql: string) {
      const statement = env.DB.prepare(sql);
      if (!sql.includes("COUNT(b.batch_id) AS received")) return statement;
      return { bind(...args: unknown[]) { const bound = statement.bind(...args); return { async all() {
        const result = await bound.all();
        rowsReturned.push(result.results.length);
        return result;
      } }; } };
    } } as unknown as D1Database;
    expect((await new SchoolCollectorRepository(database, f.owner, f.clock).status()).state).toBe("current");
    expect(rowsReturned).toEqual([1, 1, 0]);
  });

  it("counts undated work from the latest good whole read and names it in a current digest", async () => {
    const f = await collectorFixture();
    await ingest(f, observedBatch(f));
    f.setNow(new Date(f.clock().getTime() + 60_000));
    const a = observedBatch(f);
    const b = observedBatch(f, "second-course");
    const courseIds = [f.courseId, b.course.id];
    await ingest(f, { ...a, courseIds });
    await ingest(f, { ...b, readId: a.readId, courseIds });
    expect(await repo(f).status()).toMatchObject({ state: "current", lastGoodReadUndatedItems: 2 });
    const makeDigest = () => assembleDigest("daily", { clock: { now: f.clock }, timeZone: "America/Toronto", delivery: { send: async () => undefined },
      sources: { readCatchupActions: async () => [], readApplicationItems: async () => [], readDeadlines: async () => [],
        readDeadlineSources: async () => [], readProjectStatuses: async () => [], readOpenDecisions: async () => [], readD2lStatus: () => repo(f).status() } });
    const digest = await makeDigest();
    expect(digest.text).toContain("2 Brightspace items have no known date");
    expect(digest.text.toLowerCase()).not.toContain("nothing due");
    f.setNow(new Date(f.clock().getTime() + 60_000));
    await ingest(f, { ...observedBatch(f), enrollmentComplete: false });
    expect(await repo(f).status()).toMatchObject({ state: "failed", lastGoodReadUndatedItems: 2 });
    expect((await makeDigest()).text).not.toContain("2 Brightspace items have no known date");
    f.setNow(new Date(f.clock().getTime() + 60_000));
    const empty = observedBatch(f);
    await ingest(f, { ...empty, routes: empty.routes.map((route) => ({ ...route, status: 403, body: null })) });
    expect(await repo(f).status()).toMatchObject({ state: "current", lastGoodReadUndatedItems: 0 });
    expect((await makeDigest()).text).not.toContain("0 Brightspace items have no known date");
  });

  it("requires every declared course and completed enrollment before advertising a good read", async () => {
    const f = await collectorFixture();
    const a = observedBatch(f);
    await ingest(f, { ...a, courseIds: [f.courseId, "missing-course"] });
    expect(await repo(f).status()).toMatchObject({ state: "incomplete", lastGoodReadAt: null });
    f.setNow(new Date(f.clock().getTime() + 60_000));
    await ingest(f, { ...observedBatch(f), enrollmentComplete: false });
    expect(await repo(f).status()).toMatchObject({ state: "failed", lastGoodReadAt: null });
  });

  it("refuses manifest changes and altered retries while identical retries retain one receipt", async () => {
    const f = await collectorFixture();
    const batch = observedBatch(f);
    const first = await ingest(f, batch);
    const repeatedProjection = vi.spyOn(DeadlineIngestion.prototype, "ingest").mockRejectedValue(new Error("synthetic repeated projection"));
    try {
      expect(await ingest(f, batch)).toEqual(first);
      expect(repeatedProjection).not.toHaveBeenCalled();
    } finally { repeatedProjection.mockRestore(); }
    expect((await repo(f).status()).evidence).toHaveLength(5);
    await expect(ingest(f, { ...batch, course: { ...batch.course, name: "Changed" } })).rejects.toThrow("school_batch_conflict");
    const other = observedBatch(f, "different");
    await expect(ingest(f, { ...other, readId: batch.readId })).rejects.toThrow("school_batch_conflict");
    await expect(env.DB.prepare("UPDATE school_collector_reads SET enrollment_complete = 0 WHERE collector_id = ?").bind(f.key.collector_id).run())
      .rejects.toThrow("school_collector_read_immutable");
  });

  it("retains raw malformed or refused route evidence without projecting a short successful list", async () => {
    const f = await collectorFixture();
    const batch = observedBatch(f);
    const variants = [
      { ...batch, routes: batch.routes.filter((_, index) => index !== 1) },
      { ...batch, routes: batch.routes.map((route, i) => i === 0 ? { ...route, complete: false } : route) },
      { ...batch, routes: batch.routes.filter((_, i) => i !== 3) },
    ];
    for (const variant of variants) {
      expect(mapSchoolCourse(variant).failures.length).toBeGreaterThan(0);
      expect((await ingest(f, { ...variant, readId: newUlid(f.clock()) })).outcome).toBe("failed");
    }
    expect(await env.DB.prepare("SELECT * FROM deadlines WHERE source_id = ?").bind(`d2l-api:ldsb.elearningontario.ca:${f.courseId}`).first()).toBeNull();
  });

  it("preserves later projected dates when an older device read arrives and keeps immutable evidence", async () => {
    const f = await collectorFixture();
    const old = observedBatch(f);
    f.setNow(new Date(f.clock().getTime() + 60_000));
    const latest = structuredClone(observedBatch(f)) as unknown as { routes: any[] } & SchoolBatch;
    latest.routes[0].body[0].DueDate = "2026-09-28T12:00:00Z";
    await ingest(f, latest);
    expect((await ingest(f, old)).outcome).toBe("good");
    expect((await repo(f).status()).lastGoodReadAt).toBe(latest.startedAt);
    expect(await env.DB.prepare("SELECT due_at FROM deadlines WHERE source_id = ?").bind(`d2l-api:ldsb.elearningontario.ca:${f.courseId}`).first())
      .toEqual({ due_at: "2026-09-28T12:00:00.000Z" });
    await expect(env.DB.prepare("UPDATE deadlines SET last_seen_at = ? WHERE source_id = ?").bind(old.startedAt, `d2l-api:ldsb.elearningontario.ca:${f.courseId}`).run())
      .rejects.toThrow("school_collector_older_deadline");
    const row = (await repo(f).status()).evidence[0]!;
    await expect(env.DB.prepare("UPDATE school_collector_evidence SET status = 200 WHERE evidence_id = ?").bind(row.evidence_id).run())
      .rejects.toThrow("school_collector_evidence_immutable");
    await expect(env.DB.prepare("DELETE FROM school_collector_evidence WHERE evidence_id = ?").bind(row.evidence_id).run())
      .rejects.toThrow("school_collector_evidence_retained");
  });

  it("fails the read when deadline ingestion rejects an item and preserves the raw evidence", async () => {
    const f = await collectorFixture();
    const batch = structuredClone(observedBatch(f)) as unknown as { routes: any[] } & SchoolBatch;
    batch.routes[0].body[0].Id = "x".repeat(512);
    batch.routes[0].body[0].DueDate = "2026-09-25T12:00:00Z";
    batch.routes[3].route = `/d2l/api/le/1.82/${f.courseId}/dropbox/folders/${"x".repeat(512)}/submissions/mysubmissions/`;
    expect(mapSchoolCourse(batch).failures).toEqual([]);
    expect((await ingest(f, batch)).outcome).toBe("failed");
    const status = await repo(f).status();
    expect(status).toMatchObject({ state: "failed", lastGoodReadAt: null });
    expect(status.evidence).toHaveLength(5);
  });

  it("fails the read when deadline persistence throws and preserves the raw evidence", async () => {
    const f = await collectorFixture();
    const failure = vi.spyOn(DeadlineIngestion.prototype, "ingest").mockRejectedValue(new Error("synthetic persistence failure"));
    try {
      expect((await ingest(f, observedBatch(f))).outcome).toBe("failed");
      expect(await repo(f).status()).toMatchObject({ state: "failed", lastGoodReadAt: null });
      expect((await repo(f).status()).evidence).toHaveLength(5);
    } finally { failure.mockRestore(); }
  });

  it("paginates every evidence row without crossing the owner boundary", async () => {
    const f = await collectorFixture();
    await ingest(f, observedBatch(f));
    const first = await repo(f).status({ limit: 2 });
    expect(first.evidence).toHaveLength(2);
    expect(first.evidenceNextCursor).not.toBeNull();
    const second = await repo(f).status({ limit: 2, cursor: first.evidenceNextCursor! });
    const third = await repo(f).status({ limit: 2, cursor: second.evidenceNextCursor! });
    expect(third.evidence).toHaveLength(1);
    expect(third.evidenceNextCursor).toBeNull();
    expect(new Set([...first.evidence, ...second.evidence, ...third.evidence].map((row) => row.evidence_id)).size).toBe(5);
    const other = await collectorFixture();
    expect(await repo(other).status()).toMatchObject({ evidence: [], refused: [], state: "never_read" });
    await expect(repo(f).status({ limit: 0 })).rejects.toThrow("school_status_options_invalid");
    await expect(repo(f).status({ staleAfterMs: 0 })).rejects.toThrow("school_status_options_invalid");
  });

  it("refuses a malformed body hash and an invented batch outcome at the database boundary", async () => {
    const f = await collectorFixture();
    const batch = observedBatch(f);
    await ingest(f, batch);
    const insert = (hash: string, outcome: string) => env.DB.prepare(`INSERT INTO school_collector_batches
      (batch_id, collector_id, read_id, course_id, course_name, body_hash, outcome, failures_json, mapped_json, received_at)
      VALUES (?, ?, ?, 'synthetic-extra', 'Synthetic', ?, ?, '[]', '[]', ?)`)
      .bind(newUlid(), f.key.collector_id, batch.readId, hash, outcome, f.clock().toISOString()).run();
    await expect(insert("X".repeat(64), "pending")).rejects.toThrow("CHECK constraint failed");
    await expect(insert("a".repeat(63), "pending")).rejects.toThrow("CHECK constraint failed");
    await expect(insert("a".repeat(64), "invented")).rejects.toThrow("CHECK constraint failed");
  });

  it("marks stale and failed reads in the digest and never prints nothing due for either", async () => {
    const f = await collectorFixture();
    await ingest(f, observedBatch(f));
    const makeDigest = () => assembleDigest("daily", { clock: { now: f.clock }, timeZone: "America/Toronto", delivery: { send: async () => undefined },
      sources: { readCatchupActions: async () => [], readApplicationItems: async () => [], readDeadlines: async () => [],
        readDeadlineSources: async () => [], readProjectStatuses: async () => [], readOpenDecisions: async () => [], readD2lStatus: () => repo(f).status() } });
    f.setNow(new Date(f.clock().getTime() + 12 * 60 * 60_000));
    expect((await repo(f).status()).state).toBe("stale");
    const stale = await makeDigest();
    expect(stale.text).toContain("read stale");
    expect(stale.text.toLowerCase()).not.toContain("nothing due");
    await ingest(f, { ...observedBatch(f), enrollmentComplete: false });
    const failed = await makeDigest();
    expect(failed.text).toContain("read failed");
    expect(failed.text.toLowerCase()).not.toContain("nothing due");
  });

  it("labels unknown projection shapes while preserving other mapped evidence", async () => {
    const f = await collectorFixture();
    for (const alter of [
      (b: any) => { b.routes[0].body[0].Id = -1; },
      (b: any) => { b.routes[0].body[0].Name = ""; },
      (b: any) => { b.routes[0].body[0].DueDate = "not a date"; },
      (b: any) => { b.routes[0].body[0].DueDate = "2026-02-31T12:00:00Z"; },
      (b: any) => { b.routes[0].body.push(b.routes[0].body[0]); },
      (b: any) => { b.routes[1].body.Modules[0].Topics.push({ TopicId: 42, Title: "Conflicting", ToolItemId: 17,
        TypeIdentifier: "Dropbox", EndDateTime: "2026-09-30T00:00:00Z" }); },
      (b: any) => { b.routes.push({ ...b.routes[0], route: `/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=${f.courseId}`, body: { Surprise: [] } }); },
    ]) {
      const batch = structuredClone(observedBatch(f));
      alter(batch);
      expect(mapSchoolCourse(batch).failures).toEqual([]);
      expect(mapSchoolCourse(batch).unmapped.length).toBeGreaterThan(0);
    }
    expect(evidenceShape(null)).toBe("null");
    expect(evidenceShape({ Errors: [] })).toBe("object(Errors)");
    expect(evidenceShape([{}])).toBe("array(1)");
  });
});
