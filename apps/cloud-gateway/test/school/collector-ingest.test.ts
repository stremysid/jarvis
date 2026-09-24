import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";
import { collectorFixture, observedBatch, bytes, type CollectorFixture } from "./collector-fixtures.js";
import { SchoolCollectorRepository } from "../../src/school/collector-repository.js";
import { mapSchoolCourse, evidenceShape } from "../../src/school/collector-mapping.js";
import type { SchoolBatch } from "../../src/school/collector-protocol.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
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
    expect(await env.DB.prepare("SELECT title, due_at FROM deadlines WHERE source_id = ?").bind(`d2l-api:${f.courseId}`).first())
      .toEqual({ title: "Synthetic essay [availability end]", due_at: "2026-09-24T03:59:00.000Z" });
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
    batch.routes[3].route += "mysubmissions/";
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
      ? { ...route, status: 403, body: { Errors: [{ Message: "Not Authorized" }] } } : route) });
    const status = await repo(f).status({ limit: 100 });
    expect(status.state).toBe("failed");
    expect(status.lastGoodReadAt).toBe(first.startedAt);
    expect(status.refused).toEqual([{ route: b.routes[2]!.route, course: "another-course", status: 403, fetched_at: b.startedAt }]);
    expect(status.evidence).toHaveLength(15);
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
    expect(await ingest(f, batch)).toEqual(first);
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
      { ...batch, routes: batch.routes.map((route, i) => i === 0 ? { ...route, body: {} } : route) },
      { ...batch, routes: batch.routes.map((route, i) => i === 0 ? { ...route, complete: false } : route) },
      { ...batch, routes: batch.routes.filter((_, i) => i !== 3) },
    ];
    for (const variant of variants) {
      expect(mapSchoolCourse(variant).failures.length).toBeGreaterThan(0);
      expect((await ingest(f, { ...variant, readId: newUlid(f.clock()) })).outcome).toBe("failed");
    }
    expect(await env.DB.prepare("SELECT * FROM deadlines WHERE source_id = ?").bind(`d2l-api:${f.courseId}`).first()).toBeNull();
  });

  it("preserves later projected dates when an older device read arrives and keeps immutable evidence", async () => {
    const f = await collectorFixture();
    const old = observedBatch(f);
    f.setNow(new Date(f.clock().getTime() + 60_000));
    const latest = structuredClone(observedBatch(f)) as unknown as { routes: any[] } & SchoolBatch;
    latest.routes[0].body[0].DueDate = "2026-09-28T12:00:00Z";
    await ingest(f, latest);
    await ingest(f, old);
    expect((await repo(f).status()).lastGoodReadAt).toBe(latest.startedAt);
    expect(await env.DB.prepare("SELECT due_at FROM deadlines WHERE source_id = ?").bind(`d2l-api:${f.courseId}`).first())
      .toEqual({ due_at: "2026-09-28T12:00:00.000Z" });
    await expect(env.DB.prepare("UPDATE deadlines SET last_seen_at = ? WHERE source_id = ?").bind(old.startedAt, `d2l-api:${f.courseId}`).run())
      .rejects.toThrow("school_collector_older_deadline");
    const row = (await repo(f).status()).evidence[0]!;
    await expect(env.DB.prepare("UPDATE school_collector_evidence SET status = 200 WHERE evidence_id = ?").bind(row.evidence_id).run())
      .rejects.toThrow("school_collector_evidence_immutable");
    await expect(env.DB.prepare("DELETE FROM school_collector_evidence WHERE evidence_id = ?").bind(row.evidence_id).run())
      .rejects.toThrow("school_collector_evidence_retained");
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

  it("refuses invalid resource identities, dates, ambiguous links and unfamiliar myItems shapes", async () => {
    const f = await collectorFixture();
    for (const alter of [
      (b: any) => { b.routes[0].body[0].Id = -1; },
      (b: any) => { b.routes[0].body[0].Name = ""; },
      (b: any) => { b.routes[0].body[0].DueDate = "not a date"; },
      (b: any) => { b.routes[0].body[0].DueDate = "2026-02-31T12:00:00Z"; },
      (b: any) => { b.routes[2].body = { Errors: [{ Message: "Unexpected" }] }; },
      (b: any) => { b.routes[0].body.push(b.routes[0].body[0]); },
      (b: any) => { b.routes[1].body.Modules[0].Topics.push({ TopicId: 42, Title: "Conflicting", ToolItemId: 17, EndDateTime: "2026-09-30T00:00:00Z" }); },
      (b: any) => { b.routes.push({ ...b.routes[0], route: `/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=${f.courseId}`, body: { Surprise: [] } }); },
    ]) {
      const batch = structuredClone(observedBatch(f));
      alter(batch);
      expect(mapSchoolCourse(batch).failures).toContain("unsupported_or_invalid_route_shape");
    }
    expect(evidenceShape(null)).toBe("null");
    expect(evidenceShape({ Errors: [] })).toBe("object(Errors)");
    expect(evidenceShape([{}])).toBe("array(1)");
  });
});
