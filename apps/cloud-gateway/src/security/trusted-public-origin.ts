export interface UrlSnapshot {
  readonly url: URL;
  readonly serialized: string;
}

export interface TrustedPublicOrigin {
  readonly hostname: string;
  readonly origin: string;
}

/** Snapshots a URL's internal slots without invoking an overridable instance method. */
export function snapshotUrl(value: unknown): UrlSnapshot | null {
  try {
    const serialized = URL.prototype.toString.call(value);
    return Object.freeze({ url: new URL(serialized), serialized });
  } catch {
    return null;
  }
}

export function snapshotTrustedPublicOrigin(value: unknown): TrustedPublicOrigin | null {
  const snapshot = snapshotUrl(value);
  if (
    snapshot === null
    || snapshot.url.protocol !== "https:"
    || snapshot.url.hostname.length === 0
    || snapshot.url.username.length !== 0
    || snapshot.url.password.length !== 0
    || snapshot.url.port.length !== 0
    || snapshot.url.pathname !== "/"
    || snapshot.serialized.includes("?")
    || snapshot.serialized.includes("#")
  ) {
    return null;
  }
  return Object.freeze({
    hostname: snapshot.url.hostname,
    origin: snapshot.url.origin,
  });
}

export function isTrustedFixedUrl(
  snapshot: UrlSnapshot | null,
  trusted: TrustedPublicOrigin,
  protocol: "https:" | "wss:",
  pathname: string,
): snapshot is UrlSnapshot {
  if (snapshot === null) return false;
  const sameTrustedHost = protocol === "https:"
    ? snapshot.url.origin === trusted.origin
    : snapshot.url.hostname === trusted.hostname && snapshot.url.port.length === 0;
  return snapshot.url.protocol === protocol
    && sameTrustedHost
    && snapshot.url.username.length === 0
    && snapshot.url.password.length === 0
    && snapshot.url.port.length === 0
    && snapshot.url.pathname === pathname
    && !snapshot.serialized.includes("?")
    && !snapshot.serialized.includes("#");
}
