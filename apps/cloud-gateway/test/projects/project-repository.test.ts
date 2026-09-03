import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { newUlid, sha256Hex, type Sha256Hex } from "../../../../packages/contracts/src/index.js";
import { ProjectRepository } from "../../src/projects/project-repository.js";
import { FIXTURE_SHA, resetProjectTables } from "./project-fixture.js";

/**
 * The scoping rule is what this file is really about.
 *
 * "What does this project currently say" has to mean "what the most recent
 * successful observation recorded", not "the newest row for each path". The
 * two agree until a document is deleted from the repository, at which point
 * the second keeps reporting a file that is gone -- and the deletion, which is
 * the interesting event, is never noticed.
 */

const PROJECT = "project:jarvis";

async function repositoryWithProject(): Promise<ProjectRepository> {
  const projects = new ProjectRepository(env.DB);
  await projects.trackProject({
    projectId: PROJECT,
    owner: "sid",
    repository: "jarvis",
    displayName: "Jarvis",
    staleAfterDays: 7,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return projects;
}

describe("ProjectRepository", () => {
  beforeEach(async () => {
    await resetProjectTables();
  });

  it("lists only the projects still marked active, in the order they were tracked", async () => {
    const projects = await repositoryWithProject();
    await projects.trackProject({
      projectId: "project:second",
      owner: "sid",
      repository: "second",
      displayName: "Second",
      staleAfterDays: 30,
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    await projects.trackProject({
      projectId: "project:retired",
      owner: "sid",
      repository: "retired",
      displayName: "Retired",
      staleAfterDays: 7,
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    await env.DB.prepare("UPDATE tracked_projects SET active = 0 WHERE project_id = 'project:retired'").run();

    expect((await projects.listActiveProjects()).map((project) => project.projectId))
      .toEqual([PROJECT, "project:second"]);
    expect((await projects.listActiveProjects())[1]).toMatchObject({ staleAfterDays: 30, active: true });
  });

  it("reads the current hash from the last successful observation, not the last row for the path", async () => {
    const projects = await repositoryWithProject();
    const decisions = await sha256Hex("# Decisions\n");
    await projects.recordObservation({
      observationId: newUlid(),
      projectId: PROJECT,
      observedAt: "2026-09-01T00:00:00.000Z",
      headSha: FIXTURE_SHA,
      lastCommitAt: "2026-08-31T00:00:00.000Z",
      documents: [{ documentId: newUlid(), path: "DECISIONS.md", contentHash: decisions, excerpt: "# Decisions\n" }],
    });
    expect(await projects.readCurrentDocumentHash(PROJECT, "DECISIONS.md")).toBe(decisions);

    // The file is deleted from the repository: a later observation succeeds
    // and simply carries no row for it.
    await projects.recordObservation({
      observationId: newUlid(),
      projectId: PROJECT,
      observedAt: "2026-09-02T00:00:00.000Z",
      headSha: "b".repeat(40),
      lastCommitAt: "2026-09-02T00:00:00.000Z",
      documents: [],
    });

    expect(await projects.readCurrentDocumentHash(PROJECT, "DECISIONS.md")).toBeNull();
    // The row itself is still there -- observations are append-only, and the
    // history is what makes the deletion visible in the first place.
    const kept = await env.DB.prepare("SELECT COUNT(*) AS count FROM project_documents").first<{ count: number }>();
    expect(kept?.count).toBe(1);
  });

  it("keeps a failed observation from displacing the documents the last successful one recorded", async () => {
    const projects = await repositoryWithProject();
    const nextSteps = await sha256Hex("# Next steps\n");
    await projects.recordObservation({
      observationId: newUlid(),
      projectId: PROJECT,
      observedAt: "2026-09-01T00:00:00.000Z",
      headSha: FIXTURE_SHA,
      lastCommitAt: "2026-08-31T00:00:00.000Z",
      documents: [{ documentId: newUlid(), path: "NEXT_STEPS.md", contentHash: nextSteps, excerpt: "# Next steps\n" }],
    });
    await projects.recordFailedObservation({
      observationId: newUlid(),
      projectId: PROJECT,
      observedAt: "2026-09-02T00:00:00.000Z",
      failure: "head:rate_limited:403",
    });

    const project = await projects.readProject(PROJECT);
    if (project === null) throw new Error("expected the tracked project");
    const status = await projects.readProjectStatus(project);

    // The documents are still readable and still true as of the last poll that
    // worked -- but the health says they are not fresh, which is the whole
    // reason a failed poll is recorded rather than dropped.
    expect(status.pollHealth).toBe("failing");
    expect(status.documents.map((document) => document.path)).toEqual(["NEXT_STEPS.md"]);
    expect(status.latestSuccess?.lastCommitAt).toBe("2026-08-31T00:00:00.000Z");
    expect(status.latestObservation?.failure).toBe("head:rate_limited:403");
  });

  it("records a failed observation with no commit and no documents", async () => {
    const projects = await repositoryWithProject();
    await projects.recordFailedObservation({
      observationId: newUlid(),
      projectId: PROJECT,
      observedAt: "2026-09-01T00:00:00.000Z",
      failure: "head:unavailable:500",
    });

    const row = await env.DB.prepare(
      "SELECT head_sha, last_commit_at, failure FROM project_observations",
    ).first<{ head_sha: string | null; last_commit_at: string | null; failure: string | null }>();
    expect(row).toEqual({ head_sha: null, last_commit_at: null, failure: "head:unavailable:500" });
  });

  it("writes an observation and its documents in one transaction, or neither", async () => {
    // A document rejected by its CHECK must take the observation down with it.
    // An observation committed alone would read as a repository that had
    // suddenly lost all four status files.
    const projects = await repositoryWithProject();
    const good = await sha256Hex("# Next steps\n");

    await expect(projects.recordObservation({
      observationId: newUlid(),
      projectId: PROJECT,
      observedAt: "2026-09-01T00:00:00.000Z",
      headSha: FIXTURE_SHA,
      lastCommitAt: "2026-08-31T00:00:00.000Z",
      documents: [
        { documentId: newUlid(), path: "NEXT_STEPS.md", contentHash: good, excerpt: "# Next steps\n" },
        { documentId: newUlid(), path: "KNOWN_ISSUES.md", contentHash: "NOTAHASH" as Sha256Hex, excerpt: "x" },
      ],
    })).rejects.toThrow();

    const observations = await env.DB.prepare("SELECT COUNT(*) AS count FROM project_observations").first<{ count: number }>();
    const documents = await env.DB.prepare("SELECT COUNT(*) AS count FROM project_documents").first<{ count: number }>();
    expect([observations?.count, documents?.count]).toEqual([0, 0]);
  });

  it("reports a project that has never been polled as never polled rather than as up to date", async () => {
    const projects = await repositoryWithProject();
    const statuses = await projects.readActiveProjectStatuses();

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ pollHealth: "never_polled", latestObservation: null, latestSuccess: null });
    expect(statuses[0].documents).toEqual([]);
  });

  it("takes the newest successful observation when two share an instant", async () => {
    // Ties break on the observation id, which is a ULID and so sorts in the
    // order the observations were made.
    const projects = await repositoryWithProject();
    const first = newUlid();
    const second = newUlid();
    for (const [observationId, excerpt] of [[first, "older"], [second, "newer"]] as const) {
      await projects.recordObservation({
        observationId,
        projectId: PROJECT,
        observedAt: "2026-09-01T00:00:00.000Z",
        headSha: FIXTURE_SHA,
        lastCommitAt: "2026-08-31T00:00:00.000Z",
        documents: [{
          documentId: newUlid(),
          path: "NEXT_STEPS.md",
          contentHash: await sha256Hex(excerpt),
          excerpt,
        }],
      });
    }

    const latest = await projects.readLatestSuccess(PROJECT);
    expect(latest?.observation.observationId).toBe(second);
    expect(latest?.documents.map((document) => document.excerpt)).toEqual(["newer"]);
  });
});
