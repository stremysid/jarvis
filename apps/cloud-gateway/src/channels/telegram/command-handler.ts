/**
 * What a mechanical slash command does.
 *
 * Only three commands reach this file now (`/shadow`, `/exam`, `/call`); the
 * reporting commands (`/status`, `/queue`, `/digest`) are model tools, so their
 * words reach the model instead. Each handler returns text rather than sending
 * it, so the reply path is the same one an ordinary message takes and there is
 * exactly one place that talks to Telegram. It also makes each command
 * testable without a bot token.
 *
 * Two rules run through all of them:
 *
 * A command whose subsystem is not configured says so plainly. "Not set up
 * yet" and "nothing to report" must never look the same -- that is the same
 * rule the digest follows about a source it could not read, applied to the
 * commands the owner types.
 *
 * A command that changes state reports the state it reached, not the state it
 * was asked for. `/shadow off` that failed to write must not answer "shadow
 * mode off", because the next thing the owner does is act on that answer.
 */

import type { AutonomyMode } from "../../autonomy/autonomy-types.js";
import { parseToggle, type CommandName } from "./telegram-commands.js";

/** One message to send back. A command may produce several. */
export interface CommandReply {
  readonly text: string;
}

export interface CommandContext {
  readonly principalId: string;
  /** Absent when the subsystem is not configured for this deployment. */
  readonly autonomy?: {
    readMode(): Promise<{ mode: AutonomyMode; enteredAt: string }>;
    setMode(mode: AutonomyMode, now: string): Promise<{ mode: AutonomyMode; enteredAt: string }>;
  };
  readonly quietWindows?: {
    open(reason: "manual", from: Date, to: Date): Promise<void>;
    closeManual(at: Date): Promise<number>;
  };
  /** Bound to the accepted event; neither the parser nor caller chooses a destination. */
  readonly calls?: { request(): Promise<string> };
  readonly now: () => Date;
}

/** Exam mode with no end named runs a full day, then lapses on its own. */
const DEFAULT_QUIET_HOURS = 24;

function unavailable(what: string): CommandReply {
  return { text: `${what} is not configured on this deployment.` };
}

function one(text: string): readonly CommandReply[] {
  return [{ text }];
}

async function shadow(
  argument: string,
  context: CommandContext,
): Promise<readonly CommandReply[]> {
  if (context.autonomy === undefined) return [unavailable("Autonomy")];

  const toggle = parseToggle(argument);
  if (toggle === null) {
    const current = await context.autonomy.readMode();
    // Refusing rather than guessing. "/shadow of" must not turn off the gate
    // that keeps tier-2 actions from running.
    return one(`Shadow mode is ${current.mode === "shadow" ? "on" : "off"}. Say "on" or "off".`);
  }

  // "shadow on" means mode shadow; "shadow off" means live.
  const target: AutonomyMode = toggle === "on" ? "shadow" : "live";
  const reached = await context.autonomy.setMode(target, context.now().toISOString());
  return one(
    reached.mode === "shadow"
      ? "Shadow mode on. Jarvis reports what it would do and does not act."
      : "Shadow mode off. Tier-2 actions run; tier 3 still asks first.",
  );
}

async function exam(
  argument: string,
  context: CommandContext,
): Promise<readonly CommandReply[]> {
  if (context.quietWindows === undefined) return [unavailable("Quiet hours")];

  const toggle = parseToggle(argument);
  if (toggle === null) return one('Say "on" or "off".');

  const now = context.now();
  if (toggle === "off") {
    const closed = await context.quietWindows.closeManual(now);
    return one(
      closed === 0
        ? "No manual quiet window was open."
        : `Quiet hours off. Closed ${closed}.`,
    );
  }

  const until = new Date(now.getTime() + DEFAULT_QUIET_HOURS * 3_600_000);
  await context.quietWindows.open("manual", now, until);
  return one("Quiet hours on for 24h. Errors and anything payment-critical still come through.");
}

/**
 * Run one mechanical command.
 *
 * A handler that throws becomes a message rather than an unhandled rejection.
 * The owner typed something and is waiting for an answer, and a silent
 * failure reads exactly like a bot that has stopped working.
 */
export async function runCommand(
  name: CommandName,
  argument: string,
  context: CommandContext,
): Promise<readonly CommandReply[]> {
  try {
    switch (name) {
      case "call":
        if (context.calls === undefined) return [unavailable("Calling")];
        try { return one(await context.calls.request()); }
        catch { return one("Could not confirm whether the call was placed. Check your phone before trying again."); }
      case "shadow":
        return await shadow(argument, context);
      case "exam":
        return await exam(argument, context);
    }
  } catch (error) {
    return one(`That failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
