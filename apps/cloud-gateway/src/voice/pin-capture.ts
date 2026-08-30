const SPOKEN_DIGITS = Object.freeze({
  zero: 0x30,
  one: 0x31,
  two: 0x32,
  three: 0x33,
  four: 0x34,
  five: 0x35,
  six: 0x36,
  seven: 0x37,
  eight: 0x38,
  nine: 0x39,
} as const);

type SpokenDigit = keyof typeof SPOKEN_DIGITS;

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

export function normalizeSpokenPin(text: unknown): Uint8Array | null {
  if (
    typeof text !== "string"
    || !text.isWellFormed()
    || text !== text.normalize("NFC")
  ) {
    return null;
  }

  if (/^[0-9]{4}$/u.test(text)) {
    return Uint8Array.from(text, (digit) => digit.charCodeAt(0));
  }

  const words = text.split(" ");
  if (words.length !== 4 || words.some((word) => !(word in SPOKEN_DIGITS))) return null;
  return Uint8Array.from(words, (word) => SPOKEN_DIGITS[word as SpokenDigit]);
}
