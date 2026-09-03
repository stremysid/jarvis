/**
 * The watchdog's decision. No I/O, no clock, no database.
 *
 * Everything the watchdog concludes is decided here, from rows and a time
 * passed in. That is deliberate: this is the part where a wrong answer is
 * silent -- a component wrongly judged live produces no alert, no log line,
 * and no failed request, so nothing anywhere reveals the mistake. Keeping it
 * free of I/O is what makes it possible to test the answer directly instead of
 * testing whether a message happened to be sent.
 */

/**
 * A row of component_liveness.
 *
 * Duplicated from the gateway's 0012_liveness.sql rather than imported. The
 * watchdog shares the table with Jarvis and shares no code with it, because a
 * failure that kills Jarvis must not be able to kill the thing whose job is to
 * report it. If the gateway's schema changes, this shape has to be updated by
 * hand and the watchdog's own tests are what catch the drift.
 */
export interface ComponentLivenessRow {
  readonly component: string;
  /** How long silence is normal for this component, per row, not globally. */
  readonly expectedIntervalSeconds: number;
  readonly lastSeenAt: string;
  readonly detail: string | null;
  /** Set while the component is knowingly down, so a planned outage does not page. */
  readonly suppressedUntil: string | null;
}

/** A liveness_alerts row that has not been marked recovered. Also duplicated deliberately. */
export interface OpenLivenessAlert {
  readonly alertId: string;
  readonly component: string;
  /** The last_seen_at as it stood when this alert was raised. */
  readonly lastSeenAt: string;
  readonly alertedAt: string;
}

/**
 * What the watchdog concluded about one component.
 *
 * `still_overdue` and `overdue_again` are two different things and the
 * distinction is the reason liveness_alerts exists. Both describe a component
 * that is overdue with an alert already open. In the first the outage never
 * ended, so re-alerting every five minutes for the length of a long outage
 * would be noise. In the second the component was seen since that alert was
 * raised and has gone quiet again -- a second outage, which has never been
 * reported, and collapsing it into the first would lose it entirely. They are
 * told apart by whether last_seen_at has moved since the alert recorded it.
 */
export type LivenessVerdict =
  | { readonly component: string; readonly status: "live" }
  | { readonly component: string; readonly status: "suppressed"; readonly suppressedUntil: string }
  | {
      readonly component: string;
      readonly status: "newly_overdue";
      readonly lastSeenAt: string;
      readonly expectedIntervalSeconds: number;
      /** Null when last_seen_at could not be read; see `readInstant`. */
      readonly overdueBySeconds: number | null;
    }
  | {
      readonly component: string;
      readonly status: "still_overdue";
      readonly lastSeenAt: string;
      readonly openAlertId: string;
    }
  | {
      readonly component: string;
      readonly status: "overdue_again";
      readonly lastSeenAt: string;
      readonly expectedIntervalSeconds: number;
      readonly overdueBySeconds: number | null;
      readonly openAlertId: string;
      /** The last_seen_at the still-open alert was raised against. */
      readonly previousLastSeenAt: string;
    }
  | {
      readonly component: string;
      readonly status: "recovered";
      readonly lastSeenAt: string;
      readonly openAlertId: string;
    };

/** The statuses that mean something should be sent and then recorded. */
export const ACTIONABLE_STATUSES = Object.freeze(
  ["newly_overdue", "overdue_again", "recovered"] as const,
);

export type ActionableStatus = (typeof ACTIONABLE_STATUSES)[number];

export function isActionable(
  verdict: LivenessVerdict,
): verdict is Extract<LivenessVerdict, { status: ActionableStatus }> {
  return verdict.status === "newly_overdue"
    || verdict.status === "overdue_again"
    || verdict.status === "recovered";
}

export interface LivenessAssessmentInput {
  readonly rows: readonly ComponentLivenessRow[];
  readonly openAlerts: readonly OpenLivenessAlert[];
  readonly now: Date;
}

/**
 * Parse a stored timestamp, or return null.
 *
 * A timestamp that cannot be read is not evidence that a component is alive,
 * so the caller treats null as overdue rather than as healthy. Returning a
 * sentinel "very old" number instead would have worked for the overdue test
 * and then produced a nonsense overdue-by figure in the alert text, which is
 * the kind of detail that makes an operator distrust the whole message.
 */
function readInstant(value: string | null): number | null {
  if (value === null || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Keep one open alert per component, the most recently raised.
 *
 * The watchdog inserts alerts under a deterministic id, so a duplicate insert
 * is a no-op and duplicates should not arise. Should one arise anyway -- two
 * cron invocations overlapping, or a row written by hand -- the decision uses
 * the newest, and the store closes every open row for a component rather than
 * one by id, so a stray duplicate cannot leave a component permanently looking
 * like it is still down and therefore never alerted about again.
 */
function indexOpenAlerts(
  openAlerts: readonly OpenLivenessAlert[],
): ReadonlyMap<string, OpenLivenessAlert> {
  const newest = new Map<string, OpenLivenessAlert>();
  for (const alert of openAlerts) {
    const existing = newest.get(alert.component);
    if (existing === undefined || alert.alertedAt >= existing.alertedAt) newest.set(alert.component, alert);
  }
  return newest;
}

/**
 * True while a component is knowingly down and should not page.
 *
 * An unreadable suppressed_until is treated as no suppression at all. The
 * failure directions are not symmetric: reading a bad value as "suppressed"
 * silences the watchdog for that component with nothing to show for it, and
 * "suppress me" is exactly what an attacker or a corrupted write would want to
 * express. Reading it as "not suppressed" costs at worst one unwanted alert.
 */
function isSuppressed(row: ComponentLivenessRow, nowMs: number): boolean {
  const until = readInstant(row.suppressedUntil);
  return until !== null && until > nowMs;
}

/**
 * Decide the state of every component at one instant.
 *
 * Results come back sorted by component name so a caller -- or a test -- can
 * compare the whole list by equality. Comparing by membership would admit the
 * component nobody thought of, and a component silently missing from the
 * assessment is precisely the defect that has no other symptom.
 */
export function assessLiveness(input: LivenessAssessmentInput): readonly LivenessVerdict[] {
  const nowMs = input.now.getTime();
  const openByComponent = indexOpenAlerts(input.openAlerts);
  const verdicts: LivenessVerdict[] = [];

  for (const row of input.rows) {
    const open = openByComponent.get(row.component);
    const lastSeenMs = readInstant(row.lastSeenAt);
    const interval = row.expectedIntervalSeconds;
    const intervalUsable = typeof interval === "number" && Number.isFinite(interval) && interval > 0;

    // Overdue when the deadline has passed, and also when the row cannot be
    // read at all. Exactly at the deadline is still within the interval: a
    // component that reports every 300 seconds must not be judged late by the
    // cron that lands on the same second.
    const overdue = lastSeenMs === null
      || !intervalUsable
      || nowMs > lastSeenMs + interval * 1000;

    if (!overdue) {
      // Recovery is decided before suppression. Closing an alert is not a
      // page, and leaving it open through a suppression window would make the
      // next real outage read as "still down" and never be reported.
      verdicts.push(
        open === undefined
          ? { component: row.component, status: "live" }
          : {
              component: row.component,
              status: "recovered",
              lastSeenAt: row.lastSeenAt,
              openAlertId: open.alertId,
            },
      );
      continue;
    }

    if (isSuppressed(row, nowMs)) {
      verdicts.push({
        component: row.component,
        status: "suppressed",
        // Non-null: isSuppressed only returns true for a readable value.
        suppressedUntil: row.suppressedUntil as string,
      });
      continue;
    }

    const overdueBySeconds = lastSeenMs === null || !intervalUsable
      ? null
      : Math.floor((nowMs - lastSeenMs) / 1000) - interval;

    if (open === undefined) {
      verdicts.push({
        component: row.component,
        status: "newly_overdue",
        lastSeenAt: row.lastSeenAt,
        expectedIntervalSeconds: interval,
        overdueBySeconds,
      });
      continue;
    }

    if (open.lastSeenAt === row.lastSeenAt) {
      verdicts.push({
        component: row.component,
        status: "still_overdue",
        lastSeenAt: row.lastSeenAt,
        openAlertId: open.alertId,
      });
      continue;
    }

    verdicts.push({
      component: row.component,
      status: "overdue_again",
      lastSeenAt: row.lastSeenAt,
      expectedIntervalSeconds: interval,
      overdueBySeconds,
      openAlertId: open.alertId,
      previousLastSeenAt: open.lastSeenAt,
    });
  }

  return Object.freeze(verdicts.sort((a, b) => (a.component < b.component ? -1 : a.component > b.component ? 1 : 0)));
}

/**
 * The id an alert for this outage is recorded under.
 *
 * Derived from the component and the last_seen_at it went quiet at, rather
 * than random, so recording the same outage twice collides on the primary key
 * and does nothing. Two overlapping cron invocations that both decide a
 * component is newly overdue therefore leave one open alert, not two. A second
 * outage necessarily has a later last_seen_at -- the component had to be seen
 * again to have gone down again -- so it gets its own id.
 */
export function alertIdFor(component: string, lastSeenAt: string): string {
  return `liveness:${component}:${lastSeenAt}`;
}
