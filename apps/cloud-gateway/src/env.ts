import type { CallSession } from "./index.js";

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  CALL_SESSION: DurableObjectNamespace<CallSession>;
  PIN_VERIFIER_JSON: string;
}
