import type { ModelFunctionDefinition } from "../providers/provider-types.js";

/**
 * A read-only school evidence tool.
 *
 * The missing-work decision belongs to the model. This hands it the raw
 * Classroom submission state, the due date, when the source was last read and
 * how complete that read was. Code stores and delivers; it does not decide
 * whether the absence of a submission means missed work.
 */
export const SCHOOL_WORK_EVIDENCE_TOOL: ModelFunctionDefinition = Object.freeze({
  name: "school_work_evidence",
  description:
    "Read the raw Classroom submission evidence for deadlines, newest deadline first: each one's source submission state (null when Classroom has never reported one), due date, when Classroom was last read, read coverage, and the last derived label. You decide whether work is missed; code does not. A passed due date with no submission is evidence, not a verdict, and a null submission state means that course was never read, not that nothing is due. Never claim nothing is missing after a failed, incomplete or stale read; ask Sid when the evidence is incomplete. Follow the cursor until nextAfterDeadlineId is null.",
  parameters: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: Object.freeze({
      cursor: {
        type: "string",
        description: "Empty string for the first page, then the previous page's nextAfterDeadlineId.",
      },
      seenSinceDays: {
        type: "integer",
        minimum: 1,
        maximum: 90,
        description: "How many days back a Classroom observation must have been read to be included; deadlines with no observation are always included.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 40,
        description: "Maximum observations to return in this page.",
      },
    }),
    required: Object.freeze(["cursor", "seenSinceDays", "limit"]),
  }),
});
