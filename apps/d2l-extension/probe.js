(() => {
  const HOST = "https://ldsb.elearningontario.ca";
  const MATCH = `${HOST}/*`;
  const LABELS = Object.freeze({
    versions: "/d2l/api/versions/",
    enrollments: "/d2l/api/lp/1.43/enrollments/myenrollments/",
    items: "/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=<course>",
    due: "/d2l/api/le/1.82/content/myItems/due/?orgUnitIdsCSV=<course>",
    toc: "/d2l/api/le/1.82/<course>/content/toc",
    folders: "/d2l/api/le/1.82/<course>/dropbox/folders/",
    submissions: "/d2l/api/le/1.82/<course>/dropbox/folders/<folder>/submissions/mysubmissions/",
    grades: "/d2l/api/le/1.82/<course>/grades/values/myGradeValues/",
    overdue: "/d2l/api/le/1.82/overdueItems/myItems?orgUnitIdsCSV=<course>",
  });
  // Response keys can themselves be personal data (for example a gradebook keyed by id).
  // Only these schema words can leave the reader. Unknown keys are counted, never copied.
  const FIELDS = new Set([
    "Objects", "Next", "Items", "PagingInfo", "Bookmark", "HasMoreItems",
    "OrgUnit", "Id", "Type", "Code", "Name", "HomeUrl", "ImageUrl", "Access",
    "IsActive", "CanAccess", "StartDate", "EndDate", "LastAccessed", "ClasslistRoleName", "LISRoles",
    "ProductCode", "LatestVersion", "SupportedVersions", "Version", "IsSupported",
    "Modules", "Topics", "ModuleId", "TopicId", "Title", "Description", "Url",
    "StartDateTime", "EndDateTime", "DueDate", "DueDateTime", "LastModifiedDate",
    "TypeIdentifier", "CompletionType", "Completion", "Unread", "ActivityId", "ToolItemId",
    "CustomInstructions", "Text", "Html", "Attachments", "Assessment", "ScoreDenominator",
    "Rubrics", "DropboxType", "SubmissionType", "Availability", "GradeItemId",
    "TotalUsersWithSubmissions", "TotalFiles", "UnreadFiles", "FlaggedFiles", "TotalUsers",
    "Submissions", "Files", "Feedback", "Status", "Entity", "EntityId", "EntityType",
    "SubmittedBy", "SubmissionDate", "DateSubmitted", "Score", "Grade", "GradeValue",
    "GradeObjectIdentifier", "GradeObjectName", "GradeObjectType", "DisplayedGrade",
    "PointsNumerator", "PointsDenominator", "WeightedNumerator", "WeightedDenominator",
    "Comments", "PrivateComments", "Errors", "Message", "UserId", "OrgUnitId", "ItemId", "ItemName",
  ]);

  function summarize(body) {
    let shape;
    if (Array.isArray(body)) shape = body.length === 0 ? "[]" : `list of ${body.length}`;
    else if (body === null) shape = "null";
    else if (typeof body !== "object") shape = "scalar (redacted)";
    else if (Array.isArray(body.Objects)) shape = `{Objects:[...]} of ${body.Objects.length}`;
    else shape = Object.keys(body).length === 0 ? "{}" : "object";
    const fields = new Map();
    const pending = [body];
    while (pending.length) {
      const value = pending.pop();
      if (Array.isArray(value)) {
        for (const item of value) pending.push(item);
      } else if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          const label = FIELDS.has(key) ? key : "<other field>";
          const counts = fields.get(label) ?? { set: 0, null: 0 };
          counts[child === null ? "null" : "set"] += 1;
          fields.set(label, counts);
          pending.push(child);
        }
      }
    }
    return {
      shape,
      fields: [...fields].sort(([a], [b]) => a.localeCompare(b)).map(([name, counts]) => ({ name, ...counts })),
    };
  }

  function identifier(value) {
    if (!/^[0-9]{1,20}$/.test(String(value))) throw new Error("invalid-identifier");
    return String(value);
  }

  function routeUrl(route, args = {}) {
    if (!Object.hasOwn(LABELS, route)) throw new Error("invalid-route");
    let path = LABELS[route];
    if (path.includes("<course>")) path = path.replace("<course>", identifier(args.course));
    if (path.includes("<folder>")) path = path.replace("<folder>", identifier(args.folder));
    const url = new URL(path, HOST);
    if (route === "enrollments" && args.bookmark !== undefined) url.searchParams.set("bookmark", args.bookmark);
    return url.href;
  }

  async function read(route, args, fetchImpl = globalThis.fetch.bind(globalThis)) {
    const url = routeUrl(route, args);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET", credentials: "include", redirect: "manual", cache: "no-store",
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000),
      });
    } catch {
      return { status: null, error: "network-or-timeout" };
    }
    if (response.status === 0 || response.redirected || (response.status >= 300 && response.status < 400)) {
      return { status: response.status, error: "redirect-blocked" };
    }
    // A sign-in page must not be read or misreported as an empty API response.
    if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get("content-type") ?? "")) {
      return { status: response.status, error: "non-json" };
    }
    try {
      return { status: response.status, body: await response.json() };
    } catch {
      return { status: response.status, error: "invalid-json" };
    }
  }

  const isSuccess = (result) => result.status >= 200 && result.status < 300 && !result.error;

  // This transport/sink boundary is the future collector seam. Probe sinks receive shapes
  // only; signing and a separately authorised push adapter do not exist in this version.
  async function collect(readRoute, publish) {
    async function request(route, args = {}) {
      const result = await readRoute(route, args);
      await publish({ route: LABELS[route], status: result.status,
        ...(result.error ? { shape: result.error, fields: [] } : summarize(result.body)) });
      return result;
    }
    await request("versions");
    const courses = new Set();
    const bookmarks = new Set();
    let bookmark;
    do {
      const result = await request("enrollments", { bookmark });
      if (!isSuccess(result)) return "enrollments-unavailable";
      if (!Array.isArray(result.body?.Items)) return "enrollments-shape-unexpected";
      for (const item of result.body.Items) {
        if (item?.Access?.CanAccess === true) courses.add(identifier(item.OrgUnit?.Id));
      }
      if (result.body.PagingInfo?.HasMoreItems !== true) break;
      bookmark = result.body.PagingInfo.Bookmark;
      if (typeof bookmark !== "string" || bookmark.length === 0 || bookmarks.has(bookmark)) return "enrollments-pagination-stopped";
      bookmarks.add(bookmark);
    } while (true);
    for (const course of courses) {
      for (const route of ["items", "due", "toc", "grades", "overdue"]) await request(route, { course });
      const folders = await request("folders", { course });
      if (!isSuccess(folders)) continue;
      if (!Array.isArray(folders.body)) {
        await publish({ route: LABELS.submissions, status: null, shape: "folders-shape-unexpected", fields: [] });
        continue;
      }
      for (const folder of folders.body) await request("submissions", { course, folder: identifier(folder?.Id) });
    }
    return "finished";
  }

  function format(reports = {}) {
    const lines = ["D2L shape probe v0.1.0", "Field counts aggregate all nested objects; values are withheld."];
    for (const context of ["background", "content"]) {
      const report = reports[context];
      lines.push("", `${context}: ${report?.state ?? "not run"}`);
      for (const row of report?.rows ?? []) {
        lines.push(`${row.route} | HTTP ${row.status ?? "none"} | ${row.shape}`);
        lines.push(row.fields.map((field) => `${field.name}: set ${field.set}, null ${field.null}`).join("; "));
      }
    }
    return lines.join("\n");
  }

  globalThis.D2LProbe = Object.freeze({ HOST, MATCH, LABELS, summarize, routeUrl, read, collect, format });
})();
