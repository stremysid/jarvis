import type { JsonValue } from "../../../../packages/contracts/src/index.js";
import type { RawDeadlineItem } from "../deadlines/deadline-types.js";
import { type SchoolBatch, type RouteEvidence, record } from "./collector-protocol.js";

export interface SchoolItem {
  readonly id: string;
  readonly title: string;
  readonly dueAt: string | null;
  readonly dateSource: "content/myItems" | "assignment DueDate" | "availability end" | null;
  readonly dateRoute: string | null;
  readonly submission: "positive submission status" | "unknown";
}

export interface MappedCourse {
  readonly items: readonly SchoolItem[];
  readonly deadlines: readonly RawDeadlineItem[];
  readonly failures: readonly string[];
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

/** A failed projection keeps its raw evidence; it never becomes an empty success. */
export function mapSchoolCourse(batch: SchoolBatch): MappedCourse {
  const prefix = `/d2l/api/le/1.82/${batch.course.id}/`;
  const failures: string[] = [];
  const items: SchoolItem[] = [];
  const routes = new Map(batch.routes.map((row) => [row.route, row]));
  for (const row of batch.routes) {
    if (row.status !== 200 || !row.complete) failures.push(`${row.route}:${row.status}:${row.complete ? "http" : "incomplete"}`);
  }
  const required = (route: string): RouteEvidence | null => {
    const result = routes.get(prefix + route);
    if (result === undefined) failures.push(`${prefix}${route}:not_read`);
    return result?.status === 200 && result.complete ? result : null;
  };
  const folders = required("dropbox/folders/");
  const toc = required("content/toc");
  const grades = required("grades/values/myGradeValues/");
  const myItems = routes.get(`/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=${batch.course.id}`);
  const personalDates = new Map<string, string>();
  const topicDates = new Map<string, { at: string | null; title: string; topicId: string }>();
  try {
    if (grades !== null && !Array.isArray(grades.body)) {
      // The observed empty object is valid. Populated grade shapes remain raw
      // evidence until the probe confirms their contract.
      if (Object.keys(record(grades.body)).length !== 0) throw new Error("grade_shape_unverified");
    }
    if (myItems?.status === 200 && myItems.complete) {
      // This narrow adapter is a wire contract, not a claim of observed LDSB shape.
      // Unknown myItems shapes fail closed until an anonymized probe confirms them.
      for (const item of list(myItems.body)) {
        const key = id(item.ToolItemId);
        const dueAt = date(item.DueDate);
        if (dueAt !== null) personalDates.set(key, dueAt);
      }
    }
    const walk = (modules: unknown, inheritedEnd: string | null): void => {
      for (const module of list(modules)) {
        const end = date(module.EndDateTime) ?? inheritedEnd;
        for (const topic of list(module.Topics ?? [])) {
          const key = topic.ToolItemId === undefined || topic.ToolItemId === null ? `topic-${id(topic.TopicId)}` : id(topic.ToolItemId);
          const candidate = { at: date(topic.EndDateTime) ?? end, title: title(topic.Title), topicId: id(topic.TopicId) };
          // Conflicting links are evidence for Jarvis, not permission to pick a date.
          if (topicDates.has(key) && topicDates.get(key)?.at !== candidate.at) throw new Error("ambiguous_content_date");
          topicDates.set(key, candidate);
        }
        walk(module.Modules ?? [], end);
      }
    };
    if (toc !== null) walk(record(toc.body).Modules, null);
    const seen = new Set<string>();
    if (folders !== null) for (const folder of list(folders.body)) {
      const key = id(folder.Id);
      if (seen.has(key)) throw new Error("duplicate_resource");
      seen.add(key);
      const personal = personalDates.get(key) ?? null;
      const assignment = date(folder.DueDate);
      const availability = topicDates.get(key)?.at ?? null;
      const dueAt = personal ?? assignment ?? availability;
      const dateSource = personal !== null ? "content/myItems" : assignment !== null ? "assignment DueDate" : availability !== null ? "availability end" : null;
      const ownPath = `dropbox/folders/${key}/submissions/mysubmissions/`;
      const submission = routes.get(prefix + ownPath) ?? required(`dropbox/folders/${key}/submissions/`);
      const ownPositive = submission?.route === prefix + ownPath && submission.status === 200 && submission.complete
        && submission.body !== null && !Array.isArray(submission.body) && typeof submission.body === "object"
        && submission.body.Status === 1;
      items.push({ id: `folder-${key}`, title: title(folder.Name), dueAt, dateSource,
        dateRoute: personal !== null ? myItems!.route : assignment !== null ? folders.route : availability !== null ? toc!.route : null,
        submission: ownPositive ? "positive submission status" : "unknown" });
    }
    for (const [key, topic] of topicDates) {
      if (seen.has(key)) continue;
      items.push({ id: `topic-${topic.topicId}`, title: topic.title, dueAt: topic.at,
        dateSource: topic.at === null ? null : "availability end", dateRoute: topic.at === null ? null : toc!.route,
        submission: "unknown" });
    }
  } catch {
    failures.push("unsupported_or_invalid_route_shape");
  }
  const deadlines = items.flatMap((item): RawDeadlineItem[] => item.dueAt === null ? [] : [{
    externalId: item.id, course: batch.course.name, title: `${item.title} [${item.dateSource}]`, dueAt: item.dueAt,
  }]);
  return { items, deadlines, failures };
}
