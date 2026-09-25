import type { ModelFunctionDefinition } from "../providers/provider-types.js";
import { EMAIL_INBOX_TOOL_DEFINITIONS } from "../email/email-tools.js";
import { MEMORY_TOOL_DEFINITIONS } from "../memory/memory-tools.js";
import { OWNER_ARGUMENT_TOOL_DEFINITIONS } from "./owner-argument-tools.js";
import { GUIDED_ASSIGNMENT_TOOL_DEFINITIONS } from "../school/guided-assignment-tools.js";
import { SCHOOL_COLLECTOR_TOOLS } from "../school/collector-tools.js";

/**
 * The owner tools both channels offer.
 *
 * Sid's rule is that a call and a Telegram message differ in medium and nothing
 * else, so a tool one channel has and the other lacks is a bug rather than a
 * preference. Each channel composes this list and then appends only the tools
 * that genuinely depend on its surface, which is why the shared list is
 * exported here instead of inside either adapter.
 *
 * This file is also the reconciliation point for a concurrent parity change:
 * whatever ordering or grouping another branch introduces, a tool that must
 * reach both channels belongs in this list and nowhere else.
 */
export { ownerArgumentTool } from "./owner-argument-tools.js";

export const SHARED_OWNER_TOOL_DEFINITIONS: readonly ModelFunctionDefinition[] = Object.freeze([
  ...MEMORY_TOOL_DEFINITIONS,
  ...OWNER_ARGUMENT_TOOL_DEFINITIONS,
  ...GUIDED_ASSIGNMENT_TOOL_DEFINITIONS,
  ...SCHOOL_COLLECTOR_TOOLS,
  ...EMAIL_INBOX_TOOL_DEFINITIONS,
]);
