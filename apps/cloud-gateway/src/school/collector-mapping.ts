import type { JsonValue } from "../../../../packages/contracts/src/index.js";
import type { RawDeadlineItem } from "../deadlines/deadline-types.js";
import { type SchoolBatch, type RouteEvidence, record } from "./collector-protocol.js";

export interface SchoolItem {
  readonly id: string;
  readonly title: string;
  readonly dueAt: string | null;
  readonly dateSource: "content/myItems" | "assignment DueDate" | "folder Availability EndDate" | "quiz DueDate" | "availability end" | null;
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

function folderAvailabilityEnd(value: unknown): { readonly known: boolean; readonly at: string | null } {
  if (value === null || value === undefined) return { known: true, at: null };
  if (typeof value !== "object" || Array.isArray(value)
    || !Object.prototype.hasOwnProperty.call(value, "EndDate")) return { known: false, at: null };
  const end = (value as Record<string, unknown>).EndDate;
  if (end !== null && typeof end !== "string") return { known: false, at: null };
  try { return { known: true, at: date(end) }; }
  catch { return { known: false, at: null }; }
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
      const sameTool = new URL(key).pathname === new URL(routeKey(route.route)).pathname;
      if (seen.has(key) || page?.status !== 200 || !sameTool) { failures.push(`${route.route}:paging_incomplete`); break; }
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
  const topicDates = new Map<string, { at: string | null; title: string; itemId: string; toolItemId: string | null }>();
  for (const page of myItems) if (page.status === 200) attempt(page, () => {
    for (const item of rows(page)) attempt(page, () => {
      if (item.ToolItemId !== undefined) {
        const key = id(item.ToolItemId);
        const dueAt = date(item.DueDate);
        personalResources.set(key, page.route);
        if (dueAt !== null) personalDates.set(key, { at: dueAt, route: page.route });
      } else {
        // No populated ScheduledItem shape has been observed, so its content ID cannot identify an assignment.
        unmapped.push(`${page.route}:scheduled_item_projection_unknown`);
      }
    });
  });
  if (toc !== null) attempt(toc, () => {
    const walk = (modules: unknown, inheritedEnd: string | null): void => {
      for (const module of list(modules)) {
        const end = date(module.EndDateTime) ?? inheritedEnd;
        for (const topic of list(module.Topics ?? [])) {
          const topicId = id(topic.TopicId);
          const dropboxLinked = topic.TypeIdentifier === "Dropbox" && topic.ToolItemId !== undefined && topic.ToolItemId !== null;
          const toolItemId = dropboxLinked ? id(topic.ToolItemId) : null;
          const itemId = toolItemId === null ? `topic-${topicId}` : `folder-${toolItemId}`;
          const candidate = { at: date(topic.EndDateTime) ?? end, title: title(topic.Title), itemId, toolItemId };
          // Conflicting links are evidence for Jarvis, not permission to pick a date.
          if (topicDates.has(itemId) && topicDates.get(itemId)?.at !== candidate.at) {
            topicDates.set(itemId, { ...candidate, at: null });
            unmapped.push(`${toc.route}:ambiguous_content_date`);
            continue;
          }
          topicDates.set(itemId, candidate);
        }
        walk(module.Modules ?? [], end);
      }
    };
    walk(record(toc.body).Modules, null);
  });
  const seen = new Set<string>();
  let folderListReadable = false;
  if (folders !== null) attempt(folders, () => {
    const folderRows = rows(folders);
    folderListReadable = true;
    for (const folder of folderRows) attempt(folders, () => {
      const key = id(folder.Id);
      if (seen.has(key)) {
        const previous = items.findIndex((item) => item.id === `folder-${key}`);
        if (previous !== -1) items[previous] = { ...items[previous]!, dueAt: null, dateSource: null, dateRoute: null };
        throw new Error("duplicate_resource");
      }
      seen.add(key);
      const personal = personalDates.get(key) ?? null;
      const assignment = date(folder.DueDate);
      const folderAvailability = folderAvailabilityEnd(folder.Availability);
      if (!folderAvailability.known) unmapped.push(`${folders.route}:folder_availability_shape_unknown`);
      const contentAvailability = topicDates.get(`folder-${key}`)?.at ?? null;
      if (personal !== null && assignment !== null && personal.at !== assignment) {
        unmapped.push(`${folders.route}:ambiguous_assignment_date`);
      }
      // An unreadable higher-priority fallback cannot be treated as absent in order to select a lower one.
      const availability = folderAvailability.known ? folderAvailability.at ?? contentAvailability : null;
      const dueAt = personal?.at ?? assignment ?? availability;
      const dateSource = personal !== null ? "content/myItems" : assignment !== null ? "assignment DueDate"
        : folderAvailability.at !== null ? "folder Availability EndDate" : availability !== null ? "availability end" : null;
      const ownPath = `dropbox/folders/${key}/submissions/mysubmissions/`;
      const submission = required(ownPath);
      const ownPositive = submission?.route === prefix + ownPath && submission.status === 200 && submission.complete
        && submission.body !== null && !Array.isArray(submission.body) && typeof submission.body === "object"
        && submission.body.Status === 1;
      items.push({ id: `folder-${key}`, title: title(folder.Name), dueAt, dateSource,
        dateRoute: personal !== null ? personal.route : assignment !== null || folderAvailability.at !== null ? folders.route
          : availability !== null ? toc!.route : null,
        submission: ownPositive ? "positive submission status" : "unknown" });
    });
  });
  for (const topic of topicDates.values()) {
    if (topic.toolItemId !== null) {
      if (!folderListReadable) {
        unmapped.push(`${toc!.route}:linked_topic_folder_list_unread`);
        continue;
      }
      if (seen.has(topic.toolItemId)) continue;
    }
    items.push({ id: topic.itemId, title: topic.title, dueAt: topic.at,
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
