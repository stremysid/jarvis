import { newUlid, sha256Hex, type Sha256Hex } from "../../../../packages/contracts/src/index.js";
import { GitHubFailure, type GitHubCommit, type GitHubFileRead } from "./github-client.js";
import type { ProjectRepository, RecordedDocument } from "./project-repository.js";
import {
  MAX_FAILURE_CHARACTERS,
  PROJECT_DOCUMENT_PATHS,
  boundedExcerpt,
  type DocumentChange,
  type ProjectDocument,
  type ProjectDocumentPath,
  type ProjectPollOutcome,
  type TrackedProject,
} from "./project-types.js";

/**
 * Poll a tracked repository and record what it said.
 *
 * The whole subsystem turns on one rule from the plan: an empty or failed
 * fetch alerts rather than reading as "nothing changed". So every path out of
 * a poll writes a row. A repository we could not reach records a failure
 * observation; a repository we reached records what all four documents said.
 * The one thing that never happens is a poll leaving no trace, because a
 * source that has been quietly failing for a week looks exactly like a calm
 * project unless the failures are on record.
 *
 * The documents read here are untrusted text. This file hashes them and cuts
 * an excerpt; it does not read them for meaning, and nothing it returns may be
 * handed to a model as instructions. A repository we poll describes a project;
 * it does not get to tell Jarvis what to do.
 */

/** What the poller needs from GitHub. `GitHubClient` satisfies it. */
export interface ProjectSource {
  readHeadCommit(owner: string, repository: string): Promise<GitHubCommit>;
  readFileAtCommit(owner: string, repository: string, path: string, ref: string): Promise<GitHubFileRead>;
}

export interface ProjectPollerOptions {
  readonly projects: ProjectRepository;
  readonly source: ProjectSource;
  /** Injected so a test can place a poll at a chosen instant rather than at whatever `Date.now()` says. */
  readonly now: () => Date;
}

/**
 * Compose the recorded failure from this system's own vocabulary only: where
 * the poll was, a code from the client's fixed union, and an HTTP status.
 *
 * A response body must never reach this string. It is attacker-controlled text
 * from a repository, and a failure record is read by the owner and stored in a
 * column with a 512-character CHECK -- letting a repository choose its content
 * would put someone else's words in our alerting and could abort the very
 * insert that records the problem.
 */
function failureText(error: unknown, path: ProjectDocumentPath | null): string {
  const where = path ?? "head";
  const code = error instanceof GitHubFailure ? error.code : "unexpected_error";
  const status = error instanceof GitHubFailure && error.status !== null ? `:${String(error.status)}` : "";
  const composed = `${where}:${code}${status}`;
  // Bounded by construction from the three fixed vocabularies above; clamped
  // anyway because a CHECK violation here would throw and lose the one record
  // whose whole purpose is to say that something went wrong.
  return composed.slice(0, MAX_FAILURE_CHARACTERS);
}

/**
 * Compare what we just read against the last successful observation.
 *
 * A path missing from both sides is not a change, and a path missing from only
 * one is: a document that appears and one that is deleted both mean something
 * happened to the project.
 */
export function diffDocuments(
  previous: ReadonlyMap<ProjectDocumentPath, Sha256Hex>,
  current: ReadonlyMap<ProjectDocumentPath, Sha256Hex>,
): readonly DocumentChange[] {
  const changes: DocumentChange[] = [];
  for (const path of PROJECT_DOCUMENT_PATHS) {
    const before = previous.get(path) ?? null;
    const after = current.get(path) ?? null;
    if (before === after) continue;
    const kind = before === null ? "appeared" : after === null ? "disappeared" : "changed";
    changes.push(Object.freeze({ path, kind, previousHash: before, currentHash: after }));
  }
  return Object.freeze(changes);
}

export class ProjectPoller {
  constructor(private readonly options: ProjectPollerOptions) {}

  /**
   * Poll every active project, in order, one at a time.
   *
   * Sequential on purpose. Four requests per repository fanned out across every
   * tracked project is exactly the burst pattern GitHub answers with a
   * secondary rate limit, and a rate limit would fail polls that would
   * otherwise have succeeded -- turning a scheduling choice into a wave of
   * alerts about repositories that are perfectly healthy.
   *
   * A repository that cannot be reached does not stop the sweep; that is
   * already recorded per project as a failure observation. A persistence error
   * does stop it, and is deliberately not caught: if D1 is refusing writes then
   * continuing would poll every remaining project and record none of the
   * results, which is the silent failure this design exists to prevent.
   */
  async pollActiveProjects(): Promise<readonly ProjectPollOutcome[]> {
    const projects = await this.options.projects.listActiveProjects();
    const outcomes: ProjectPollOutcome[] = [];
    for (const project of projects) outcomes.push(await this.pollProject(project));
    return Object.freeze(outcomes);
  }

  async pollProject(project: TrackedProject): Promise<ProjectPollOutcome> {
    const observedAt = this.#now();
    const observationId = newUlid();

    let commit: GitHubCommit;
    try {
      commit = await this.options.source.readHeadCommit(project.owner, project.repository);
    } catch (error) {
      return this.#recordFailure(project, observationId, observedAt, failureText(error, null));
    }

    // Read the previous state before writing the new observation, or the
    // comparison would be against the row we are about to insert and every
    // poll would report nothing changed.
    const previousSuccess = await this.options.projects.readLatestSuccess(project.projectId);
    const previous = new Map<ProjectDocumentPath, Sha256Hex>(
      (previousSuccess?.documents ?? []).map((document) => [document.path, document.contentHash]),
    );

    const recorded: RecordedDocument[] = [];
    const current = new Map<ProjectDocumentPath, Sha256Hex>();
    for (const path of PROJECT_DOCUMENT_PATHS) {
      let read: GitHubFileRead;
      try {
        read = await this.options.source.readFileAtCommit(
          project.owner, project.repository, path, commit.sha,
        );
      } catch (error) {
        // One unreadable document fails the whole observation. There is no
        // place in the schema to say "these three are current and the fourth
        // could not be read", and recording the other three as the project's
        // state would let the unread one keep its stale hash and read as
        // unchanged for as long as the failure lasts.
        return this.#recordFailure(project, observationId, observedAt, failureText(error, path));
      }

      // A 404 is not a failure. The standard asks for four files; a project
      // that has not written DECISIONS.md yet is behind on the standard, not
      // unreachable, and the two must not produce the same record.
      if (read.outcome === "absent") continue;

      const contentHash = await sha256Hex(read.content);
      current.set(path, contentHash);
      recorded.push({ documentId: newUlid(), path, contentHash, excerpt: boundedExcerpt(read.content) });
    }

    await this.options.projects.recordObservation({
      observationId,
      projectId: project.projectId,
      observedAt,
      headSha: commit.sha,
      lastCommitAt: commit.committedAt,
      documents: recorded,
    });

    const documents: readonly ProjectDocument[] = Object.freeze(recorded.map((document) => Object.freeze({
      documentId: document.documentId,
      observationId,
      projectId: project.projectId,
      path: document.path,
      contentHash: document.contentHash,
      excerpt: document.excerpt,
      observedAt,
    })));

    return Object.freeze({
      status: "observed" as const,
      projectId: project.projectId,
      observationId,
      observedAt,
      headSha: commit.sha,
      lastCommitAt: commit.committedAt,
      documents,
      changes: diffDocuments(previous, current),
      firstObservation: previousSuccess === null,
    });
  }

  async #recordFailure(
    project: TrackedProject,
    observationId: string,
    observedAt: string,
    failure: string,
  ): Promise<ProjectPollOutcome> {
    await this.options.projects.recordFailedObservation({
      observationId, projectId: project.projectId, observedAt, failure,
    });
    return Object.freeze({
      status: "failed" as const,
      projectId: project.projectId,
      observationId,
      observedAt,
      failure,
    });
  }

  #now(): string {
    const now = this.options.now();
    const epoch = now.valueOf();
    if (!Number.isFinite(epoch)) throw new TypeError("project_clock_invalid");
    return new Date(epoch).toISOString();
  }
}
