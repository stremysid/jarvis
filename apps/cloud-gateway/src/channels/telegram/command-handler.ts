/**
 * What a slash command does.
 *
 * Every handler returns text rather than sending it, so the reply path is the
 * same one an ordinary message takes and there is exactly one place that
 * talks to Telegram. It also makes each command testable without a bot token.
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
import type { DecisionItem } from "../../decisions/decision-types.js";
import { buildDecisionKeyboard, type TelegramInlineKeyboardMarkup } from "../../decisions/telegram-keyboard.js";
import { COMMAND_HELP, parseToggle, type CommandName } from "./telegram-commands.js";

/** One message to send back. A command may produce several. */
export interface CommandReply {
  readonly text: string;
  readonly keyboard?: TelegramInlineKeyboardMarkup;
  /** Set for a decision message, so delivery can be recorded once it lands. */
  readonly decisionId?: string;
}

export interface CommandContext {
  readonly principalId: string;
  /** Absent when the subsystem is not configured for this deployment. */
  readonly autonomy?: {
    readMode(): Promise<{ mode: AutonomyMode; enteredAt: string }>;
    setMode(mode: AutonomyMode, now: string): Promise<{ mode: AutonomyMode; enteredAt: string }>;
  };
  readonly decisions?: {
    queue(principalId: string): Promise<readonly DecisionItem[]>;
  };
  readonly scheduler?: {
    recent(job: string, limit: number): Promise<readonly {
      runKey: string;
      startedAt: string;
      finishedAt: string | null;
      failure: string | null;
    }[]>;
  };
  readonly quietWindows?: {
    open(reason: "manual", from: Date, to: Date): Promise<void>;
    closeManual(at: Date): Promise<number>;
  };
  readonly runDigestNow?: () => Promise<string>;
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

async function status(context: CommandContext): Promise<readonly CommandReply[]> {
  const lines: string[] = [];

  if (context.autonomy === undefined) {
    lines.push("Autonomy: not configured");
  } else {
    const mode = await context.autonomy.readMode();
    lines.push(
      mode.mode === "shadow"
        ? `Autonomy: shadow since ${mode.enteredAt.slice(0, 10)} (reporting, not acting)`
        : `Autonomy: live since ${mode.enteredAt.slice(0, 10)}`,
    );
  }

  if (context.scheduler === undefined) {
    lines.push("Scheduler: not configured");
  } else {
    for (const job of ["drain", "poll", "digest"]) {
      const [last] = await context.scheduler.recent(job, 1);
      if (last === undefined) {
        // Never having run is a different fact from having run and failed,
        // and the difference is what tells a fresh deployment from a broken
        // one.
        lines.push(`${job}: never run`);
      } else if (last.failure !== null) {
        lines.push(`${job}: FAILED at ${last.startedAt.slice(11, 16)} -- ${last.failure}`);
      } else if (last.finishedAt === null) {
        lines.push(`${job}: started ${last.startedAt.slice(11, 16)}, never finished`);
      } else {
        lines.push(`${job}: ok at ${last.finishedAt.slice(11, 16)}`);
      }
    }
  }

  return one(lines.join("\n"));
}

async function queue(context: CommandContext): Promise<readonly CommandReply[]> {
  if (context.decisions === undefined) return [unavailable("The decision queue")];
  const items = await context.decisions.queue(context.principalId);
  if (items.length === 0) return one("Nothing waiting on you.");

  // One message per decision, each with its own buttons. A single message
  // cannot carry several keyboards, and a tap has to name which question it
  // answered.
  return items.map((item) => ({
    text: item.urgency === "urgent" ? `! ${item.question}` : item.question,
    keyboard: buildDecisionKeyboard(item),
    decisionId: item.decisionId,
  }));
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

async function digest(context: CommandContext): Promise<readonly CommandReply[]> {
  if (context.runDigestNow === undefined) return [unavailable("The digest")];
  return one(await context.runDigestNow());
}

/**
 * Run one command.
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
      case "help":
        return one(COMMAND_HELP);
      case "status":
        return await status(context);
      case "queue":
        return await queue(context);
      case "digest":
        return await digest(context);
      case "shadow":
        return await shadow(argument, context);
      case "exam":
        return await exam(argument, context);
      case "vault":
        // The vault is on the owner's machine, not here. Saying so is more
        // use than a generic failure -- it tells them where to run it.
        return one("The vault lives on your PC. Run: jarvis vault search <query>");
    }
  } catch (error) {
    return one(`That failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
