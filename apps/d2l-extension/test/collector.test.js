import test from "node:test";
import assert from "node:assert/strict";
import { collectHost, offering, supported } from "../collector.js";
import { sessions, validateHop } from "../sessions.js";
import { D2L, clock, good, json, versions, course, page, fixture, fakeApi } from "./fixtures.js";

test("It pins both literal D2L origins and every generated route to their allowlist.", () => {
  assert.deepEqual(D2L.HOSTS, ["https://ldsb.elearningontario.ca", "https://durham.elearningontario.ca"]);
  for (const host of D2L.HOSTS) for (const route of Object.keys(D2L.LABELS)) {
    assert.equal(new URL(D2L.routeUrl(host, route, { course: 1, folder: 2 })).origin, host);
  }
  for (const host of ["https://other.invalid", "http://ldsb.elearningontario.ca", `${D2L.HOSTS[0]}.evil.invalid`]) assert.throws(() => D2L.routeUrl(host, "versions"));
  assert.throws(() => D2L.routeUrl(D2L.HOSTS[0], "constructor"), /invalid-route/);
  for (const id of ["../1", "1?x=2", "", "1/", "1".repeat(21)]) assert.throws(() => D2L.routeUrl(D2L.HOSTS[0], "submissions", { course: id, folder: 2 }));
  assert.match(D2L.routeUrl(D2L.HOSTS[0], "submissions", { course: 1, folder: 2 }), /\/submissions\/mysubmissions\/$/);
  assert.match(D2L.routeUrl(D2L.HOSTS[0], "items", { course: 1 }), /orgUnitIdsCSV=1$/);
  assert.equal(new URL(D2L.routeUrl(D2L.HOSTS[0], "enrollments", { bookmark: "a&b" })).searchParams.get("bookmark"), "a&b");
});
test("It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON.", async () => {
  let options;
  const ok = await D2L.read(D2L.HOSTS[0], "versions", { method: "POST" }, async (_, init) => { options = init; return json([]); });
  assert.equal(ok.complete, true);
  assert.equal(options.method, "GET"); assert.equal(options.credentials, "include");
  assert.equal(options.redirect, "manual"); assert.equal(options.cache, "no-store");
  for (const response of [
    new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
    new Response("[]", { headers: { "content-type": "text/html" } }),
    new Response("bad", { headers: { "content-type": "application/json" } }),
    json([], 401), { status: 302, redirected: false }, { status: 0 }, { status: 200, redirected: true },
  ]) {
    const result = await D2L.read(D2L.HOSTS[1], "grades", { course: 1 }, async () => response);
    assert.equal(result.complete, false); assert.equal(result.body.collectorFailure, "session-expired");
  }
  assert.equal((await D2L.read(D2L.HOSTS[0], "versions", {}, async () => { throw Error(); })).error, "network-or-timeout");
  const refusal = await D2L.read(D2L.HOSTS[0], "submissions", { course: 1, folder: 2 }, async () => json({ Errors: [] }, 403));
  assert.equal(refusal.status, 403); assert.equal(refusal.complete, true); assert.deepEqual(refusal.body, { Errors: [] });
});
test("It reads active accessible course offerings without judging their names.", () => {
  assert.equal(offering(course()), true);
  const orientation = course(); orientation.OrgUnit.Name = "DCE D2L BrightSpace Orientation";
  assert.equal(offering(orientation), true);
  for (const change of [
    (c) => { c.Access.CanAccess = false; }, (c) => { c.Access.IsActive = false; },
    (c) => { c.OrgUnit.Type.Id = 4; },
  ]) { const value = course(); change(value); assert.equal(offering(value), false); }
});
test("It requires both observed API versions and pushes version loss as failed course evidence.", async () => {
  assert.equal(supported(versions), true);
  for (const value of [[], versions.slice(0, 1), versions.slice(1), [{ ProductCode: "lp", SupportedVersions: ["1.42"] }, versions[1]]]) assert.equal(supported(value), false);
  const f = fixture();
  await f.store.set(`courses:${f.host}`, [{ id: "1", name: "Synthetic course" }]);
  const result = await collectHost({ ...f, request: async () => good([]) });
  assert.equal(result.error, "required-api-version-unavailable");
  assert.equal(f.batches[0].enrollmentComplete, false);
  assert.ok(f.batches[0].routes.every((route) => !route.complete && route.body.collectorFailure === result.error));
});
test("It follows enrollment bookmarks and reads every required tool for each unique course.", async () => {
  const f = fixture();
  await collectHost({ ...f, request: async (host, route, args) => {
    if (route === "enrollments") { f.calls.push({ route, args }); return good(args.bookmark ? page([course(1), course(2)]) : page([course(1)], true, "next&1")); }
    return f.request(host, route, args);
  } });
  assert.equal(f.calls.filter((call) => call.route === "versions").length, 1);
  assert.equal(f.calls.filter((call) => call.route === "enrollments")[1].args.bookmark, "next&1");
  assert.equal(f.batches.length, 2);
  assert.deepEqual(f.batches[0].courseIds, ["1", "2"]);
  assert.equal(f.batches[0].host, "ldsb.elearningontario.ca");
  assert.ok(f.batches.every((b) => b.routes.length === 6 && b.routes.some((r) => r.route.endsWith("/news/")) && b.routes.some((r) => r.route.endsWith("/quizzes/"))));
});
test("It stops repeated or missing bookmarks without claiming complete enrollments.", async () => {
  for (const bookmark of ["again", "", null]) {
    const f = fixture();
    let count = 0;
    const result = await collectHost({ ...f, request: async (host, route, args) => {
      assert.ok(++count < 15, "Broken pagination must fail by name instead of timing out the mutation runner.");
      return route === "enrollments" ? good(page([course()], true, bookmark)) : f.request(host, route, args);
    } });
    assert.equal(result.error, "enrollments-pagination-stopped");
    assert.equal(f.batches[0].enrollmentComplete, false);
  }
});
test("It refuses malformed enrollment manifests and never invents a course after a first-run login failure.", async () => {
  for (const body of [{}, page([{ ...course(), OrgUnit: { ...course().OrgUnit, Id: "bad/path" } }]), page([{ ...course(), OrgUnit: { ...course().OrgUnit, Name: "" } }])]) {
    const f = fixture();
    const result = await collectHost({ ...f, request: async (host, route, args) => route === "enrollments" ? good(body) : f.request(host, route, args) });
    assert.equal(result.error, "enrollments-shape-unexpected");
    assert.equal(result.lastGoodRead, null);
  }
  const f = fixture();
  const result = await collectHost({ ...f, request: async () => D2L.failed(200, "session-expired") });
  assert.equal(result.error, "session-expired"); assert.equal(f.batches.length, 0);
});
test("It preserves null dates and submission refusals while continuing through optional tools.", async () => {
  const f = fixture();
  const result = await collectHost({ ...f, request: async (host, route, args) => {
    if (route === "folders") return good([{ Id: 11, DueDate: null }, { Id: 12, DueDate: "2026-09-25T20:00:00Z" }]);
    if (route === "submissions") return args.folder === 11 ? { status: 403, complete: true, body: { Errors: [] } } : good([]);
    if (route === "news") return { status: 404, complete: true, body: {} };
    return f.request(host, route, args);
  } });
  assert.equal(f.batches[0].routes.length, 8);
  assert.deepEqual(f.batches[0].routes.find((r) => r.route.endsWith("/folders/")).body[0], { Id: 11, DueDate: null });
  assert.equal(f.batches[0].routes.find((r) => r.route.includes("/11/submissions/")).status, 403);
  assert.equal(result.courses[0].refused, 2); assert.equal(result.courses[0].read, 6);
  assert.equal(result.lastGoodRead, null);
  assert.doesNotMatch(JSON.stringify(result), /DueDate|2026-09-25|unsubmitted|not.due/);
});
test("It keeps cached folder IDs without relabeling a failed listing as fresh evidence.", async () => {
  const f = fixture();
  await f.store.set(`folders:${f.host}:1`, [{ Id: 2, DueDate: null }]);
  await collectHost({ ...f, request: async (host, route, args) => route === "folders" ? { status: 403, complete: true, body: {} } : f.request(host, route, args) });
  assert.ok(f.calls.some((call) => call.route === "submissions" && call.args.folder === 2));
  const refusal = f.batches[0].routes.find((r) => r.route.endsWith("/folders/"));
  assert.equal(refusal.status, 403); assert.equal(refusal.complete, true); assert.deepEqual(refusal.body, {});
  assert.equal((await f.store.get(`folders:${f.host}:1`))[0].Id, 2);
});
test("It refuses malformed folder listings and retains valid folder evidence in the cache.", async () => {
  for (const body of [{}, [{ Id: "../invalid" }], [{ Id: 2 }]]) {
    const f = fixture();
    await collectHost({ ...f, request: async (host, route, args) => route === "folders" ? good(body) : f.request(host, route, args) });
    const evidence = f.batches[0].routes.find((r) => r.route.endsWith("/folders/"));
    assert.equal(evidence.complete, Array.isArray(body) && body[0].Id === 2);
    if (evidence.complete) assert.deepEqual(await f.store.get(`folders:${f.host}:1`), body);
  }
});
test("It bounds the enrollment manifest and labels Durham batches with their own host.", async () => {
  const f = fixture();
  const huge = await collectHost({ ...f, request: async (host, route, args) => route === "enrollments" ? good(page(Array.from({ length: 129 }, (_, i) => course(i + 1)))) : f.request(host, route, args) });
  assert.equal(huge.error, "course-manifest-too-large"); assert.equal(f.batches.length, 0);
  const result = await collectHost({ ...f, host: D2L.HOSTS[1] });
  assert.equal(f.batches[0].host, "durham.elearningontario.ca"); assert.equal(result.lastGoodRead, clock());
});
test("It spaces actual requests by one second and leaves the background test free of fallback tabs.", async () => {
  const f = fakeApi(); let now = 0; const times = [];
  const session = sessions({ ...f, now: () => now, sleep: async (ms) => { now += ms; }, fetchImpl: async () => { times.push(now); return json({}, 403); } });
  await session.request(D2L.HOSTS[0], "enrollments", {}, true);
  await session.request(D2L.HOSTS[1], "enrollments", {}, true);
  assert.deepEqual(times, [0, 1000]); assert.equal(f.events.length, 0);
});
test("It falls back to an isolated LDSB tab and closes only tabs it created.", async () => {
  for (const existing of [false, true]) {
    const f = fakeApi();
    if (existing) f.api.tabs.query = async () => [{ id: 7 }];
    const session = sessions({ ...f, sleep: async () => {}, fetchImpl: async () => json({}, 401) });
    assert.equal((await session.request(D2L.HOSTS[0], "enrollments")).complete, true);
    assert.equal(f.events.filter(([type]) => type === "remove").length, existing ? 0 : 1);
    const message = f.events.find(([type]) => type === "message");
    assert.deepEqual(message[3], { frameId: 0 }); assert.equal(message[2].host, D2L.HOSTS[0]);
  }
});
test("It renews Durham only after LDSB is live and retries once through the stored hop.", async () => {
  const f = fakeApi(); const requests = [];
  const hop = `${D2L.HOSTS[0]}/synthetic-federation`;
  const session = sessions({ ...f, hop, sleep: async () => {}, fetchImpl: async (url) => { requests.push(url); return url.startsWith(D2L.HOSTS[0]) ? json(page()) : json({}, 403); } });
  const result = await session.request(D2L.HOSTS[1], "enrollments");
  assert.equal(result.complete, true);
  assert.equal(requests.length, 3); assert.ok(requests[1].startsWith(D2L.HOSTS[0]));
  assert.deepEqual(f.events.find(([type]) => type === "create")[1], { url: hop, active: false });
  await session.request(D2L.HOSTS[1], "grades", { course: 1 });
  assert.equal(f.events.filter(([type]) => type === "create").length, 1);
});
test("It reports failed federation and never attempts Durham login without a live LDSB session.", async () => {
  for (const mode of ["ldsb", "hop", "durham"]) {
    const f = fakeApi();
    f.api.tabs.sendMessage = async () => D2L.failed(401, "session-expired");
    const session = sessions({ ...f, hop: mode === "hop" ? "" : `${D2L.HOSTS[0]}/synthetic-hop`, sleep: async () => {},
      fetchImpl: async (url) => url.startsWith(D2L.HOSTS[0]) && mode !== "ldsb" ? json(page()) : json({}, 401) });
    const result = await session.request(D2L.HOSTS[1], "enrollments");
    assert.equal(result.error, { ldsb: "ldsb-session-required", hop: "durham-hop-required", durham: "durham-session-renewal-failed" }[mode]);
    assert.ok(f.events.filter(([type]) => type === "create").every(([, options]) => options.url.startsWith(D2L.HOSTS[0])));
  }
});
test("It rejects hop URLs outside the two approved origins and URLs with credentials.", () => {
  assert.equal(validateHop(""), "");
  assert.equal(validateHop(`${D2L.HOSTS[1]}/d2l/home/1`), `${D2L.HOSTS[1]}/d2l/home/1`);
  for (const value of ["https://evil.invalid", "javascript:1", "https://user@ldsb.elearningontario.ca/hop", "http://durham.elearningontario.ca"]) assert.throws(() => validateHop(value));
});
test("It reads a course with refused LDSB quizzes without opening a fallback tab.", async () => {
  const f = fakeApi(); const collected = fixture();
  const session = sessions({ ...f, sleep: async () => {}, fetchImpl: async (url) =>
    url.endsWith("/quizzes/") ? json({ Errors: [] }, 403) : json(url.endsWith("/versions/") ? versions
      : url.includes("myenrollments") ? page() : []) });
  const summary = await collectHost({ ...collected, request: session.request });
  assert.equal(f.events.filter(([type]) => type === "create").length, 0);
  assert.equal(summary.courses[0].refused, 1);
  assert.equal(summary.courses[0].read, 5);
  const quiz = collected.batches[0].routes.find((route) => route.route.endsWith("/quizzes/"));
  assert.deepEqual(quiz.body, { Errors: [] }); assert.equal(quiz.complete, true); assert.equal(quiz.status, 403);
});
test("It marks an unfinished tool page incomplete instead of claiming the first page is everything.", async () => {
  for (const body of [{ Objects: [], Next: "untrusted-next-url" }, { Items: [], PagingInfo: { HasMoreItems: true } }]) {
    const f = fixture();
    const result = await collectHost({ ...f, request: async (host, route, args) => route === "items" ? good(body) : f.request(host, route, args) });
    assert.equal(f.batches[0].routes[0].complete, false); assert.deepEqual(f.batches[0].routes[0].body, body);
    assert.equal(result.courses[0].error, "tool-pagination-incomplete"); assert.equal(result.lastGoodRead, null);
  }
});
test("It records failed tab creation and bounds retries when the content listener never arrives.", async () => {
  const f = fakeApi(); let sends = 0;
  f.api.tabs.sendMessage = async () => { sends += 1; throw Error("Synthetic listener unavailable"); };
  const make = () => sessions({ ...f, sleep: async () => {}, fetchImpl: async () => json({}, 401) });
  assert.equal((await make().request(D2L.HOSTS[0], "enrollments")).error, "session-expired");
  assert.equal(sends, 15);
  assert.equal(f.events.filter(([type]) => type === "remove").length, 1);
  f.api.tabs.create = async () => { throw Error("Synthetic tab unavailable"); };
  assert.equal((await make().request(D2L.HOSTS[0], "enrollments")).error, "in-tab-unavailable");
});
test("It records complete tool refusals normally while refusing enrollment and version failures.", async () => {
  const f = fixture();
  const result = await collectHost({ ...f, request: async (host, route, args) => ["folders", "grades", "toc"].includes(route)
    ? { status: 403, complete: true, body: { Errors: [] } } : f.request(host, route, args) });
  assert.equal(result.lastGoodRead, clock()); assert.equal(result.courses[0].refused, 3); assert.equal(result.courses[0].read, 3);
  for (const refusedRoute of ["versions", "enrollments"]) {
    const g = fixture();
    const summary = await collectHost({ ...g, request: async (host, route, args) => route === refusedRoute
      ? { status: 403, complete: true, body: route === "versions" ? versions : page() } : g.request(host, route, args) });
    assert.equal(summary.error, `${refusedRoute}-refused`); assert.equal(summary.lastGoodRead, null);
  }
});
test("It retains a complete Durham tool refusal after the single renewal attempt.", async () => {
  const f = fakeApi();
  f.api.tabs.sendMessage = async () => ({ status: 403, complete: true, body: { Errors: [] } });
  const session = sessions({ ...f, hop: `${D2L.HOSTS[0]}/synthetic-hop`, sleep: async () => {},
    fetchImpl: async (url) => url.startsWith(D2L.HOSTS[0]) ? json(page()) : json({ Errors: [] }, 403) });
  const result = await session.request(D2L.HOSTS[1], "grades", { course: 1 });
  assert.deepEqual(result, { status: 403, complete: true, body: { Errors: [] } });
});
