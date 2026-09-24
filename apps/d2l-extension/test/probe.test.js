import test from "node:test";
import assert from "node:assert/strict";
import { load, plain, json, enrollment } from "./helpers.js";

const probe = load().D2LProbe;

test("It pins every route to the literal LDSB HTTPS origin.", () => {
  assert.equal(probe.HOST, "https://ldsb.elearningontario.ca");
  for (const route of Object.keys(probe.LABELS)) {
    assert.equal(new URL(probe.routeUrl(route, { course: 1, folder: 2 })).origin,
      "https://ldsb.elearningontario.ca", route);
  }
});

test("It distinguishes empty arrays, empty objects, lists and Objects envelopes.", () => {
  assert.equal(probe.summarize([]).shape, "[]");
  assert.equal(probe.summarize({}).shape, "{}");
  assert.equal(probe.summarize([{}, {}]).shape, "list of 2");
  assert.equal(probe.summarize({ Objects: [], Next: null }).shape, "{Objects:[...]} of 0");
  assert.equal(probe.summarize({ Objects: [{}, {}] }).shape, "{Objects:[...]} of 2");
  assert.equal(probe.summarize(null).shape, "null");
  assert.equal(probe.summarize("SYNTHETIC_PRIVATE_TEXT").shape, "scalar (redacted)");
});

test("It reports nested field presence and nulls without printing values or unknown keys.", () => {
  const body = { Objects: [{ Id: 987654321, Name: "SYNTHETIC_PRIVATE_NAME", DueDate: null,
    EndDate: "SYNTHETIC_PRIVATE_DATE", Grade: 93.123, Modules: [{ Title: "SYNTHETIC_PRIVATE_TITLE", DueDate: null }],
    SYNTHETIC_PRIVATE_KEY: { "987654321": "SYNTHETIC_PRIVATE_VALUE" } }], Next: "SYNTHETIC_PRIVATE_NEXT" };
  const summary = plain(probe.summarize(body));
  assert.deepEqual(summary.fields.find((field) => field.name === "DueDate"), { name: "DueDate", set: 0, null: 2 });
  assert.deepEqual(summary.fields.find((field) => field.name === "EndDate"), { name: "EndDate", set: 1, null: 0 });
  assert.deepEqual(summary.fields.find((field) => field.name === "<other field>"), { name: "<other field>", set: 2, null: 0 });
  assert.doesNotMatch(JSON.stringify(summary), /SYNTHETIC_PRIVATE|987654321|93\.123/);
});

test("It withholds every scalar value even when hostile keys look like report fields.", () => {
  const body = { shape: "SYNTHETIC_PRIVATE_SHAPE", fields: ["SYNTHETIC_PRIVATE_FIELDS"],
    status: 987654321, "__proto__": null, Name: "SYNTHETIC_PRIVATE_NAME",
    Description: { Html: "<script>SYNTHETIC_PRIVATE_HTML</script>", Text: null },
    numeric: 93.123, scalarList: ["SYNTHETIC_PRIVATE_LIST", true, 87654321] };
  assert.doesNotMatch(JSON.stringify(probe.summarize(body)), /SYNTHETIC_PRIVATE|987654321|87654321|93\.123|<script>/);
});

test("It constructs only the fixed host and the student submission route.", () => {
  const url = new URL(probe.routeUrl("submissions", { course: 101, folder: 202, method: "POST", url: "https://invalid.example" }));
  assert.equal(url.origin, probe.HOST);
  assert.equal(url.pathname, "/d2l/api/le/1.82/101/dropbox/folders/202/submissions/mysubmissions/");
  assert.equal(new URL(probe.routeUrl("due", { course: "101" })).searchParams.get("orgUnitIdsCSV"), "101");
});

test("It refuses unknown routes and path injection before calling fetch.", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return json([]); };
  for (const route of ["https://invalid.example", "whoami", "toString", "__proto__"]) {
    await assert.rejects(probe.read(route, {}, fetchImpl), /invalid-route/);
  }
  for (const id of ["../101", "101?x=y", "https://invalid.example", null, {}, -2, 1.5]) {
    await assert.rejects(probe.read("toc", { course: id }, fetchImpl), /invalid-identifier/);
    await assert.rejects(probe.read("submissions", { course: "101", folder: id }, fetchImpl), /invalid-identifier/);
  }
  assert.equal(calls, 0);
});

test("It hard-codes GET and forbids redirect following and request bodies.", async () => {
  let observed;
  const result = await probe.read("versions", { method: "POST", body: "SYNTHETIC_PRIVATE_BODY" }, async (url, init) => {
    observed = { url, init }; return json([]);
  });
  assert.equal(result.status, 200);
  assert.equal(observed.url, `${probe.HOST}/d2l/api/versions/`);
  assert.equal(observed.init.method, "GET");
  assert.equal(observed.init.redirect, "manual");
  assert.equal(observed.init.credentials, "include");
  assert.equal(observed.init.cache, "no-store");
  assert.deepEqual(plain(observed.init.headers), { Accept: "application/json" });
  assert.equal(observed.init.body, undefined);
  assert.ok(observed.init.signal instanceof AbortSignal);
});

test("It binds the default fetch to its global object.", async () => {
  const context = load({ fetch: async function () { assert.equal(this.D2LProbe.HOST, probe.HOST); return json([]); } });
  assert.equal((await context.D2LProbe.read("versions")).status, 200);
});

test("It supplies a fifteen-second abort signal to the fetch transport.", async () => {
  const signal = new AbortController().signal;
  let timeout;
  const context = load({ AbortSignal: { timeout(milliseconds) { timeout = milliseconds; return signal; } } });
  await context.D2LProbe.read("versions", {}, async (_url, init) => {
    assert.equal(init.signal, signal);
    return json([]);
  });
  assert.equal(timeout, 15000);
});

test("It refuses redirected and opaque responses without reading their bodies.", async () => {
  for (const response of [{ status: 302 }, { status: 0 }, { status: 200, redirected: true }]) {
    let reads = 0;
    const result = await probe.read("versions", {}, async () => ({
      ...response, headers: new Headers({ "content-type": "application/json" }),
      async json() { reads += 1; return { Name: "SYNTHETIC_PRIVATE_REDIRECT" }; },
    }));
    assert.equal(result.error, "redirect-blocked");
    assert.equal(reads, 0);
  }
});

test("It refuses HTML and missing content types without reading web pages.", async () => {
  for (const contentType of ["text/html", "text/plain", ""]) {
    let reads = 0;
    const result = await probe.read("versions", {}, async () => ({ status: 200,
      headers: new Headers({ "content-type": contentType }), async json() { reads += 1; return {}; },
    }));
    assert.equal(result.error, "non-json");
    assert.equal(reads, 0);
  }
});

test("It preserves refusal statuses but never copies exception text into results.", async () => {
  const denied = await probe.read("versions", {}, async () => json({ Errors: [{ Message: "SYNTHETIC_PRIVATE_ERROR" }] }, 403));
  assert.equal(denied.status, 403);
  const network = await probe.read("versions", {}, async () => { throw new Error("SYNTHETIC_PRIVATE_NETWORK"); });
  assert.deepEqual(plain(network), { status: null, error: "network-or-timeout" });
  const invalid = await probe.read("versions", {}, async () => new Response("SYNTHETIC_PRIVATE_JSON", {
    headers: { "content-type": "application/json" },
  }));
  assert.deepEqual(plain(invalid), { status: 200, error: "invalid-json" });
});

test("It discovers all accessible enrollment pages and probes every folder through the student route.", async () => {
  const calls = [];
  const rows = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const path = new URL(url).pathname;
    if (path.endsWith("myenrollments/")) return json(new URL(url).searchParams.has("bookmark")
      ? { Items: [enrollment("102", true, 3), enrollment("101")], PagingInfo: { HasMoreItems: false } }
      : { Items: [enrollment("101"), enrollment("103", false)], PagingInfo: { HasMoreItems: true, Bookmark: "opaque&bookmark" } });
    if (path.endsWith("/folders/")) return json([{ Id: "201", DueDate: null }, { Id: "202", Name: "SYNTHETIC_PRIVATE_FOLDER" }]);
    return json({ Objects: [], Next: null });
  };
  assert.equal(await probe.collect((route, args) => probe.read(route, args, fetchImpl), async (row) => rows.push(row)), "finished");
  assert.equal(calls[0].url.pathname, "/d2l/api/versions/");
  assert.equal(calls[1].url.pathname, "/d2l/api/lp/1.43/enrollments/myenrollments/");
  assert.equal(calls[2].url.searchParams.get("bookmark"), "opaque&bookmark");
  assert.equal(calls.length, 19);
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith("mysubmissions/")).length, 4);
  for (const course of ["101", "102"]) {
    for (const suffix of ["content/myItems/", "content/myItems/due/", "overdueItems/myItems"]) {
      assert.ok(calls.some(({ url }) => url.pathname.endsWith(suffix) && url.searchParams.get("orgUnitIdsCSV") === course));
    }
    assert.ok(calls.some(({ url }) => url.pathname === `/d2l/api/le/1.82/${course}/grades/values/myGradeValues/`));
    assert.ok(calls.some(({ url }) => url.pathname === `/d2l/api/le/1.82/${course}/content/toc`));
  }
  assert.ok(calls.every(({ url, init }) => url.origin === probe.HOST && init.method === "GET"));
  assert.ok(calls.every(({ url }) => !url.href.includes("103") && !url.href.includes("whoami")));
  assert.doesNotMatch(probe.format({ background: { state: "finished", rows } }), /SYNTHETIC_PRIVATE|opaque&bookmark|\/101\/|\/102\/|\/201\/|\/202\//);
});

test("It does not treat refused enrollments as a successful discovery.", async () => {
  const calls = [];
  const state = await probe.collect(async (route) => {
    calls.push(route); return { status: 403, body: { Items: [enrollment("101")] } };
  }, async () => {});
  assert.equal(state, "enrollments-unavailable");
  assert.deepEqual(calls, ["versions", "enrollments"]);
});

test("It reports unexpected enrollment shapes instead of claiming there are no courses.", async () => {
  assert.equal(await probe.collect(async () => ({ status: 200, body: {} }), async () => {}), "enrollments-shape-unexpected");
});

test("It stops missing or repeated enrollment bookmarks without following response URLs.", async () => {
  for (const bookmark of [null, "", "same-bookmark"]) {
    let calls = 0;
    const state = await probe.collect(async () => {
      calls += 1;
      assert.ok(calls <= 3, "Pagination must stop before a repeated page is read again.");
      return { status: 200, body: { Items: [], PagingInfo: { HasMoreItems: true, Bookmark: bookmark } } };
    }, async () => {});
    assert.equal(state, "enrollments-pagination-stopped");
    assert.equal(calls, bookmark === "same-bookmark" ? 3 : 2);
  }
});

test("It stops discovery when a transport error accompanies a nominal success status.", async () => {
  const calls = [];
  const state = await probe.collect(async (route) => {
    calls.push(route);
    return { status: 200, error: "invalid-json", body: { Items: [enrollment("101")] } };
  }, async () => {});
  assert.equal(state, "enrollments-unavailable");
  assert.deepEqual(calls, ["versions", "enrollments"]);
});

test("It continues unrelated routes after refusals and does not discover folders from errors.", async () => {
  const calls = [];
  const rows = [];
  await probe.collect(async (route) => {
    calls.push(route);
    if (route === "enrollments") return { status: 200, body: { Items: [enrollment("101"), enrollment("102")] } };
    return { status: 403, body: [{ Id: "201", Message: "SYNTHETIC_PRIVATE_ERROR" }] };
  }, async (row) => rows.push(row));
  assert.equal(calls.filter((route) => route === "folders").length, 2);
  assert.equal(calls.filter((route) => route === "overdue").length, 2);
  assert.equal(calls.includes("submissions"), false);
  assert.doesNotMatch(probe.format({ content: { state: "finished", rows } }), /SYNTHETIC_PRIVATE/);
});

test("It reports unexpected folder shapes as unprobed submissions.", async () => {
  const rows = [];
  await probe.collect(async (route) => ({ status: 200,
    body: route === "enrollments" ? { Items: [enrollment("101")] } : {},
  }), async (row) => rows.push(row));
  assert.ok(rows.some((row) => row.route === probe.LABELS.submissions && row.shape === "folders-shape-unexpected"));
});

test("It displays both contexts and distinguishes an unrun pass from an empty result.", () => {
  const output = probe.format({ background: { state: "finished", rows: [{ route: probe.LABELS.versions,
    status: 200, ...probe.summarize([]) }] } });
  assert.match(output, /background: finished/);
  assert.match(output, /HTTP 200 \| \[\]/);
  assert.match(output, /content: not run/);
});
