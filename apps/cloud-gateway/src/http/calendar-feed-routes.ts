import { composeCalendarFeed } from "../calendar/ics-feed.js";
import { DeadlineRepository } from "../deadlines/deadline-repository.js";
import type { Env } from "../env.js";
import { SchoolCatchupRepository } from "../school/school-catchup-repository.js";
import { UniversityTrackerRepository } from "../university/university-tracker-repository.js";
import type { LivenessRateLimiter } from "./health.js";

const encoder = new TextEncoder();
const DAY_MS = 86_400_000;
const privateHeaders = { "cache-control": "private, no-store" };

function failure(status: number, body: string): Response {
  return new Response(body, { status, headers: privateHeaders });
}

export async function handleCalendarFeedRequest(
  request: Request,
  env: Pick<Env, "DB" | "CALENDAR_FEED_TOKEN" | "OWNER_PRINCIPAL_ID">,
  dependencies: { readonly clock: () => Date; readonly rateLimiter: LivenessRateLimiter },
): Promise<Response> {
  const expected = env.CALENDAR_FEED_TOKEN ?? "";
  const match = /^\/calendar\/([^/]+)\.ics$/u.exec(new URL(request.url).pathname);
  if (request.method !== "GET" || match === null) {
    return failure(404, "Not found");
  }
  const encodedToken = match[1]!;
  let presented: string;
  try {
    presented = decodeURIComponent(encodedToken);
  } catch {
    return failure(404, "Not found");
  }
  // Fixed-length digests let the runtime compare every byte in constant time,
  // including when the presented credential has the wrong length. Hash and
  // compare even an unset or short configuration before refusing it.
  const [actualHash, expectedHash] = await Promise.all([presented, expected].map((value) =>
    crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const tokenMatches = crypto.subtle.timingSafeEqual(actualHash!, expectedHash!);
  if (!tokenMatches || Array.from(expected).length < 32 || expected !== expected.trim()) {
    return failure(404, "Not found");
  }
  try {
    if (!await dependencies.rateLimiter.allow()) return failure(429, "Unavailable");
    const principalId = env.OWNER_PRINCIPAL_ID;
    if (!principalId) return failure(503, "Unavailable");
    const now = dependencies.clock();
    const university = new UniversityTrackerRepository(env.DB);
    const [actions, deadlines, applications, workflows] = await Promise.all([
      new SchoolCatchupRepository(env.DB).listPlannedActions(principalId),
      new DeadlineRepository(env.DB).listDueWithin({
        from: new Date(now.getTime() - 14 * DAY_MS),
        to: new Date(now.getTime() + 90 * DAY_MS), statuses: ["open"],
      }),
      // A calendar must not inherit the digest's five-item display limit.
      university.listApplicationItemsByDueDate(principalId, null),
      university.listWorkflowItemsByDueDate(principalId, null),
    ]);
    return new Response(composeCalendarFeed({ now, actions, deadlines, applications, workflows }), {
      headers: { ...privateHeaders, "content-type": "text/calendar; charset=utf-8" },
    });
  } catch {
    // Never echo or log an exception: it can carry the request's bearer URL.
    // An error must not look like an empty calendar and erase subscribed events.
    return failure(503, "Unavailable");
  }
}
