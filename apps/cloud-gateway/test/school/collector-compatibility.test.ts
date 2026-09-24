import { env } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { canonicalJson, newUlid } from "../../../../packages/contracts/src/index.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";
import { collectorFixture, observedBatch, bytes, readKey, type CollectorFixture } from "./collector-fixtures.js";
import { SchoolCollectorRepository } from "../../src/school/collector-repository.js";
import { mapSchoolCourse } from "../../src/school/collector-mapping.js";
import { parseSchoolBatch, type SchoolBatch, type SchoolHostFailureBatch } from "../../src/school/collector-protocol.js";
import { handleSchoolRequest } from "../../src/http/school-routes.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { assembleDigest } from "../../src/jobs/digest-job.js";
import type { Env } from "../../src/env.js";

beforeAll(applyNewestRuntimeMigration);
const repo = (f: CollectorFixture) => new SchoolCollectorRepository(env.DB, f.owner, f.clock);
const upload = async (f: CollectorFixture, batch: unknown) => f.dispatch(await f.request("/school/observations", batch));
const digest = (f: CollectorFixture) => assembleDigest("daily", { clock: { now: f.clock }, timeZone: "America/Toronto", delivery: { send: async () => undefined }, sources: {
  readCatchupActions: async () => [], readApplicationItems: async () => [], readDeadlines: async () => [], readDeadlineSources: async () => [],
  readProjectStatuses: async () => [], readOpenDecisions: async () => [], readD2lStatus: () => repo(f).status(),
} });
const hostFailure = (f: CollectorFixture): SchoolHostFailureBatch => ({ schemaVersion: "1.0", host: "durham.elearningontario.ca",
  readId: newUlid(f.clock()), startedAt: f.clock().toISOString(), courseIds: [], enrollmentComplete: false, course: null,
  routes: [{ route: "/d2l/api/versions/", status: 0, fetchedAt: f.clock().toISOString(), complete: false, body: { collectorFailure: "session-expired" } }],
});

it("persists Durham provenance and isolates equal course IDs across hosts even when Durham arrives late", async () => {
  const f = await collectorFixture();
  const durham: SchoolBatch = { ...observedBatch(f), host: "durham.elearningontario.ca", course: { id: f.courseId, name: "Synthetic online course" } };
  f.setNow(new Date(f.clock().getTime() + 60_000));
  const ldsb = observedBatch(f);
  expect(await (await upload(f, ldsb)).json()).toMatchObject({ outcome: "good" });
  expect(await (await upload(f, durham)).json()).toMatchObject({ outcome: "good" });
  const status = await repo(f).status({ limit: 100 });
  expect(status.evidence.filter((row) => row.host === durham.host)).toHaveLength(5);
  expect(status.hosts.map((host) => host.host).sort()).toEqual([durham.host, ldsb.host]);
  expect(status.lastGoodReadAt).toBe(durham.startedAt);
  expect(status.lastGoodReadUndatedItems).toBe(2);
  const rows = await env.DB.prepare("SELECT source_id, course FROM deadlines WHERE source_id IN (?, ?) ORDER BY source_id")
    .bind(`d2l-api:${durham.host}:${f.courseId}`, `d2l-api:${ldsb.host}:${f.courseId}`).all();
  expect(rows.results).toEqual([{ source_id: `d2l-api:${durham.host}:${f.courseId}`, course: durham.course.name },
    { source_id: `d2l-api:${ldsb.host}:${f.courseId}`, course: ldsb.course.name }]);
  expect((await upload(f, { ...ldsb, host: durham.host })).status).toBe(400);
  expect((await repo(f).status({ limit: 100 })).evidence).toHaveLength(10);
});

it("accepts announcements as raw evidence and projects quiz due dates and availability ends without guessing submission", async () => {
  const f = await collectorFixture();
  const batch = observedBatch(f);
  const prefix = `/d2l/api/le/1.82/${f.courseId}/`;
  const news = [{ Id: 1, Title: "Synthetic announcement", EndDate: "2026-09-27T00:00:00Z", Body: { Text: "Read this later" } }];
  const quizzes = { Objects: [
    { QuizId: 8, Name: "Synthetic quiz", DueDate: "2026-09-25T00:00:00Z", EndDate: "2026-09-26T00:00:00Z" },
    { QuizId: 9, Name: "Undated quiz", DueDate: null, EndDate: null },
    { QuizId: 10, Name: "Availability only", DueDate: null, EndDate: "2026-09-27T00:00:00Z" },
  ], Next: null };
  const value = { ...batch, routes: [...batch.routes, ...[{ route: prefix + "news/", body: news }, { route: prefix + "quizzes/", body: quizzes }]
    .map((row) => ({ ...row, status: 200, complete: true, fetchedAt: batch.startedAt }))] };
  expect(await (await upload(f, value)).json()).toMatchObject({ outcome: "good" });
  const status = await repo(f).status({ limit: 100 });
  expect(status.evidence.find((row) => row.route === prefix + "news/")?.raw_json).toBe(canonicalJson(news));
  expect(status.evidence.find((row) => row.route === prefix + "quizzes/")?.raw_json).toBe(canonicalJson(quizzes));
  expect(status.lastGoodReadUndatedItems).toBe(2);
  const mapped = mapSchoolCourse(value);
  expect(mapped.items.find((item) => item.id === "quiz-9")).toMatchObject({ dueAt: null, submission: "unknown" });
  expect(mapped.deadlines.filter((item) => item.externalId.startsWith("quiz-"))).toEqual([
    { externalId: "quiz-8", course: batch.course.name, title: "Synthetic quiz [quiz DueDate]", dueAt: "2026-09-25T00:00:00.000Z" },
    { externalId: "quiz-8-end", course: batch.course.name, title: "Synthetic quiz [availability end]", dueAt: "2026-09-26T00:00:00.000Z" },
    { externalId: "quiz-10", course: batch.course.name, title: "Availability only [availability end]", dueAt: "2026-09-27T00:00:00.000Z" },
  ]);
  expect(mapped.items.some((item) => item.title === "Synthetic announcement")).toBe(false);
});

it("stores the observed empty myItems envelope and all linked pages without treating an unseen page as empty", async () => {
  const f = await collectorFixture();
  const batch = observedBatch(f);
  const path = `/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=${f.courseId}`;
  const row = { route: path, status: 200, complete: true, fetchedAt: batch.startedAt, body: { Objects: [], Next: null } };
  expect(await (await upload(f, { ...batch, routes: [...batch.routes, row] })).json()).toMatchObject({ outcome: "good" });
  expect((await repo(f).status()).evidence.find((entry) => entry.route === path)?.raw_json).toBe(canonicalJson(row.body));
  const page1 = { ...row, body: { Objects: [{ ToolItemId: 17, DueDate: "2026-09-28T00:00:00Z" }], Next: path + "&bookmark=second" } };
  const page2 = { ...row, route: path + "&bookmark=second", body: { Objects: [{ ItemId: 71, ItemName: "Scheduled reading", DueDate: null, EndDate: null }], Next: null } };
  const paged = { ...batch, readId: newUlid(f.clock()), routes: [...batch.routes, page1, page2] };
  expect(await (await upload(f, paged)).json()).toMatchObject({ outcome: "good" });
  const mapped = mapSchoolCourse(paged);
  expect(mapped.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "folder-17", dateSource: "content/myItems", dueAt: "2026-09-28T00:00:00.000Z" }),
  ]));
  expect(mapped.items.some((item) => item.id === "myitem-71")).toBe(false);
  expect(mapped.unmapped).toContain(`${page2.route}:scheduled_item_projection_unknown`);
  for (const routes of [[...batch.routes, page1], [...batch.routes, page1, { ...page2, body: { ...page2.body, Next: path } }]]) {
    expect(await (await upload(f, { ...batch, readId: newUlid(f.clock()), routes })).json()).toMatchObject({ outcome: "failed" });
  }
});

it("accepts observed empty student submissions as unknown evidence with their original body", async () => {
  const f = await collectorFixture();
  const batch = observedBatch(f);
  const value = batch;
  expect(await (await upload(f, value)).json()).toMatchObject({ outcome: "good" });
  expect(mapSchoolCourse(value).items).toHaveLength(2);
  expect(mapSchoolCourse(value).items.every((item) => item.submission === "unknown")).toBe(true);
  const evidence = (await repo(f).status()).evidence.filter((row) => String(row.route).includes("mysubmissions"));
  expect(evidence).toHaveLength(2);
  expect(evidence.every((row) => row.raw_json === "[]" && row.shape === "array(0)")).toBe(true);
  expect(JSON.stringify(evidence)).not.toMatch(/unsubmitted|"missed"/);
});

it("records a refused student submission route without treating it as not submitted", async () => {
  const f = await collectorFixture();
  const batch = observedBatch(f);
  const routes = batch.routes.map((row, i) => i === 3 ? { ...row, status: 403, body: { Errors: [{ Message: "Not Authorized" }] } } : row);
  const value = { ...batch, routes };
  expect(await (await upload(f, value)).json()).toMatchObject({ outcome: "good" });
  expect(mapSchoolCourse(value).items.find((item) => item.id === "folder-17")?.submission).toBe("unknown");
  expect((await repo(f).status()).refused).toContainEqual({ route: routes[3]!.route, course: f.courseId, host: batch.host,
    disposition: "refused", status: 403, fetched_at: batch.startedAt });
  expect(JSON.stringify(await repo(f).status())).not.toMatch(/not submitted|unsubmitted|"missed"/i);
});

it("keeps an unobserved populated student submission array unknown", async () => {
  const f = await collectorFixture();
  const batch = observedBatch(f);
  const routes = batch.routes.map((row, i) => i === 3 ? { ...row, body: [{ Status: 1 }] } : row);
  const value = { ...batch, routes };
  expect(await (await upload(f, value)).json()).toMatchObject({ outcome: "good" });
  expect(mapSchoolCourse(value).items.find((item) => item.id === "folder-17")?.submission).toBe("unknown");
  expect((await repo(f).status()).evidence.find((row) => row.route === routes[3]!.route)).toMatchObject({
    shape: "array(1)", raw_json: JSON.stringify([{ Status: 1 }]),
  });
});

it("keeps a first-run host session failure visible after the other host succeeds", async () => {
  const f = await collectorFixture();
  const failure = hostFailure(f);
  expect(await (await upload(f, failure)).json()).toMatchObject({ outcome: "failed" });
  expect(await repo(f).status()).toMatchObject({ state: "failed", lastGoodReadAt: null,
    hosts: [{ host: failure.host, state: "failed", sessionExpired: true }] });
  f.setNow(new Date(f.clock().getTime() + 60_000));
  await upload(f, observedBatch(f));
  const status = await repo(f).status({ limit: 100 });
  expect(status.state).toBe("failed");
  expect(status.lastGoodReadAt).toBeNull();
  expect(status.evidence.find((row) => row.host === failure.host)).toMatchObject({ course: null, outcome: "failed", raw_json: JSON.stringify(failure.routes[0]!.body) });
  expect(status.refused).toContainEqual(expect.objectContaining({ host: failure.host, course: null, status: 0 }));
  const result = await digest(f);
  expect(result.text).toContain(failure.host);
  expect(result.text).toContain("session expired");
  expect(result.text.toLowerCase()).not.toContain("nothing due");
});

it("accepts a paged compact oversized-manifest failure and refuses a host-only success or invented course", async () => {
  const f = await collectorFixture();
  const failure = hostFailure(f);
  const value = { ...failure, routes: [{ ...failure.routes[0]!, route: "/d2l/api/lp/1.43/enrollments/myenrollments/?bookmark=page",
    status: 200, body: { collectorFailure: "course-manifest-too-large", courseCount: 129 } }] };
  expect(await (await upload(f, value)).json()).toMatchObject({ outcome: "failed" });
  expect(await repo(f).status()).toMatchObject({ state: "failed", hosts: [{ sessionExpired: false }] });
  expect((await digest(f)).text).toContain("read failed");
  for (const invalid of [{ ...value, enrollmentComplete: true }, { ...value, courseIds: [f.courseId] }, { ...value, routes: [] },
    { ...value, routes: [{ ...value.routes[0]!, route: `/d2l/api/le/1.82/${f.courseId}/news/` }] }]) {
    expect(() => parseSchoolBatch(invalid, f.clock())).toThrow();
  }
});

it("records complete optional-tool 404 responses as missing while keeping projected deadlines", async () => {
  const f = await collectorFixture();
  const batch = observedBatch(f);
  const routes = batch.routes.map((row, i) => i === 2 ? { ...row, status: 404, body: {} } : row);
  for (const suffix of ["news/", "quizzes/"]) routes.push({ ...batch.routes[2]!, route: `/d2l/api/le/1.82/${f.courseId}/${suffix}`, status: 404, body: {} });
  routes.push({ ...batch.routes[2]!, route: `/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=${f.courseId}`, status: 404, body: {} });
  expect(await (await upload(f, { ...batch, routes })).json()).toMatchObject({ outcome: "good" });
  const status = await repo(f).status();
  expect(status.state).toBe("current");
  expect(status.refused).toHaveLength(4);
  expect(status.refused.every((row) => row.status === 404 && row.disposition === "missing tool")).toBe(true);
  expect(mapSchoolCourse({ ...batch, routes }).deadlines).toHaveLength(1);
  expect(await (await upload(f, { ...batch, readId: newUlid(f.clock()), routes: routes.map((row) => row.status === 404 ? { ...row, complete: false } : row) })).json()).toMatchObject({ outcome: "failed" });
});

it("stores unfamiliar JSON shapes with projection labels and prevents an empty digest from calling them nothing due", async () => {
  const f = await collectorFixture();
  const batch = observedBatch(f);
  const routes = batch.routes.map((row, i) => i === 0 ? { ...row, body: { UnknownFolderShape: [{ Work: "still evidence" }] } }
    : i === 1 ? { ...row, body: { Modules: [] } } : row);
  expect(await (await upload(f, { ...batch, routes })).json()).toMatchObject({ outcome: "good" });
  const status = await repo(f).status();
  // `unmappedRoutes` counts labels in unmapped_json. This fixture removes every
  // toc topic, so only the unfamiliar folder-list shape contributes a label.
  expect(status).toMatchObject({ state: "current", unmappedRoutes: 1, lastGoodReadUndatedItems: 0 });
  expect(status.evidence[0]!.unmapped_json).toContain("projection_unknown");
  expect(status.evidence[0]!.unmapped_json).not.toContain("linked_topic_folder_list_unread");
  expect(status.evidence.find((row) => row.route === routes[0]!.route)?.raw_json).toBe(JSON.stringify(routes[0]!.body));
  const result = await digest(f);
  expect(result.text).toContain("unknown projection or date disagreement");
  expect(result.text.toLowerCase()).not.toContain("nothing due");
});

it("retries failed pairing notification with a fresh signature and the same decision before activating on its tap", async () => {
  const f = await collectorFixture(false);
  const notify = vi.fn().mockRejectedValueOnce(new Error("synthetic send failed")).mockResolvedValue(undefined);
  const send = async () => handleSchoolRequest(await f.request("/school/pairing/prove", { challenge: f.key.challenge }),
    { ...env, OWNER_PRINCIPAL_ID: f.owner } as Env, { now: f.clock, notify });
  expect((await send()).status).toBe(400);
  const key = await readKey(f.key.collector_id);
  expect(key.status).toBe("pending");
  const retry = await send();
  expect(retry.status).toBe(202);
  expect(await retry.json()).toMatchObject({ decisionId: key.decision_id });
  expect(notify).toHaveBeenCalledTimes(2);
  expect((await send()).status).toBe(202);
  expect(notify).toHaveBeenCalledTimes(2);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM decision_items WHERE origin_reference = ?").bind(f.key.collector_id).first()).toEqual({ n: 1 });
  await f.decisions.answer({ decisionId: key.decision_id!, answeredByIdentityId: f.identity, optionKey: "confirm" });
  expect(await f.pairing.activateFromDecision(key.decision_id!, f.identity)).toBe(true);
});

it("recovers pairing decision creation failure and converges concurrent proof retries on one decision", async () => {
  const f = await collectorFixture(false);
  const raise = vi.spyOn(DecisionRepository.prototype, "raise").mockRejectedValueOnce(new Error("synthetic database unavailable"));
  try { await expect(f.pairing.prove(f.key, { challenge: f.key.challenge })).rejects.toThrow("synthetic database unavailable"); }
  finally { raise.mockRestore(); }
  const results = await Promise.all([f.pairing.prove(f.key, { challenge: f.key.challenge }), f.pairing.prove(f.key, { challenge: f.key.challenge })]);
  expect(results[0]!.decisionId).toBe(results[1]!.decisionId);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM decision_items WHERE origin_reference = ?").bind(f.key.collector_id).first()).toEqual({ n: 1 });
  expect((await readKey(f.key.collector_id)).decision_id).toBe(results[0]!.decisionId);
});

it("refuses a second course that tries to change the host of an existing read manifest", async () => {
  const f = await collectorFixture();
  const first = observedBatch(f);
  const second = observedBatch(f, "other-course");
  const courseIds = [first.course.id, second.course.id];
  expect((await upload(f, { ...first, courseIds })).status).toBe(200);
  expect((await upload(f, { ...second, courseIds, readId: first.readId, host: "durham.elearningontario.ca" })).status).toBe(400);
  expect((await repo(f).status({ limit: 100 })).evidence).toHaveLength(5);
});

it("labels non-JSON bodies and redirects as expired sessions even when the HTTP status resembles an optional refusal", async () => {
  const f = await collectorFixture();
  for (const [status, body] of [[200, "<html>login</html>"], [403, "<html>login</html>"], [404, "<html>login</html>"], [302, {}], [401, {}], [200, { collectorFailure: "session-expired" }]] as const) {
    f.setNow(new Date(f.clock().getTime() + 60_000));
    const batch = observedBatch(f);
    expect(await (await upload(f, { ...batch, routes: batch.routes.map((row, i) => i === 2 ? { ...row, status, body } : row) })).json()).toMatchObject({ outcome: "failed" });
    const result = await repo(f).status();
    expect(result.hosts[0]).toMatchObject({ state: "failed", sessionExpired: true });
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]!.disposition).toBe("session expired");
    expect((await digest(f)).text).toContain("session expired");
  }
});

it("keeps unlinked and conflicting dates visible without projecting an arbitrary date", async () => {
  const f = await collectorFixture();
  const batch = structuredClone(observedBatch(f)) as SchoolBatch & { routes: any[] };
  batch.routes[0].body.push({ ...batch.routes[0].body[0], DueDate: "2026-09-30T00:00:00Z" });
  expect(mapSchoolCourse(batch).items.find((item) => item.id === "folder-17")?.dueAt).toBeNull();
  batch.routes[0].body.pop();
  batch.routes[1].body.Modules[0].Topics.push({ TopicId: 43, Title: "Other link", ToolItemId: 17,
    TypeIdentifier: "Dropbox", EndDateTime: "2026-10-02T00:00:00Z" });
  expect(mapSchoolCourse(batch).items.find((item) => item.id === "folder-17")?.dueAt).toBeNull();
  batch.routes[0].body.push({ ...batch.routes[0].body[0], DueDate: "2026-09-30T00:00:00Z" });
  batch.routes.push({ route: `/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=${f.courseId}`, fetchedAt: batch.startedAt,
    status: 200, complete: true, body: { Objects: [{ ToolItemId: 800, DueDate: null }], Next: null } });
  const mapped = mapSchoolCourse(batch);
  expect(mapped.items.find((item) => item.id === "folder-17")?.dueAt).toBeNull();
  expect(mapped.unmapped).toHaveLength(3);
  expect(mapped.deadlines).toHaveLength(0);
  expect(await (await upload(f, batch)).json()).toMatchObject({ outcome: "good" });
  expect((await repo(f).status()).unmappedRoutes).toBe(3);
  expect((await digest(f)).text).toContain("unknown projection or date disagreement");
});

it("counts each folder-specific projection label and keeps the digest gap visible", async () => {
  const f = await collectorFixture();
  const batch = structuredClone(observedBatch(f)) as SchoolBatch & { routes: any[] };
  batch.routes[0].body[0].Availability = { ClosesAt: "2026-09-25T00:00:00Z" };
  batch.routes[0].body[1].Availability = { EndDate: 5 };
  const mapped = mapSchoolCourse(batch);
  expect(mapped.unmapped).toEqual([
    `${batch.routes[0].route}:folder-17:folder_availability_shape_unknown`,
    `${batch.routes[0].route}:folder-18:folder_availability_shape_unknown`,
  ]);
  expect(await (await upload(f, batch)).json()).toMatchObject({ outcome: "good" });
  const status = await repo(f).status();
  expect(status).toMatchObject({ unmappedRoutes: 2, hosts: [expect.objectContaining({ unmappedRoutes: 2 })] });
  expect(status.instructions).toContain("unmappedRoutes counts unmapped_json label entries");
  expect((await digest(f)).text).toContain("unknown projection or date disagreement");
});

it("counts an unmapped route once even when several of its items cannot be projected", async () => {
  const f = await collectorFixture(false);
  const batch = observedBatch(f);
  const mapped = mapSchoolCourse({ ...batch, routes: batch.routes.map((row, i) => i === 0 ? { ...row, body: [{ Surprise: 1 }, { Surprise: 2 }] } : row) });
  expect(mapped.unmapped).toHaveLength(1);
});

it("reports a stale host even when another host has a fresh successful read", async () => {
  const f = await collectorFixture();
  const durham: SchoolBatch = { ...observedBatch(f), host: "durham.elearningontario.ca" };
  await upload(f, durham);
  f.setNow(new Date(f.clock().getTime() + 13 * 60 * 60_000));
  await upload(f, observedBatch(f));
  const status = await repo(f).status();
  expect(status.state).toBe("stale");
  expect(status.hosts.find((host) => host.host === durham.host)?.state).toBe("stale");
  expect(status.hosts.find((host) => host.host !== durham.host)?.state).toBe("current");
  expect((await digest(f)).text).toContain("read stale");
});
