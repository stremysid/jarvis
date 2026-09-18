/**
 * Reads a four-digit PIN out of ordinary speech.
 *
 * Sid sometimes struggles to speak clearly on demand, so a failed read is far
 * more likely to be a mis-hearing than an attack. This parser is therefore
 * generous about form -- "four two seven one", "four, two, seven, one",
 * "forty-two seventy-one" and "4271" all read the same -- and it refuses to
 * guess. A read that is not exactly four digits reports which way it fell
 * short, because "I did not catch that" and "I only heard three" are different
 * sentences to say back and only one of them tells the caller what to change.
 *
 * Nothing here is written anywhere. The digits live in a Uint8Array the caller
 * zeroises, and the transcript is a parameter rather than a record.
 */

export type SpokenPinRead =
  | Readonly<{ kind: "pin"; digits: Uint8Array }>
  | Readonly<{ kind: "partial" }>
  | Readonly<{ kind: "unclear" }>;

const UNITS: Readonly<Record<string, number>> = Object.freeze({
  zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9,
});

const TENS: Readonly<Record<string, number>> = Object.freeze({
  twenty: 2, thirty: 3, forty: 4, fourty: 4, fifty: 5,
  sixty: 6, seventy: 7, eighty: 8, ninety: 9,
});

const MAX_READ_DIGITS = 12;
const MAX_TRANSCRIPT_CHARACTERS = 256;

/**
 * Every token that carries digits, in order. Words that carry none are skipped
 * rather than treated as a boundary, so "four, um, two seven one" reads the
 * same as the clean sentence. Null means the caller said more digits than any
 * four-digit PIN has, which is a partial read rather than an unreadable one.
 */
function readDigits(text: string): number[] | null {
  const tokens = text.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim().split(" ").filter((token) => token.length > 0);
  const read: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (/^[0-9]+$/u.test(token)) {
      for (const character of token) read.push(character.charCodeAt(0) - 0x30);
    } else {
      const tens = TENS[token];
      if (tens !== undefined) {
        const next = tokens[index + 1];
        const unit = next === undefined ? undefined : UNITS[next];
        if (unit === undefined) {
          read.push(tens, 0);
        } else {
          read.push(tens, unit);
          index += 1;
        }
      } else {
        const unit = UNITS[token];
        if (unit === undefined) continue;
        read.push(unit);
      }
    }
    if (read.length > MAX_READ_DIGITS) return null;
  }
  return read;
}

export function readSpokenPin(text: unknown): SpokenPinRead {
  if (typeof text !== "string" || !text.isWellFormed()) return Object.freeze({ kind: "unclear" });
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TRANSCRIPT_CHARACTERS) return Object.freeze({ kind: "unclear" });
  const read = readDigits(trimmed);
  if (read === null) return Object.freeze({ kind: "partial" });
  if (read.length === 0) return Object.freeze({ kind: "unclear" });
  if (read.length !== 4) {
    read.fill(0);
    return Object.freeze({ kind: "partial" });
  }
  const digits = Uint8Array.from(read, (digit) => 0x30 + digit);
  read.fill(0);
  return Object.freeze({ kind: "pin", digits });
}
