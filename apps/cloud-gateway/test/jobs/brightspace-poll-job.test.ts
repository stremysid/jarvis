import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { buildJobTable, type JobEnvironment } from "../../src/jobs/job-table.js";
import { resetArchiveFixture } from "../archive/archive-fixture.js";
import { resetDeadlineTables } from "../deadlines/deadline-fixture.js";
import { applySchoolCatchupMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const FEED_URL = "https://school.example/d2l/le/calendar/feed/user.ics?subscription=fixture-only";

const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:brightspace-item-1",
  "SUMMARY:Unit 2 Project",
  "CATEGORIES:SPH4U Physics",
  "DTSTART:20260918T183000Z",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

function datedFeed(count: number): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0"];
  for (let index = 0; index < count; index += 1) {
    const due = new Date(NOW.getTime() + (index - 100) * 86_400_000);
    const stamp = due.toISOString().replace(/[-:]/gu, "").replace(".000Z", "Z");
    lines.push(
      "BEGIN:VEVENT",
      `UID:bounded-${index}`,
      `SUMMARY:Assignment ${index}`,
      "CATEGORIES:Course",
      `DTSTART:${stamp}`,
      "END:VEVENT",
    );
  }
  return [...lines, "END:VCALENDAR", ""].join("\r\n");
}

function queryCountingDatabase(): { database: D1Database; queryCount(): number } {
  let count = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: async <T>(columnName?: string) => {
        count += 1;
        return columnName === undefined ? statement.first<T>() : statement.first<T>(columnName);
      },
      run: async <T>() => { count += 1; return statement.run<T>(); },
      all: async <T>() => { count += 1; return statement.all<T>(); },
      raw: async (options?: { columnNames?: boolean }) => {
        count += 1;
        return options?.columnNames === true ? statement.raw({ columnNames: true }) : statement.raw();
      },
    } as D1PreparedStatement;
    originals.set(wrapped as object, statement);
    return wrapped;
  };
  return {
    database: {
      prepare: (query: string) => wrap(env.DB.prepare(query)),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        count += statements.length;
        return env.DB.batch<T>(statements.map((statement) => originals.get(statement as object) ?? statement));
      },
    } as D1Database,
    queryCount: () => count,
  };
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
      BRIGHTSPACE_ICAL_URL: undefined,
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

describe("hourly Brightspace calendar-feed ingestion", () => {
  beforeEach(async () => {
    await resetArchiveFixture();
    await resetDeadlineTables();
    await applySchoolCatchupMigration();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDeadlineTables();
  });

  it("ingests the configured feed through the stable Brightspace source and morning digest", async () => {
    const fetcher = vi.fn(async () => new Response(FEED, {
      headers: { "content-type": "text/calendar; charset=utf-8" },
    })) as unknown as typeof fetch;
    const send = vi.fn(async (_text: string) => undefined);
    const jobContext = { ...context(fetcher, { BRIGHTSPACE_ICAL_URL: FEED_URL }), delivery: { send } };

    await expect(runPoll(jobContext)).resolves.toMatchObject({
      ok: true,
      detail: expect.stringContaining("Brightspace 1 seen, 0 cancelled, 0 rejected, 0 absent"),
    });

    const repository = new DeadlineRepository(env.DB);
    expect(await repository.readSource("brightspace-ical")).toMatchObject({
      kind: "brightspace",
      lastSuccessAt: NOW.toISOString(),
      lastFailure: null,
    });
    expect(await repository.readByExternalId("brightspace-ical", "brightspace-item-1")).toMatchObject({
      course: "SPH4U Physics",
      title: "Unit 2 Project",
      dueAt: "2026-09-18T18:30:00.000Z",
    });

    const digest = buildJobTable(jobContext).digest;
    if (digest === undefined) throw new Error("digest_job_missing");
    await expect(digest()).resolves.toMatchObject({ ok: true, detail: "sent" });
    expect(String(send.mock.calls[0]?.[0])).toContain("Unit 2 Project");
    expect(String(send.mock.calls[0]?.[0])).not.toContain("not set up");
  });

  it("makes no network call or source row without the URL and tells the digest it is not set up", async () => {
    const fetcher = vi.fn(async () => { throw new Error("network_must_not_run"); }) as unknown as typeof fetch;
    const send = vi.fn(async (_text: string) => undefined);
    const jobContext = { ...context(fetcher), delivery: { send } };

    await expect(runPoll(jobContext)).resolves.toMatchObject({
      ok: true,
      detail: expect.stringContaining("Brightspace not configured"),
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await new DeadlineRepository(env.DB).listSources()).toEqual([]);

    const digest = buildJobTable(jobContext).digest;
    if (digest === undefined) throw new Error("digest_job_missing");
    await expect(digest()).resolves.toMatchObject({ ok: true, detail: "sent with 1 gaps" });
    expect(String(send.mock.calls[0]?.[0])).toContain("Brightspace: not set up");
  });

  it("records removed configuration without contacting the feed", async () => {
    const repository = new DeadlineRepository(env.DB);
    await repository.ensureSource({
      sourceId: "brightspace-ical",
      kind: "brightspace",
      label: "Brightspace",
      now: NOW,
    });
    const fetcher = vi.fn(async () => { throw new Error("network_must_not_run"); }) as unknown as typeof fetch;

    await expect(runPoll(context(fetcher))).resolves.toMatchObject({
      detail: expect.stringContaining("Brightspace configuration missing"),
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await repository.readSource("brightspace-ical")).toMatchObject({
      lastFailure: "brightspace_configuration_missing",
      lastFailureAt: NOW.toISOString(),
    });
  });

  it("does not reactivate or contact an owner-disabled source", async () => {
    const repository = new DeadlineRepository(env.DB);
    await repository.ensureSource({
      sourceId: "brightspace-ical",
      kind: "brightspace",
      label: "Brightspace",
      active: false,
      now: NOW,
    });
    const fetcher = vi.fn(async () => { throw new Error("network_must_not_run"); }) as unknown as typeof fetch;

    await expect(runPoll(context(fetcher, { BRIGHTSPACE_ICAL_URL: FEED_URL }))).resolves.toMatchObject({
      detail: expect.stringContaining("Brightspace source inactive"),
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await repository.readSource("brightspace-ical")).toMatchObject({ active: false });
  });

  it("records a fixed invalid-URL failure without making a request", async () => {
    const fetcher = vi.fn(async () => { throw new Error("network_must_not_run"); }) as unknown as typeof fetch;
    await expect(runPoll(context(fetcher, { BRIGHTSPACE_ICAL_URL: "http://school.example/private" })))
      .resolves.toMatchObject({ detail: expect.stringContaining("brightspace_feed_url_invalid") });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await new DeadlineRepository(env.DB).readSource("brightspace-ical")).toMatchObject({
      lastFailure: "brightspace_feed_url_invalid",
    });
  });

  it("keeps the private URL and provider body out of durable source health", async () => {
    const fetcher = vi.fn(async () => new Response("fixture-private-marker and provider detail", { status: 403 })) as unknown as typeof fetch;
    const result = await runPoll(context(fetcher, { BRIGHTSPACE_ICAL_URL: FEED_URL }));
    const source = await new DeadlineRepository(env.DB).readSource("brightspace-ical");

    expect(result).toMatchObject({ detail: expect.stringContaining("brightspace_feed_rejected") });
    expect(source?.lastFailure).toBe("brightspace_feed_rejected");
    expect(JSON.stringify(result)).not.toContain("fixture-private-marker");
    expect(JSON.stringify(source)).not.toContain("provider detail");
  });

  it("closes an open deadline only when the feed explicitly cancels it", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(FEED))
      .mockResolvedValueOnce(new Response(FEED.replace(
        "SUMMARY:Unit 2 Project",
        "STATUS:CANCELLED\r\nSUMMARY:Unit 2 Project",
      )));
    const jobContext = context(fetcher, { BRIGHTSPACE_ICAL_URL: FEED_URL });

    await runPoll(jobContext);
    await expect(new DeadlineRepository(env.DB).readByExternalId("brightspace-ical", "brightspace-item-1"))
      .resolves.toMatchObject({ status: "open" });
    await expect(runPoll(jobContext)).resolves.toMatchObject({
      detail: expect.stringContaining("0 seen, 1 cancelled"),
    });
    await expect(new DeadlineRepository(env.DB).readByExternalId("brightspace-ical", "brightspace-item-1"))
      .resolves.toMatchObject({ status: "cancelled" });
  });

  it("keeps a 600-component feed under the D1 budget by ingesting only the bounded date window", async () => {
    const counted = queryCountingDatabase();
    const fetcher = vi.fn(async () => new Response(datedFeed(600))) as unknown as typeof fetch;
    const jobContext = context(fetcher, { DB: counted.database, BRIGHTSPACE_ICAL_URL: FEED_URL });

    await expect(runPoll(jobContext)).resolves.toMatchObject({
      detail: expect.stringContaining("Brightspace 134 seen"),
    });
    const firstRunQueries = counted.queryCount();
    expect(firstRunQueries).toBeLessThan(800);

    await runPoll(jobContext);
    expect(counted.queryCount() - firstRunQueries).toBeLessThan(180);
  });

  it("records an owner configuration error without contacting the private feed", async () => {
    const fetcher = vi.fn(async () => { throw new Error("network_must_not_run"); }) as unknown as typeof fetch;
    const jobContext = context(fetcher, {
      BRIGHTSPACE_ICAL_URL: FEED_URL,
      DIGEST_TIMEZONE: "not/a-time-zone",
    });

    await expect(runPoll(jobContext)).resolves.toMatchObject({
      detail: expect.stringContaining("brightspace_timezone_invalid"),
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(new DeadlineRepository(env.DB).readSource("brightspace-ical")).resolves.toMatchObject({
      lastFailure: "brightspace_timezone_invalid",
    });
  });

  it("continues source polling when archival fails", async () => {
    const database = {
      prepare(query: string) {
        if (query.includes("FROM archive_state")) throw new Error("fixture_archive_failed");
        return env.DB.prepare(query);
      },
      batch: <T>(statements: D1PreparedStatement[]) => env.DB.batch<T>(statements),
    } as D1Database;
    const fetcher = vi.fn(async () => new Response(FEED)) as unknown as typeof fetch;

    await expect(runPoll(context(fetcher, { DB: database, BRIGHTSPACE_ICAL_URL: FEED_URL }))).resolves.toMatchObject({
      detail: expect.stringContaining("archival failed (archive_operation_failed); Classroom not configured; Brightspace 1 seen"),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
