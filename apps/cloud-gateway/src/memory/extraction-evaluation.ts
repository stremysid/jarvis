import type { MemoryFactOriginV1 } from "../../../../packages/contracts/src/memory-projection.js";
import { isAuthenticatedFirstPersonQuote } from "./extraction-policy.js";

export interface EvaluationEvent {
  readonly eventId: string;
  readonly speaker: "owner" | "assistant" | "third_party";
  readonly authenticatedOwner: boolean;
  readonly text: string;
}

export interface ExpectedMemory {
  readonly memoryId: string;
  readonly acceptableTexts: readonly string[];
  readonly sourceEventIds: readonly string[];
  readonly origin: MemoryFactOriginV1;
  readonly uncertain: boolean;
  readonly topicPath: readonly string[];
}

export interface EvaluationCase {
  readonly caseId: string;
  readonly conversation: readonly EvaluationEvent[];
  readonly expectedMemories: readonly ExpectedMemory[];
  readonly forbiddenMemories: readonly string[];
}

export interface ExtractionEvaluationSuite {
  readonly schemaVersion: "1.0";
  readonly cases: readonly EvaluationCase[];
}

export interface CandidateMemory {
  readonly text: string;
  readonly sourceEventIds: readonly string[];
  readonly origin: MemoryFactOriginV1;
  readonly uncertain: boolean;
  readonly topicPath: readonly string[];
}

export interface ExtractionCandidateRun {
  readonly modelId: string;
  readonly outputs: readonly {
    readonly caseId: string;
    readonly memories: readonly CandidateMemory[];
  }[];
}

export interface EvaluationSafetyFailure {
  readonly caseId: string;
  readonly reason:
    | "model_guess_not_uncertain"
    | "forbidden_memory_emitted"
    | "source_not_in_conversation"
    | "trusted_origin_not_supported"
    | "unsupported_candidate_origin";
  readonly text: string;
}

export interface ExtractionEvaluationResult {
  readonly modelId: string;
  readonly expectedMemories: number;
  readonly matchedMemories: number;
  readonly unexpectedMemories: number;
  readonly provenanceMatches: number;
  readonly originMatches: number;
  readonly uncertaintyMatches: number;
  readonly topicMatches: number;
  readonly safetyFailures: readonly EvaluationSafetyFailure[];
  readonly qualityScore: number;
  readonly eligibleForSelection: boolean;
}

const ORIGINS: ReadonlySet<string> = new Set([
  "authenticated_first_person",
  "deterministic_observation",
  "model",
  "third_party",
]);
const SPEAKERS: ReadonlySet<string> = new Set(["owner", "assistant", "third_party"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function stringArray(value: unknown, error: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value)
    || (!allowEmpty && value.length === 0)
    || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new TypeError(error);
  }
  return Object.freeze(value.map((item) => (item as string).normalize("NFC").trim()));
}

function requiredString(value: unknown, error: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(error);
  return value.normalize("NFC").trim();
}

function parseEvent(value: unknown): EvaluationEvent {
  if (!isPlainObject(value)) throw new TypeError("evaluation_event_invalid");
  const eventId = requiredString(value.eventId, "evaluation_event_id_invalid");
  if (typeof value.speaker !== "string" || !SPEAKERS.has(value.speaker)) {
    throw new TypeError("evaluation_event_speaker_invalid");
  }
  if (typeof value.authenticatedOwner !== "boolean") {
    throw new TypeError("evaluation_event_authentication_invalid");
  }
  return Object.freeze({
    eventId,
    speaker: value.speaker as EvaluationEvent["speaker"],
    authenticatedOwner: value.authenticatedOwner,
    text: requiredString(value.text, "evaluation_event_text_invalid"),
  });
}

function parseExpectedMemory(value: unknown): ExpectedMemory {
  if (!isPlainObject(value)) throw new TypeError("evaluation_memory_invalid");
  if (typeof value.origin !== "string" || !ORIGINS.has(value.origin)) {
    throw new TypeError("evaluation_memory_origin_invalid");
  }
  if (typeof value.uncertain !== "boolean") {
    throw new TypeError("evaluation_memory_uncertainty_invalid");
  }
  return Object.freeze({
    memoryId: requiredString(value.memoryId, "evaluation_memory_id_invalid"),
    acceptableTexts: stringArray(value.acceptableTexts, "evaluation_memory_texts_invalid"),
    sourceEventIds: stringArray(value.sourceEventIds, "evaluation_memory_sources_invalid"),
    origin: value.origin as MemoryFactOriginV1,
    uncertain: value.uncertain,
    topicPath: stringArray(value.topicPath, "evaluation_memory_topic_invalid"),
  });
}

function hasFirstPersonSupport(
  memory: Pick<CandidateMemory, "text" | "sourceEventIds">,
  conversation: readonly EvaluationEvent[],
): boolean {
  const sourceIds = new Set(memory.sourceEventIds);
  return conversation.some((event) =>
    sourceIds.has(event.eventId)
      && event.speaker === "owner"
      && isAuthenticatedFirstPersonQuote({
        quote: memory.text,
        sourceText: event.text,
        authenticatedOwner: event.authenticatedOwner,
      }));
}

/** Parse static, synthetic evaluation data before any model comparison. */
export function parseEvaluationSuite(value: unknown): ExtractionEvaluationSuite {
  if (!isPlainObject(value) || value.schemaVersion !== "1.0") {
    throw new TypeError("evaluation_schema_invalid");
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new TypeError("evaluation_cases_required");
  }
  const seenCases = new Set<string>();
  const cases = value.cases.map((rawCase): EvaluationCase => {
    if (!isPlainObject(rawCase)) throw new TypeError("evaluation_case_invalid");
    const caseId = requiredString(rawCase.caseId, "evaluation_case_id_invalid");
    if (seenCases.has(caseId)) throw new RangeError("evaluation_case_id_duplicate");
    seenCases.add(caseId);
    if (!Array.isArray(rawCase.conversation) || rawCase.conversation.length === 0) {
      throw new TypeError("evaluation_conversation_required");
    }
    if (!Array.isArray(rawCase.expectedMemories)) {
      throw new TypeError("evaluation_expected_memories_invalid");
    }
    const conversation = rawCase.conversation.map(parseEvent);
    const eventIds = new Set(conversation.map((event) => event.eventId));
    if (eventIds.size !== conversation.length) {
      throw new RangeError("evaluation_event_id_duplicate");
    }
    const expectedMemories = rawCase.expectedMemories.map(parseExpectedMemory);
    const memoryIds = new Set(expectedMemories.map((memory) => memory.memoryId));
    if (memoryIds.size !== expectedMemories.length) {
      throw new RangeError("evaluation_memory_id_duplicate");
    }
    for (const memory of expectedMemories) {
      if (memory.sourceEventIds.some((sourceId) => !eventIds.has(sourceId))) {
        throw new RangeError("evaluation_expected_source_missing");
      }
      if (memory.origin === "model" && !memory.uncertain) {
        throw new RangeError("evaluation_model_guess_must_be_uncertain");
      }
      if (memory.origin === "authenticated_first_person"
        && !memory.acceptableTexts.some((text) =>
          hasFirstPersonSupport({ ...memory, text }, conversation))) {
        throw new RangeError("evaluation_trusted_origin_not_supported");
      }
    }
    return Object.freeze({
      caseId,
      conversation: Object.freeze(conversation),
      expectedMemories: Object.freeze(expectedMemories),
      forbiddenMemories: stringArray(
        rawCase.forbiddenMemories,
        "evaluation_forbidden_memories_invalid",
        true,
      ),
    });
  });
  return Object.freeze({ schemaVersion: "1.0", cases: Object.freeze(cases) });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].toSorted();
  const sortedRight = [...right].toSorted();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizedText(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function parseCandidateMemory(value: unknown): CandidateMemory {
  if (!isPlainObject(value)) throw new TypeError("evaluation_candidate_memory_invalid");
  if (typeof value.origin !== "string" || !ORIGINS.has(value.origin)) {
    throw new TypeError("evaluation_candidate_origin_invalid");
  }
  if (typeof value.uncertain !== "boolean") {
    throw new TypeError("evaluation_candidate_uncertainty_invalid");
  }
  return Object.freeze({
    text: requiredString(value.text, "evaluation_candidate_text_invalid"),
    sourceEventIds: stringArray(value.sourceEventIds, "evaluation_candidate_sources_invalid"),
    origin: value.origin as MemoryFactOriginV1,
    uncertain: value.uncertain,
    topicPath: stringArray(value.topicPath, "evaluation_candidate_topic_invalid"),
  });
}

function parseCandidateRun(
  suite: ExtractionEvaluationSuite,
  value: unknown,
): ExtractionCandidateRun {
  if (!isPlainObject(value)) throw new TypeError("evaluation_run_invalid");
  if (!Array.isArray(value.outputs)) throw new TypeError("evaluation_outputs_invalid");
  const knownCaseIds = new Set(suite.cases.map((testCase) => testCase.caseId));
  const seenCaseIds = new Set<string>();
  const outputs = value.outputs.map((rawOutput) => {
    if (!isPlainObject(rawOutput)) throw new TypeError("evaluation_output_invalid");
    const caseId = requiredString(rawOutput.caseId, "evaluation_output_case_id_invalid");
    if (!knownCaseIds.has(caseId)) throw new RangeError("evaluation_output_case_unknown");
    if (seenCaseIds.has(caseId)) throw new RangeError("evaluation_output_case_duplicate");
    seenCaseIds.add(caseId);
    if (!Array.isArray(rawOutput.memories)) {
      throw new TypeError("evaluation_output_memories_invalid");
    }
    return Object.freeze({
      caseId,
      memories: Object.freeze(rawOutput.memories.map(parseCandidateMemory)),
    });
  });
  return Object.freeze({
    modelId: requiredString(value.modelId, "evaluation_model_id_invalid"),
    outputs: Object.freeze(outputs),
  });
}

/**
 * Score already-captured outputs. This function has no provider, network, or
 * filesystem dependency; a live run must be supplied separately by Sid.
 */
export function evaluateExtractionRun(
  suite: ExtractionEvaluationSuite,
  run: ExtractionCandidateRun,
): ExtractionEvaluationResult {
  const parsedRun = parseCandidateRun(suite, run);
  const outputByCase = new Map<string, readonly CandidateMemory[]>();
  for (const output of parsedRun.outputs) {
    outputByCase.set(output.caseId, output.memories);
  }

  let expectedMemories = 0;
  let matchedMemories = 0;
  let unexpectedMemories = 0;
  let provenanceMatches = 0;
  let originMatches = 0;
  let uncertaintyMatches = 0;
  let topicMatches = 0;
  const safetyFailures: EvaluationSafetyFailure[] = [];

  for (const testCase of suite.cases) {
    expectedMemories += testCase.expectedMemories.length;
    const candidates = outputByCase.get(testCase.caseId) ?? [];
    const matchedCandidateIndexes = new Set<number>();
    const conversationIds = new Set(testCase.conversation.map((event) => event.eventId));

    for (const expected of testCase.expectedMemories) {
      const candidateIndex = candidates.findIndex((candidate, index) =>
        !matchedCandidateIndexes.has(index)
          && expected.acceptableTexts.some((text) =>
            normalizedText(text) === normalizedText(candidate.text)));
      if (candidateIndex === -1) continue;
      matchedCandidateIndexes.add(candidateIndex);
      matchedMemories += 1;
      const candidate = candidates[candidateIndex];
      if (candidate === undefined) continue;
      if (sameStrings(expected.sourceEventIds, candidate.sourceEventIds)) provenanceMatches += 1;
      if (expected.origin === candidate.origin) originMatches += 1;
      if (expected.uncertain === candidate.uncertain) uncertaintyMatches += 1;
      if (samePath(expected.topicPath, candidate.topicPath)) topicMatches += 1;
    }

    unexpectedMemories += candidates.length - matchedCandidateIndexes.size;
    for (const candidate of candidates) {
      if (candidate.origin === "model" && !candidate.uncertain) {
        safetyFailures.push({
          caseId: testCase.caseId,
          reason: "model_guess_not_uncertain",
          text: candidate.text,
        });
      }
      if (candidate.origin !== "model" && candidate.origin !== "authenticated_first_person") {
        safetyFailures.push({
          caseId: testCase.caseId,
          reason: "unsupported_candidate_origin",
          text: candidate.text,
        });
      }
      if (candidate.origin === "authenticated_first_person"
        && !hasFirstPersonSupport(candidate, testCase.conversation)) {
        safetyFailures.push({
          caseId: testCase.caseId,
          reason: "trusted_origin_not_supported",
          text: candidate.text,
        });
      }
      if (testCase.forbiddenMemories.some((text) =>
        normalizedText(text) === normalizedText(candidate.text))) {
        safetyFailures.push({
          caseId: testCase.caseId,
          reason: "forbidden_memory_emitted",
          text: candidate.text,
        });
      }
      if (candidate.sourceEventIds.some((sourceId) => !conversationIds.has(sourceId))) {
        safetyFailures.push({
          caseId: testCase.caseId,
          reason: "source_not_in_conversation",
          text: candidate.text,
        });
      }
    }
  }

  const possibleQualityPoints = expectedMemories * 5;
  const earnedQualityPoints = matchedMemories
    + provenanceMatches
    + originMatches
    + uncertaintyMatches
    + topicMatches;
  const baseScore = possibleQualityPoints === 0
    ? 100
    : (earnedQualityPoints / possibleQualityPoints) * 100;
  // One valid extra costs half of one completely missed memory. Scaling by the
  // suite size preserves that relationship when the real comparison grows.
  const unexpectedMemoryPenalty = expectedMemories === 0
    ? unexpectedMemories * 100
    : unexpectedMemories * (100 / expectedMemories) / 2;
  const qualityScore = Math.max(
    0,
    Math.round((baseScore - unexpectedMemoryPenalty) * 100) / 100,
  );

  return Object.freeze({
    modelId: parsedRun.modelId,
    expectedMemories,
    matchedMemories,
    unexpectedMemories,
    provenanceMatches,
    originMatches,
    uncertaintyMatches,
    topicMatches,
    safetyFailures: Object.freeze(safetyFailures.map((failure) => Object.freeze(failure))),
    qualityScore,
    eligibleForSelection: safetyFailures.length === 0
      && (expectedMemories === 0 || matchedMemories > 0),
  });
}

/** Rank offline results with the uncertainty safety gate ahead of raw quality. */
export function rankExtractionResults(
  results: readonly ExtractionEvaluationResult[],
): readonly ExtractionEvaluationResult[] {
  const modelIds = new Set(results.map((result) => result.modelId));
  if (modelIds.size !== results.length) {
    throw new RangeError("evaluation_model_id_duplicate");
  }
  return Object.freeze([...results].toSorted((left, right) =>
    Number(right.eligibleForSelection) - Number(left.eligibleForSelection)
      || right.qualityScore - left.qualityScore
      || left.safetyFailures.length - right.safetyFailures.length
      || left.modelId.localeCompare(right.modelId, "en-US")));
}
