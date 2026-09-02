/**
 * Reporting this Worker's own liveness to the watchdog.
 *
 * Over HTTP to a separate Worker rather than through a service binding, and
 * that is the point rather than an oversight. The watchdog exists because the
 * failure that kills Jarvis must not also kill the thing meant to report it,
 * and a binding would couple their deployments back together -- a bad deploy
 * of this Worker would take both down at once and the outage would go
 * unreported.
 *
 * Two rules govern everything here:
 *
 * A heartbeat is a claim that this Worker did its work, so it is sent AFTER
 * the work, never before. Sent first, it says "alive" for a run that then
 * failed, which is worse than saying nothing: it converts "I would have
 * noticed" into "I was told it was fine".
 *
 * A failed heartbeat never fails the job. The watchdog missing one beat
 * produces a false alarm, which is recoverable. A digest that did not send
 * because its heartbeat could not be delivered is not.
 */

/** The heartbeat is a fire-and-forget status ping; a slow one is a dead one. */
const TIMEOUT_MS = 5_000;

export interface HeartbeatConfiguration {
  readonly url: string;
  readonly secret: string;
}

export interface HeartbeatReport {
  readonly component: string;
  /**
   * How long silence is normal for this component. The watchdog stores it, so
   * a component that changes its own cadence tells the watchdog rather than
   * needing the watchdog redeployed.
   */
  readonly expectedIntervalSeconds: number;
  /** Short and structural -- a version, a count. Never content. */
  readonly detail?: string;
}

export type HeartbeatOutcome =
  | { sent: true }
  | { sent: false; reason: "not_configured" | "rejected" | "unreachable"; detail?: string };

/**
 * Send one heartbeat.
 *
 * Returns rather than throws. The caller is a scheduled job whose real work
 * has already succeeded by the time this runs, and there is nothing useful it
 * could do with an exception except swallow it.
 */
export async function reportHeartbeat(
  report: HeartbeatReport,
  configuration: HeartbeatConfiguration | null,
  fetcher: typeof fetch,
): Promise<HeartbeatOutcome> {
  // Unconfigured is reported, not silently skipped. A deployment missing the
  // watchdog secret has no liveness monitoring at all, and that should be
  // visible in this Worker's own logs rather than only as an absence
  // somewhere else.
  if (configuration === null) return { sent: false, reason: "not_configured" };

  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, TIMEOUT_MS);

  try {
    const response = await fetcher(configuration.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // A bearer header rather than a query parameter: a URL with a secret
        // in it ends up in request logs on both sides.
        authorization: `Bearer ${configuration.secret}`,
      },
      body: JSON.stringify({
        component: report.component,
        expectedIntervalSeconds: report.expectedIntervalSeconds,
        ...(report.detail === undefined ? {} : { detail: report.detail }),
      }),
      signal: abort.signal,
    });

    if (!response.ok) {
      return { sent: false, reason: "rejected", detail: `status ${response.status}` };
    }
    return { sent: true };
  } catch (error) {
    // Includes the abort. A watchdog that is itself down or slow must not
    // become a way to take this Worker down with it.
    return {
      sent: false,
      reason: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the configuration, or null when it is incomplete.
 *
 * Both halves or neither. A URL without a secret would send an unauthenticated
 * heartbeat that the watchdog rejects on every run, which looks like a
 * watchdog fault rather than a missing secret.
 */
export function heartbeatConfiguration(
  url: string | undefined,
  secret: string | undefined,
): HeartbeatConfiguration | null {
  if (url === undefined || secret === undefined) return null;
  if (url.length === 0 || secret.length === 0) return null;
  return { url, secret };
}
