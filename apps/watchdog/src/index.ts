/**
 * The watchdog Worker.
 *
 * A cron that asks, every few minutes, which components have stopped reporting
 * in, and a small HTTP surface: one authenticated endpoint for components to
 * report in on, and one unauthenticated endpoint for something outside to
 * check that the watchdog itself is still running.
 *
 * It shares the D1 database with the cloud gateway and shares nothing else --
 * no import, no package, no binding, not a type. That is the entire reason it
 * is a separate app. A watchdog that runs inside the process it is watching
 * dies with it, and its silence is indistinguishable from good news.
 *
 * What this design does not cover, stated plainly because a comment is the
 * only place it can be stated: if this Worker's cron stops firing, nothing
 * here notices. There is no code running to notice with. The mitigation is
 * external and manual -- point an uptime monitor at GET /health, which reports
 * how long it has been since a cycle last recorded itself, and have that
 * monitor page on a non-200. Until that monitor exists, nothing watches the
 * watchdog. Adding a second timer inside this Worker would not help; it would
 * share the fate of the first.
 */

import { TelegramAlertChannel, UnconfiguredAlertChannel, type AlertChannel } from "./alert-channel.js";
import type { Env } from "./env.js";
import { HEALTH_PATH, handleHealth } from "./health.js";
import { HEARTBEAT_PATH, handleHeartbeat } from "./heartbeat.js";
import { D1LivenessStore } from "./liveness-store.js";
import { runWatchdogCycle, systemClock, type SelfHeartbeatConfig } from "./watchdog-run.js";

const DEFAULT_SELF_COMPONENT = "watchdog";

/**
 * Three cron periods. One missed run is tolerated; two are not.
 *
 * Set against the five-minute trigger in wrangler.toml. If that trigger
 * changes, this wants changing with it -- too tight and /health flaps on a
 * single skipped run, too loose and a stopped cron goes unreported for as long
 * as the slack allows.
 */
const DEFAULT_SELF_INTERVAL_SECONDS = 900;

function selfIntervalSeconds(env: Env): number {
  const configured = Number(env.WATCHDOG_SELF_INTERVAL_SECONDS ?? "");
  // A misconfigured value falls back rather than throwing. Refusing to start
  // over a bad number would take the watchdog off the air for a typo.
  if (!Number.isSafeInteger(configured) || configured <= 0) return DEFAULT_SELF_INTERVAL_SECONDS;
  return configured;
}

function selfComponent(env: Env): string {
  const configured = env.WATCHDOG_SELF_COMPONENT ?? "";
  return configured.length > 0 && configured.length <= 64 ? configured : DEFAULT_SELF_COMPONENT;
}

function selfHeartbeat(env: Env): SelfHeartbeatConfig {
  return { component: selfComponent(env), expectedIntervalSeconds: selfIntervalSeconds(env) };
}

/**
 * The alert path, or a stand-in that reports every send as undelivered.
 *
 * Half a configuration is treated as none. A bot token without a chat id
 * cannot deliver anything, and building a channel that fails on every call
 * would look like a Telegram outage rather than a missing setting.
 */
export function resolveAlertChannel(env: Env): AlertChannel {
  const botToken = env.WATCHDOG_TELEGRAM_BOT_TOKEN ?? "";
  const chatId = env.WATCHDOG_TELEGRAM_CHAT_ID ?? "";
  if (botToken.length === 0 || chatId.length === 0) return new UnconfiguredAlertChannel();
  return new TelegramAlertChannel({ botToken, chatId });
}

async function runCycle(env: Env, cron: string): Promise<void> {
  const db = env.DB;
  if (db === undefined) {
    // Nothing else to do, and nothing to alert with either: the alert channel
    // may well be configured, so say it there too rather than only in a log.
    await resolveAlertChannel(env).send("WATCHDOG DEGRADED\nno database binding; no component was checked");
    console.error("watchdog_cycle_skipped", { cron, reason: "database_not_bound" });
    return;
  }

  const result = await runWatchdogCycle({
    store: new D1LivenessStore(db),
    alerts: resolveAlertChannel(env),
    clock: systemClock,
    self: selfHeartbeat(env),
  });

  // Structural only: counts and fault labels, never a component's detail text.
  console.log("watchdog_cycle", {
    cron,
    ranAt: result.ranAt,
    outcome: result.outcome,
    components: result.verdicts.length,
    delivered: result.delivered,
    undelivered: result.undelivered,
    deferred: result.deferred,
    faults: result.faults,
  });
}

export default {
  async scheduled(controller, env, ctx): Promise<void> {
    const cycle = runCycle(env, controller.cron);
    // Both: waitUntil so the invocation is not torn down early, and awaited so
    // a rejection is attributable to this run rather than to a floating
    // promise. runWatchdogCycle does not throw, but the bindings around it can.
    ctx.waitUntil(cycle);
    await cycle;
  },

  async fetch(request, env): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (pathname === HEARTBEAT_PATH) {
      const secret = env.WATCHDOG_HEARTBEAT_SECRET ?? "";
      // Refused outright rather than left open. An empty configured secret
      // would compare equal to an absent header and authenticate everyone,
      // which is the one failure this endpoint must not have.
      if (secret.length === 0) return unavailable("heartbeat_secret_not_configured");
      const db = env.DB;
      if (db === undefined) return unavailable("database_not_bound");

      return handleHeartbeat(request, {
        store: new D1LivenessStore(db),
        clock: systemClock,
        secret,
      });
    }

    if (pathname === HEALTH_PATH) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      const db = env.DB;
      return handleHealth({
        store: db === undefined ? null : new D1LivenessStore(db),
        clock: systemClock,
        alertChannelConfigured: resolveAlertChannel(env).configured,
        selfComponent: selfComponent(env),
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function unavailable(reason: string): Response {
  return new Response(JSON.stringify({ ok: false, reason }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}
