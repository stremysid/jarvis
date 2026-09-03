/**
 * The watchdog's bindings.
 *
 * Everything is optional, including the database. That is not laziness about
 * types: a watchdog that throws on boot because a secret is missing is a
 * watchdog that is silently absent, and the whole point of this Worker is that
 * its absence must be visible. So every binding is optional at the type level
 * and the Worker degrades in a way that says so -- /health refuses to answer
 * "ok" when it could not alert, and a cycle that cannot read the database
 * tries to alert about that rather than concluding nothing is wrong.
 *
 * The Telegram credentials are deliberately named differently from the
 * gateway's TELEGRAM_BOT_TOKEN. They should be a different bot and a different
 * chat. If the watchdog alerted through the gateway's bot, revoking or
 * rotating that token during an incident would take out the alert path at the
 * exact moment it is needed, and nothing would report that it had gone.
 */
export interface Env {
  /**
   * The gateway's D1 database, read for component_liveness and read/written
   * for liveness_alerts. This is the only surface shared with Jarvis, and no
   * gateway code is imported to use it.
   */
  DB?: D1Database;

  /** Bot token for the watchdog's own alert bot. Not the gateway's. */
  WATCHDOG_TELEGRAM_BOT_TOKEN?: string;

  /** Chat the alerts go to. Not the gateway's. */
  WATCHDOG_TELEGRAM_CHAT_ID?: string;

  /**
   * Shared secret a component presents to POST /heartbeat.
   *
   * Without it the endpoint is refused outright rather than left open. An
   * unauthenticated heartbeat endpoint lets anyone silence the watchdog by
   * reporting liveness for a component that is dead, which is strictly worse
   * than having no watchdog: it converts "I would have noticed" into "I was
   * told it was fine."
   */
  WATCHDOG_HEARTBEAT_SECRET?: string;

  /**
   * The component name the watchdog records itself under after each cycle, so
   * an external monitor polling /health can see a durable last-ran time that
   * survives isolate eviction. Defaults to "watchdog".
   */
  WATCHDOG_SELF_COMPONENT?: string;

  /**
   * How stale the watchdog's own row may get before /health reports unhealthy,
   * as a decimal integer of seconds. Defaults to three cron periods, so a
   * single missed run is tolerated and two are not. Set as a string because
   * Worker vars arrive as strings.
   */
  WATCHDOG_SELF_INTERVAL_SECONDS?: string;
}
