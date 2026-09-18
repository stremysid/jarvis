/**
 * Exchanges the owner's long-lived Google refresh token for short-lived
 * access tokens. Credentials stay in Worker secrets; this module never logs
 * them or includes Google's response body in an error.
 */

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_TIMEOUT_MS = 15_000;
const REFRESH_SKEW_MS = 60_000;

export interface GoogleOAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

export interface GoogleOAuthTokenProviderOptions {
  readonly credentials: GoogleOAuthCredentials;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export class GoogleOAuthRequestError extends Error {
  readonly status: number | null;
  readonly transient: boolean;

  constructor(code: string, status: number | null, transient: boolean) {
    super(code);
    this.name = "GoogleOAuthRequestError";
    this.status = status;
    this.transient = transient;
  }
}

interface CachedToken {
  readonly value: string;
  readonly refreshAfter: number;
}

function validCredential(value: string): boolean {
  return value.length > 0 && /^[\x20-\x7e]+$/u.test(value);
}

function nowMilliseconds(now: () => Date): number {
  const value = now().getTime();
  if (!Number.isFinite(value)) throw new TypeError("google_oauth_clock_invalid");
  return value;
}

/** A small, per-invocation cache prevents one token exchange per API page. */
export class GoogleOAuthTokenProvider {
  readonly #credentials: GoogleOAuthCredentials;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  #cached: CachedToken | null = null;
  #pending: Promise<string> | null = null;

  constructor(options: GoogleOAuthTokenProviderOptions) {
    const { clientId, clientSecret, refreshToken } = options.credentials;
    if (![clientId, clientSecret, refreshToken].every(validCredential)) {
      throw new TypeError("google_oauth_credentials_invalid");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("google_oauth_timeout_invalid");

    this.#credentials = Object.freeze({ clientId, clientSecret, refreshToken });
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = timeoutMs;
  }

  async getAccessToken(): Promise<string> {
    const now = nowMilliseconds(this.#now);
    if (this.#cached !== null && now < this.#cached.refreshAfter) return this.#cached.value;
    if (this.#pending !== null) return this.#pending;

    const pending = this.#refresh();
    this.#pending = pending;
    try {
      return await pending;
    } finally {
      if (this.#pending === pending) this.#pending = null;
    }
  }

  async #refresh(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.#credentials.clientId,
      client_secret: this.#credentials.clientSecret,
      refresh_token: this.#credentials.refreshToken,
      grant_type: "refresh_token",
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        // A redirect must never replay the client secret or refresh token to a
        // second origin. Google's token endpoint is fixed and should answer
        // directly.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new GoogleOAuthRequestError("google_oauth_unavailable", null, true);
    } finally {
      clearTimeout(timer);
    }

    if (
      response.redirected
      || (response.type as string) === "opaqueredirect"
      || response.status === 0
      || (response.status >= 300 && response.status < 400)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new GoogleOAuthRequestError("google_oauth_rejected", response.status, false);
    }
    if (!response.ok) {
      const transient = response.status === 429 || response.status >= 500;
      throw new GoogleOAuthRequestError(
        transient ? "google_oauth_unavailable" : "google_oauth_rejected",
        response.status,
        transient,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new GoogleOAuthRequestError("google_oauth_response_unparseable", response.status, true);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new GoogleOAuthRequestError("google_oauth_response_invalid", response.status, false);
    }
    const value = (parsed as Record<string, unknown>).access_token;
    const expiresIn = (parsed as Record<string, unknown>).expires_in;
    if (typeof value !== "string" || !/^[\x21-\x7e]+$/u.test(value)) {
      throw new GoogleOAuthRequestError("google_oauth_access_token_invalid", response.status, false);
    }
    if (!Number.isSafeInteger(expiresIn) || (expiresIn as number) <= 0) {
      throw new GoogleOAuthRequestError("google_oauth_expiry_invalid", response.status, false);
    }

    const now = nowMilliseconds(this.#now);
    const expiresAt = now + (expiresIn as number) * 1_000;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new GoogleOAuthRequestError("google_oauth_expiry_invalid", response.status, false);
    }
    this.#cached = Object.freeze({ value, refreshAfter: Math.max(now, expiresAt - REFRESH_SKEW_MS) });
    return value;
  }
}
