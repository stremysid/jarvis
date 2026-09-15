import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { buildJobTable, type JobEnvironment } from "../../src/jobs/job-table.js";
import { resetArchiveFixture } from "../archive/archive-fixture.js";
import { resetDeadlineTables } from "../deadlines/deadline-fixture.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const CONFIGURED = {
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_REFRESH_TOKEN: "refresh-token",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function context(
  fetcher: typeof fetch,
  overrides: Partial<JobEnvironment["env"]> = {},
): JobEnvironment {
  return {
    env: {
      ...env,
      GITHUB_TOKEN: undefined,
      OWNER_PRINCIPAL_ID: "principal:owner",
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_REFRESH_TOKEN: undefined,
      ...overrides,
    },
    clock: { now: () => new Date(NOW) },
    delivery: { send: async () => undefined },
    fetcher,
  };
}

async function runPoll(jobContext: JobEnvironment) {
  const poll = buildJobTable(jobContext).poll;
  if (poll === undefined) throw new Error("poll_job_missing");
  return poll();
}

describe("hourly Classroom ingestion", () => {
  beforeEach(async () => {
    await resetArchiveFixture();
    await resetDeadlineTables();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDeadlineTables();
  });

  it("uses configured OAuth, ingests UTC timed fields, and reuses the stable source on retry", async () => {
    const fetcher = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.origin === "https://oauth2.googleapis.com") {
        return json({ access_token: "access-token", expires_in: 3600, token_type: "Bearer" });
      }
      if (url.pathname === "/v1/courses") {
        return json({ courses: [{ id: "physics", name: "SPH4U Physics" }] });
      }
      if (url.pathname === "/v1/courses/physics/courseWork") {
        return json({
          courseWork: [{
            id: "quiz-1",
            title: "Unit 1 Quiz",
            dueDate: { year: 2026, month: 9, day: 18 },
            dueTime: { hours: 18, minutes: 30 },
          }],
        });
      }
      throw new Error(`unrouted ${url.origin}${url.pathname}`);
    }) as unknown as typeof fetch;
    const send = vi.fn(async (_text: string) => undefined);
    const jobContext = { ...context(fetcher, CONFIGURED), delivery: { send } };

    await expect(runPoll(jobContext)).resolves.toMatchObject({ ok: true });
    await expect(runPoll(jobContext)).resolves.toMatchObject({ ok: true });

    const repository = new DeadlineRepository(env.DB);
    const sources = await repository.listSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      sourceId: "google-classroom",
      kind: "classroom",
      lastSuccessAt: NOW.toISOString(),
      lastFailure: null,
    });
    expect(await repository.readByExternalId("google-classroom", "physics:quiz-1")).toMatchObject({
      course: "SPH4U Physics",
      title: "Unit 1 Quiz",
      // The API documents the timed pair as UTC; Toronto must not shift it.
      dueAt: "2026-09-18T18:30:00.000Z",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM deadlines").first("count")).toBe(1);

    const digest = buildJobTable(jobContext).digest;
    if (digest === undefined) throw new Error("digest_job_missing");
    await expect(digest()).resolves.toMatchObject({ ok: true, detail: "sent" });
    expect(String(send.mock.calls[0]?.[0])).toContain("Unit 1 Quiz");
  });

  it("does not contact Google or create a source when all configuration is absent", async () => {
    const fetcher = vi.fn(async () => { throw new Error("network_must_not_run"); }) as unknown as typeof fetch;
    const result = await runPoll(context(fetcher));

    expect(result).toMatchObject({ ok: true, detail: expect.stringContaining("Classroom not configured") });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await new DeadlineRepository(env.DB).listSources()).toEqual([]);
  });

  it("reports removed configuration after a source has existed instead of treating stale data as current", async () => {
    const repository = new DeadlineRepository(env.DB);
    await repository.ensureSource({
      sourceId: "google-classroom",
      kind: "classroom",
      label: "Google Classroom",
      now: NOW,
    });
    const fetcher = vi.fn(async () => { throw new Error("network_must_not_run"); }) as unknown as typeof fetch;

    const result = await runPoll(context(fetcher));

    expect(result).toMatchObject({ ok: true, detail: expect.stringContaining("configuration missing") });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await repository.readSource("google-classroom")).toMatchObject({
      lastFailure: "classroom_configuration_missing",
      lastFailureAt: NOW.toISOString(),
    });
  });

  it("records partial configuration as a visible source failure without making a request", async () => {
    const fetcher = vi.fn(async () => { throw new Error("network_must_not_run"); }) as unknown as typeof fetch;
    const result = await runPoll(context(fetcher, { GOOGLE_CLIENT_ID: CONFIGURED.GOOGLE_CLIENT_ID }));

    expect(result).toMatchObject({ ok: true, detail: expect.stringContaining("configuration incomplete") });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await new DeadlineRepository(env.DB).readSource("google-classroom")).toMatchObject({
      lastFailure: "classroom_configuration_incomplete",
      lastFailureAt: NOW.toISOString(),
    });
  });

  it("persists a fixed failure code and never Google's response body", async () => {
    const fetcher = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.origin === "https://oauth2.googleapis.com") {
        return json({ error: "invalid_grant", leaked: "credential-detail" }, 400);
      }
      throw new Error("Classroom must not run after OAuth rejection");
    }) as unknown as typeof fetch;

    const result = await runPoll(context(fetcher, CONFIGURED));
    const source = await new DeadlineRepository(env.DB).readSource("google-classroom");
    expect(result).toMatchObject({ ok: true, detail: expect.stringContaining("google_oauth_rejected") });
    expect(source?.lastFailure).toBe("google_oauth_rejected");
    expect(source?.lastFailure).not.toContain("credential-detail");
  });
});
