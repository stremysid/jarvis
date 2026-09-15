import { describe, expect, it } from "vitest";
import {
  ClassroomClient,
  ClassroomRequestError,
  DEFAULT_CLASSROOM_TIME_ZONE,
  classroomDueInstant,
} from "../../src/deadlines/classroom-client.js";

const TORONTO = { timeZone: "America/Toronto" };

interface StubCall {
  readonly url: string;
  readonly authorization: string | null;
}

/**
 * A fetch that never reaches the network.
 *
 * It throws on an unrouted URL rather than returning a 404, so a test that
 * silently stops calling the endpoint it is about fails instead of passing
 * against nothing.
 */
function stubFetch(
  handler: (url: URL) => Response,
): { readonly fetchImplementation: typeof fetch; readonly calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetchImplementation = ((input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers ?? {});
    calls.push({ url: url.toString(), authorization: headers.get("authorization") });
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
  return { fetchImplementation, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("classroomDueInstant", () => {
  it("reads a due date and due time together as the UTC instant the API documents them to be", () => {
    expect(classroomDueInstant(
      { dueDate: { year: 2026, month: 9, day: 15 }, dueTime: { hours: 23, minutes: 59 } },
      TORONTO,
    )).toBe("2026-09-15T23:59:00.000Z");
  });

  it("gives a coursework item with a due date but no due time the end of that day in the owner's zone", () => {
    // Not midnight UTC. Midnight UTC on the 15th is 20:00 on the 14th in
    // Toronto -- a day early, and often already past at the moment we ingest
    // it, which would drop the deadline out of every forward-looking query.
    expect(classroomDueInstant({ dueDate: { year: 2026, month: 9, day: 15 }, dueTime: null }, TORONTO))
      .toBe("2026-09-16T03:59:59.999Z");
    expect(classroomDueInstant({ dueDate: { year: 2026, month: 9, day: 15 } }, TORONTO))
      .toBe("2026-09-16T03:59:59.999Z");
  });

  it("uses the zone's offset on the day in question rather than one fixed offset", () => {
    // September is daylight time (UTC-4) and January is standard time (UTC-5).
    // A hardcoded offset passes one of these and fails the other.
    expect(classroomDueInstant({ dueDate: { year: 2026, month: 9, day: 15 }, dueTime: null }, TORONTO))
      .toBe("2026-09-16T03:59:59.999Z");
    expect(classroomDueInstant({ dueDate: { year: 2026, month: 1, day: 15 }, dueTime: null }, TORONTO))
      .toBe("2026-01-16T04:59:59.999Z");
  });

  it("treats an empty dueTime object as midnight rather than as a missing time", () => {
    // proto3 JSON omits zero fields, so `{}` is a real TimeOfDay meaning
    // 00:00:00. Collapsing it into the no-time case would move the deadline to
    // the end of the day, which is nearly a full day late.
    const midnight = classroomDueInstant({ dueDate: { year: 2026, month: 9, day: 15 }, dueTime: {} }, TORONTO);
    const noTime = classroomDueInstant({ dueDate: { year: 2026, month: 9, day: 15 }, dueTime: null }, TORONTO);
    expect(midnight).toBe("2026-09-15T00:00:00.000Z");
    expect(midnight).not.toBe(noTime);
  });

  it("returns nothing for coursework with no due date at all, rather than inventing one", () => {
    expect(classroomDueInstant({ dueDate: null, dueTime: { hours: 9 } }, TORONTO)).toBeNull();
    expect(classroomDueInstant({}, TORONTO)).toBeNull();
  });

  it("refuses a date that does not exist instead of rolling it into the next month", () => {
    // Date.UTC turns February 30th into March 2nd without complaining, which
    // would become a real deadline on a day nobody set.
    expect(classroomDueInstant({ dueDate: { year: 2026, month: 2, day: 30 }, dueTime: { hours: 9 } }, TORONTO)).toBeNull();
    expect(classroomDueInstant({ dueDate: { year: 2026, month: 13, day: 1 }, dueTime: {} }, TORONTO)).toBeNull();
    expect(classroomDueInstant({ dueDate: { year: 2026, month: 9 }, dueTime: {} }, TORONTO)).toBeNull();
  });

  it("refuses an out-of-range time rather than wrapping it into the next day", () => {
    expect(classroomDueInstant({ dueDate: { year: 2026, month: 9, day: 15 }, dueTime: { hours: 24 } }, TORONTO)).toBeNull();
    expect(classroomDueInstant({ dueDate: { year: 2026, month: 9, day: 15 }, dueTime: { minutes: 61 } }, TORONTO)).toBeNull();
  });

  it("refuses an unknown time zone at construction rather than quietly falling back to UTC", () => {
    expect(() => new ClassroomClient({ accessToken: async () => "t", timeZone: "Mars/Olympus" }))
      .toThrow("classroom_time_zone_invalid");
    expect(DEFAULT_CLASSROOM_TIME_ZONE).toBe("America/Toronto");
  });
});

describe("ClassroomClient", () => {
  function corpus(url: URL): Response {
    if (url.pathname === "/v1/courses") {
      return json({
        courses: [
          { id: "c-physics", name: "SPH4U Physics", courseState: "ACTIVE" },
          { id: "c-english", name: "ENG4U English", courseState: "ACTIVE" },
        ],
      });
    }
    if (url.pathname === "/v1/courses/c-physics/courseWork") {
      return json({
        courseWork: [
          { id: "1", title: "Unit 3 Quiz", dueDate: { year: 2026, month: 9, day: 15 }, dueTime: { hours: 18, minutes: 30 } },
          // No due date: material, not a deadline.
          { id: "2", title: "Formula sheet" },
        ],
      });
    }
    if (url.pathname === "/v1/courses/c-english/courseWork") {
      // Same coursework id as the physics course, which is legal: a Classroom
      // id is unique only within its course.
      return json({ courseWork: [{ id: "1", title: "Comparative essay", dueDate: { year: 2026, month: 9, day: 20 } }] });
    }
    throw new Error(`unrouted ${url.pathname}`);
  }

  it("collects every dated published assignment across active courses and keys each one by course and item", async () => {
    const { fetchImplementation, calls } = stubFetch(corpus);
    const client = new ClassroomClient({ accessToken: async () => "token-abc", fetchImplementation, timeZone: "America/Toronto" });

    const items = await client.collectDeadlines();

    expect(items).toEqual([
      { externalId: "c-physics:1", course: "SPH4U Physics", title: "Unit 3 Quiz", dueAt: "2026-09-15T18:30:00.000Z" },
      { externalId: "c-english:1", course: "ENG4U English", title: "Comparative essay", dueAt: "2026-09-21T03:59:59.999Z" },
    ]);
    // The two items share a Classroom id; only the course prefix keeps them
    // from collapsing onto one row under the (source, external_id) key.
    expect(new Set(items.map((item) => item.externalId)).size).toBe(items.length);
    expect(calls.every((call) => call.authorization === "Bearer token-abc")).toBe(true);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/courses", "/v1/courses/c-physics/courseWork", "/v1/courses/c-english/courseWork",
    ]);
  });

  it("asks only for active courses and published coursework", async () => {
    const { fetchImplementation, calls } = stubFetch(corpus);
    await new ClassroomClient({ accessToken: async () => "t", fetchImplementation }).collectDeadlines();
    expect(new URL(calls[0]!.url).searchParams.get("courseStates")).toBe("ACTIVE");
    expect(new URL(calls[1]!.url).searchParams.get("courseWorkStates")).toBe("PUBLISHED");
  });

  it("mints a fresh access token for every request rather than capturing one", async () => {
    let issued = 0;
    const { fetchImplementation, calls } = stubFetch(corpus);
    const client = new ClassroomClient({
      accessToken: async () => `token-${++issued}`,
      fetchImplementation,
    });
    await client.collectDeadlines();
    // A token captured at construction expires mid-sweep and turns a long run
    // into a 401 that looks like a revoked grant.
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3"]);
  });

  it("follows pagination and stops when the token stops coming", async () => {
    const { fetchImplementation, calls } = stubFetch((url) => {
      if (url.pathname === "/v1/courses") {
        return url.searchParams.get("pageToken") === null
          ? json({ courses: [{ id: "c-1", name: "One" }], nextPageToken: "page-2" })
          : json({ courses: [{ id: "c-2", name: "Two" }] });
      }
      return json({});
    });
    const courses = await new ClassroomClient({ accessToken: async () => "t", fetchImplementation }).listCourses();
    expect(courses.map((course) => course.id)).toEqual(["c-1", "c-2"]);
    expect(calls).toHaveLength(2);
  });

  it("reads a course with no coursework as empty rather than as an error", async () => {
    // proto3 JSON omits empty arrays, so an assignment-free course answers `{}`.
    const { fetchImplementation } = stubFetch(() => json({}));
    await expect(new ClassroomClient({ accessToken: async () => "t", fetchImplementation }).listCourseWork("c-1"))
      .resolves.toEqual([]);
  });

  it("separates a credential failure from an outage, because only one of them is worth retrying", async () => {
    for (const [status, transient] of [[401, false], [403, false], [429, true], [503, true]] as const) {
      const { fetchImplementation } = stubFetch(() => json({ error: {} }, status));
      const client = new ClassroomClient({ accessToken: async () => "t", fetchImplementation });
      const error = await client.listCourses().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ClassroomRequestError);
      expect((error as ClassroomRequestError).status).toBe(status);
      expect((error as ClassroomRequestError).transient).toBe(transient);
    }
  });

  it("refuses an access token that could inject a header instead of handing it to fetch", async () => {
    const { fetchImplementation, calls } = stubFetch(corpus);
    const client = new ClassroomClient({ accessToken: async () => "abc\r\nx-admin: 1", fetchImplementation });
    await expect(client.listCourses()).rejects.toThrow("classroom_access_token_invalid");
    expect(calls).toHaveLength(0);
  });

  it("percent-encodes a course id from the response before it becomes part of a path", async () => {
    const { fetchImplementation, calls } = stubFetch(() => json({}));
    await new ClassroomClient({ accessToken: async () => "t", fetchImplementation }).listCourseWork("../../v1/admin");
    // The id is data from a response, not a route we chose.
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/courses/..%2F..%2Fv1%2Fadmin/courseWork");
  });

  it("does not follow any link the response supplies", async () => {
    const { fetchImplementation, calls } = stubFetch((url) => {
      if (url.pathname === "/v1/courses") return json({ courses: [{ id: "c-1", name: "One", alternateLink: "https://evil.example/pull" }] });
      return json({
        courseWork: [{
          id: "1",
          title: "Essay",
          dueDate: { year: 2026, month: 9, day: 20 },
          alternateLink: "https://evil.example/pull",
          materials: [{ link: { url: "https://evil.example/pull" } }],
        }],
      });
    });
    await new ClassroomClient({ accessToken: async () => "t", fetchImplementation }).collectDeadlines();
    expect(calls.every((call) => new URL(call.url).origin === "https://classroom.googleapis.com")).toBe(true);
  });
});
