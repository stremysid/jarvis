import type { Env } from "../env.js";
import { handleD2lNotificationEmail, type D2lEmailHandlerDependencies } from "../school/d2l-email-handler.js";
import { storeInboundEmail } from "./email-inbox.js";

/**
 * The Worker's `email()` entry point.
 *
 * Every delivery is retained first, whatever it is and whoever sent it, and
 * only then is the same message offered to the existing D2L notification
 * consumer. The order matters in one direction: the legacy consumer's
 * authentication checks decide whether a D2L deadline is created, and once they
 * have run nothing can make the inbox copy disappear.
 *
 * The replay hands the legacy consumer an object with the archived bytes and
 * the original runtime headers. That is a deliberate narrowing of `setReject`,
 * whose callers in the legacy path reject the SMTP delivery. A message the
 * inbox has already accepted must not then bounce: General mail is the point of
 * this path. Real operational failures still propagate so Cloudflare retries,
 * which is why only the configuration error is contained.
 *
 * The D2L consumer returns `outside_d2l_scope` for mail that is not addressed
 * to it (the envelope recipient is not the ingest address, or the visible From
 * is not a pinned D2L domain) before it writes anything. Ordinary mail therefore
 * never counts as a D2L failure, never marks the D2L source failing in the
 * digest and never reaches the "check your sender pins" notice.
 */
export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
  dependencies: D2lEmailHandlerDependencies = {},
): Promise<void> {
  const stored = await storeInboundEmail(message, env, dependencies.now);
  // Re-read the exact bytes that were stored rather than the incoming stream,
  // which `ARCHIVE.put` already consumed. The legacy consumer and the inbox
  // therefore always agree on what arrived.
  const raw = await env.ARCHIVE.get(stored.rawKey);
  if (raw === null) throw new Error("email_inbox_archive_unavailable");
  try {
    await handleD2lNotificationEmail({
      from: message.from,
      to: message.to,
      headers: message.headers,
      rawSize: message.rawSize,
      raw: raw.body,
      // No content or header values in the log line.
      setReject: () => { console.warn("email_inbox_legacy_rejection"); },
      forward: message.forward.bind(message),
      reply: message.reply.bind(message),
    } as ForwardableEmailMessage, env, dependencies);
  } catch (error) {
    // Only a missing or malformed school configuration is contained. General
    // inbox delivery must not depend on school-specific configuration, and the
    // message is already stored. Anything else is an operational failure and
    // rethrows so the platform retries the delivery.
    if (!(error instanceof Error && error.message === "school_email_configuration_invalid")) throw error;
    console.warn("email_inbox_legacy_processing_skipped");
  }
}
