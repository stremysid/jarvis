/**
 * Google Classroom, read-only, against the owner's own account.
 *
 * `fetch` and the access token arrive as injected dependencies. The token is a
 * supplier rather than a string because access tokens are minted per run from
 * the stored refresh token and expire while a long sweep is still running; a
 * captured string would work in every test and fail on the first course after
 * an hour.
 *
 * Everything this returns is untrusted text. Titles are written by teachers,
 * and the API's own `alternateLink` and `materials` are URLs into a system we
 * do not control -- so nothing here follows a link from the response, and the
 * only fields read are the ones a deadline is made of. The result is a plain
 * `RawDeadlineItem`, the same shape the Brightspace calendar feed produces, and
 * nothing downstream can tell them apart.
 */

import type { RawDeadlineItem } from "./deadline-types.js";
import {
  SCHOOL_PROGRESS_ITEMS_PER_SWEEP,
  type RawSchoolProgressItem,
  type SchoolSubmissionState,
} from "../school/school-progress-types.js";

const API_ORIGIN = "https://classroom.googleapis.com";

/** Classroom's maximum; fewer round trips for the same result. */
const PAGE_SIZE = 100;

/**
 * A cap on pagination. A `nextPageToken` that never stops -- a bug at either
 * end -- would otherwise hold a Worker invocation until the platform kills it,
 * and the sweep would look like a timeout rather than a loop.
 */
const MAX_PAGES = 25;

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The owner's school board is in Ontario, so this is the zone a course's dates
 * are lived in. It is a guess about a person rather than a fact about the API,
 * and it is the one constant in this file a reviewer should check against the
 * owner before trusting a reminder time.
 */
export const DEFAULT_CLASSROOM_TIME_ZONE = "America/Toronto";

/** Google's `Date`: proto3 JSON, so a field that is zero may simply be absent. */
export interface ClassroomDate {
  readonly year?: number;
  readonly month?: number;
  readonly day?: number;
}

/**
 * Google's `TimeOfDay`. Every field is optional and omitted when zero, so
 * `{}` is a real value that means midnight -- and is a different thing from
 * the field being absent, which means no time was set at all. Collapsing the
 * two is the bug this type exists to make visible.
 */
export interface ClassroomTimeOfDay {
  readonly hours?: number;
  readonly minutes?: number;
  readonly seconds?: number;
}

export interface ClassroomCourse {
  readonly id: string;
  readonly name: string;
}

export interface ClassroomCourseWork {
  readonly id: string;
  readonly courseId: string;
  readonly title: string;
  readonly dueDate: ClassroomDate | null;
  readonly dueTime: ClassroomTimeOfDay | null;
  readonly maximumPoints: number | null;
}

export interface ClassroomStudentSubmission {
  readonly id: string;
  readonly courseId: string;
  readonly courseWorkId: string;
  readonly state: SchoolSubmissionState;
  readonly late: boolean | null;
  readonly assignedGrade: number | null;
  readonly updateTime: string | null;
}

export interface ClassroomProgressCollection {
  readonly items: readonly RawSchoolProgressItem[];
  readonly rejectedCount: number;
  /** Null when this course is complete, otherwise the last item in this slice. */
  readonly checkpointExternalId: string | null;
}

export interface ClassroomDueOptions {
  readonly timeZone: string;
}

export interface ClassroomClientOptions {
  /** Mints a fresh OAuth access token. Called once per HTTP request, not once per client. */
  readonly accessToken: () => Promise<string>;
  readonly fetchImplementation?: typeof fetch;
  readonly timeZone?: string;
  readonly timeoutMs?: number;
}

/** A failed Classroom call. `transient` is what decides whether the sweep is worth retrying. */
export class ClassroomRequestError extends Error {
  readonly status: number | null;
  readonly transient: boolean;

  constructor(code: string, status: number | null, transient: boolean) {
    super(code);
    this.name = "ClassroomRequestError";
    this.status = status;
    this.transient = transient;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalPoints(value: unknown, allowZero: boolean): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) return null;
  if (!allowZero && value === 0) return null;
  return value;
}

function canonicalOptionalInstant(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function submissionState(value: unknown): SchoolSubmissionState | null {
  if (value === "NEW") return "new";
  if (value === "CREATED") return "created";
  if (value === "TURNED_IN") return "turned_in";
  if (value === "RETURNED") return "returned";
  if (value === "RECLAIMED_BY_STUDENT") return "reclaimed";
  if (value === "STUDENT_EDITED_AFTER_TURN_IN") return "edited_after_turn_in";
  return null;
}

function optionalInteger(value: unknown, low: number, high: number): number | null {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < low || (value as number) > high) return null;
  return value as number;
}

/**
 * Read a zone's UTC offset at a given instant, in milliseconds.
 *
 * There is no API that answers this directly, so it is read back out of a
 * formatter: format the instant in the zone, reassemble those digits as though
 * they were UTC, and the difference is the offset.
 */
function zoneOffsetMilliseconds(instant: number, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(new Date(instant));
  const field = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) throw new TypeError("classroom_time_zone_unreadable");
    const parsed = Number(part.value);
    if (!Number.isSafeInteger(parsed)) throw new TypeError("classroom_time_zone_unreadable");
    return parsed;
  };
  // Seconds resolution is enough: no zone offset has ever had a sub-minute
  // component in the era Classroom serves dates for.
  const wall = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
  return wall - Math.floor(instant / 1_000) * 1_000;
}

/**
 * The single UTC instant named by a wall-clock reading in a zone.
 *
 * Two passes, and the second is not redundant. The first offset is read at the
 * wrong moment -- we can only ask the zone what it was doing at the UTC instant
 * with those digits -- and applying it can land on the far side of a
 * daylight-saving transition, where the offset is different. The second pass
 * asks again at the corrected instant.
 *
 * A wall-clock time that a transition skipped has no instant; the arithmetic
 * still yields one, an hour off in the direction of the jump. It is left that
 * way deliberately: the only clock time this function is asked for that is not
 * copied from the API is the end of a day, and no zone has ever moved its
 * clocks at midnight in the region this serves.
 */
function zonedInstant(
  wall: Readonly<{ year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number }>,
  formatter: Intl.DateTimeFormat,
): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond);
  const firstPass = naive - zoneOffsetMilliseconds(naive, formatter);
  return naive - zoneOffsetMilliseconds(firstPass, formatter);
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    // An unknown zone is a configuration error. Falling back to UTC would shift
    // every dateless deadline by hours and never say so.
    throw new TypeError("classroom_time_zone_invalid");
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * THE conversion. A Classroom due date and due time become one instant here
 * and nowhere else in this subsystem.
 *
 * Three cases, and the third is the one that bites:
 *
 *   - No `dueDate`: not a deadline. Classroom lists ungraded and undated
 *     coursework alongside everything else; an item with no due date is
 *     material, not something to remind about, and it returns null rather than
 *     being given an invented date.
 *
 *   - `dueDate` and `dueTime`: read together as UTC, which is the Classroom
 *     API's documented contract. This is deliberately not configurable: a
 *     local-time switch would make identical API data mean two instants.
 *     Note that `dueTime: {}` reaches this branch and means midnight; only an
 *     absent `dueTime` reaches the next one.
 *
 *   - `dueDate` with no `dueTime`: the end of that calendar day in the owner's
 *     zone -- 23:59:59.999 local. There is no time to interpret, only a day to
 *     choose a meaning for. Reading it as midnight UTC would put a
 *     Tuesday deadline at 20:00 Monday local: a day early, and often already
 *     in the past at the moment we ingest it, which would make it vanish from
 *     every forward-looking query.
 */
export function classroomDueInstant(
  due: Readonly<{ dueDate?: ClassroomDate | null; dueTime?: ClassroomTimeOfDay | null }>,
  options: ClassroomDueOptions,
): string | null {
  const date = due.dueDate;
  if (date === null || date === undefined || !isPlainObject(date)) return null;

  const year = optionalInteger(date.year, 1970, 9999);
  const month = optionalInteger(date.month, 1, 12);
  const day = optionalInteger(date.day, 1, 31);
  // A Date with a zero year, month, or day is not a date. Unlike TimeOfDay,
  // none of these fields has a meaningful zero, so an omitted one is corrupt
  // rather than defaulted.
  if (year === null || month === null || day === null || year === 0 || month === 0 || day === 0) return null;

  const formatter = zoneFormatter(options.timeZone);
  const time = due.dueTime;

  if (time === null || time === undefined) {
    const instant = zonedInstant(
      { year, month, day, hour: 23, minute: 59, second: 59, millisecond: 999 },
      formatter,
    );
    return calendarSafe(instant, year, month, day) ? new Date(instant).toISOString() : null;
  }

  if (!isPlainObject(time)) return null;
  const hour = optionalInteger(time.hours, 0, 23);
  const minute = optionalInteger(time.minutes, 0, 59);
  const second = optionalInteger(time.seconds, 0, 59);
  if (hour === null || minute === null || second === null) return null;

  const instant = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  return calendarSafe(instant, year, month, day) ? new Date(instant).toISOString() : null;
}

/**
 * Refuse a date that does not exist. `Date.UTC` rolls February 30th forward
 * into March without complaint, so a corrupt payload would become a real
 * deadline on the wrong day rather than an obvious rejection. The check allows
 * for the zone shift moving the UTC day by one.
 */
function calendarSafe(instant: number, year: number, month: number, day: number): boolean {
  if (!Number.isFinite(instant)) return false;
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  return roundTrip.getUTCFullYear() === year && roundTrip.getUTCMonth() === month - 1 && roundTrip.getUTCDate() === day;
}

export class ClassroomClient {
  readonly #accessToken: () => Promise<string>;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #dueOptions: ClassroomDueOptions;

  constructor(options: ClassroomClientOptions) {
    if (typeof options.accessToken !== "function") throw new TypeError("classroom_access_token_supplier_invalid");
    this.#accessToken = options.accessToken;
    // Bound to globalThis. The Workers runtime rejects native fetch called with
    // any other `this`, and holding it as a class field then calling
    // this.#fetch(...) supplies the instance -- which raises "Illegal
    // invocation" in production and nowhere else, because Node does not care.
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeZone = options.timeZone ?? DEFAULT_CLASSROOM_TIME_ZONE;
    // Validated at construction so a bad zone is a startup error rather than a
    // wrong reminder time discovered in March.
    zoneFormatter(timeZone);
    this.#dueOptions = Object.freeze({ timeZone });
  }

  /** Active courses only. An archived course's assignments are not deadlines. */
  async listCourses(): Promise<readonly ClassroomCourse[]> {
    const courses: ClassroomCourse[] = [];
    for await (const page of this.#pages("/v1/courses", { courseStates: "ACTIVE" }, "courses")) {
      for (const entry of page) {
        if (!isPlainObject(entry)) continue;
        const id = entry.id;
        if (typeof id !== "string" || id.length === 0) continue;
        const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : id;
        courses.push(Object.freeze({ id, name }));
      }
    }
    return Object.freeze(courses);
  }

  /**
   * Published coursework for one course.
   *
   * Draft and deleted coursework is filtered by the API, not by us: a draft is
   * something a teacher has not committed to, and reminding him about one
   * teaches him to distrust the reminders.
   */
  async listCourseWork(courseId: string): Promise<readonly ClassroomCourseWork[]> {
    if (typeof courseId !== "string" || courseId.length === 0) throw new TypeError("classroom_course_id_invalid");
    const work: ClassroomCourseWork[] = [];
    // The id came out of a response, so it is data. Percent-encoded before it
    // becomes part of a path, because an id containing "../" would otherwise
    // choose the endpoint.
    const path = `/v1/courses/${encodeURIComponent(courseId)}/courseWork`;
    for await (const page of this.#pages(path, { courseWorkStates: "PUBLISHED" }, "courseWork")) {
      for (const entry of page) {
        if (!isPlainObject(entry)) continue;
        const id = entry.id;
        const title = entry.title;
        if (typeof id !== "string" || id.length === 0) continue;
        if (typeof title !== "string" || title.length === 0) continue;
        work.push(Object.freeze({
          id,
          courseId,
          title,
          dueDate: isPlainObject(entry.dueDate) ? (entry.dueDate as ClassroomDate) : null,
          // `workType` is deliberately not read. A MULTIPLE_CHOICE_QUESTION is
          // not necessarily a quiz and an ASSIGNMENT can be a term project, so
          // it would add confidence without adding information.
          dueTime: isPlainObject(entry.dueTime) ? (entry.dueTime as ClassroomTimeOfDay) : null,
          maximumPoints: optionalPoints(entry.maxPoints, false),
        }));
      }
    }
    return Object.freeze(work);
  }

  /**
   * Every dated, published assignment across every active course, in the shape
   * ingestion takes.
   *
   * The external id carries the course id because a Classroom coursework id is
   * unique only within its course, and the store's uniqueness key is (source,
   * external id). Two courses' first assignment would otherwise be one row.
   */
  async collectDeadlines(coursesValue?: readonly ClassroomCourse[]): Promise<readonly RawDeadlineItem[]> {
    const items: RawDeadlineItem[] = [];
    const courses = coursesValue ?? await this.listCourses();
    for (const course of courses) {
      for (const work of await this.listCourseWork(course.id)) {
        const dueAt = classroomDueInstant(work, this.#dueOptions);
        if (dueAt === null) continue;
        items.push(Object.freeze({
          externalId: `${course.id}:${work.id}`,
          course: course.name,
          title: work.title,
          dueAt,
        }));
      }
    }
    return Object.freeze(items);
  }

  /**
   * The owner's own submission rows for one course.
   *
   * The literal `-` is Google's documented all-coursework selector and is
   * code, not response data. `userId=me` keeps the route incapable of walking
   * another student's records even if a broader teacher scope were ever
   * present on the token.
   */
  async listStudentSubmissions(courseId: string): Promise<{
    readonly submissions: readonly ClassroomStudentSubmission[];
    readonly rejectedCount: number;
    readonly rejectedCourseWorkIds: readonly string[];
  }> {
    if (typeof courseId !== "string" || courseId.length === 0) {
      throw new TypeError("classroom_course_id_invalid");
    }
    const submissions: ClassroomStudentSubmission[] = [];
    const rejectedCourseWorkIds = new Set<string>();
    let rejectedCount = 0;
    const path = `/v1/courses/${encodeURIComponent(courseId)}/courseWork/-/studentSubmissions`;
    for await (const page of this.#pages(path, { userId: "me" }, "studentSubmissions")) {
      for (const entry of page) {
        if (!isPlainObject(entry)) {
          rejectedCount += 1;
          continue;
        }
        const id = entry.id;
        const responseCourseId = entry.courseId;
        const courseWorkId = entry.courseWorkId;
        const state = submissionState(entry.state);
        const late = entry.late === undefined ? null : typeof entry.late === "boolean" ? entry.late : undefined;
        const assignedGrade = optionalPoints(entry.assignedGrade, true);
        const updateTime = canonicalOptionalInstant(entry.updateTime);
        if (
          typeof id !== "string" || id.length === 0
          || responseCourseId !== courseId
          || typeof courseWorkId !== "string" || courseWorkId.length === 0
          || state === null || late === undefined || updateTime === undefined
          || entry.assignedGrade !== undefined && assignedGrade === null
        ) {
          if (typeof courseWorkId === "string" && courseWorkId.length > 0) {
            rejectedCourseWorkIds.add(courseWorkId);
          }
          rejectedCount += 1;
          continue;
        }
        submissions.push(Object.freeze({
          id,
          courseId,
          courseWorkId,
          state,
          late,
          assignedGrade,
          updateTime,
        }));
      }
    }
    return Object.freeze({
      submissions: Object.freeze(submissions),
      rejectedCount,
      rejectedCourseWorkIds: Object.freeze([...rejectedCourseWorkIds]),
    });
  }

  /** One bounded course slice for the resumable scheduled progress walk. */
  async collectProgressForCourse(
    course: ClassroomCourse,
    now: Date,
    afterExternalId: string | null = null,
  ): Promise<ClassroomProgressCollection> {
    const observed = now.getTime();
    if (!Number.isFinite(observed)) throw new TypeError("classroom_progress_clock_invalid");
    const work = await this.listCourseWork(course.id);
    const collected = await this.listStudentSubmissions(course.id);
    const submissions = new Map<string, ClassroomStudentSubmission>();
    const rejectedCourseWorkIds = new Set(collected.rejectedCourseWorkIds);
    let duplicateCount = 0;
    for (const submission of collected.submissions) {
      if (submissions.has(submission.courseWorkId)) {
        rejectedCourseWorkIds.add(submission.courseWorkId);
        duplicateCount += 1;
      } else {
        submissions.set(submission.courseWorkId, submission);
      }
    }
    const knownWork = new Set(work.map((item) => item.id));
    const rejectedCount = collected.rejectedCount
      + duplicateCount
      + collected.submissions.filter((submission) => !knownWork.has(submission.courseWorkId)).length;
    const items = work.filter((item) => !rejectedCourseWorkIds.has(item.id)).map((item): RawSchoolProgressItem => {
      const submission = submissions.get(item.id) ?? null;
      return Object.freeze({
        externalId: `${course.id}:${item.id}`,
        course: course.name,
        title: item.title,
        dueAt: classroomDueInstant(item, this.#dueOptions),
        maximumPoints: item.maximumPoints,
        submission: submission === null ? null : Object.freeze({
          externalId: submission.id,
          state: submission.state,
          late: submission.late,
          sourceUpdatedAt: submission.updateTime,
        }),
        assignedPoints: submission?.assignedGrade ?? null,
      });
    });
    const ordered = [...items].sort((left, right) => left.externalId.localeCompare(right.externalId));
    const nextIndex = afterExternalId === null
      ? 0
      : ordered.findIndex((item) => item.externalId.localeCompare(afterExternalId) > 0);
    const start = nextIndex === -1 ? ordered.length : nextIndex;
    const selected = ordered.slice(start, start + SCHOOL_PROGRESS_ITEMS_PER_SWEEP);
    const complete = start + selected.length >= ordered.length;
    return Object.freeze({
      items: Object.freeze(selected),
      rejectedCount,
      checkpointExternalId: complete ? null : selected.at(-1)?.externalId ?? afterExternalId,
    });
  }

  async *#pages(path: string, query: Record<string, string>, field: string): AsyncGenerator<readonly unknown[]> {
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(`${API_ORIGIN}${path}`);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      url.searchParams.set("pageSize", String(PAGE_SIZE));
      if (pageToken !== null) url.searchParams.set("pageToken", pageToken);

      const body = await this.#get(url);
      const entries = body[field];
      // proto3 JSON omits empty arrays, so a course with no coursework returns
      // `{}` rather than an empty list. That is not an error.
      yield Array.isArray(entries) ? entries : [];

      const next = body.nextPageToken;
      if (typeof next !== "string" || next.length === 0) return;
      pageToken = next;
    }
    throw new ClassroomRequestError("classroom_pagination_unbounded", null, false);
  }

  async #get(url: URL): Promise<Record<string, unknown>> {
    const token = await this.#accessToken();
    // A token with a newline in it is header injection, and the failure it
    // produces otherwise is an opaque error from the fetch implementation.
    if (typeof token !== "string" || token.length === 0 || !/^[\x21-\x7e]+$/u.test(token)) {
      throw new ClassroomRequestError("classroom_access_token_invalid", null, false);
    }

    // A hung request would hold the invocation open until the platform kills
    // it, so the deadline is enforced here rather than hoped for.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      throw new ClassroomRequestError("classroom_request_timeout", null, true);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const status = response.status;
      // 401 and 403 mean the credential, not the network: retrying a revoked
      // grant every five minutes for a week is how an expired token becomes an
      // outage nobody investigates.
      const transient = status === 429 || status >= 500;
      throw new ClassroomRequestError(transient ? "classroom_unavailable" : "classroom_rejected", status, transient);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ClassroomRequestError("classroom_response_unparseable", response.status, true);
    }
    if (!isPlainObject(parsed)) throw new ClassroomRequestError("classroom_response_invalid", response.status, false);
    return parsed;
  }
}
