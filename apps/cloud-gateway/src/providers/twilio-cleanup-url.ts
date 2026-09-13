import { isTrustedFixedUrl, snapshotUrl, type TrustedPublicOrigin, type UrlSnapshot } from "../security/trusted-public-origin.js";

// Two retries, including 5xx cleanup failures, within Twilio's voice deadline.
// Twilio consumes this fragment; it is absent from the signed HTTP request.
const CLEANUP_RETRIES = "#rc=2&rp=ct,rt,5xx";

export function twilioCleanupUrl(pathname: string, base: URL | string): URL {
  const url = new URL(pathname, base);
  url.hash = CLEANUP_RETRIES;
  return url;
}

/** Permit only the fixed override on a callback; preserve all origin/path checks. */
export function isTrustedCleanupUrl(
  snapshot: UrlSnapshot | null, trusted: TrustedPublicOrigin, pathname: string,
): snapshot is UrlSnapshot {
  if (snapshot === null) return false;
  if (!snapshot.serialized.includes("#")) return isTrustedFixedUrl(snapshot, trusted, "https:", pathname);
  if (snapshot.url.hash !== CLEANUP_RETRIES) return false;
  const delivered = new URL(snapshot.serialized);
  delivered.hash = "";
  return isTrustedFixedUrl(snapshotUrl(delivered), trusted, "https:", pathname);
}
