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

  /**
   * The Worker's own public origin, used to build the callback URLs Twilio
   * posts back to. Not a secret -- but it must be the exact origin Twilio
   * will reach, because inbound webhook signatures are verified against the
   * full URL and a mismatch rejects every call.
   */
  PUBLIC_ORIGIN?: string;

  /**
   * Twilio. Calls are placed with an API Key (SID + secret) rather than the
   * account auth token, so the credential used for outbound requests can be
   * rotated or revoked without invalidating webhook verification.
   * TWILIO_AUTH_TOKEN is separate and used only to verify inbound signatures.
   */
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_API_KEY_SID?: string;
  TWILIO_API_KEY_SECRET?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_E164?: string;

  /**
   * Telegram. The bot token sends messages; the webhook secret is the value
   * given to setWebhook and presented back in the
   * X-Telegram-Bot-Api-Secret-Token header on every update. They are distinct
   * credentials: the secret proves an update came from Telegram, the token
   * authorizes us to Telegram.
   */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;

  /** Model provider for all Jarvis reasoning. */
  DEEPSEEK_API_KEY?: string;

  /**
   * Overrides the model id. The foundation design pins deepseek-v4-pro;
   * this exists so a provider rename can be corrected with a secret change
   * rather than a redeploy.
   */
  DEEPSEEK_MODEL?: string;
}
