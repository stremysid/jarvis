import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import {
  SCHOOL_PROGRESS_ITEMS_PER_SWEEP,
  SCHOOL_PROGRESS_SWEEP_D1_STATEMENT_BUDGET,
  SchoolProgressRepository,
} from "../../src/school/school-progress-repository.js";
import type { RawSchoolProgressItem } from "../../src/school/school-progress-types.js";
import { applySchoolProgressMigration } from "../persistence/migration.js";

const NOW = new Date("2026-09-16T12:00:00.000Z");

async function addPrincipal(principalId: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?1, 'human', 'active', 'School owner', ?2, ?2)`)
    .bind(principalId, NOW.toISOString()).run();
}

function item(overrides: Partial<RawSchoolProgressItem> = {}): RawSchoolProgressItem {
  return {
    externalId: "course-chem:work-lab",
    course: "SCH4U Chemistry",
    title: "Acid-base lab",
    dueAt: "2026-09-15T20:00:00.000Z",
    maximumPoints: 100,
    submission: {
      externalId: "submission-lab",
      state: "created",
      late: false,
      sourceUpdatedAt: "2026-09-15T18:00:00.000Z",
    },
    assignedPoints: null,
    ...overrides,
  };
}

function queryCountingDatabase(): { readonly database: D1Database; queryCount(): number } {
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

beforeAll(async () => {
  await applySchoolProgressMigration();
  await new DeadlineRepository(env.DB).ensureSource({
    sourceId: "google-classroom",
    kind: "classroom",
    label: "Google Classroom",
    now: NOW,
  });
});

describe("SchoolProgressRepository", () => {
  it("labels a passed deadline as derived no submission seen instead of asserting that it was missed", async () => {
    const principalId = "principal:school-progress-derived";
    await addPrincipal(principalId);
    const repository = new SchoolProgressRepository(env.DB);

    await repository.ingestClassroomCourse({
      principalId,
      sourceId: "google-classroom",
      items: [item()],
      checkpointCourseId: "course-chem",
      checkpointWorkItemExternalId: null,
      healthGap: null,
      now: NOW,
    });

    const digest = await repository.readDigest(principalId);
    expect(digest.missingWork).toEqual([expect.objectContaining({
      course: "SCH4U Chemistry",
      title: "Acid-base lab",
      source: "Google Classroom API",
      checkedAt: NOW.toISOString(),
      label: "derived_no_submission_seen",
    })]);
    expect(JSON.stringify(digest)).not.toMatch(/you missed|was missed/iu);
  });

  it("resolves the derived transition after a submission signal and exposes only the verified assigned grade", async () => {
    const principalId = "principal:school-progress-submitted";
    await addPrincipal(principalId);
    const repository = new SchoolProgressRepository(env.DB);
    await repository.ingestClassroomCourse({
      principalId, sourceId: "google-classroom", items: [item()], checkpointCourseId: "course-chem",
      checkpointWorkItemExternalId: null,
      healthGap: null, now: NOW,
    });
    const returnedAt = new Date("2026-09-16T13:00:00.000Z");
    await repository.ingestClassroomCourse({
      principalId,
      sourceId: "google-classroom",
      items: [item({
        submission: {
          externalId: "submission-lab",
          state: "returned",
          late: true,
          sourceUpdatedAt: "2026-09-16T12:55:00.000Z",
        },
        assignedPoints: 84.5,
      })],
      checkpointCourseId: "course-chem",
      checkpointWorkItemExternalId: null,
      healthGap: null,
      now: returnedAt,
    });

    const digest = await repository.readDigest(principalId);
    expect(digest.missingWork).toEqual([]);
    expect(digest.grades).toEqual([expect.objectContaining({
      assignedPoints: 84.5,
      maximumPoints: 100,
      source: "Google Classroom API",
      observedAt: returnedAt.toISOString(),
      sourceUpdatedAt: "2026-09-16T12:55:00.000Z",
    })]);
  });

  it("keeps an absent due date and absent maximum absent", async () => {
    const principalId = "principal:school-progress-absent-fields";
    await addPrincipal(principalId);
    const repository = new SchoolProgressRepository(env.DB);
    await repository.ingestClassroomCourse({
      principalId,
      sourceId: "google-classroom",
      items: [item({
        externalId: "course-chem:work-reflection",
        title: "Reflection",
        dueAt: null,
        maximumPoints: null,
        submission: {
          externalId: "submission-reflection",
          state: "returned",
          late: null,
          sourceUpdatedAt: null,
        },
        assignedPoints: 7,
      })],
      checkpointCourseId: "course-chem",
      checkpointWorkItemExternalId: null,
      healthGap: null,
      now: NOW,
    });

    const digest = await repository.readDigest(principalId);
    expect(digest.missingWork).toEqual([]);
    expect(digest.grades[0]).toMatchObject({ title: "Reflection", assignedPoints: 7, maximumPoints: null });
  });

  it("keeps a failed course walk resumable at the last successful checkpoint", async () => {
    const principalId = "principal:school-progress-checkpoint";
    await addPrincipal(principalId);
    const repository = new SchoolProgressRepository(env.DB);
    await repository.ingestClassroomCourse({
      principalId, sourceId: "google-classroom", items: [item()], checkpointCourseId: "course-chem",
      checkpointWorkItemExternalId: null,
      healthGap: null, now: NOW,
    });
    await repository.recordFailure(
      principalId,
      "classroom_rejected",
      new Date("2026-09-16T13:00:00.000Z"),
    );

    await expect(repository.readSourceState(principalId, NOW)).resolves.toMatchObject({
      checkpointCourseId: "course-chem",
      lastFailure: "classroom_rejected",
      lastFailureAt: "2026-09-16T13:00:00.000Z",
    });
  });

  it("keeps the maximum course slice inside its declared D1 statement budget", async () => {
    const principalId = "principal:school-progress-budget";
    await addPrincipal(principalId);
    const counted = queryCountingDatabase();
    const repository = new SchoolProgressRepository(counted.database);
    const items = Array.from({ length: SCHOOL_PROGRESS_ITEMS_PER_SWEEP }, (_, index) => item({
      externalId: `course-budget:work-${index}`,
      title: `Assignment ${index}`,
      submission: {
        externalId: `submission-${index}`,
        state: "returned",
        late: false,
        sourceUpdatedAt: NOW.toISOString(),
      },
      assignedPoints: index,
    }));

    await repository.ingestClassroomCourse({
      principalId,
      sourceId: "google-classroom",
      items,
      checkpointCourseId: "course-budget",
      checkpointWorkItemExternalId: null,
      healthGap: null,
      now: NOW,
    });

    expect(counted.queryCount()).toBe(SCHOOL_PROGRESS_SWEEP_D1_STATEMENT_BUDGET);
  });

  it("refuses an unapproved source id before any observation can be stored", async () => {
    const principalId = "principal:school-progress-source";
    await addPrincipal(principalId);
    const repository = new SchoolProgressRepository(env.DB);
    await expect(repository.ingestClassroomCourse({
      principalId,
      sourceId: "brightspace-api" as "google-classroom",
      items: [item()],
      checkpointCourseId: null,
      checkpointWorkItemExternalId: null,
      healthGap: null,
      now: NOW,
    })).rejects.toThrow("school_progress_source_invalid");
  });
});
