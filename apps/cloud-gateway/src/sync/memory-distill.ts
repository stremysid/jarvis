/**
 * Distillation: turn archived excerpts into fact proposals.
 *
 * The local agent selects excerpts and submits them signed; the gateway holds
 * the model key and does the asking. That split is the point — the agent never
 * needs the credential, and the model never sees anything the agent did not
 * deliberately select.
 *
 * The response is validated here as well as on the agent. Two checks are
 * cheaper and more certain at this end: a proposal citing a source that was
 * not submitted can be caught against the request we just verified, and a
 * proposal that tries to declare itself active or invoke a tool can be
 * rejected before it is ever returned. Validating in both places is deliberate
 * duplication — the agent cannot assume a well-behaved gateway, and the
 * gateway should not emit output it knows is invalid.
 */

import type { ModelAdapter } from "../model/model-types.js";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { hasFactTextControls } from "../../../../packages/contracts/src/memory-projection.js";
import { collectStream } from "../providers/deepseek-provider.js";
import { validateExtractionProposal } from "../memory/extraction-policy.js";

export const DISTILL_PATH = "/memory/distill";

/** Distillation is background work, so it can afford the better answer. */
const REASONING_EFFORT = "high" as const;
const FIRST_TOKEN_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARACTERS = 8_000;

const MAX_EXCERPTS = 32;
const MAX_EXCERPT_CHARACTERS = 4_000;
const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;

const INSTRUCTIONS = [
  "You extract durable facts about the user from excerpts of their own messages.",
  "Return ONLY a JSON array. Each element must be an object with exactly:",
  '  "text": one short factual statement about the user,',
  '  "sourceEventIds": array of the excerpt ids the fact is drawn from,',
  '  "confidence": number between 0 and 1.',
  "Cite only ids that appear in the excerpts given to you.",
  "Do not invent facts. Do not include preferences the user did not state.",
  "Do not include any other key. Do not return prose. If nothing durable is",
  "present, return [].",
].join("\n");

export interface DistillExcerpt {
  readonly sourceEventId: string;
  readonly text: string;
}

export interface DistillProposal {
  readonly text: string;
  readonly sourceEventIds: readonly string[];
  readonly confidence: number;
  readonly origin: "model";
  readonly uncertain: true;
}

export interface DistillDependencies {
  readonly model: ModelAdapter;
  readonly principalId: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** Validates the submitted excerpts before any model call is made. */
export function validateExcerpts(value: unknown): readonly DistillExcerpt[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXCERPTS) return null;
  const excerpts: DistillExcerpt[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) return null;
    const { sourceEventId, text } = item;
    if (typeof sourceEventId !== "string" || !ULID.test(sourceEventId)) return null;
    if (typeof text !== "string" || text.trim().length === 0) return null;
    if (text.length > MAX_EXCERPT_CHARACTERS) return null;
    if (hasFactTextControls(text)) return null;
    excerpts.push({ sourceEventId, text });
  }
  return excerpts;
}

/**
 * Narrow one model-returned element, or reject it.
 *
 * `supplied` is the set of ids we actually sent. Anything else is either
 * invented or an attempt to attach a claim to evidence we did not provide.
 */
export function validateProposal(
  value: unknown,
  supplied: ReadonlySet<string>,
): DistillProposal | null {
  const validated = validateExtractionProposal(value, supplied);
  if (validated === null) return null;
  return {
    text: validated.text,
    sourceEventIds: validated.sourceEventIds,
    confidence: validated.confidence,
    origin: validated.origin,
    uncertain: validated.uncertain,
  };
}

/** Extract the JSON array from a model response that may be wrapped in prose. */
function parseArray(raw: string): unknown[] | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function distil(
  excerpts: readonly DistillExcerpt[],
  dependencies: DistillDependencies,
  signal: AbortSignal,
): Promise<readonly DistillProposal[]> {
  // Keep prompt construction safe even when a caller bypasses the HTTP validator.
  const captured = validateExcerpts(excerpts);
  if (captured === null) throw new TypeError("excerpts_invalid");
  const supplied = new Set(captured.map((excerpt) => excerpt.sourceEventId));
  const listing = captured
    .map((excerpt) => `[${excerpt.sourceEventId}] ${excerpt.text}`)
    .join("\n");

  const answer = await collectStream(
    dependencies.model.stream({
      correlationId: newUlid(),
      principalId: dependencies.principalId,
      channel: "telegram",
      userText: `${INSTRUCTIONS}\n\nExcerpts:\n${listing}`,
      // Deliberately empty. Distillation reads only what was submitted; giving
      // it retrieved memory as well would let existing facts reinforce
      // themselves into new ones with no new evidence.
      context: [],
      reasoningEffort: REASONING_EFFORT,
      firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
      timeoutMs: TOTAL_TIMEOUT_MS,
      contextTokenBudget: 8_000,
      maxOutputCharacters: MAX_OUTPUT_CHARACTERS,
      signal,
    }),
  );

  const parsed = parseArray(answer);
  if (parsed === null) return [];

  const proposals: DistillProposal[] = [];
  for (const item of parsed) {
    const proposal = validateProposal(item, supplied);
    // One malformed element does not discard the rest: the others were
    // independently derived and are independently checkable.
    if (proposal !== null) proposals.push(proposal);
  }
  return Object.freeze(proposals);
}
