import type { CallSession } from "./index.js";

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  CALL_SESSION: DurableObjectNamespace<CallSession>;
  OWNER_VOICE_IDENTITY_ID: string;
  GUEST_PIN_PEPPER_V1: string;
  AUTHENTICATION_BUDGET_PEPPER: string;
  IDENTITY_CHALLENGE_HMAC_PEPPER: string;
  DEFAULT_GUEST_PIN?: string;
}
