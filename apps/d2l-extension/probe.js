(() => {
  const HOSTS = Object.freeze(["https://ldsb.elearningontario.ca", "https://durham.elearningontario.ca"]);
  const LABELS = Object.freeze({
    versions: "/d2l/api/versions/",
    enrollments: "/d2l/api/lp/1.43/enrollments/myenrollments/",
    items: "/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=<course>",
    toc: "/d2l/api/le/1.82/<course>/content/toc",
    folders: "/d2l/api/le/1.82/<course>/dropbox/folders/",
    submissions: "/d2l/api/le/1.82/<course>/dropbox/folders/<folder>/submissions/mysubmissions/",
    grades: "/d2l/api/le/1.82/<course>/grades/values/myGradeValues/",
    news: "/d2l/api/le/1.82/<course>/news/",
    quizzes: "/d2l/api/le/1.82/<course>/quizzes/",
  });
  function identifier(value) {
    if (!/^[0-9]{1,20}$/.test(String(value))) throw new Error("invalid-identifier");
    return String(value);
  }
  function routeUrl(host, route, args = {}) {
    if (!HOSTS.includes(host)) throw new Error("invalid-host");
    if (!Object.hasOwn(LABELS, route)) throw new Error("invalid-route");
    let path = LABELS[route];
    if (path.includes("<course>")) path = path.replace("<course>", identifier(args.course));
    if (path.includes("<folder>")) path = path.replace("<folder>", identifier(args.folder));
    const url = new URL(path, host);
    if (route === "enrollments" && args.bookmark !== undefined) url.searchParams.set("bookmark", args.bookmark);
    return url.href;
  }
  const failed = (status, error) => ({ status, complete: false, body: { collectorFailure: error }, error });
  async function read(host, route, args, fetchImpl = globalThis.fetch.bind(globalThis)) {
    const url = routeUrl(host, route, args);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET", credentials: "include", redirect: "manual", cache: "no-store",
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000),
      });
    } catch { return failed(0, "network-or-timeout"); }
    if (response.status === 0 || response.redirected || (response.status >= 300 && response.status < 400)) {
      return failed(response.status, "session-expired");
    }
    // Login HTML, including HTML 403 responses, is never evidence of an empty course.
    if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get("content-type") ?? "")) {
      return failed(response.status, "session-expired");
    }
    let body;
    try { body = await response.json(); }
    catch { return failed(response.status, "session-expired"); }
    if (response.status === 401) return failed(401, "session-expired");
    // Completeness describes receipt/paging, not permission. A JSON 403 is a
    // fully observed refusal under the receiver contract, never an empty success.
    return { status: response.status, complete: true, body };
  }
  const needsSession = (result) => result.error === "session-expired" || result.status === 403;
  globalThis.D2L = Object.freeze({ HOSTS, LABELS, identifier, routeUrl, read, failed, needsSession });
})();
