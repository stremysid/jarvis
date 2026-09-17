const PASSES = 6;

/**
 * Production workerd rejects one PBKDF2 call above 100,000 iterations. Six
 * chained passes retain the 600,000-iteration work factor without crossing
 * that per-call limit; every pass reuses the record's salt and treats the
 * previous 32-byte result as its password.
 */
export async function deriveChainedPbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  let input = password;
  try {
    for (let pass = 0; pass < PASSES; pass += 1) {
      const key = await crypto.subtle.importKey("raw", input, "PBKDF2", false, ["deriveBits"]);
      const output = new Uint8Array(await crypto.subtle.deriveBits({
        name: "PBKDF2",
        hash: "SHA-256",
        salt,
        iterations: 100_000,
      }, key, 256));
      if (input !== password) input.fill(0);
      input = output;
    }
    return input;
  } catch (error) {
    if (input !== password) input.fill(0);
    throw error;
  }
}
