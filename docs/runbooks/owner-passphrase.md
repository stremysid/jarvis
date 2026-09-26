# Generate or rotate the owner passphrase verifier

The per-call owner passphrase gate was removed on 2026-09-24 (Sid: an ordinary
owner call goes straight to Jarvis). An ordinary call now reaches the relay
with nothing asked of the caller, and nothing in the call path reads this
verifier. The only credential a call asks for is the four-digit PIN at a
sensitive action; set that PIN as described in
[OWNER-ACTIONS.md](../OWNER-ACTIONS.md).

What remains here is the passphrase verifier foundation, kept deliberately for
later use. This runbook describes it. It does not authorize a migration,
secret change, deployment, or live call, and no call currently verifies
against it.

## What is stored

The Worker selects three independent words with replacement from the fixed
2,048-word `eff-long-cmudict-2026-09-v2` list. D1 stores only the versioned
HMAC-plus-PBKDF2 verifier, its 16-byte salt, the creating device-key binding,
and an immutable rotation receipt. It never stores the words. A signed status
request returns only the current verifier version and whether it is active or
disabled. A successful generation response returns the words once.

Migration `0017` also reserves PR 3's guarded recovery path. An immutable
disable receipt must cite the exact accepted, confirmed owner Telegram event;
its trigger revokes the active verifier and disables the head atomically. The
same verifier cannot be restored. Re-enable requires this signed Windows CLI
to publish a new verifier version, which supersedes the revoked record and
moves the head back to active. This PR does not expose the Telegram disable
command.

The source list is derived from EFF's 2016 large Diceware list, then filtered
with CMUdict commit `74790861f652b15e4ac49015a90074ad62a27690`. The checked-in
list's newline-delimited SHA-256 is
`52cfd230e93567f01b90c059f7e400d915f23b558ce1a28f0bfc4dc0c9ba1cc4`.
The selection removes number words; the reviewed speech variants `okay`,
`alright`, `awhile`, `online`, `hangup`, `maybe`, and `twice`; non-US spelling
variants; reviewed manual exclusions; compounds detectable as two CMUdict
entries of at least two letters; punctuation; and words outside four to eight
ASCII letters. Hash-ranked greedy selection ensures that no two retained words
share a CMUdict pronunciation.

## Reviewed rollout sequence

1. Confirm the implementation commit has passed Claude max review. List remote
   migrations and apply exactly the reviewed pending files. Wrangler tracks
   migration names rather than enforcing numeric continuity, so this
   runbook's `0017_owner_passphrase.sql` can be applied before R2's reserved
   `0016`; if `0016` lands later, it remains unapplied and is applied then.
2. From a protected PowerShell session with transcription off, create a random
   32-byte value, base64-encode it, and enter it through Wrangler's interactive
   `secret put OWNER_PASSPHRASE_PEPPER_V1` prompt. Never put the value in a
   command argument, file, test, log, or chat.
3. Apply reviewed pending migrations only after the owner confirms the remote
   inventory and recovery point. Deploy the reviewed Worker revision. These are
   separate owner-confirmed operations under `deploy.md`.
4. On the enrolled Windows 11 home PC, in an attended terminal, run:

   ```powershell
   jarvis owner-passphrase status
   jarvis owner-passphrase generate
   ```

   The generate command reads the current version, asks for confirmation, and
   sends the expected version in its signed request. D1 rejects a concurrent or
   stale rotation. Save the one displayed phrase in the owner's password
   manager, then close the terminal.
5. If the response is lost or the phrase was not retained, run `generate`
   again. The status request recovers the committed version and the next signed
   request creates a newer verifier. There is no endpoint that reads old words.

Generating or rotating the verifier does not change what an ordinary call
asks, because no call path consults it. Reusing the verifier for call
authentication would need a new, separately reviewed design.

`jarvis owner-passphrase status` prints only a version and state, or “not
configured.” A disabled status names its current version so `generate` can
compare-and-swap to a new one. A device mismatch, configured-owner mismatch,
clock problem, unavailable gateway, and CAS conflict use fixed messages that
contain no phrase or verifier material.
