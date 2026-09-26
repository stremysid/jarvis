import { env } from "cloudflare:test";
import type { Sha256Hex } from "../../../../packages/contracts/src/index.js";
import { applyFoundationMigration } from "../persistence/migration.js";
import type {
  ProjectDocument,
  ProjectDocumentPath,
  ProjectObservation,
  ProjectStatus,
  TrackedProject,
} from "../../src/projects/project-types.js";

/**
 * Shared setup for the project-manager tests.
 *
 * No test in this directory may reach the network. Every GitHub call is served
 * by `githubFetch` below, which is handed to the client as its fetch
 * implementation; a request for a URL no route matches throws rather than
 * falling through to the real API, so a test that accidentally asks for
 * something unstubbed fails loudly instead of quietly making a request.
 */

/**
 * Clear the three project tables between tests.
 *
 * Observations and documents are append-only in production and carry triggers
 * that refuse a DELETE, so the triggers come off and go straight back on. They
 * are recreated in a `finally` -- a test that left the production guard
 * dropped would let a later bug delete history and no test would notice.
 */
export async function resetProjectTables(): Promise<void> {
  await applyFoundationMigration();
  await env.DB.prepare("DROP TRIGGER IF EXISTS project_documents_reject_delete").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS project_observations_reject_delete").run();
  try {
    await env.DB.prepare("DELETE FROM project_documents").run();
    await env.DB.prepare("DELETE FROM project_observations").run();
    await env.DB.prepare("DELETE FROM tracked_projects").run();
  } finally {
    await env.DB.prepare(`CREATE TRIGGER project_observations_reject_delete
      BEFORE DELETE ON project_observations
      BEGIN
        SELECT RAISE(ABORT, 'project_observation_delete_forbidden');
      END`).run();
    await env.DB.prepare(`CREATE TRIGGER project_documents_reject_delete
      BEFORE DELETE ON project_documents
      BEGIN
        SELECT RAISE(ABORT, 'project_document_delete_forbidden');
      END`).run();
  }
}

export interface GitHubRoutes {
  /** Answers `GET /repos/{owner}/{repo}/commits`, told which repository was asked for. */
  readonly head?: (repository: string) => Response | Promise<Response>;
  /** Answers `GET /repos/{owner}/{repo}/contents/{path}`. */
  readonly file?: (path: string, repository: string) => Response | Promise<Response>;
}

export interface StubbedFetch {
  readonly implementation: typeof fetch;
  /** Every request the client made, in order, so a test can assert on headers as well as outcomes. */
  readonly calls: { url: string; headers: Headers }[];
}

export function githubFetch(routes: GitHubRoutes): StubbedFetch {
  const calls: { url: string; headers: Headers }[] = [];
  const implementation = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, headers: new Headers(init?.headers) });

    const commits = /^\/repos\/[^/]+\/([^/]+)\/commits$/u.exec(url.pathname);
    if (commits !== null) {
      if (routes.head === undefined) throw new Error(`unstubbed commits request: ${url.href}`);
      return await routes.head(commits[1]);
    }

    const contents = /^\/repos\/[^/]+\/([^/]+)\/contents\/(.+)$/u.exec(url.pathname);
    if (contents !== null) {
      if (routes.file === undefined) throw new Error(`unstubbed contents request: ${url.href}`);
      return await routes.file(decodeURIComponent(contents[2]), contents[1]);
    }

    throw new Error(`unstubbed request: ${url.href}`);
  }) as unknown as typeof fetch;

  return { implementation, calls };
}

export function commitsResponse(sha: string, committedAt: string): Response {
  return new Response(
    JSON.stringify([{ sha, commit: { committer: { date: committedAt }, author: { date: committedAt } } }]),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export function fileResponse(content: string): Response {
  return new Response(content, { status: 200, headers: { "content-type": "text/plain" } });
}

export function missingResponse(): Response {
  return new Response("Not Found", { status: 404, headers: { "content-type": "application/json" } });
}

export function rateLimitedResponse(): Response {
  return new Response("rate limited", {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "retry-after": "60" },
  });
}

/** Serves the same four documents for every file request, and absent for the rest. */
export function documentRoutes(
  documents: Partial<Record<ProjectDocumentPath, string>>,
): (path: string) => Response {
  return (path: string) => {
    const content = documents[path as ProjectDocumentPath];
    return content === undefined ? missingResponse() : fileResponse(content);
  };
}

export const FIXTURE_SHA = "a".repeat(40);

export function trackedProject(overrides: Partial<TrackedProject> = {}): TrackedProject {
  return Object.freeze({
    projectId: "project:jarvis",
    owner: "sid",
    repository: "jarvis",
    displayName: "Jarvis",
    staleAfterDays: 7,
    active: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });
}

function fixtureHash(seed: string): Sha256Hex {
  let value = "";
  for (let index = 0; index < 64; index += 1) {
    value += "0123456789abcdef"[(seed.charCodeAt(index % seed.length) + index) % 16];
  }
  return value as Sha256Hex;
}

/**
 * A status view built by hand, so the project-facts reader can be tested without
 * a database or a poll. The reader is a pure function over these; keeping
 * it that way is what makes a date rule cheap enough to test exhaustively.
 */
export function projectStatus(input: {
  readonly project?: Partial<TrackedProject>;
  readonly lastCommitAt?: string | null;
  readonly documents?: Partial<Record<ProjectDocumentPath, string>>;
  readonly pollHealth?: ProjectStatus["pollHealth"];
  readonly observedAt?: string;
}): ProjectStatus {
  const project = trackedProject(input.project);
  const observedAt = input.observedAt ?? "2026-09-01T00:00:00.000Z";
  const pollHealth = input.pollHealth ?? "ok";

  if (pollHealth === "never_polled") {
    return Object.freeze({
      project,
      latestObservation: null,
      latestSuccess: null,
      documents: Object.freeze([]),
      pollHealth,
    });
  }

  const success: ProjectObservation = Object.freeze({
    observationId: `observation:${project.projectId}`,
    projectId: project.projectId,
    observedAt,
    headSha: FIXTURE_SHA,
    lastCommitAt: input.lastCommitAt === undefined ? observedAt : input.lastCommitAt,
    failure: null,
  });

  const documents: ProjectDocument[] = Object.entries(input.documents ?? {}).map(([path, excerpt]) => Object.freeze({
    documentId: `document:${path}`,
    observationId: success.observationId,
    projectId: project.projectId,
    path: path as ProjectDocumentPath,
    contentHash: fixtureHash(excerpt),
    excerpt,
    observedAt,
  }));

  const latestObservation: ProjectObservation = pollHealth === "failing"
    ? Object.freeze({
      observationId: `observation:${project.projectId}:failed`,
      projectId: project.projectId,
      observedAt,
      headSha: null,
      lastCommitAt: null,
      failure: "head:unavailable:500",
    })
    : success;

  return Object.freeze({
    project,
    latestObservation,
    latestSuccess: success,
    documents: Object.freeze(documents),
    pollHealth,
  });
}
