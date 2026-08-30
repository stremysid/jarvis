import { SafeLogger } from "../../apps/cloud-gateway/src/observability/safe-log.js";
import type { Ulid } from "../../packages/contracts/src/index.js";

const logger = new SafeLogger(() => undefined);
const safeRecord = {
  eventId: "01k3s6k8000000000000000001" as Ulid,
  correlationId: "01k3s6k8000000000000000002" as Ulid,
  component: "sync",
  operation: "pull",
  outcome: "ok",
} as const;

logger.info(safeRecord);

const widenedWithRawText = { ...safeRecord, text: "raw transcript" };
// @ts-expect-error SafeLogger must reject widened records containing fields outside its allowlist.
logger.info(widenedWithRawText);

const widenedStructuredSecret = { ...safeRecord, component: "password_secret" as const };
// @ts-expect-error SafeLogger components are a finite allowlist, not an arbitrary safe-looking token.
logger.info(widenedStructuredSecret);
