/**
 * The vocabulary of the AI project manager.
 *
 * The plan's premise is that no new tracking discipline is needed. The
 * software standard already requires NEXT_STEPS.md, KNOWN_ISSUES.md,
 * DECISIONS.md and CHANGELOG.md in every project, so a project following the
 * standard is already reporting; this subsystem only reads what those four
 * files say and when the repository was last touched.
 *
 * Everything carried in a `ProjectDocument` is untrusted text written by
 * whoever can push to the repository. This subsystem extracts data from it --
 * a hash, a bounded excerpt, a date -- and never treats it as a directive.
 * Nothing here may be handed to a model as though it came from the owner: a
 * repository we poll is a source of facts about a project, not a source of
 * instructions to Jarvis, and the two must not be confused because one of
 * them is trusted and the other is a text file anyone with push access can
 * edit.
 */

import type { Sha256Hex } from "../../../../packages/contracts/src/index.js";

/**
 * The four files the standard requires, in the order a digest reads them.
 *
 * This list must stay identical to the CHECK constraint on
 * `project_documents.path` in 0010_projects.sql. A path added here but not
 * there fails at INSERT time, which -- because a failing insert aborts the
 * whole observation batch -- would lose the poll rather than the document.
 */
export const PROJECT_DOCUMENT_PATHS = [
  "NEXT_STEPS.md",
  "KNOWN_ISSUES.md",
  "DECISIONS.md",
  "CHANGELOG.md",
] as const;

export type ProjectDocumentPath = (typeof PROJECT_DOCUMENT_PATHS)[number];

/**
 * The two files whose change means something needs attention.
 *
 * A CHANGELOG entry is work already finished and a NEXT_STEPS edit is routine
 * planning, but a new known issue or a new decision is the project telling you
 * something you did not know. Pinging on all four would train the owner to
 * ignore the ping.
 */
export const ATTENTION_DOCUMENT_PATHS: readonly ProjectDocumentPath[] = Object.freeze([
  "KNOWN_ISSUES.md",
  "DECISIONS.md",
]);

/** Mirrors the CHECK on `project_documents.excerpt`. */
export const MAX_EXCERPT_CHARACTERS = 4096;

/** Mirrors the CHECK on `project_observations.failure`. */
export const MAX_FAILURE_CHARACTERS = 512;

export interface TrackedProject {
  readonly projectId: string;
  readonly owner: string;
  readonly repository: string;
  readonly displayName: string;
  /** Days without a commit before the project counts as stale. */
  readonly staleAfterDays: number;
  readonly active: boolean;
  readonly createdAt: string;
}

/**
 * One look at a repository. Append-only, and a failed look is recorded as
 * surely as a successful one: `headSha` and `failure` are mutually exclusive
 * and the schema's CHECK enforces exactly one of them.
 */
export interface ProjectObservation {
  readonly observationId: string;
  readonly projectId: string;
  readonly observedAt: string;
  readonly headSha: string | null;
  readonly lastCommitAt: string | null;
  readonly failure: string | null;
}

/** What one of the four files said at the commit an observation recorded. */
export interface ProjectDocument {
  readonly documentId: string;
  readonly observationId: string;
  readonly projectId: string;
  readonly path: ProjectDocumentPath;
  /** Over the whole file, not the excerpt -- see `boundedExcerpt`. */
  readonly contentHash: Sha256Hex;
  readonly excerpt: string;
  readonly observedAt: string;
}

/**
 * A document that appeared, changed, or went missing since the last
 * successful observation.
 *
 * `disappeared` is a change in its own right rather than an absence: a
 * KNOWN_ISSUES.md that was there last week and is gone today is a thing that
 * happened, and treating it as "no document, nothing to say" would hide it.
 */
export type DocumentChangeKind = "appeared" | "changed" | "disappeared";

export interface DocumentChange {
  readonly path: ProjectDocumentPath;
  readonly kind: DocumentChangeKind;
  readonly previousHash: Sha256Hex | null;
  readonly currentHash: Sha256Hex | null;
}

export interface ObservedDocuments {
  readonly observation: ProjectObservation;
  readonly documents: readonly ProjectDocument[];
}

export interface ProjectPollSuccess {
  readonly status: "observed";
  readonly projectId: string;
  readonly observationId: string;
  readonly observedAt: string;
  readonly headSha: string;
  readonly lastCommitAt: string;
  readonly documents: readonly ProjectDocument[];
  readonly changes: readonly DocumentChange[];
  /**
   * True when no successful observation preceded this one, in which case
   * every document present reads as `appeared`. Exposed rather than silently
   * suppressed so a digest can decide not to announce four changes the first
   * time a project is tracked, without this layer pretending nothing was seen.
   */
  readonly firstObservation: boolean;
}

export interface ProjectPollFailure {
  readonly status: "failed";
  readonly projectId: string;
  readonly observationId: string;
  readonly observedAt: string;
  readonly failure: string;
}

export type ProjectPollOutcome = ProjectPollSuccess | ProjectPollFailure;

/**
 * Whether the last thing we tried to do to this repository worked.
 *
 * `failing` exists because the plan's rule is that a source which has been
 * quietly failing for a week must alert rather than read as "nothing
 * changed". Without this field a digest cannot tell a calm project from an
 * unreachable one -- both have an unchanged document set.
 */
export type ProjectPollHealth = "ok" | "failing" | "never_polled";

/** The digest-facing view: what the four documents say, and how fresh it is. */
export interface ProjectStatus {
  readonly project: TrackedProject;
  /** The most recent observation of any kind, successful or failed. */
  readonly latestObservation: ProjectObservation | null;
  /** The most recent successful observation; the documents below are its. */
  readonly latestSuccess: ProjectObservation | null;
  readonly documents: readonly ProjectDocument[];
  readonly pollHealth: ProjectPollHealth;
}

/** The document at `path` in a status view, or null when it was absent. */
export function documentAt(status: ProjectStatus, path: ProjectDocumentPath): ProjectDocument | null {
  return status.documents.find((document) => document.path === path) ?? null;
}

/**
 * Count Unicode code points, which is what SQLite's `length()` counts for
 * TEXT. JavaScript's `.length` counts UTF-16 units, so a document full of
 * emoji would measure twice as long here as it does to the CHECK constraint.
 */
export function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const point = value.codePointAt(index);
    if (point !== undefined && point > 0xffff) index += 1;
    count += 1;
  }
  return count;
}

/**
 * Cut a document to the stored excerpt bound without splitting a surrogate
 * pair.
 *
 * `slice(0, 4096)` would satisfy the CHECK -- 4096 UTF-16 units is at most
 * 4096 code points -- but can end the string on a lone high surrogate, which
 * is not well-formed text and which downstream renderers mangle. Walking code
 * points costs one pass over at most a few thousand characters and removes
 * the whole class.
 */
export function boundedExcerpt(content: string, maximumCodePoints = MAX_EXCERPT_CHARACTERS): string {
  let end = 0;
  let counted = 0;
  while (end < content.length && counted < maximumCodePoints) {
    const point = content.codePointAt(end);
    end += point !== undefined && point > 0xffff ? 2 : 1;
    counted += 1;
  }
  return content.slice(0, end);
}

/**
 * Whether an excerpt sits at the storage bound, meaning the document may
 * continue past what was kept.
 *
 * A document exactly 4096 code points long is indistinguishable from a longer
 * one that was cut, so this over-reports by one file length. The stalled
 * detector treats both as "there may be more we did not see", which is the
 * safe direction: the alternative is asserting there is no deadline in a part
 * of the file nobody read.
 */
export function isExcerptAtCap(excerpt: string): boolean {
  return codePointLength(excerpt) >= MAX_EXCERPT_CHARACTERS;
}
