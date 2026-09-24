import type { JsonValue } from "../../../../packages/contracts/src/index.js";
import type { RawDeadlineItem } from "../deadlines/deadline-types.js";
import { type SchoolBatch, type RouteEvidence, record } from "./collector-protocol.js";

export interface SchoolItem {
  readonly id: string;
  readonly title: string;
  readonly dueAt: string | null;
  readonly dateSource: "content/myItems" | "assignment DueDate" | "quiz DueDate" | "availability end" | null;
  readonly dateRoute: string | null;
  readonly submission: "positive submission status" | "unknown";
}

export interface MappedCourse {
  readonly items: readonly SchoolItem[];
  readonly deadlines: readonly RawDeadlineItem[];
  readonly failures: readonly string[];
  readonly unmapped: readonly string[];
}

export function evidenceShape(body: JsonValue): string {
  if (Array.isArray(body)) return `array(${body.length})`;
  if (body !== null && typeof body === "object") return `object(${Object.keys(body).sort().join(",")})`;
  return body === null ? "null" : typeof body;
}

function id(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value)) return value;
  throw new Error("resource_id_invalid");
}

function title(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("resource_title_invalid");
  return value;
}

function date(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error("resource_date_invalid");
  return new Date(value).toISOString();
}

function list(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("resource_list_invalid");
  return value.map(record);
}

export function sessionExpired(row: RouteEvidence): boolean {
  return row.status === 401 || row.status >= 300 && row.status < 400 || typeof row.body === "string"
    || row.body !== null && typeof row.body === "object" && !Array.isArray(row.body) && row.body.collectorFailure === "session-expired";
}

/** Shape knowledge limits projection, never the evidence Jarvis is allowed to read. */
export function mapSchoolCourse(batch: SchoolBatch): MappedCourse {
  const prefix = `/d2l/api/le/1.82/${batch.course.id}/`;
  const failures: string[] = [];
  const items: SchoolItem[] = [];
  const unmapped: string[] = [];
  const routes = new Map(batch.routes.map((row) => [row.route, row]));
  for (const row of batch.routes) {
    // Teachers disable individual tools. A complete refusal is evidence, not a broken read.
    if (sessionExpired(row)) failures.push(`${row.route}:session_expired`);
    else if (![200, 403, 404].includes(row.status) || !row.complete) failures.push(`${row.route}:${row.status}:${row.complete ? "http" : "incomplete"}`);
  }
  const attempt = (route: RouteEvidence, action: () => void): void => {
    try { action(); } catch { unmapped.push(`${route.route}:${evidenceShape(route.body)}:projection_unknown`); }
  };
  const routeKey = (path: string): string => new URL(path, `https://${batch.host}`).href;
  const pages = new Map(batch.routes.map((row) => [routeKey(row.route), row]));
  const rows = (route: RouteEvidence): readonly Record<string, unknown>[] => {
    if (Array.isArray(route.body)) return list(route.body);
    const envelope = record(route.body);
    // A Next link describes coverage. We never fetch it or mistake one page for the whole tool.
    const seen = new Set<string>([routeKey(route.route)]);
    let next = envelope.Next;
    while (next !== null && next !== undefined) {
      if (typeof next !== "string") { failures.push(`${route.route}:paging_incomplete`); break; }
      const key = routeKey(next);
      const page = pages.get(key);
      if (seen.has(key) || page?.status !== 200) { failures.push(`${route.route}:paging_incomplete`); break; }
      seen.add(key);
      next = record(page.body).Next;
    }
    if (envelope.PagingInfo !== undefined && record(envelope.PagingInfo).HasMoreItems === true) failures.push(`${route.route}:paging_incomplete`);
    return list(envelope.Objects);
  };
  const required = (route: string): RouteEvidence | null => {
    const result = routes.get(prefix + route);
    if (result === undefined) failures.push(`${prefix}${route}:not_read`);
    return result?.status === 200 && result.complete ? result : null;
  };
  const folders = required("dropbox/folders/");
  const toc = required("content/toc");
  required("grades/values/myGradeValues/");
  const myItems = batch.routes.filter((row) => new URL(row.route, `https://${batch.host}`).pathname === "/d2l/api/le/1.82/content/myItems/");
  const personalDates = new Map<string, { at: string; route: string }>();
  const personalResources = new Map<string, string>();
  const topicDates = new Map<string, { at: string | null; title: string; topicId: string }>();
  for (const page of myItems) if (page.status === 200) attempt(page, () => {
    for (const item of rows(page)) attempt(page, () => {
      const dueAt = date(item.DueDate);
      if (item.ToolItemId !== undefined) {
        const key = id(item.ToolItemId);
        personalResources.set(key, page.route);
        if (dueAt !== null) personalDates.set(key, { at: dueAt, route: page.route });
      } else {
        // ScheduledItem.ItemId is a content ID, not an assignment or quiz ID.
        const end = date(item.EndDate);
        items.push({ id: `myitem-${id(item.ItemId)}`, title: title(item.ItemName), dueAt: dueAt ?? end,
          dateSource: dueAt !== null ? "content/myItems" : end !== null ? "availability end" : null,
          dateRoute: dueAt !== null || end !== null ? page.route : null, submission: "unknown" });
      }
    });
  });
  if (toc !== null) attempt(toc, () => {
    const walk = (modules: unknown, inheritedEnd: string | null): void => {
      for (const module of list(modules)) {
        const end = date(module.EndDateTime) ?? inheritedEnd;
        for (const topic of list(module.Topics ?? [])) {
          const key = topic.ToolItemId === undefined || topic.ToolItemId === null ? `topic-${id(topic.TopicId)}` : id(topic.ToolItemId);
          const candidate = { at: date(topic.EndDateTime) ?? end, title: title(topic.Title), topicId: id(topic.TopicId) };
          // Conflicting links are evidence for Jarvis, not permission to pick a date.
          if (topicDates.has(key) && topicDates.get(key)?.at !== candidate.at) {
            topicDates.set(key, { ...candidate, at: null });
            unmapped.push(`${toc.route}:ambiguous_content_date`);
            continue;
          }
          topicDates.set(key, candidate);
        }
        walk(module.Modules ?? [], end);
      }
    };
    walk(record(toc.body).Modules, null);
  });
  const seen = new Set<string>();
  if (folders !== null) attempt(folders, () => {
    for (const folder of rows(folders)) attempt(folders, () => {
      const key = id(folder.Id);
      if (seen.has(key)) {
        const previous = items.findIndex((item) => item.id === `folder-${key}`);
        if (previous !== -1) items[previous] = { ...items[previous]!, dueAt: null, dateSource: null, dateRoute: null };
        throw new Error("duplicate_resource");
      }
      seen.add(key);
      const personal = personalDates.get(key) ?? null;
      const assignment = date(folder.DueDate);
      const availability = topicDates.get(key)?.at ?? null;
      const dueAt = personal?.at ?? assignment ?? availability;
      const dateSource = personal !== null ? "content/myItems" : assignment !== null ? "assignment DueDate" : availability !== null ? "availability end" : null;
      const ownPath = `dropbox/folders/${key}/submissions/mysubmissions/`;
      const submission = routes.get(prefix + ownPath) ?? required(`dropbox/folders/${key}/submissions/`);
      const ownPositive = submission?.route === prefix + ownPath && submission.status === 200 && submission.complete
        && submission.body !== null && !Array.isArray(submission.body) && typeof submission.body === "object"
        && submission.body.Status === 1;
      items.push({ id: `folder-${key}`, title: title(folder.Name), dueAt, dateSource,
        dateRoute: personal !== null ? personal.route : assignment !== null ? folders.route : availability !== null ? toc!.route : null,
        submission: ownPositive ? "positive submission status" : "unknown" });
    });
  });
    for (const [key, topic] of topicDates) {
      if (seen.has(key)) continue;
      items.push({ id: `topic-${topic.topicId}`, title: topic.title, dueAt: topic.at,
        dateSource: topic.at === null ? null : "availability end", dateRoute: topic.at === null ? null : toc!.route,
        submission: "unknown" });
    }
  for (const [key, route] of personalResources) if (!seen.has(key)) unmapped.push(`${route}:unlinked_myItems_item`);
  // Announcement publication/expiry is not an assignment due date. Its entire body stays raw.
  for (const quizRoute of batch.routes.filter((row) => new URL(row.route, `https://${batch.host}`).pathname === prefix + "quizzes/" && row.status === 200)) {
    attempt(quizRoute, () => {
      for (const quiz of rows(quizRoute)) attempt(quizRoute, () => {
        const key = id(quiz.QuizId);
        const dueAt = date(quiz.DueDate);
        const end = date(quiz.EndDate);
        items.push({ id: `quiz-${key}`, title: title(quiz.Name), dueAt: dueAt ?? end,
          dateSource: dueAt !== null ? "quiz DueDate" : end !== null ? "availability end" : null,
          dateRoute: dueAt !== null || end !== null ? quizRoute.route : null, submission: "unknown" });
        if (dueAt !== null && end !== null && dueAt !== end) items.push({ id: `quiz-${key}-end`, title: title(quiz.Name), dueAt: end,
          dateSource: "availability end", dateRoute: quizRoute.route, submission: "unknown" });
      });
    });
  }
  const deadlines = items.flatMap((item): RawDeadlineItem[] => item.dueAt === null ? [] : [{
    externalId: item.id, course: batch.course.name, title: `${item.title} [${item.dateSource}]`, dueAt: item.dueAt,
  }]);
  return { items, deadlines, failures, unmapped: [...new Set(unmapped)] };
}
