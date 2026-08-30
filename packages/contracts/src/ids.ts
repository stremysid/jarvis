export type Ulid = string & { readonly __ulid: unique symbol };
export type Sha256Hex = string & { readonly __sha256: unique symbol };

const ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
let previousTimestamp = -1;
let previousRandom = new Array<number>(16).fill(0);

function encodeBase32(value: number, length: number): string {
  let remaining = value;
  let encoded = "";

  for (let index = 0; index < length; index += 1) {
    encoded = ULID_ALPHABET[remaining % 32] + encoded;
    remaining = Math.floor(remaining / 32);
  }

  return encoded;
}

function nextRandom(timestamp: number): number[] {
  if (timestamp > previousTimestamp) {
    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    previousRandom = [...random].map((byte) => byte & 31);
    previousTimestamp = timestamp;
    return previousRandom;
  }

  for (let index = previousRandom.length - 1; index >= 0; index -= 1) {
    if (previousRandom[index] < 31) {
      previousRandom[index] += 1;
      return previousRandom;
    }
    previousRandom[index] = 0;
  }

  throw new RangeError("ULID monotonic random component exhausted");
}

/** Creates a lowercase, monotonic ULID for the supplied instant. */
export function newUlid(now = new Date()): Ulid {
  const observedTimestamp = now.getTime();
  if (!Number.isSafeInteger(observedTimestamp) || observedTimestamp < 0 || observedTimestamp >= 2 ** 48) {
    throw new RangeError("ULID time must be a valid millisecond instant");
  }
  const timestamp = Math.max(observedTimestamp, previousTimestamp);

  return `${encodeBase32(timestamp, 10)}${nextRandom(timestamp).map((value) => ULID_ALPHABET[value]).join("")}` as Ulid;
}
