/**
 * The few slash commands that stay code.
 *
 * Ordinary messages are answered by DeepSeek, and so is almost every slash
 * command: `/status`, `/queue` and `/digest` are capabilities the model now
 * reaches through its own tools (`owner_status`, `decision_queue`,
 * `run_digest`), available on Telegram and on a call alike. A router that
 * recognised those words and acted instead of letting the model read them was
 * deciding what Sid's message meant.
 *
 * Three commands remain, and each is a purely mechanical owner-authenticated
 * action rather than a reading of Sid's words:
 *
 *   `/shadow on|off` and `/exam on|off` are the owner's own permission and
 *   notification switches. They are the escape hatches from shadow mode and
 *   quiet hours, so they must work even when the model path is unavailable,
 *   and `on`/`off` is a value, not a judgment.
 *
 *   `/call <reason> --confirm` is a confirmed action whose authorization is the
 *   exact text: `D1TelegramCallCommands.reconstruct` re-reads this line from the
 *   durable event and refuses without `--confirm`. Moving it behind a tool
 *   would rewrite that authorization, so it stays a command.
 *
 * Everything else -- an unknown name, a bare slash, a path -- is ordinary text
 * and reaches the model, which decides what Sid meant. That is why there is no
 * "unknown command" reply: refusing it in code would be deciding that a
 * message the model never saw was not worth answering.
 *
 * Parsing is total and pure. It never touches the database, so a malformed
 * command costs nothing and cannot fail a webhook that has already been
 * accepted.
 */

/**
 * Telegram appends `@botname` to commands sent in a group, and sends them
 * bare in a private chat. Both forms must resolve to the same command or the
 * bot silently ignores half of them.
 */
const COMMAND_PATTERN = /^\/([a-z_]{1,32})(?:@([A-Za-z0-9_]{1,32}))?(?:\s+([\s\S]*))?$/u;

export type CommandName = "exam" | "shadow" | "call";

const KNOWN_COMMANDS: ReadonlySet<string> = new Set<CommandName>([
  "exam",
  "shadow",
  "call",
]);

export interface ParsedCommand {
  readonly kind: "command";
  readonly name: CommandName;
  /** Trimmed remainder of the line, empty when there was none. */
  readonly argument: string;
  /** Present when the message addressed a specific bot. */
  readonly addressedTo: string | null;
}

export interface OrdinaryText {
  readonly kind: "text";
}

export type CommandParse = ParsedCommand | OrdinaryText;

/**
 * Classify one inbound message.
 *
 * `botUsername` is the bot's own name. When a message is addressed to a
 * different bot in a group, this returns ordinary text rather than the
 * command: acting on a command aimed at someone else is worse than ignoring
 * it, and in a group both bots would otherwise answer.
 */
export function parseCommand(text: string, botUsername: string | null): CommandParse {
  // Leading whitespace is stripped, but a slash that is not at the start is
  // left alone. "the file is at /help" is a sentence, not a command.
  const line = text.trimStart();
  if (!line.startsWith("/")) return { kind: "text" };

  // Only the first line. Telegram sends a command and its argument in one
  // message, and a pasted block below a command should not become part of it.
  const firstLine = line.split("\n", 1)[0] ?? "";
  const ordinaryMatch = COMMAND_PATTERN.exec(firstLine);
  // A slash followed by something that is not a command shape -- "/", "/123",
  // or any other hyphenated name -- is text, and so is a command-shaped name
  // that is not one of the three mechanical commands.
  if (ordinaryMatch === null) return { kind: "text" };

  const name = ordinaryMatch[1] ?? "";
  const addressed = ordinaryMatch[2];
  const rest = ordinaryMatch[3];
  if (
    addressed !== undefined
    && botUsername !== null
    // Telegram usernames are case-insensitive.
    && addressed.toLowerCase() !== botUsername.toLowerCase()
  ) {
    return { kind: "text" };
  }

  if (!KNOWN_COMMANDS.has(name)) return { kind: "text" };

  return {
    kind: "command",
    name: name as CommandName,
    // A call must validate all the supplied text. Truncation or ignoring a
    // second line could turn a non-final --confirm into permission to dial.
    // Nothing is sliced: `requireConfirmation` refuses an over-long argument
    // visibly, and the model reads every other command's words itself.
    argument: name === "call"
      ? line.slice(1 + name.length + (addressed === undefined ? 0 : addressed.length + 1)).trim()
      : (rest ?? "").trim(),
    addressedTo: addressed ?? null,
  };
}

export type Toggle = "on" | "off";

/**
 * Read an on/off argument.
 *
 * Returns null for anything else rather than guessing. `/shadow maybe` must
 * not resolve to either state: shadow mode is the gate that keeps tier-2
 * actions from running, and a typo that silently disables it is the one
 * outcome this whole subsystem exists to prevent.
 */
export function parseToggle(argument: string): Toggle | null {
  const value = argument.trim().toLowerCase();
  if (value === "on" || value === "enable" || value === "enabled") return "on";
  if (value === "off" || value === "disable" || value === "disabled") return "off";
  return null;
}
