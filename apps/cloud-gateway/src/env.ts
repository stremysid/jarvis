import type { CallSession } from "./index.js";

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  CALL_SESSION: DurableObjectNamespace<CallSession>;
  OWNER_VOICE_IDENTITY_ID: string;
  GUEST_PIN_PEPPER_V1: string;
  AUTHENTICATION_BUDGET_PEPPER: string;
  IDENTITY_CHALLENGE_HMAC_PEPPER: string;
  /** Explicit rotation version shared by challenge issuance, inbound admission and confirmation. */
  IDENTITY_CHALLENGE_HMAC_KEY_VERSION?: string;
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

  /**
   * The bot's own @name, without the @.
   *
   * Only needed in a group, where Telegram appends `@botname` to a command
   * and every bot in the chat receives it. Without this the bot cannot tell a
   * command aimed at it from one aimed at another bot, so it answers both. In
   * a private chat commands arrive bare and this is unused, which is why it
   * is optional rather than required.
   */
  TELEGRAM_BOT_USERNAME?: string;

  /**
   * 32 random bytes, base64. Signs the snapshot continuation tokens the
   * local agent quotes back when acknowledging a page, so a token cannot be
   * forged to claim a view of the log the cloud never issued.
   *
   * Rotating it invalidates outstanding tokens; the agent recovers by
   * pulling a fresh page.
   */
  SYNC_CONTINUATION_SECRET?: string;

  /** Model provider for all Jarvis reasoning. */
  DEEPSEEK_API_KEY?: string;

  /**
   * Overrides the model id. The foundation design pins deepseek-v4-pro;
   * this exists so a provider rename can be corrected with a secret change
   * rather than a redeploy.
   */
  DEEPSEEK_MODEL?: string;

  /**
   * The principal every scheduled job acts for and delivers to.
   *
   * Scheduled work has no request to derive an identity from, so it needs one
   * named up front. Without it the digest has nobody to send to, and the
   * handler declines to run rather than picking a principal out of the
   * database and guessing it meant the owner.
   */
  OWNER_PRINCIPAL_ID?: string;

  /**
   * IANA zone the daily digest is composed for, e.g. "America/Toronto".
   *
   * Cloudflare crons fire on UTC and have no notion of a timezone, so the
   * schedule drifts an hour across a daylight-saving boundary. Correcting it
   * here rather than in the cron means the digest keeps saying "today" about
   * the right day in March and November.
   */
  DIGEST_TIMEZONE?: string;

  /**
   * Fine-grained personal access token, read-only, for the tracked
   * repositories only. The project poller reads four status documents and the
   * latest commit; nothing in this system needs write access to a repository,
   * so a token that has it is a token that can be stolen for more than it was
   * issued for.
   */
  GITHUB_TOKEN?: string;

  /**
   * Google Classroom, via the owner's own account. The refresh token is the
   * long-lived credential -- access tokens are minted from it per run, so a
   * leaked access token expires on its own and a compromised refresh token is
   * revocable in one place.
   */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;

  /**
   * The watchdog's heartbeat endpoint and its shared secret.
   *
   * Deliberately a URL rather than a service binding: the watchdog is a
   * separate Worker precisely so the failure that kills this one cannot kill
   * the thing meant to report it, and a binding would couple their
   * deployments back together.
   */
  WATCHDOG_HEARTBEAT_URL?: string;
  WATCHDOG_HEARTBEAT_SECRET?: string;
}
