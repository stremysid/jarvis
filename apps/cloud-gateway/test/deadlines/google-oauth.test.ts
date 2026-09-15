import { describe, expect, it, vi } from "vitest";
import { GoogleOAuthRequestError, GoogleOAuthTokenProvider } from "../../src/deadlines/google-oauth.js";

const CREDENTIALS = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GoogleOAuthTokenProvider", () => {
  it("exchanges the refresh token at Google's fixed endpoint and caches the short-lived token", async () => {
    let now = new Date("2026-09-15T12:00:00.000Z");
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      json({ access_token: "access-token", expires_in: 3600, token_type: "Bearer" }));
    const fetchImplementation = fetchMock as unknown as typeof fetch;
    const provider = new GoogleOAuthTokenProvider({
      credentials: CREDENTIALS,
      fetchImplementation,
      now: () => new Date(now),
    });

    await expect(provider.getAccessToken()).resolves.toBe("access-token");
    now = new Date("2026-09-15T12:58:59.000Z");
    await expect(provider.getAccessToken()).resolves.toBe("access-token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe(CREDENTIALS.clientId);
    expect(body.get("client_secret")).toBe(CREDENTIALS.clientSecret);
    expect(body.get("refresh_token")).toBe(CREDENTIALS.refreshToken);
  });

  it("refreshes before expiry instead of handing Classroom a nearly expired token", async () => {
    let now = new Date("2026-09-15T12:00:00.000Z");
    let issued = 0;
    const fetchImplementation = vi.fn(async () => json({ access_token: `access-${++issued}`, expires_in: 120 })) as unknown as typeof fetch;
    const provider = new GoogleOAuthTokenProvider({
      credentials: CREDENTIALS,
      fetchImplementation,
      now: () => new Date(now),
    });

    await expect(provider.getAccessToken()).resolves.toBe("access-1");
    now = new Date("2026-09-15T12:01:00.000Z");
    await expect(provider.getAccessToken()).resolves.toBe("access-2");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("never includes Google's response body in a credential failure", async () => {
    const fetchImplementation = vi.fn(async () => json({ error: "invalid_grant", leaked: "do-not-repeat" }, 400)) as unknown as typeof fetch;
    const provider = new GoogleOAuthTokenProvider({ credentials: CREDENTIALS, fetchImplementation });

    const error = await provider.getAccessToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleOAuthRequestError);
    expect((error as Error).message).toBe("google_oauth_rejected");
    expect((error as Error).message).not.toContain("do-not-repeat");
    expect((error as GoogleOAuthRequestError).transient).toBe(false);
    expect((error as GoogleOAuthRequestError).status).toBe(400);
  });

  it("refuses malformed credentials before making a request", async () => {
    const fetchImplementation = vi.fn(async () => json({ access_token: "unused", expires_in: 3600 })) as unknown as typeof fetch;
    expect(() => new GoogleOAuthTokenProvider({
      credentials: { ...CREDENTIALS, refreshToken: "bad\nheader" },
      fetchImplementation,
    })).toThrow("google_oauth_credentials_invalid");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
