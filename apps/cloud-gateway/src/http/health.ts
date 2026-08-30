export type CoarseAvailability = "available" | "unavailable";

export interface LivenessRateLimiter {
  allow(): boolean | Promise<boolean>;
}

export interface LivenessDependencies {
  rateLimiter: LivenessRateLimiter;
  availability: CoarseAvailability;
}

function publicResponse(status: 200 | 429 | 503, body: "ok" | "unavailable"): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

/** Public, non-diagnostic liveness boundary. Detailed readiness is authenticated separately. */
export async function handleLiveness(deps: LivenessDependencies): Promise<Response> {
  let allowed: unknown;
  try {
    allowed = await deps.rateLimiter.allow();
  } catch {
    return publicResponse(503, "unavailable");
  }
  if (allowed === false) return publicResponse(429, "unavailable");
  if (allowed !== true) return publicResponse(503, "unavailable");

  let availability: unknown;
  try {
    availability = deps.availability;
  } catch {
    return publicResponse(503, "unavailable");
  }
  return availability === "available"
    ? publicResponse(200, "ok")
    : publicResponse(503, "unavailable");
}
