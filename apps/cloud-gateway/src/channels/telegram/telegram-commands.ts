/**
 * Recognising a command before it reaches the model.
 *
 * Ordinary messages are answered by DeepSeek. A command is not: `/exam off`
 * must toggle exam mode, not produce a paragraph about exams. So the split
 * happens here, ahead of the conversation service, and it is deliberately
 * conservative -- a message that only looks like a command is treated as
 * ordinary text rather than dispatched to something that acts.
 *
 * Parsing is total and pure. It never touches the database, so an unknown
 * command costs nothing and a malformed one cannot fail a webhook that has
 * already been accepted.
 */

/**
 * Telegram appends `@botname` to commands sent in a group, and sends them
 * bare in a private chat. Both forms must resolve to the same command or the
 * bot silently ignores half of them.
 */
const COMMAND_PATTERN = /^\/([a-z_]{1,32})(?:@([A-Za-z0-9_]{1,32}))?(?:\s+([\s\S]*))?$/u;
const OWNER_STEP_UP_COMMAND_PATTERN = /^\/(disable-owner-step-up)(?:@([A-Za-z0-9_]{1,32}))?(?:\s+([\s\S]*))?$/u;

export type CommandName =
  | "help"
  | "status"
  | "queue"
  | "digest"
  | "exam"
  | "shadow"
  | "call"
  | "disable-owner-step-up"
  | "vault";

const KNOWN_COMMANDS: ReadonlySet<string> = new Set<CommandName>([
  "help",
  "status",
  "queue",
  "digest",
  "exam",
  "shadow",
  "call",
  "disable-owner-step-up",
  "vault",
]);

/** Bounded so a pathological argument cannot be carried into a query. */
const MAX_ARGUMENT_CHARACTERS = 256;

export interface ParsedCommand {
  readonly kind: "command";
  readonly name: CommandName;
  /** Trimmed remainder of the line, empty when there was none. */
  readonly argument: string;
  /** Present when the message addressed a specific bot. */
  readonly addressedTo: string | null;
}

export interface UnknownCommand {
  readonly kind: "unknown_command";
  readonly attempted: string;
}

export interface OrdinaryText {
  readonly kind: "text";
}

export type CommandParse = ParsedCommand | UnknownCommand | OrdinaryText;

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
  const match = OWNER_STEP_UP_COMMAND_PATTERN.exec(firstLine) ?? COMMAND_PATTERN.exec(firstLine);
  // A slash followed by something that is not a command shape -- "/", "/123",
  // or any other hyphenated name -- is text. Reporting it as unknown would mean
  // replying "unknown command" to a message that never was one.
  if (match === null) return { kind: "text" };

  const [, name = "", addressed, rest] = match;
  if (
    addressed !== undefined
    && botUsername !== null
    // Telegram usernames are case-insensitive.
    && addressed.toLowerCase() !== botUsername.toLowerCase()
  ) {
    return { kind: "text" };
  }

  if (!KNOWN_COMMANDS.has(name)) return { kind: "unknown_command", attempted: name };

  return {
    kind: "command",
    name: name as CommandName,
    // A call must validate all the supplied text. Truncation or ignoring a
    // second line could turn a non-final --confirm into permission to dial.
    argument: name === "call" || name === "disable-owner-step-up"
      ? line.slice(1 + name.length + (addressed === undefined ? 0 : addressed.length + 1)).trim()
      : (rest ?? "").trim().slice(0, MAX_ARGUMENT_CHARACTERS),
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

/** Shown for `/help` and for an unrecognised command. */
export const COMMAND_HELP: string = [
  "/status - what Jarvis has been doing",
  "/queue - decisions waiting on you",
  "/digest - today's digest now",
  "/exam on|off - hold non-urgent pings",
  "/shadow on|off - whether Jarvis acts or only reports",
  "/vault <query> - search your notes",
  "/call <reason> --confirm - call your verified phone (owner only)",
  "/disable-owner-step-up --confirm - disable spoken owner-call step-up",
  "/help - this",
].join("\n");
