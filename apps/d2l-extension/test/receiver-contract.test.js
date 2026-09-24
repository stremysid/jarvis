import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInThisContext } from "node:vm";
import { canonical, createKey, publicKeyBase64, sign, uploadBlock } from "../protocol.js";
import { batch, clock } from "./fixtures.js";

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
  assert.equal(uploadBlock(value), null);
  await assert.rejects(receiver.verifyCollectorRequest(database, identity.principalId, header, "/school/pairing/prove", new TextEncoder().encode(body), new Date(clock()), "active"), /school_signature_invalid/);
  await assert.rejects(receiver.verifyCollectorRequest(database, identity.principalId, header, "/school/observations", new TextEncoder().encode(body + " "), new Date(clock()), "active"), /school_body_hash_invalid/);
  receiver.exact({ publicKeyBase64: key.public_key_base64, deviceLabel: "Synthetic" }, ["publicKeyBase64", "deviceLabel"]);
  receiver.exact({ challenge: "synthetic" }, ["challenge"]); receiver.exact({}, []);
});
test("It proves the receiver accepts complete refusals and still rejects the new hosts, tools, and observed shapes.", () => {
  const value = batch();
  value.routes.find((route) => route.route.endsWith("content/toc")).body = { Modules: [] };
  for (const route of value.routes) { route.status = 403; route.complete = true; route.body = { Errors: [] }; }
  assert.deepEqual(mapping.mapSchoolCourse(receiver.parseSchoolBatch(value, new Date(clock()))).failures, []);
  const durham = { ...value, host: "durham.elearningontario.ca" };
  assert.throws(() => receiver.parseSchoolBatch(durham, new Date(clock())), /school_source_invalid/);
  assert.equal(uploadBlock(durham), "receiver-contract-host-unsupported");
  for (const suffix of ["news/", "quizzes/"]) {
    const tool = { ...value, routes: [...value.routes, { ...value.routes[0], route: `/d2l/api/le/1.82/1/${suffix}` }] };
    assert.throws(() => receiver.parseSchoolBatch(tool, new Date(clock())), /school_route_invalid/);
    assert.equal(uploadBlock(tool), "receiver-contract-route-unsupported");
  }
  const items = structuredClone(value);
  Object.assign(items.routes[0], { status: 200, body: { Objects: [], Next: null } });
  assert.deepEqual(mapping.mapSchoolCourse(items).failures, ["unsupported_or_invalid_route_shape"]);
  const submissions = structuredClone(value);
  Object.assign(submissions.routes[2], { status: 200, body: [{ Id: 2, Name: "Synthetic", DueDate: null }] });
  submissions.routes.push({ ...value.routes[0], route: "/d2l/api/le/1.82/1/dropbox/folders/2/submissions/mysubmissions/", status: 200, body: [] });
  assert.deepEqual(mapping.mapSchoolCourse(submissions).failures, ["unsupported_or_invalid_route_shape"]);
  const emptyManifest = { ...value, courseIds: [] };
  assert.throws(() => receiver.parseSchoolBatch(emptyManifest, new Date(clock())), /school_manifest_invalid/);
});
