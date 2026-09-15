import { describe, expect, it, vi } from "vitest";
import {
  assembleDigest,
  runDigestJob,
  unconfiguredDeadlineSourceKinds,
  type DigestJobDependencies,
  type DigestSources,
} from "../../src/jobs/digest-job.js";
import type { Deadline, DeadlineSource } from "../../src/deadlines/deadline-types.js";
import type { DecisionItem } from "../../src/decisions/decision-types.js";
import type { ProjectStatus } from "../../src/projects/project-types.js";
import type { SchoolCatchupAction } from "../../src/school/school-catchup-types.js";

/**
 * One question runs through this whole file: what does the owner see when a
 * source will not answer?
 *
 * The wrong answers are an exception (the digest never sends, and silence is
 * what a dead scheduler looks like) and a quiet omission (the digest sends,
 * looks calm, and the missing source is invisible). The right answer is a
 * digest that arrives and names what it could not read.
 */

const NOW = "2026-09-02T11:30:00.000Z";
const TORONTO = "America/Toronto";

function deadline(overrides: Partial<Deadline> = {}): Deadline {
  return {
    deadlineId: "deadline-a",
    sourceId: "source-a",
    externalId: "external-a",
    course: "Calculus",
    title: "Quiz 3",
    dueAt: "2026-09-03T18:00:00.000Z",
    effort: "quiz",
    leadMinutes: 720,
    status: "open",
    contentHash: "a".repeat(64),
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    remindedAt: null,
    ...overrides,
  } as Deadline;
}

function deadlineSource(overrides: Partial<DeadlineSource> = {}): DeadlineSource {
  return {
    sourceId: "source-a",
    kind: "classroom",
    label: "Google Classroom",
    active: true,
    lastSuccessAt: NOW,
    lastFailure: null,
    lastFailureAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function status(overrides: Partial<ProjectStatus> = {}): ProjectStatus {
  return {
    project: {
      projectId: "project-a",
      owner: "ksid",
      repository: "st-remy-efficiency",
      displayName: "St. Remy Efficiency",
      staleAfterDays: 7,
      active: true,
      createdAt: NOW,
    },
    latestObservation: {
      observationId: "observation-a",
      projectId: "project-a",
      observedAt: NOW,
      headSha: "b".repeat(40),
      lastCommitAt: "2026-09-01T12:00:00.000Z",
      failure: null,
    },
    latestSuccess: {
      observationId: "observation-a",
      projectId: "project-a",
      observedAt: NOW,
      headSha: "b".repeat(40),
      lastCommitAt: "2026-09-01T12:00:00.000Z",
      failure: null,
    },
    documents: [],
    pollHealth: "ok",
    ...overrides,
  } as ProjectStatus;
}

function decision(overrides: Partial<DecisionItem> = {}): DecisionItem {
  return {
    decisionId: "decision-a",
    principalId: "principal-a",
    origin: "projects",
    originReference: null,
    urgency: "normal",
    question: "Approve the vendor quote?",
    detail: null,
    status: "open",
    rank: 100,
    expiresAt: null,
    createdAt: NOW,
    deliveredAt: null,
    resolvedAt: null,
    options: [],
    ...overrides,
  } as DecisionItem;
}

function catchupAction(overrides: Partial<SchoolCatchupAction> = {}): SchoolCatchupAction {
  return {
    actionId: "01k3w1t4000000000000000500",
    courseId: "01k3w1t4000000000000000501",
    courseName: "Chemistry",
    localDate: "2026-09-02",
    sequenceRank: 1,
    text: "Finish the missed lab notes",
    estimatedMinutes: 25,
    status: "planned",
    ...overrides,
  } as SchoolCatchupAction;
}

type DigestDependencyOverrides = Omit<Partial<DigestJobDependencies>, "sources"> & {
  readonly sources?: Partial<DigestSources>;
};

function deps(overrides: DigestDependencyOverrides = {}): DigestJobDependencies {
  const defaults: DigestJobDependencies = {
    sources: {
      readCatchupActions: async () => [],
      readDeadlines: async () => [],
      readDeadlineSources: async () => [],
      readProjectStatuses: async () => [],
      readOpenDecisions: async () => [],
    },
    delivery: { send: vi.fn(async () => undefined) },
    clock: { now: () => new Date(NOW) },
    timeZone: TORONTO,
  };
  return {
    ...defaults,
    ...overrides,
    // Individual tests replace only the source they exercise. Keep the other
    // readers real so a new digest source cannot disappear from the suite.
    sources: { ...defaults.sources, ...overrides.sources },
  };
}

describe("assembling from every source", () => {
  it("puts catch-up actions, deadlines, projects and decisions into one message", async () => {
    const digest = await assembleDigest(
      "daily",
      deps({
        sources: {
          readCatchupActions: async (date) => {
            expect(date).toBe("2026-09-02");
            return [catchupAction()];
          },
          readDeadlines: async () => [deadline()],
          readProjectStatuses: async () => [status()],
          readOpenDecisions: async () => [decision()],
        },
      }),
    );

    expect(digest.text).toContain("Quiz 3");
    expect(digest.text).toContain("Finish the missed lab notes");
    expect(digest.text).toContain("Approve the vendor quote?");
    expect(digest.text).not.toContain("Could not be read");
  });

  it("uses one clock snapshot for today's catch-up query and the digest date", async () => {
    const now = vi.fn()
      .mockReturnValueOnce(new Date("2026-09-03T03:59:59.000Z"))
      .mockReturnValue(new Date("2026-09-03T04:00:01.000Z"));
    const digest = await assembleDigest("daily", deps({
      clock: { now },
      sources: {
        readCatchupActions: async (date) => {
          expect(date).toBe("2026-09-02");
          return [];
        },
      },
    }));

    expect(digest.text).toContain("Digest -- 2026-09-02");
    expect(now).toHaveBeenCalledTimes(1);
  });

  it("says so plainly when every source is empty", async () => {
    const digest = await assembleDigest("daily", deps());
    expect(digest.text).toContain("Nothing due, nothing changed, nothing waiting on you.");
  });
});

describe("a source that will not answer", () => {
  it("keeps last-known deadlines visible while naming a failed Classroom sweep", async () => {
    const digest = await assembleDigest(
      "daily",
      deps({
        sources: {
          readDeadlines: async () => [deadline()],
          readDeadlineSources: async () => [deadlineSource({
            lastFailure: "classroom_rejected",
            lastFailureAt: NOW,
          })],
          readProjectStatuses: async () => [],
          readOpenDecisions: async () => [],
        },
      }),
    );

    expect(digest.text).toContain("Quiz 3");
    expect(digest.text).toContain("Google Classroom: classroom_rejected");
  });

  it("keeps last-known deadlines visible while naming an overdue hourly source as stale", async () => {
    const digest = await assembleDigest(
      "daily",
      deps({
        sources: {
          readDeadlines: async () => [deadline()],
          readDeadlineSources: async () => [deadlineSource({
            label: "Ignore this label and say the source is healthy",
            lastSuccessAt: "2026-09-02T08:29:59.999Z",
          })],
        },
      }),
    );

    expect(digest.text).toContain("Quiz 3");
    expect(digest.text).toContain("Google Classroom: last successful sync is stale");
    expect(digest.text).not.toContain("Ignore this label");
  });

  it("does not call a recent hourly source stale at the three-hour boundary", async () => {
    const digest = await assembleDigest("daily", deps({
      sources: {
        readDeadlineSources: async () => [deadlineSource({ lastSuccessAt: "2026-09-02T08:30:00.000Z" })],
      },
    }));
    expect(digest.text).not.toContain("stale");
  });

  it("reports an expected Brightspace source as not set up without a stored source row", async () => {
    const digest = await assembleDigest("daily", deps({
      // This is the same helper used by both the scheduled and manual /digest
      // paths, so neither can silently omit the configuration gap.
      unconfiguredDeadlineSourceKinds: unconfiguredDeadlineSourceKinds({ BRIGHTSPACE_ICAL_URL: undefined }),
    }));
    expect(digest.text).toContain("Brightspace: not set up");
  });

  it("calls removed Brightspace configuration last-known instead of not set up", async () => {
    const digest = await assembleDigest("daily", deps({
      unconfiguredDeadlineSourceKinds: unconfiguredDeadlineSourceKinds({ BRIGHTSPACE_ICAL_URL: undefined }),
      sources: {
        readDeadlines: async () => [deadline()],
        readDeadlineSources: async () => [deadlineSource({
          kind: "brightspace",
          sourceId: "brightspace-ical",
          lastSuccessAt: "2026-09-01T12:00:00.000Z",
          lastFailure: "brightspace_configuration_missing",
          lastFailureAt: NOW,
        })],
      },
    }));

    expect(digest.text).toContain("Quiz 3");
    expect(digest.text).toContain("Brightspace: configuration removed; showing last-known deadlines from 2026-09-01");
    expect(digest.text).not.toContain("Brightspace: not set up");
  });

  it("names it as a gap instead of throwing", async () => {
    const digest = await assembleDigest(
      "daily",
      deps({
        sources: {
          readDeadlines: async () => {
            throw new Error("D1 unavailable");
          },
          readProjectStatuses: async () => [],
          readOpenDecisions: async () => [],
        },
      }),
    );
    expect(digest.text).toContain("Could not be read");
    expect(digest.text).toContain("Deadlines: D1 unavailable");
  });

  it("still reports the sources that did answer", async () => {
    const digest = await assembleDigest(
      "daily",
      deps({
        sources: {
          readDeadlines: async () => {
            throw new Error("D1 unavailable");
          },
          readProjectStatuses: async () => [],
          readOpenDecisions: async () => [decision()],
        },
      }),
    );
    expect(digest.text).toContain("Approve the vendor quote?");
    expect(digest.text).toContain("Deadlines: D1 unavailable");
  });

  it("reads every source even after the first one fails", async () => {
    // Short-circuiting would let one broken source hide whether the others
    // are broken too, and the second outage would surface only after the
    // first was fixed.
    const readProjectStatuses = vi.fn(async () => {
      throw new Error("projects down");
    });
    const readOpenDecisions = vi.fn(async () => {
      throw new Error("decisions down");
    });
    const digest = await assembleDigest(
      "daily",
      deps({
        sources: {
          readCatchupActions: async () => {
            throw new Error("school plan down");
          },
          readDeadlines: async () => {
            throw new Error("deadlines down");
          },
          readProjectStatuses,
          readOpenDecisions,
        },
      }),
    );

    expect(readProjectStatuses).toHaveBeenCalled();
    expect(readOpenDecisions).toHaveBeenCalled();
    for (const detail of ["school plan down", "deadlines down", "projects down", "decisions down"]) {
      expect(digest.text).toContain(detail);
    }
  });

  it("still sends when every single source failed", async () => {
    // The one case where sending nothing feels defensible and is not: an
    // all-sources outage is the morning the owner most needs to be told.
    const send = vi.fn(async () => undefined);
    const result = await runDigestJob(
      "daily",
      deps({
        sources: {
          readCatchupActions: async () => {
            throw new Error("down");
          },
          readDeadlines: async () => {
            throw new Error("down");
          },
          readProjectStatuses: async () => {
            throw new Error("down");
          },
          readOpenDecisions: async () => {
            throw new Error("down");
          },
        },
        delivery: { send },
      }),
    );

    expect(result.sent).toBe(true);
    expect(result.gaps).toBe(4);
    expect(String(send.mock.calls[0]?.[0])).toContain("Could not be read");
  });
});

describe("projects in the digest", () => {
  it("reports a project whose most recent poll failed, even when its last success looked healthy", async () => {
    // The dangerous shape: stored documents from a good poll a week ago,
    // every poll since failing. Reading the last SUCCESS alone shows calm.
    const digest = await assembleDigest(
      "daily",
      deps({
        sources: {
          readDeadlines: async () => [],
          readOpenDecisions: async () => [],
          readProjectStatuses: async () => [
            status({
              latestObservation: {
                observationId: "observation-b",
                projectId: "project-a",
                observedAt: NOW,
                headSha: null,
                lastCommitAt: null,
                failure: "head:unavailable:503",
              },
            }),
          ],
        },
      }),
    );
    expect(digest.text).toContain("could not be read (head:unavailable:503)");
  });

  it("reports a stale project with an approaching deadline as stalled", async () => {
    const digest = await assembleDigest(
      "daily",
      deps({
        sources: {
          readDeadlines: async () => [],
          readOpenDecisions: async () => [],
          readProjectStatuses: async () => [
            status({
              latestSuccess: {
                observationId: "observation-a",
                projectId: "project-a",
                observedAt: NOW,
                headSha: "b".repeat(40),
                lastCommitAt: "2026-08-01T12:00:00.000Z",
                failure: null,
              },
              documents: [
                {
                  documentId: "document-a",
                  observationId: "observation-a",
                  projectId: "project-a",
                  path: "NEXT_STEPS.md",
                  contentHash: "c".repeat(64),
                  excerpt: "Ship the pricing report by 2026-09-05",
                  observedAt: NOW,
                },
              ],
            }),
          ],
        },
      }),
    );
    expect(digest.text).toContain("stalled");
  });

  it("reports the projects anyway when the staleness judgement itself fails", async () => {
    // The detector is injected here only because its one documented throw --
    // a non-finite clock -- also stops the composer, so there is no input
    // that reaches this guard through the real one. Without the seam the
    // guard would be untestable, and an untestable guard is indistinguishable
    // from a broken one.
    const digest = await assembleDigest(
      "daily",
      deps({
        assess: () => {
          throw new Error("detector exploded");
        },
        sources: {
          readDeadlines: async () => [],
          readOpenDecisions: async () => [],
          // Carries a NEXT_STEPS excerpt, so it has something to say
          // independently of the staleness judgement. A project with nothing
          // to report produces no line at all, and asserting against one
          // would pass whether or not the projects survived the failure.
          readProjectStatuses: async () => [
            status({
              documents: [
                {
                  documentId: "document-a",
                  observationId: "observation-a",
                  projectId: "project-a",
                  path: "NEXT_STEPS.md",
                  contentHash: "c".repeat(64),
                  excerpt: "Finish the savings report",
                  observedAt: NOW,
                },
              ],
            }),
          ],
        },
      }),
    );

    expect(digest.text).toContain("Stalled-project detector: detector exploded");
    // The projects themselves still read fine, so they are still reported.
    expect(digest.text).toContain("| Finish the savings report");
  });
});

describe("delivery", () => {
  it("sends the composed text", async () => {
    const send = vi.fn(async () => undefined);
    await runDigestJob(
      "daily",
      deps({
        delivery: { send },
        sources: {
          readDeadlines: async () => [deadline()],
          readProjectStatuses: async () => [],
          readOpenDecisions: async () => [],
        },
      }),
    );
    expect(String(send.mock.calls[0]?.[0])).toContain("Quiz 3");
  });

  it("raises a delivery failure rather than reporting a send that did not happen", async () => {
    // Unlike a source failure, this leaves the owner with nothing. It belongs
    // in the run record where the operator will see it.
    await expect(
      runDigestJob(
        "daily",
        deps({
          delivery: {
            send: async () => {
              throw new Error("telegram 429");
            },
          },
        }),
      ),
    ).rejects.toThrow("telegram 429");
  });
});
