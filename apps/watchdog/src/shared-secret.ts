/**
 * Constant-time comparison for the heartbeat secret.
 *
 * Redeclared here rather than imported from the gateway's telegram-webhook
 * module, for the same reason as everything else in this app: the watchdog
 * must not stop working because something in Jarvis stopped working. Twenty
 * lines duplicated is the price of that, and it is cheap.
 *
 * Why constant time at all, for a heartbeat: the secret is what stops an
 * outsider reporting a heartbeat for a component that is dead. Leaking it a
 * byte at a time through response timing would hand over the ability to
 * silence the watchdog, and a silenced watchdog is worse than an absent one --
 * it answers "everything is fine" with the same words it uses when everything
 * really is.
 */

const encoder = new TextEncoder();

/**
 * OR together the difference at every index of both arrays.
 *
 * Exported so a test can watch which indices it reads. An implementation that
 * returned early at the first difference would pass any assertion about the
 * boolean answer, so the only way to pin the property is to observe the reads
 * themselves.
 *
 * Length is folded into the same accumulator instead of being checked by an
 * early return, so a wrong-length secret is not distinguishable by timing
 * either.
 */
export function foldByteDifference(a: Uint8Array, b: Uint8Array): number {
  let difference = a.byteLength ^ b.byteLength;
  const span = Math.max(a.byteLength, b.byteLength);
  for (let index = 0; index < span; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference;
}

/** True when the two secrets are identical, in time independent of where they differ. */
export function secretsMatch(presented: string, expected: string): boolean {
  return foldByteDifference(encoder.encode(presented), encoder.encode(expected)) === 0;
}

/**
 * Pull the secret out of an `Authorization: Bearer ...` header.
 *
 * Returns the empty string when the header is absent or malformed rather than
 * null, so the caller compares something either way. Skipping the comparison
 * for a missing header would make "no credential" measurably faster than
 * "wrong credential" and reintroduce the timing signal the comparison exists
 * to remove.
 */
export function bearerCredential(header: string | null): string {
  if (header === null) return "";
  // The scheme name is case-insensitive per RFC 7235; the credential after it
  // is not, and is taken verbatim.
  const match = /^bearer[ ]+(.*)$/iu.exec(header);
  return match?.[1] ?? "";
}
