/**
 * Receipt-time identity is structural attribution, not message text. Store a
 * domain-separated digest as bytes so content redaction cannot merge distinct
 * principals, without minting an unredacted text token or storing credentials.
 */
export async function telegramPrincipalBinding(principalId: string): Promise<readonly number[]> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`telegram-principal-v1:${principalId}`)))];
}
