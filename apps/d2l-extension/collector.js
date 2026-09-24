import "./probe.js";
const { HOSTS, routeUrl, identifier, failed } = globalThis.D2L;
const ROUTES = ["items", "toc", "folders", "grades", "news", "quizzes"];
const pathFor = (host, route, args) => routeUrl(host, route, args).slice(host.length);

export function supported(body) {
  return Array.isArray(body) && [["lp", "1.43"], ["le", "1.82"]].every(([product, version]) =>
    body.some((item) => item.ProductCode === product && Array.isArray(item.SupportedVersions) && item.SupportedVersions.includes(version)));
}
export function offering(item) {
  return item?.Access?.CanAccess === true && item.Access.IsActive === true
    && item.OrgUnit?.Type?.Id === 3 && item.OrgUnit.Name !== "DCE D2L BrightSpace Orientation";
}
export async function collectHost({ host, request, store, emit, clock, readId }) {
  const startedAt = clock();
  const known = await store.get(`courses:${host}`) ?? [];
  const courses = new Map();
  const bookmarks = new Set();
  let error;
  let bookmark;
  const versions = await request(host, "versions");
  if (!versions.complete) error = versions.error ?? "versions-refused";
  else if (!supported(versions.body)) error = "required-api-version-unavailable";
  while (!error) {
    const page = await request(host, "enrollments", { bookmark });
    if (!page.complete) { error = page.error ?? "enrollments-refused"; break; }
    if (!Array.isArray(page.body?.Items) || typeof page.body.PagingInfo?.HasMoreItems !== "boolean") {
      error = "enrollments-shape-unexpected"; break;
    }
    for (const item of page.body.Items.filter(offering)) {
      try {
        const id = identifier(item.OrgUnit.Id);
        if (typeof item.OrgUnit.Name !== "string" || !item.OrgUnit.Name.trim() || item.OrgUnit.Name.length > 512) throw new Error();
        courses.set(id, { id, name: item.OrgUnit.Name });
      } catch { error = "enrollments-shape-unexpected"; }
    }
    if (!page.body.PagingInfo.HasMoreItems) break;
    bookmark = page.body.PagingInfo.Bookmark;
    if (typeof bookmark !== "string" || !bookmark || bookmarks.has(bookmark)) { error = "enrollments-pagination-stopped"; break; }
    bookmarks.add(bookmark);
  }
  if (error) for (const course of known) courses.set(course.id, course);
  const manifest = [...courses.values()];
  if (manifest.length > 128) return { host, error: "course-manifest-too-large", courses: [], lastGoodRead: null };
  if (!error) await store.set(`courses:${host}`, manifest);
  const summaries = [];
  for (const course of manifest) {
    const routes = [];
    const routeErrors = [];
    const readRoute = async (route, args = { course: course.id }) => {
      let result = error ? failed(0, error) : await request(host, route, args);
      if (result.complete && (result.body?.Next != null || result.body?.PagingInfo?.HasMoreItems === true)) {
        result = { ...result, complete: false, error: "tool-pagination-incomplete" };
      }
      // Cache folder IDs for retrying submissions; a failed current listing stays a failure.
      if (route === "folders" && result.complete && !Array.isArray(result.body)) result = failed(result.status, "folders-shape-unexpected");
      routeErrors.push(result.error);
      routes.push({ route: pathFor(host, route, args), status: result.status,
        fetchedAt: clock(), complete: result.complete, body: result.body });
      return result;
    };
    let folders;
    for (const route of ROUTES) {
      const result = await readRoute(route);
      if (route === "folders") folders = result;
    }
    if (!error) {
      const key = `folders:${host}:${course.id}`;
      if (folders.complete) await store.set(key, folders.body);
      const list = folders.complete ? folders.body : await store.get(key) ?? [];
      for (const folder of list) {
        try { identifier(folder.Id); }
        catch { routes.find((entry) => entry.route === pathFor(host, "folders", { course: course.id })).complete = false; continue; }
        await readRoute("submissions", { course: course.id, folder: folder.Id });
      }
    }
    const batch = { schemaVersion: "1.0", host: new URL(host).hostname, readId, startedAt,
      courseIds: manifest.map((entry) => entry.id), enrollmentComplete: !error, course, routes };
    const queued = await emit(batch);
    summaries.push({ name: course.name, refused: routes.filter((entry) => !entry.complete).length,
      read: routes.filter((entry) => entry.complete).length,
      error: queued.error ?? error ?? routeErrors.find(Boolean) ?? null });
  }
  return { host, error: error ?? null, courses: summaries,
    lastGoodRead: !error && summaries.every((course) => course.refused === 0 && !course.error) ? clock() : null };
}
export { HOSTS, ROUTES };
