import { SCHOOL_COLLECTOR_TOOLS } from "../school/collector-tools.js";
import { SCHOOL_WORK_EVIDENCE_TOOL } from "../school/school-work-tools.js";
import { GUIDED_ASSIGNMENT_TOOL_DEFINITIONS } from "../school/guided-assignment-tools.js";
import { MEMORY_TOOL_DEFINITIONS } from "../memory/memory-tools.js";
import { OWNER_ARGUMENT_TOOL_DEFINITIONS } from "./owner-argument-tools.js";
import { REPLY_REFERENCE_TOOL_DEFINITIONS } from "./reply-reference-tools.js";
import { OWNER_ACCESS_TOOL_DEFINITIONS } from "../voice/owner-access-tool.js";
import { EMAIL_INBOX_TOOL_DEFINITIONS } from "../email/email-tools.js";
import { PROJECT_FACTS_TOOL } from "../projects/project-tools.js";
import type { ModelFunctionDefinition } from "../providers/provider-types.js";

/** A new owner capability reaches both communication adapters from this catalogue. */
export const OWNER_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  ...MEMORY_TOOL_DEFINITIONS,
  ...REPLY_REFERENCE_TOOL_DEFINITIONS,
  ...OWNER_ARGUMENT_TOOL_DEFINITIONS,
  ...GUIDED_ASSIGNMENT_TOOL_DEFINITIONS,
  ...SCHOOL_COLLECTOR_TOOLS,
  SCHOOL_WORK_EVIDENCE_TOOL,
  PROJECT_FACTS_TOOL,
  ...OWNER_ACCESS_TOOL_DEFINITIONS,
  Object.freeze({
    name: "school_update",
    description: "Save school work and replan catch-up from Sid's current message: a pasted D2L assignment list, 'I missed the Chemistry lab', 'I finished the English essay', or 'what should I do today'. Records work per course, completion reports and a proposed study schedule. Use this even when pasted assignment instructions mention emailing a teacher; it cannot contact anyone or submit work. Use deadline_record for a dated deadline or a deadline's status (open, submitted, missed, cancelled); you judge which one Sid's words mean, and ask him if unsure.",
    parameters: Object.freeze({ type: "object", additionalProperties: false, properties: {} }),
  }),
  Object.freeze({
    name: "university_update",
    description: "Update university planning when Sid names a shortlist, admission requirement, application date or progress, for example 'add Waterloo Computer Science' or 'I finished my application draft'. Keeps supplied dates visibly verified or unverified. Use school_update for a pasted school assignment list or missed classwork. This prepares and records plans; it cannot submit applications or contact anyone.",
    parameters: Object.freeze({ type: "object", additionalProperties: false, properties: {} }),
  }),
  Object.freeze({
    name: "study_coach",
    description: "Help Sid learn or practise a topic, for example 'explain titration', 'quiz me on derivatives', or 'I missed the lesson on quadratics; teach me'. Use school_update to save a pasted assignment list, record 'I finished the lab', or plan 'what should I do today'; use study_coach for the actual explanation, practice and feedback.",
    parameters: Object.freeze({ type: "object", additionalProperties: false, properties: {} }),
  }),
  ...EMAIL_INBOX_TOOL_DEFINITIONS,
]);
