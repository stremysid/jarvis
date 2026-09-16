import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildJobTable, type JobEnvironment } from "../../src/jobs/job-table.js";
import { SchoolProgressRepository } from "../../src/school/school-progress-repository.js";
import { applySchoolProgressMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const PRINCIPAL_ID = "principal:classroom-progress-job";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

beforeAll(async () => {
  await applySchoolProgressMigration();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'School owner', ?2, ?2)`)
    .bind(PRINCIPAL_ID, NOW.toISOString()).run();
});

describe("the resumable Classroom progress poll", () => {
  it("persists a bounded work-item checkpoint and finishes the course on the next hourly run", async () => {
    const courseWork = Array.from({ length: 50 }, (_, index) => ({
      id: `work-${String(index).padStart(2, "0")}`,
      title: `Assignment ${index}`,
      dueDate: { year: 2026, month: 9, day: 15 },
      dueTime: { hours: 20 },
      maxPoints: 10,
    }));
    const fetcher = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.origin === "https://oauth2.googleapis.com") {
        return json({ access_token: "access-token", expires_in: 3600, token_type: "Bearer" });
      }
      if (url.pathname === "/v1/courses") {
        return json({ courses: [{ id: "course-chem", name: "SCH4U Chemistry" }] });
      }
      if (url.pathname === "/v1/courses/course-chem/courseWork") return json({ courseWork });
      if (url.pathname === "/v1/courses/course-chem/courseWork/-/studentSubmissions") {
        expect(url.searchParams.get("userId")).toBe("me");
        return json({});
      }
      throw new Error(`unrouted ${url.origin}${url.pathname}`);
    }) as unknown as typeof fetch;
    const context: JobEnvironment = {
      env: {
        ...env,
        OWNER_PRINCIPAL_ID: PRINCIPAL_ID,
        GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REFRESH_TOKEN: "refresh-token",
        BRIGHTSPACE_ICAL_URL: undefined,
        GITHUB_TOKEN: undefined,
      },
      clock: { now: () => new Date(NOW) },
      delivery: { send: async () => undefined },
      fetcher,
    };
    const poll = buildJobTable(context).poll;
    if (poll === undefined) throw new Error("poll_job_missing");

    await expect(poll()).resolves.toMatchObject({
      ok: true,
      detail: expect.stringContaining("Classroom progress synced"),
    });
    const repository = new SchoolProgressRepository(env.DB);
    const first = await repository.readSourceState(PRINCIPAL_ID, NOW);
    expect(first).toMatchObject({
      checkpointCourseId: "course-chem",
      checkpointWorkItemExternalId: "course-chem:work-47",
      lastFailure: null,
    });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM school_progress_work_items
      WHERE principal_id = ?1`).bind(PRINCIPAL_ID).first("count")).toBe(48);

    await expect(poll()).resolves.toMatchObject({ ok: true });
    const second = await repository.readSourceState(PRINCIPAL_ID, NOW);
    expect(second).toMatchObject({
      checkpointCourseId: "course-chem",
      checkpointWorkItemExternalId: null,
      lastFailure: null,
    });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM school_progress_work_items
      WHERE principal_id = ?1`).bind(PRINCIPAL_ID).first("count")).toBe(50);
  });
});
