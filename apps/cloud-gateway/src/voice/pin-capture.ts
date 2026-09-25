/**
 * The number words a spoken PIN may use, as the value each one names.
 *
 * The values are numbers, not characters: a digit word names its digit, and
 * the ten-to-ninety entries let a two-digit group fold into one number. The
 * tens entries exist because Sid says a four digit PIN as "forty-eight
 * twenty-one" at least as readily as "four eight two one", and forgiving
 * recognition is a blocking requirement, not a nicety. Nothing here is a
 * keyword test of what Sid means: every entry maps a word to the number it is,
 * and a candidate that does not resolve to exactly four digits is refused
 * rather than guessed at.
 */
const SPOKEN_NUMBERS = Object.freeze({
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
} as const);

type SpokenNumber = keyof typeof SPOKEN_NUMBERS;

export class FourDigitPinCapture {
  readonly #bytes = new Uint8Array(4);
  #length = 0;

  get length(): number {
    return this.#length;
  }

  pushDtmf(digit: string): "incomplete" | "complete" | "cleared" {
    if (digit === "*" || digit === "#" || !/^[0-9]$/u.test(digit) || this.#length >= 4) {
      this.clear();
      return "cleared";
    }

    this.#bytes[this.#length] = digit.charCodeAt(0);
    this.#length += 1;
    return this.#length === 4 ? "complete" : "incomplete";
  }

  take(): Uint8Array | null {
    const result = this.#length === 4 ? this.#bytes.slice() : null;
    this.clear();
    return result;
  }

  clear(): void {
    this.#bytes.fill(0);
    this.#length = 0;
  }
}

/** The digits a number word group names, or null when the token is not one. */
function numberFromToken(token: string): number | null {
  if (/^[0-9]$/u.test(token)) return token.charCodeAt(0) - 0x30;
  return Object.hasOwn(SPOKEN_NUMBERS, token) ? SPOKEN_NUMBERS[token as SpokenNumber] : null;
}

/**
 * A token into the numbers it contributes, in order.
 *
 * A tens word and a following unit fold into one number ("forty eight" is 48),
 * which is why the tokens are walked in order rather than mapped one by one.
 * Anything that is not a number word or a short digit run makes the whole
 * candidate unreadable instead of being dropped: dropping it would silently
 * turn "four eight two one please" into a guess at a PIN.
 */
function readNumberTokens(tokens: readonly string[]): readonly number[] | null {
  const numbers: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    // A digit run is its digits, one by one, so "4821", "48 21" and "4 8 2 1"
    // all read the same. Folding "4821" into one number would refuse it.
    if (/^[0-9]+$/u.test(token)) {
      for (const digit of token) numbers.push(digit.charCodeAt(0) - 0x30);
      continue;
    }
    const value = numberFromToken(token);
    if (value === null) return null;
    if (value >= 20 && value % 10 === 0 && value < 100) {
      const next = tokens[index + 1];
      const unit = next === undefined ? null : numberFromToken(next);
      if (unit !== null && unit >= 1 && unit <= 9) {
        numbers.push(value + unit);
        index += 1;
        continue;
      }
    }
    numbers.push(value);
  }
  return numbers;
}

function digitsFromNumbers(numbers: readonly number[]): Uint8Array | null {
  const digits: number[] = [];
  for (const number of numbers) {
    if (!Number.isSafeInteger(number) || number < 0 || number > 99) return null;
    if (number < 10) {
      digits.push(number);
      continue;
    }
    digits.push(Math.floor(number / 10), number % 10);
  }
  return digits.length === 4
    ? Uint8Array.from(digits, (digit) => digit + 0x30)
    : null;
}

/**
 * The words of an answer given at a PIN prompt, with the transcript's
 * formatting taken off.
 *
 * Speech-to-text capitalises and punctuates what it hears ("Four eight two
 * one.", "4,821", "Cancel."), and none of that formatting is something Sid
 * said. So this lowercases and turns sentence punctuation and hyphens into
 * spaces ("4,821" reads as "4 821", which is the same four digits because a
 * digit run is read digit by digit). It changes formatting only: no word is
 * removed, replaced or read for meaning, which is why a filler word still
 * makes a PIN unreadable and the caller is asked again.
 */
export function pinAnswerWords(text: string): readonly string[] {
  return Object.freeze(text
    .toLowerCase()
    .replace(/[.,!?;:\-\u2010-\u2014]/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length > 0));
}

/**
 * The four digits a spoken candidate names, or null when it does not name
 * exactly four.
 *
 * Accepted: the four digits as digits ("4821", "4 8 2 1", "4,821"), as four
 * digit words ("four eight two one", with "oh" as zero), as two two-digit
 * numbers ("forty-eight twenty-one", "48 21"), and as any mix that still
 * resolves to exactly four digits, with or without the capitals and
 * punctuation a transcript adds ("Four eight two one.").
 */
export function normalizeSpokenPin(text: unknown): Uint8Array | null {
  if (
    typeof text !== "string"
    || !text.isWellFormed()
    || text !== text.normalize("NFC")
  ) {
    return null;
  }

  const tokens = pinAnswerWords(text);
  if (tokens.length === 0) return null;
  const numbers = readNumberTokens(tokens);
  return numbers === null ? null : digitsFromNumbers(numbers);
}
