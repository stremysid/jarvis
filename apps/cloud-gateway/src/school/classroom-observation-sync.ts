import type {
  ClassroomCourse,
  ClassroomSubmissionPage,
} from "../deadlines/classroom-client.js";
import {
  MISSING_WORK_DERIVATION_PAGE_SIZE,
  type D1StatementBudget,
  type SchoolObservationRepository,
} from "./school-observation-repository.js";

/** Four bounded API pages keeps the matching D1 writes inside the declared budget. */
export const CLASSROOM_SUBMISSION_REQUEST_BUDGET = 4;
const MAXIMUM_SCAN_AGE_MS = 24 * 60 * 60 * 1_000;

export interface ClassroomSubmissionPageReader {
  listSubmissionPage(courseId: string, pageToken: string | null): Promise<ClassroomSubmissionPage>;
}

export interface ClassroomObservationSyncResult {
  readonly outcome: "complete" | "partial" | "failed";
  readonly pages: number;
  readonly seen: number;
  readonly rejected: number;
  readonly transitions: number;
  readonly failure: string | null;
  readonly statementsUsed: number;
}

export interface ClassroomObservationSyncOptions {
  readonly repository: SchoolObservationRepository;
  readonly client: ClassroomSubmissionPageReader;
  readonly courses: readonly ClassroomCourse[];
  readonly principalId: string;
  readonly sourceId: string;
  readonly budget: D1StatementBudget;
  readonly now: () => Date;
}

function safeFailure(error: unknown): string {
  if (error instanceof Error && /^(?:classroom|school_observation)_[a-z0-9_]+$/u.test(error.message)) {
    return error.message.slice(0, 160);
  }
  return "school_observation_sync_failed";
}

function orderedCourses(courses: readonly ClassroomCourse[]): readonly ClassroomCourse[] {
  const seen = new Set<string>();
  const ordered = [...courses].sort((left, right) => left.id.localeCompare(right.id));
  for (const course of ordered) {
    if (seen.has(course.id)) throw new TypeError("classroom_course_list_duplicate");
    seen.add(course.id);
  }
  return Object.freeze(ordered);
}

/**
 * Advance one resumable Classroom submission slice.
 *
 * A provider page token is persisted after every page. If a request or D1
 * write fails, the next run resumes the same page and content-addressed
 * ingestion makes the replay safe. A checkpoint whose course disappeared is
 * recorded as a visible failure and reset for the following run.
 */
export async function runClassroomObservationSync(
  options: ClassroomObservationSyncOptions,
): Promise<ClassroomObservationSyncResult> {
  const observedAt = new Date(options.now().getTime());
  let pages = 0;
  let seen = 0;
  let rejected = 0;
  let transitions = 0;
  try {
    let sync = await options.repository.ensureSync(
      options.principalId,
      options.sourceId,
      observedAt,
    );

    if (sync.derivationScanAt !== null) {
      if (sync.derivationStartedAt === null) throw new Error("school_observation_checkpoint_invalid");
      const report = await options.repository.deriveMissingWorkPage({
        principalId: options.principalId,
        sourceId: options.sourceId,
        derivedAt: sync.derivationScanAt,
        observationsSeenSince: sync.derivationStartedAt,
        afterDeadlineId: sync.derivationAfterDeadlineId,
        limit: MISSING_WORK_DERIVATION_PAGE_SIZE,
      });
      transitions += report.transitions;
      if (report.nextAfterDeadlineId === null) {
        await options.repository.completeDerivation(options.principalId, options.sourceId, observedAt);
        return Object.freeze({
          outcome: "complete" as const,
          pages, seen, rejected, transitions, failure: null,
          statementsUsed: options.budget.used,
        });
      }
      await options.repository.saveDerivationCheckpoint(
        options.principalId,
        options.sourceId,
        report.nextAfterDeadlineId,
        observedAt,
      );
      return Object.freeze({
        outcome: "partial" as const,
        pages, seen, rejected, transitions, failure: null,
        statementsUsed: options.budget.used,
      });
    }

    const courses = orderedCourses(options.courses);
    if (courses.length === 0) {
      await options.repository.recordFailure({
        principalId: options.principalId,
        sourceId: options.sourceId,
        failure: "classroom_observation_empty_course_sweep",
        now: observedAt,
        resetScan: true,
      });
      return Object.freeze({
        outcome: "failed" as const,
        pages, seen, rejected, transitions,
        failure: "classroom_observation_empty_course_sweep",
        statementsUsed: options.budget.used,
      });
    }

    let courseIndex = sync.checkpointCourseId === null
      ? 0
      : courses.findIndex((course) => course.id === sync.checkpointCourseId);
    if (courseIndex < 0) {
      await options.repository.recordFailure({
        principalId: options.principalId,
        sourceId: options.sourceId,
        failure: "classroom_observation_checkpoint_course_missing",
        now: observedAt,
        resetScan: true,
      });
      return Object.freeze({
        outcome: "failed" as const,
        pages, seen, rejected, transitions,
        failure: "classroom_observation_checkpoint_course_missing",
        statementsUsed: options.budget.used,
      });
    }
    let pageToken = sync.checkpointPageToken;
    const scanStartedAt = sync.scanStartedAt ?? observedAt.toISOString();
    const scanAge = observedAt.getTime() - Date.parse(scanStartedAt);
    if (!Number.isFinite(scanAge) || scanAge < 0 || scanAge > MAXIMUM_SCAN_AGE_MS) {
      await options.repository.recordFailure({
        principalId: options.principalId,
        sourceId: options.sourceId,
        failure: "classroom_observation_checkpoint_stale",
        now: observedAt,
        resetScan: true,
      });
      return Object.freeze({
        outcome: "failed" as const,
        pages, seen, rejected, transitions,
        failure: "classroom_observation_checkpoint_stale",
        statementsUsed: options.budget.used,
      });
    }
    if (sync.checkpointCourseId === null) {
      await options.repository.saveCheckpoint({
        principalId: options.principalId,
        sourceId: options.sourceId,
        courseId: courses[courseIndex]!.id,
        pageToken: null,
        scanStartedAt,
        now: observedAt,
      });
      sync = { ...sync, checkpointCourseId: courses[courseIndex]!.id, scanStartedAt };
    }

    const seenPageTokens = new Set<string>();
    if (pageToken !== null) seenPageTokens.add(pageToken);
    while (pages < CLASSROOM_SUBMISSION_REQUEST_BUDGET) {
      const course = courses[courseIndex];
      if (course === undefined) throw new Error("classroom_observation_checkpoint_invalid");
      const page = await options.client.listSubmissionPage(course.id, pageToken);
      pages += 1;
      const report = await options.repository.ingest({
        principalId: options.principalId,
        sourceId: options.sourceId,
        items: page.items,
        sourceRejectedCount: page.rejected,
        now: observedAt,
      });
      seen += report.created + report.revised + report.unchanged;
      rejected += report.rejected;

      if (page.nextPageToken !== null) {
        if (seenPageTokens.has(page.nextPageToken)) throw new Error("classroom_pagination_unbounded");
        seenPageTokens.add(page.nextPageToken);
        pageToken = page.nextPageToken;
        await options.repository.saveCheckpoint({
          principalId: options.principalId,
          sourceId: options.sourceId,
          courseId: course.id,
          pageToken,
          scanStartedAt,
          now: observedAt,
        });
        continue;
      }

      courseIndex += 1;
      pageToken = null;
      const nextCourse = courses[courseIndex];
      if (nextCourse !== undefined) {
        await options.repository.saveCheckpoint({
          principalId: options.principalId,
          sourceId: options.sourceId,
          courseId: nextCourse.id,
          pageToken: null,
          scanStartedAt,
          now: observedAt,
        });
        continue;
      }

      await options.repository.completeSubmissionScan(options.principalId, options.sourceId, observedAt);
      const derived = await options.repository.deriveMissingWorkPage({
        principalId: options.principalId,
        sourceId: options.sourceId,
        derivedAt: observedAt.toISOString(),
        observationsSeenSince: scanStartedAt,
        afterDeadlineId: null,
        limit: MISSING_WORK_DERIVATION_PAGE_SIZE,
      });
      transitions += derived.transitions;
      if (derived.nextAfterDeadlineId === null) {
        await options.repository.completeDerivation(options.principalId, options.sourceId, observedAt);
        return Object.freeze({
          outcome: "complete" as const,
          pages, seen, rejected, transitions, failure: null,
          statementsUsed: options.budget.used,
        });
      }
      await options.repository.saveDerivationCheckpoint(
        options.principalId,
        options.sourceId,
        derived.nextAfterDeadlineId,
        observedAt,
      );
      return Object.freeze({
        outcome: "partial" as const,
        pages, seen, rejected, transitions, failure: null,
        statementsUsed: options.budget.used,
      });
    }

    return Object.freeze({
      outcome: "partial" as const,
      pages, seen, rejected, transitions, failure: null,
      statementsUsed: options.budget.used,
    });
  } catch (error) {
    const failure = safeFailure(error);
    try {
      await options.repository.recordFailure({
        principalId: options.principalId,
        sourceId: options.sourceId,
        failure,
        now: observedAt,
      });
    } catch {
      // The original failure remains the result. A second failure while
      // recording it cannot safely be reported as durable health evidence.
    }
    return Object.freeze({
      outcome: "failed" as const,
      pages, seen, rejected, transitions, failure,
      statementsUsed: options.budget.used,
    });
  }
}
