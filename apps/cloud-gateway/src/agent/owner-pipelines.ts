import type { Env } from "../env.js";
import type { ModelAdapter } from "../model/model-types.js";
import type { ModelFunctionCall } from "../providers/provider-types.js";
import type { Redactor } from "../security/redaction.js";
import { SchoolCatchupModelAdapter } from "../school/school-catchup-model.js";
import { SchoolCatchupRepository } from "../school/school-catchup-repository.js";
import { StudyCoachModelAdapter } from "../school/study-coach-model.js";
import { StudyCoachRepository } from "../school/study-coach-repository.js";
import { UniversityTrackerRepository } from "../university/university-tracker-repository.js";
import { runOnDemandBrightspaceRefresh } from "../jobs/job-table.js";

export interface OwnerPipelineModels {
  readonly schoolModel: ModelAdapter;
  readonly universityModel: ModelAdapter;
  readonly studyCoachModel: ModelAdapter;
}

export function ownerPipelineModel(models: OwnerPipelineModels, call: ModelFunctionCall): ModelAdapter | null {
  const pipelines: Readonly<Record<string, ModelAdapter>> = {
    school_update: models.schoolModel,
    university_update: models.universityModel,
    study_coach: models.studyCoachModel,
  };
  return Object.hasOwn(pipelines, call.name) ? pipelines[call.name]! : null;
}

/** Both channels reach the same repositories and validated pipeline bodies. */
export function createOwnerPipelineModels(
  env: Env, baseModel: ModelAdapter, redactor: Redactor,
  ownerPrincipalId: string, ownerTurnAuthoritative: boolean,
  now: () => Date = () => new Date(),
): OwnerPipelineModels {
  const schoolRepository = new SchoolCatchupRepository(env.DB);
  const universityRepository = new UniversityTrackerRepository(env.DB);
  const schoolModel = new SchoolCatchupModelAdapter({
    model: baseModel,
    database: env.DB, // Without this, a pinned daily capacity never reaches the planner.
    repository: schoolRepository,
    redactor,
    now,
    timeZone: env.DIGEST_TIMEZONE ?? "America/Toronto",
    ownerPrincipalId,
    ownerTurnAuthoritative,
    agentSelectedScope: "school",
    fixedActionReceipts: true,
    refreshBrightspace: async (now, signal) => runOnDemandBrightspaceRefresh({
      env,
      clock: { now: () => new Date(now.getTime()) },
      delivery: { send: async () => undefined },
      fetcher: globalThis.fetch.bind(globalThis),
      signal,
    }),
  });
  const universityModel = new SchoolCatchupModelAdapter({
    model: baseModel,
    repository: schoolRepository,
    universityRepository,
    redactor,
    now,
    timeZone: env.DIGEST_TIMEZONE ?? "America/Toronto",
    ownerPrincipalId,
    ownerTurnAuthoritative,
    agentSelectedScope: "university",
    fixedActionReceipts: true,
  });
  const studyFallbackModel: ModelAdapter = {
    async *stream() {
      yield Object.freeze({
        index: 0,
        text: "I couldn't identify one validated study-coach action from that message. Nothing changed.",
      });
    },
  };
  const studyModel = new StudyCoachModelAdapter({
    fallbackModel: studyFallbackModel,
    practiceModel: baseModel,
    repository: new StudyCoachRepository(env.DB),
    redactor,
    now,
    ownerPrincipalId,
    ownerTurnAuthoritative,
    timeZone: env.DIGEST_TIMEZONE ?? "America/Toronto",
  });
  return Object.freeze({ schoolModel, universityModel, studyCoachModel: studyModel });
}
