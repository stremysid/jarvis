import type { Sha256Hex } from "../../../../packages/contracts/src/index.js";
import { TransactionRunner } from "../persistence/transaction.js";
import {
  PROJECT_DOCUMENT_PATHS,
  type ObservedDocuments,
  type ProjectDocument,
  type ProjectDocumentPath,
  type ProjectObservation,
  type ProjectPollHealth,
  type ProjectStatus,
  type TrackedProject,
} from "./project-types.js";

/**
 * D1 access for the AI project manager.
 *
 * Two rules from 0010_projects.sql shape everything here. Observations are
 * append-only, so nothing in this file updates or deletes one -- the triggers
 * would refuse anyway, and the history is what makes "KNOWN_ISSUES.md changed"
 * an answerable question at all. And a document belongs to the observation
 * that produced it, so "what does this project currently say" always means
 * "what did the most recent successful observation record", never "the newest
 * row per path": those differ exactly when a document has been deleted from
 * the repository, which is the case worth noticing.
 */

interface ProjectRow {
  readonly project_id: string;
  readonly owner: string;
  readonly repository: string;
  readonly display_name: string;
  readonly stale_after_days: number;
  readonly active: number;
  readonly created_at: string;
}

interface ObservationRow {
  readonly observation_id: string;
  readonly project_id: string;
  readonly observed_at: string;
  readonly head_sha: string | null;
  readonly last_commit_at: string | null;
  readonly failure: string | null;
}

interface DocumentRow {
  readonly document_id: string;
  readonly observation_id: string;
  readonly project_id: string;
  readonly path: string;
  readonly content_hash: string;
  readonly excerpt: string;
  readonly observed_at: string;
}

export interface TrackProjectInput {
  readonly projectId: string;
  readonly owner: string;
  readonly repository: string;
  readonly displayName: string;
  readonly staleAfterDays: number;
  readonly createdAt: string;
}

export interface RecordedDocument {
  readonly documentId: string;
  readonly path: ProjectDocumentPath;
  readonly contentHash: Sha256Hex;
  readonly excerpt: string;
}

export interface RecordObservationInput {
  readonly observationId: string;
  readonly projectId: string;
  readonly observedAt: string;
  readonly headSha: string;
  readonly lastCommitAt: string;
  readonly documents: readonly RecordedDocument[];
}

export interface RecordFailedObservationInput {
  readonly observationId: string;
  readonly projectId: string;
  readonly observedAt: string;
  readonly failure: string;
}

const DOCUMENT_PATHS: ReadonlySet<string> = new Set(PROJECT_DOCUMENT_PATHS);

/**
 * The CHECK on `project_documents.path` makes an unknown value unreachable,
 * but the row arrives from D1 typed as `string` and something has to justify
 * the narrowing. Throwing is right: a path outside the four means the schema
 * and this file have diverged, and guessing which one is correct would put a
 * document under the wrong heading in the digest.
 */
function asDocumentPath(value: string): ProjectDocumentPath {
  if (!DOCUMENT_PATHS.has(value)) throw new Error("project_document_path_unknown");
  return value as ProjectDocumentPath;
}

function toProject(row: ProjectRow): TrackedProject {
  return Object.freeze({
    projectId: row.project_id,
    owner: row.owner,
    repository: row.repository,
    displayName: row.display_name,
    staleAfterDays: row.stale_after_days,
    active: row.active === 1,
    createdAt: row.created_at,
  });
}

function toObservation(row: ObservationRow): ProjectObservation {
  return Object.freeze({
    observationId: row.observation_id,
    projectId: row.project_id,
    observedAt: row.observed_at,
    headSha: row.head_sha,
    lastCommitAt: row.last_commit_at,
    failure: row.failure,
  });
}

function toDocument(row: DocumentRow): ProjectDocument {
  return Object.freeze({
    documentId: row.document_id,
    observationId: row.observation_id,
    projectId: row.project_id,
    path: asDocumentPath(row.path),
    contentHash: row.content_hash as Sha256Hex,
    excerpt: row.excerpt,
    observedAt: row.observed_at,
  });
}

function healthOf(latest: ProjectObservation | null): ProjectPollHealth {
  if (latest === null) return "never_polled";
  return latest.failure === null ? "ok" : "failing";
}

export class ProjectRepository {
  readonly #transactions: TransactionRunner;

  constructor(private readonly database: D1Database) {
    this.#transactions = new TransactionRunner(database);
  }

  async trackProject(input: TrackProjectInput): Promise<void> {
    await this.database.prepare(
      `INSERT INTO tracked_projects (
         project_id, owner, repository, display_name, stale_after_days, active, created_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).bind(
      input.projectId, input.owner, input.repository, input.displayName,
      input.staleAfterDays, input.createdAt,
    ).run();
  }

  async listActiveProjects(): Promise<readonly TrackedProject[]> {
    const result = await this.database.prepare(
      `SELECT project_id, owner, repository, display_name, stale_after_days, active, created_at
       FROM tracked_projects WHERE active = 1 ORDER BY created_at, project_id`,
    ).all<ProjectRow>();
    return Object.freeze(result.results.map(toProject));
  }

  async readProject(projectId: string): Promise<TrackedProject | null> {
    const row = await this.database.prepare(
      `SELECT project_id, owner, repository, display_name, stale_after_days, active, created_at
       FROM tracked_projects WHERE project_id = ?`,
    ).bind(projectId).first<ProjectRow>();
    return row === null ? null : toProject(row);
  }

  /**
   * Append a successful observation together with the documents it read, in
   * one transaction.
   *
   * They cannot be written separately. A document row committed without its
   * observation would be read as the project's current state by a query that
   * has no observation to date it against, and an observation committed
   * without its documents would read as a repository that has suddenly lost
   * all four status files -- which the change detector would report as four
   * disappearances that never happened.
   */
  async recordObservation(input: RecordObservationInput): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.database.prepare(
        `INSERT INTO project_observations (
           observation_id, project_id, observed_at, head_sha, last_commit_at, failure
         ) VALUES (?, ?, ?, ?, ?, NULL)`,
      ).bind(input.observationId, input.projectId, input.observedAt, input.headSha, input.lastCommitAt),
    ];
    for (const document of input.documents) {
      statements.push(this.database.prepare(
        `INSERT INTO project_documents (
           document_id, observation_id, project_id, path, content_hash, excerpt, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        document.documentId, input.observationId, input.projectId, document.path,
        document.contentHash, document.excerpt, input.observedAt,
      ));
    }
    await this.#transactions.batch(statements);
  }

  /**
   * Append a failed observation. No documents accompany it: the schema's CHECK
   * makes head_sha NULL here, so there is no commit for a document to have
   * been read at, and recording a partial read as though it were the
   * repository's state is precisely the silent failure this design forbids.
   */
  async recordFailedObservation(input: RecordFailedObservationInput): Promise<void> {
    await this.database.prepare(
      `INSERT INTO project_observations (
         observation_id, project_id, observed_at, head_sha, last_commit_at, failure
       ) VALUES (?, ?, ?, NULL, NULL, ?)`,
    ).bind(input.observationId, input.projectId, input.observedAt, input.failure).run();
  }

  /** The most recent observation of any kind. A failure here is what makes a quietly broken source visible. */
  async readLatestObservation(projectId: string): Promise<ProjectObservation | null> {
    const row = await this.database.prepare(
      `SELECT observation_id, project_id, observed_at, head_sha, last_commit_at, failure
       FROM project_observations WHERE project_id = ?
       ORDER BY observed_at DESC, observation_id DESC LIMIT 1`,
    ).bind(projectId).first<ObservationRow>();
    return row === null ? null : toObservation(row);
  }

  /**
   * The most recent successful observation and the documents it recorded --
   * the project's current state, as far as anyone knows it.
   *
   * Ties on `observed_at` break on observation_id, which is a ULID and so
   * sorts in the order the observations were made.
   */
  async readLatestSuccess(projectId: string): Promise<ObservedDocuments | null> {
    const row = await this.database.prepare(
      `SELECT observation_id, project_id, observed_at, head_sha, last_commit_at, failure
       FROM project_observations WHERE project_id = ? AND head_sha IS NOT NULL
       ORDER BY observed_at DESC, observation_id DESC LIMIT 1`,
    ).bind(projectId).first<ObservationRow>();
    if (row === null) return null;

    const documents = await this.database.prepare(
      `SELECT document_id, observation_id, project_id, path, content_hash, excerpt, observed_at
       FROM project_documents WHERE observation_id = ? ORDER BY path`,
    ).bind(row.observation_id).all<DocumentRow>();

    return Object.freeze({
      observation: toObservation(row),
      documents: Object.freeze(documents.results.map(toDocument)),
    });
  }

  /**
   * The hash this project's `path` carried at the last successful observation,
   * or null if it carried none.
   *
   * Deliberately scoped to that one observation rather than to the newest row
   * for the path. A document deleted from the repository leaves its last row
   * behind forever, so "newest row for this path" would keep reporting a hash
   * for a file that is gone, and the deletion would never be detected.
   */
  async readCurrentDocumentHash(projectId: string, path: ProjectDocumentPath): Promise<Sha256Hex | null> {
    const row = await this.database.prepare(
      `SELECT content_hash FROM project_documents
       WHERE project_id = ? AND path = ? AND observation_id = (
         SELECT observation_id FROM project_observations
         WHERE project_id = ? AND head_sha IS NOT NULL
         ORDER BY observed_at DESC, observation_id DESC LIMIT 1
       )`,
    ).bind(projectId, path, projectId).first<{ content_hash: string }>();
    return row === null ? null : (row.content_hash as Sha256Hex);
  }

  /** The digest-facing view of one project. */
  async readProjectStatus(project: TrackedProject): Promise<ProjectStatus> {
    const [latestObservation, success] = await Promise.all([
      this.readLatestObservation(project.projectId),
      this.readLatestSuccess(project.projectId),
    ]);
    return Object.freeze({
      project,
      latestObservation,
      latestSuccess: success?.observation ?? null,
      documents: success?.documents ?? Object.freeze([]),
      pollHealth: healthOf(latestObservation),
    });
  }

  async readActiveProjectStatuses(): Promise<readonly ProjectStatus[]> {
    const projects = await this.listActiveProjects();
    const statuses: ProjectStatus[] = [];
    for (const project of projects) statuses.push(await this.readProjectStatus(project));
    return Object.freeze(statuses);
  }
}
