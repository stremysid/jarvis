/**
 * What the digest reads, expressed as the digest's own narrow interfaces.
 *
 * The composer declares what it needs rather than importing the deadline,
 * project and decision repositories. That is not ceremony: the digest is the
 * one place every subsystem meets, and importing four concrete repositories
 * would make it the file that has to change whenever any of them does. It
 * also makes the composer testable without a database, which matters because
 * the interesting behaviour here is what it says when a source is missing --
 * and a fixture can be missing in ways a real repository cannot easily be
 * made to be.
 */

/** Which kind of message a suppression window applies to. */
export type MessageClass = "digest" | "reminder" | "business" | "error" | "payment";

export interface DigestDeadline {
  readonly deadlineId: string;
  readonly course: string;
  readonly title: string;
  readonly dueAt: string;
  readonly effort: "quiz" | "test" | "exam" | "essay" | "project" | "other";
}

export interface DigestProject {
  readonly projectId: string;
  readonly displayName: string;
  /** ISO instant of the most recent commit, or null when the poll failed. */
  readonly lastCommitAt: string | null;
  /** First lines of NEXT_STEPS.md. Untrusted repository text -- see below. */
  readonly nextStepsExcerpt: string | null;
  /** Set when the project is stalled, saying why. */
  readonly stalledReason: string | null;
  /** Set when the most recent poll failed rather than succeeded. */
  readonly pollFailure: string | null;
  /** Documents whose content changed since the previous successful poll. */
  readonly changedDocuments: readonly string[];
}

export interface DigestDecision {
  readonly decisionId: string;
  readonly question: string;
  readonly urgency: "urgent" | "normal";
}

/**
 * A source that could not be read.
 *
 * Present in the digest deliberately. The plan's rule is that an empty or
 * failed fetch alerts rather than quietly reading as "nothing due" -- a digest
 * that omits a broken source is indistinguishable from one reporting a quiet
 * day, and that is the failure mode this whole design exists to avoid.
 */
export interface DigestGap {
  readonly source: string;
  readonly detail: string;
}

export interface DigestInput {
  readonly deadlines: readonly DigestDeadline[];
  readonly projects: readonly DigestProject[];
  readonly decisions: readonly DigestDecision[];
  readonly gaps: readonly DigestGap[];
}

export interface DigestSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

export interface Digest {
  readonly kind: "daily" | "retro";
  /** The local day the digest speaks about, as YYYY-MM-DD in the owner's zone. */
  readonly localDate: string;
  readonly sections: readonly DigestSection[];
  /** True when content was dropped to fit the channel's limit. */
  readonly truncated: boolean;
  readonly text: string;
}
