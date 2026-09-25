import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInThisContext } from "node:vm";
import { canonical, createKey, publicKeyBase64, sign } from "../protocol.js";
import { collectHost } from "../collector.js";
import { D2L, batch, clock, fixture } from "./fixtures.js";

// Execute the pinned receiver's real parser/mapper against extension output.
// Shared signing source on main differs from dfc284e only by three export keywords.
// SQL is mocked here; this does not assert actual D1 or HTTP integration behavior.
function load(path, names, dependencies = {}) {
  const text = readFileSync(new URL(path, import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
  const js = stripTypeScriptTypes(text, { mode: "transform" }).replace(/^export /gm, "");
  return runInThisContext(`(function(deps) { const { ${Object.keys(dependencies).join(",")} } = deps;\n${js}\nreturn { ${names.join(",")} }; })`)(dependencies);
}
const contracts = load("../../../packages/contracts/src/canonical-json.ts", ["canonicalize", "sha256Hex"]);
const signing = load("../../cloud-gateway/src/sync/signed-request.ts", ["validateRequest", "decodeCanonicalRawBody", "decodeCanonicalBase64", "signatureText"], contracts);
const types = load("../../cloud-gateway/src/deadlines/deadline-types.ts", ["requireText", "requireInstant"]);
const receiver = load("./receiver/collector-protocol.ts.txt", ["parseSchoolBatch", "verifyCollectorRequest", "exact", "record"], { ...contracts, ...signing, ...types });
const mapping = load("./receiver/collector-mapping.ts.txt", ["mapSchoolCourse"], { record: receiver.record });

test("It passes extension bytes and signatures through the pinned receiver verifier and batch parser.", async () => {
  const keys = await createKey();
  const identity = { collectorId: "synthetic-collector", principalId: "synthetic-owner" };
  const key = { collector_id: identity.collectorId, principal_id: identity.principalId,
    public_key_base64: await publicKeyBase64(keys), status: "active" };
  const database = { prepare(sql) { return { bind(...args) { return { async first() {
    if (sql.startsWith("SELECT")) { assert.equal(args[0], identity.collectorId); assert.equal(args[1], identity.principalId); return key; }
    assert.match(sql, /^INSERT INTO school_collector_nonces/); return { collector_id: identity.collectorId };
  } }; } }; } };
  const value = batch();
  const body = canonical(value);
  assert.equal(body, new TextDecoder().decode(contracts.canonicalize(value)));
  const header = await sign("/school/observations", body, keys, identity, clock());
  const verified = await receiver.verifyCollectorRequest(database, identity.principalId, header, "/school/observations", new TextEncoder().encode(body), new Date(clock()), "active");
  assert.deepEqual(receiver.parseSchoolBatch(verified.body, new Date(clock())), value);
  await assert.rejects(receiver.verifyCollectorRequest(database, identity.principalId, header, "/school/pairing/prove", new TextEncoder().encode(body), new Date(clock()), "active"), /school_signature_invalid/);
  await assert.rejects(receiver.verifyCollectorRequest(database, identity.principalId, header, "/school/observations", new TextEncoder().encode(body + " "), new Date(clock()), "active"), /school_body_hash_invalid/);
  receiver.exact({ publicKeyBase64: key.public_key_base64, deviceLabel: "Synthetic" }, ["publicKeyBase64", "deviceLabel"]);
  receiver.exact({ challenge: "synthetic" }, ["challenge"]); receiver.exact({}, []);
});
test("It proves the refreshed receiver accepts Durham, news and quizzes and still refuses unknown sources and shapes.", () => {
  const value = batch();
  value.routes.find((route) => route.route.endsWith("content/toc")).body = { Modules: [] };
  for (const route of value.routes) { route.status = 403; route.complete = true; route.body = { Errors: [] }; }
  assert.deepEqual(mapping.mapSchoolCourse(receiver.parseSchoolBatch(value, new Date(clock()))).failures, []);
  // #175 (c66c38709a9774e32546bfd7cbd7766995278a71) added the second host and the
  // news/quizzes routes to this parser, and stopped treating storable unknown JSON
  // as a failed read. All three assertions below therefore flipped from rejection.
  const durham = { ...value, host: "durham.elearningontario.ca" };
  assert.deepEqual(receiver.parseSchoolBatch(durham, new Date(clock())).host, "durham.elearningontario.ca");
  for (const suffix of ["news/", "quizzes/"]) {
    const tool = { ...value, routes: [...value.routes, { ...value.routes[0], route: `/d2l/api/le/1.82/1/${suffix}` }] };
    assert.deepEqual(mapping.mapSchoolCourse(receiver.parseSchoolBatch(tool, new Date(clock()))).failures, []);
  }
  // Quizzes may carry a query string; news may not, and this proves both halves.
  const queried = { ...value, routes: [...value.routes, { ...value.routes[0], route: "/d2l/api/le/1.82/1/quizzes/?orgUnitIdsCSV=1" }] };
  receiver.parseSchoolBatch(queried, new Date(clock()));
  const queriedNews = { ...value, routes: [...value.routes, { ...value.routes[0], route: "/d2l/api/le/1.82/1/news/?x=1" }] };
  assert.throws(() => receiver.parseSchoolBatch(queriedNews, new Date(clock())), /school_route_invalid/);
  const items = structuredClone(value);
  Object.assign(items.routes[0], { status: 200, body: { Items: [], Next: null } });
  assert.deepEqual(mapping.mapSchoolCourse(receiver.parseSchoolBatch(items, new Date(clock()))).failures, []);
  const submissions = structuredClone(value);
  Object.assign(submissions.routes[2], { status: 200, body: [{ Id: 2, Name: "Synthetic", DueDate: null }] });
  submissions.routes.push({ ...value.routes[0], route: "/d2l/api/le/1.82/1/dropbox/folders/2/submissions/mysubmissions/", status: 200, body: [] });
  assert.deepEqual(mapping.mapSchoolCourse(receiver.parseSchoolBatch(submissions, new Date(clock()))).failures, []);
  const wrongHost = { ...value, host: "other.invalid" };
  assert.throws(() => receiver.parseSchoolBatch(wrongHost, new Date(clock())), /school_source_invalid/);
  const wrongTool = { ...value, routes: [...value.routes, { ...value.routes[0], route: "/d2l/api/le/1.82/1/assignments/" }] };
  assert.throws(() => receiver.parseSchoolBatch(wrongTool, new Date(clock())), /school_route_invalid/);
  const wrongSubmission = { ...value, routes: [...value.routes, { ...value.routes[0], route: "/d2l/api/le/1.82/1/dropbox/folders/2/submissions/" }] };
  assert.throws(() => receiver.parseSchoolBatch(wrongSubmission, new Date(clock())), /school_route_invalid/);
  const emptyManifest = { ...value, courseIds: [] };
  assert.throws(() => receiver.parseSchoolBatch(emptyManifest, new Date(clock())), /school_manifest_invalid/);
});
test("It feeds real collectHost output for both boards through the pinned receiver parser and mapper.", async () => {
  const folders = [{ Id: 2, Name: "Synthetic folder A", DueDate: null }, { Id: 3, Name: "Synthetic folder B", DueDate: null }];
  for (const host of D2L.HOSTS) {
    const good = fixture();
    const request = good.request;
    await collectHost({ ...good, host, request: async (h, route, args) => (route === "folders" ? { status: 200, complete: true, body: folders } : request(h, route, args)) });
    assert.equal(good.batches.length, 1);
    const read = good.batches[0];
    assert.equal(read.host, new URL(host).hostname);
    assert.equal(read.routes.filter((entry) => entry.route.endsWith("/submissions/mysubmissions/")).length, 2);
    for (const tool of ["news/", "quizzes/"]) assert.ok(read.routes.some((entry) => entry.route.endsWith(`/${tool}`)), tool);
    assert.deepEqual(receiver.parseSchoolBatch(read, new Date(clock())), read);
    assert.deepEqual(mapping.mapSchoolCourse(receiver.parseSchoolBatch(read, new Date(clock()))).failures, []);

    const lost = fixture();
    await lost.store.set(`courses:${host}`, [{ id: "1", name: "Synthetic course" }]);
    await collectHost({ ...lost, host, request: async () => ({ status: 200, complete: true, body: [] }) });
    assert.equal(lost.batches.length, 1);
    assert.equal(lost.batches[0].enrollmentComplete, false);
    assert.deepEqual(receiver.parseSchoolBatch(lost.batches[0], new Date(clock())), lost.batches[0]);
    assert.ok(mapping.mapSchoolCourse(receiver.parseSchoolBatch(lost.batches[0], new Date(clock()))).failures.length > 0);
  }
});
